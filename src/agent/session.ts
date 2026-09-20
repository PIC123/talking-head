import type { Config } from '../config/schema';
import type { AgentAudioLevel, AgentState, TranscriptLine, VoiceAgent } from './types';
import { ElevenLabsAgent } from './elevenlabs';
import { EchoAgent, MicLoopAgent } from './micLoop';
import { micErrorKind, micHint } from '../ui/diagnostics';

export type Logger = (kind: 'info' | 'err' | 'agent' | 'user', text: string) => void;

const BACKOFF_MS = [1000, 2000, 5000, 10000];

/**
 * Owns the agent lifecycle: connect on demand, end the session after a quiet period,
 * reconnect with backoff after unexpected drops, and never surface errors on the face.
 */
export class SessionManager {
  private agent: VoiceAgent | null = null;
  private wantConnected = false;
  private connecting = false;
  private lastActivity = performance.now();
  private retryIndex = 0;
  private retryTimer: number | undefined;
  private talkHeld = false;
  private agentState: AgentState = 'disconnected';
  private personaPrompt: string | undefined;
  private stateCb: (s: AgentState) => void = () => {};
  /** Set once WebRTC failed fast in 'auto' mode; later sessions use WebSocket. Remembered per tab. */
  private wsFallback = sessionStorage.getItem('talking-head:wsFallback') === '1';
  private connectedAt = -1;
  private sessionStartedAt = -1;

  constructor(
    private getConfig: () => Config,
    private log: Logger,
  ) {}

  onState(cb: (s: AgentState) => void): void {
    this.stateCb = cb;
  }

  setPersonaPrompt(p: string | undefined): void {
    this.personaPrompt = p;
  }

  /** What the face should show. Deliberate disconnects between visitors look like idle, not broken. */
  getFaceState(): AgentState {
    if (this.agentState === 'disconnected') return this.wantConnected ? 'disconnected' : 'idle';
    return this.agentState;
  }

  getAgentState(): AgentState {
    return this.agentState;
  }

  getLevel(): AgentAudioLevel {
    return this.agent?.getOutputLevel() ?? { level: 0, brightness: 0 };
  }

  isTalkHeld(): boolean {
    return this.talkHeld;
  }

  msSinceActivity(): number {
    return performance.now() - this.lastActivity;
  }

  isPaused(): boolean {
    return this.getConfig().agent.paused;
  }

  /** Called once after the Start overlay. */
  start(): void {
    const c = this.getConfig().agent;
    if (c.paused) return;
    if (c.connectOnStart || c.turnMode === 'openMic' || c.provider === 'micloop') this.requestConnect();
  }

  pressTalk(): void {
    if (this.talkHeld) return;
    if (this.isPaused()) {
      this.log('info', 'paused: talk ignored (press P or untick "paused" to resume)');
      return;
    }
    this.talkHeld = true;
    this.lastActivity = performance.now();
    if (!this.agent || this.agentState === 'disconnected') this.requestConnect();
    this.agent?.setMicEnabled(true);
  }

  releaseTalk(): void {
    if (!this.talkHeld) return;
    this.talkHeld = false;
    this.lastActivity = performance.now();
    this.agent?.setMicEnabled(false);
  }

  /** Provider or agent settings changed: drop the current session; the next talk press rebuilds it. */
  rebuild(): void {
    const old = this.agent;
    this.wantConnected = false;
    window.clearTimeout(this.retryTimer);
    this.retryIndex = 0;
    // Detach first so a talk press during the async disconnect builds a fresh agent instead of
    // reviving the old one; stale callbacks from `old` are ignored (see buildAgent).
    this.agent = null;
    if (old && this.agentState !== 'disconnected') {
      this.log('info', 'ending session: config changed');
      void old.disconnect().catch((e) => this.log('err', `disconnect failed: ${String(e)}`));
    }
    this.agentState = 'disconnected';
    this.stateCb('disconnected');
    this.start();
  }

  /** Call once per frame. */
  tick(): void {
    const c = this.getConfig().agent;
    if (c.paused) {
      if (this.wantConnected || this.agentState !== 'disconnected') void this.endSession('paused');
      return;
    }
    // In push-to-talk only the visitor's presses count as activity. The agent re-engaging on its
    // own ("still there?") must not keep a session alive, or an abandoned head talks to itself
    // until the credits run out. In open mic, any speech from either side counts.
    const busy = this.agentState === 'listening' || this.agentState === 'speaking' || this.agentState === 'thinking';
    if (busy && (c.turnMode === 'openMic' || this.talkHeld)) this.lastActivity = performance.now();
    const keepAlive = c.provider === 'micloop' || c.connectOnStart;
    if (this.wantConnected && !keepAlive && !this.talkHeld && this.msSinceActivity() > c.sessionIdleTimeoutSec * 1000) {
      void this.endSession('idle timeout');
    }
    if (this.wantConnected && c.maxSessionSec > 0 && this.sessionStartedAt > 0 && performance.now() - this.sessionStartedAt > c.maxSessionSec * 1000) {
      void this.endSession(`max session length (${c.maxSessionSec}s)`);
    }
  }

