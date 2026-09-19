import type { Config } from '../config/schema';
import type { AgentAudioLevel, AgentState, TranscriptLine, VoiceAgent } from './types';
import { ElevenLabsAgent } from './elevenlabs';
import { EchoAgent, MicLoopAgent } from './micLoop';

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

  /** Called once after the Start overlay. */
  start(): void {
    const c = this.getConfig().agent;
    if (c.connectOnStart || c.turnMode === 'openMic' || c.provider === 'micloop') this.requestConnect();
  }

  pressTalk(): void {
    if (this.talkHeld) return;
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
  async rebuild(): Promise<void> {
    await this.endSession('config changed');
    this.agent = null;
    this.start();
  }

  /** Call once per frame. */
  tick(): void {
    const c = this.getConfig().agent;
    if (this.agentState === 'listening' || this.agentState === 'speaking' || this.agentState === 'thinking') {
      this.lastActivity = performance.now();
    }
    const keepAlive = c.turnMode === 'openMic' || c.provider === 'micloop' || c.connectOnStart;
    if (this.wantConnected && !keepAlive && !this.talkHeld && this.msSinceActivity() > c.sessionIdleTimeoutSec * 1000) {
      void this.endSession('idle timeout');
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
        });
        break;
      case 'echo':
        agent = new EchoAgent();
        break;
      default:
        agent = new MicLoopAgent();
    }
    agent.onState((s) => this.handleState(s));
    agent.onError((e) => this.log('err', e.message));
    agent.onTranscript((l: TranscriptLine) => this.log(l.role, l.text));
    return agent;
  }

  private handleState(s: AgentState): void {
    const prev = this.agentState;
    this.agentState = s;
    this.stateCb(s);
    if (s === 'disconnected' && prev !== 'disconnected' && this.wantConnected && !this.connecting) {
      this.log('info', 'connection dropped, will retry');
      this.scheduleRetry();
    }
    if (s !== 'disconnected' && s !== 'connecting') this.retryIndex = 0;
  }

  private requestConnect(): void {
    this.wantConnected = true;
    this.lastActivity = performance.now();
    void this.connectNow();
  }

  private async connectNow(): Promise<void> {
    if (this.connecting || !this.wantConnected) return;
    if (this.agentState !== 'disconnected') return;
    if (!this.agent) this.agent = this.buildAgent();
    this.connecting = true;
    try {
      this.log('info', `connecting (${this.agent.name})`);
      await this.agent.connect();
      this.connecting = false;
      this.retryIndex = 0;
      this.lastActivity = performance.now();
      if (this.talkHeld) this.agent.setMicEnabled(true);
    } catch (e) {
      this.connecting = false;
      if (this.wantConnected) this.scheduleRetry();
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
