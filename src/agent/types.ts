export type AgentState = 'disconnected' | 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking';

export interface AgentAudioLevel {
  /** Smoothed loudness 0..1 of the agent's voice. */
  level: number;
  /** Rough spectral brightness 0..1 (high-frequency share), for mouth width. */
  brightness: number;
}

export interface TranscriptLine {
  role: 'user' | 'agent';
  text: string;
}

/**
 * Provider-agnostic voice agent. One instance per session; `connect()` may be called
 * again after `disconnect()` or an error.
 */
export interface VoiceAgent {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Unmute the mic (push-to-talk pressed). */
  setMicEnabled(on: boolean): void;
  /** Read the current output level; polled once per frame. */
  getOutputLevel(): AgentAudioLevel;
  onState(cb: (s: AgentState) => void): void;
  onError(cb: (e: Error) => void): void;
  onTranscript(cb: (line: TranscriptLine) => void): void;
}

/** Small helper base class so adapters only implement the provider bits. */
export abstract class BaseAgent implements VoiceAgent {
  abstract readonly name: string;
  protected state: AgentState = 'disconnected';
  private stateCb: (s: AgentState) => void = () => {};
  private errorCb: (e: Error) => void = () => {};
  private transcriptCb: (l: TranscriptLine) => void = () => {};

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract setMicEnabled(on: boolean): void;
  abstract getOutputLevel(): AgentAudioLevel;

  onState(cb: (s: AgentState) => void): void {
    this.stateCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errorCb = cb;
  }
  onTranscript(cb: (l: TranscriptLine) => void): void {
    this.transcriptCb = cb;
  }

  getState(): AgentState {
    return this.state;
  }

  protected setState(s: AgentState): void {
    if (s === this.state) return;
    this.state = s;
    this.stateCb(s);
  }
  protected emitError(e: unknown): void {
    this.errorCb(e instanceof Error ? e : new Error(String(e)));
  }
  protected emitTranscript(role: 'user' | 'agent', text: string): void {
    this.transcriptCb({ role, text });
  }
}
