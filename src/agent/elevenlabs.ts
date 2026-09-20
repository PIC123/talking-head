import { VoiceConversation, type Mode, type Status } from '@elevenlabs/client';
import { BaseAgent, type AgentAudioLevel } from './types';
import { levelFromFrequencyData } from '../audio/analyzer';

export interface ElevenLabsOptions {
  agentId: string;
  /** Keep the mic muted except while talk is held. */
  pushToTalk: boolean;
  /** Optional system prompt override; the agent must allow overrides in its Security settings. */
  promptOverride?: string;
  connectionType: 'webrtc' | 'websocket';
  log?: (text: string) => void;
}

/**
 * ElevenLabs Conversational AI over WebRTC. Public agents need no backend: the agent ID is
 * enough. The SDK captures the mic and plays the agent's audio itself; we only read levels.
 */
export class ElevenLabsAgent extends BaseAgent {
  readonly name = 'elevenlabs';
  private conv: VoiceConversation | null = null;
  private micHeld = false;
  private awaitingReply = false;
  private thinkTimeout: number | undefined;
  private mode: Mode = 'listening';
  private freq: Uint8Array = new Uint8Array(32);

  constructor(private readonly opts: ElevenLabsOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.conv) return;
    if (!this.opts.agentId) throw new Error('ElevenLabs agent ID is empty (set it in the edit panel or config)');
    this.setState('connecting');
    try {
      const conv = await VoiceConversation.startSession({
        agentId: this.opts.agentId,
        connectionType: this.opts.connectionType,
        onConnect: ({ conversationId }) =>
          this.opts.log?.(`connected over ${this.opts.connectionType}, conversation ${conversationId}`),
        overrides: this.opts.promptOverride ? { agent: { prompt: { prompt: this.opts.promptOverride } } } : undefined,
        onStatusChange: ({ status }) => this.onStatus(status),
        onModeChange: ({ mode }) => this.onMode(mode),
        onError: (message, context) => this.emitError(new Error(`${message} ${context ? JSON.stringify(context) : ''}`)),
        onDisconnect: (details) => {
          this.conv = null;
          const clientTeardown = details.reason === 'agent' && /CLIENT_INITIATED/i.test(String(details.context?.reason ?? ''));
          if (clientTeardown) {
            // The SDK closes the room itself when setup fails (typically the mic); the real error follows.
            this.opts.log?.('connection closed during setup (client-initiated); see the next line for the cause');
          } else if (details.reason !== 'user') {
            const bits = [
              'message' in details ? details.message : '',
              details.context?.reason ? `reason: ${details.context.reason}` : '',
              details.context?.type ? `type: ${details.context.type}` : '',
              details.closeCode !== undefined ? `code ${details.closeCode}` : '',
              details.closeReason ? details.closeReason : '',
            ].filter(Boolean);
            this.emitError(new Error(`disconnected by ${details.reason} (${bits.join(', ') || 'no detail given'})`));
          }
          this.setState('disconnected');
        },
        onMessage: ({ role, message }) => this.emitTranscript(role, message),
        onInterruption: () => this.clearThinking(),
      });
      this.conv = conv;
      conv.setMicMuted(this.opts.pushToTalk && !this.micHeld);
      if (this.state === 'connecting') this.setState(this.derive());
    } catch (e) {
      this.conv = null;
      this.setState('disconnected');
      this.emitError(e);
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.clearThinking();
    const c = this.conv;
    this.conv = null;
    if (c) {
      try {
        await c.endSession();
      } catch (e) {
        console.warn('endSession failed', e);
      }
    }
    this.setState('disconnected');
  }

  setMicEnabled(on: boolean): void {
    if (on === this.micHeld) return;
    this.micHeld = on;
    if (!this.conv) return;
    if (this.opts.pushToTalk) this.conv.setMicMuted(!on);
    if (on) {
      // Barge-in: the SDK sends live audio, the server interrupts the agent on speech.
      this.clearThinking();
    } else {
      // Visitor released talk: show "thinking" until the agent starts speaking (or gives up).
      this.awaitingReply = true;
      window.clearTimeout(this.thinkTimeout);
      this.thinkTimeout = window.setTimeout(() => this.clearThinking(), 8000);
    }
    this.setState(this.derive());
  }

  getOutputLevel(): AgentAudioLevel {
    if (!this.conv || this.mode !== 'speaking') return { level: 0, brightness: 0 };
    try {
      this.freq = this.conv.getOutputByteFrequencyData();
    } catch {
      return { level: 0, brightness: 0 };
    }
    return levelFromFrequencyData(this.freq);
  }

  private onStatus(status: Status): void {
    if (status === 'connecting') this.setState('connecting');
    else if (status === 'connected') this.setState(this.derive());
    else if (status === 'disconnected') this.setState('disconnected');
  }

  private onMode(mode: Mode): void {
    this.mode = mode;
    if (mode === 'speaking') this.clearThinking();
    this.setState(this.derive());
  }

  private clearThinking(): void {
    this.awaitingReply = false;
    window.clearTimeout(this.thinkTimeout);
    this.thinkTimeout = undefined;
    if (this.conv) this.setState(this.derive());
  }

  private derive() {
    if (!this.conv) return 'disconnected' as const;
    if (this.mode === 'speaking') return 'speaking' as const;
    if (this.micHeld) return 'listening' as const;
    if (this.awaitingReply) return 'thinking' as const;
    if (!this.opts.pushToTalk) return 'listening' as const;
    return 'idle' as const;
  }
}