  private buildAgent(): VoiceAgent {
    const c = this.getConfig().agent;
    let agent: VoiceAgent;
    switch (c.provider) {
      case 'elevenlabs':
        agent = new ElevenLabsAgent({
          agentId: c.agentId,
          pushToTalk: c.turnMode === 'pushToTalk',
          promptOverride: this.personaPrompt,
          connectionType: c.connection === 'auto' ? (this.wsFallback ? 'websocket' : 'webrtc') : c.connection,
          log: (t) => this.log('info', t),
        });
        break;
      case 'echo':
        agent = new EchoAgent();
        break;
      default:
        agent = new MicLoopAgent();
    }
    agent.onState((s) => {
      if (this.agent === agent) this.handleState(s);
    });
    agent.onError((e) => {
      this.log('err', e.message);
      if (/quota_exceeded|run out of credits|max_duration_exceeded|unauthorized|\b401\b|\b403\b/i.test(e.message)) {
        // Terminal from the server's side; retrying only repeats the message. The next press tries again.
        this.wantConnected = false;
        window.clearTimeout(this.retryTimer);
        this.log('err', 'not retrying: fix this on the ElevenLabs side (credits, plan or agent security), then press talk again');
      }
    });
    agent.onTranscript((l: TranscriptLine) => this.log(l.role, l.text));
    return agent;
  }

  private handleState(s: AgentState): void {
    const prev = this.agentState;
    this.agentState = s;
    this.stateCb(s);
    if (s === 'disconnected' && prev !== 'disconnected' && this.wantConnected && !this.connecting) {
      this.log('info', 'connection dropped, will retry');
      this.considerTransportFallback();
      this.scheduleRetry();
    }
    if (s !== 'disconnected' && s !== 'connecting') {
      this.retryIndex = 0;
      if (prev === 'connecting' || prev === 'disconnected') this.connectedAt = performance.now();
    }
  }

  /** WebRTC that fails to connect, or drops within seconds of connecting, is usually a UDP-blocking network. */
  private considerTransportFallback(): void {
    const c = this.getConfig().agent;
    if (c.provider !== 'elevenlabs' || c.connection !== 'auto' || this.wsFallback) return;
    const quick = this.connectedAt < 0 || performance.now() - this.connectedAt < 5000;
    if (!quick) return;
    this.wsFallback = true;
    this.agent = null; // next connect builds a WebSocket agent
    try {
      sessionStorage.setItem('talking-head:wsFallback', '1');
    } catch {
      /* ignore */
    }
    this.log('info', 'WebRTC failed quickly; switching to WebSocket transport for this tab');
  }

  private requestConnect(): void {
    if (!this.wantConnected) this.sessionStartedAt = performance.now();
    this.wantConnected = true;
    this.lastActivity = performance.now();
    void this.connectNow();
  }

  private async connectNow(): Promise<void> {
    if (this.connecting || !this.wantConnected) return;
    if (this.agentState !== 'disconnected') return;
    if (!this.agent) this.agent = this.buildAgent();
    this.connecting = true;
    this.connectedAt = -1;
    try {
      this.log('info', `connecting (${this.agent.name})`);
      await this.agent.connect();
      this.connecting = false;
      this.retryIndex = 0;
      this.lastActivity = performance.now();
      if (this.talkHeld) this.agent.setMicEnabled(true);
    } catch (e) {
      this.connecting = false;
      const mic = micErrorKind(e);
      if (mic) {
        // Retrying would only re-prompt (and dismissed prompts get the site auto-blocked) or fail the
        // same way without a device. Wait for the next talk press instead.
        this.wantConnected = false;
        const name = (e as { name?: string })?.name ?? '';
        this.log('err', mic === 'denied' ? `MICROPHONE BLOCKED. ${micHint('NotAllowedError')}` : `MICROPHONE UNAVAILABLE (${name}). ${micHint(name) || 'Check the input device in the OS sound settings.'}`);
        return;
      }
      if (this.wantConnected) {
        const before = this.wsFallback;
        this.considerTransportFallback();
        if (this.wsFallback && !before) void this.connectNow(); // switch transports without waiting
        else this.scheduleRetry();
      }
    }
  }

  private scheduleRetry(): void {
    window.clearTimeout(this.retryTimer);
    const delay = BACKOFF_MS[Math.min(this.retryIndex, BACKOFF_MS.length - 1)];
    this.retryIndex++;
    this.log('info', `retrying in ${delay / 1000}s`);
    this.retryTimer = window.setTimeout(() => {
      // Give up quietly once the visitor has clearly walked away.
      const idleMs = this.getConfig().agent.sessionIdleTimeoutSec * 1000;
      if (!this.wantConnected) return;
      if (this.msSinceActivity() > idleMs && !this.talkHeld) {
        void this.endSession('gave up reconnecting');
        return;
      }
      void this.connectNow();
    }, delay);
  }

  private async endSession(reason: string): Promise<void> {
    this.wantConnected = false;
    window.clearTimeout(this.retryTimer);
    this.retryIndex = 0;
    if (this.agent && this.agentState !== 'disconnected') {
      this.log('info', `ending session: ${reason}`);
      await this.agent.disconnect();
    }
    this.agentState = 'disconnected';
    this.stateCb('disconnected');
  }
}
