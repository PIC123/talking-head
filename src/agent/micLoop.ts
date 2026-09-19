import { BaseAgent, type AgentAudioLevel } from './types';
import { StreamAnalyzer, getAudioContext } from '../audio/analyzer';

/**
 * Test agent with no provider: your own mic drives the mouth directly.
 * Holding talk shows the "listening" state, but the mouth follows the mic at all times
 * so face work can proceed before any provider is wired.
 */
export class MicLoopAgent extends BaseAgent {
  readonly name = 'micloop';
  private stream: MediaStream | null = null;
  private analyzer: StreamAnalyzer | null = null;
  private micOn = false;

  async connect(): Promise<void> {
    this.setState('connecting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.analyzer = new StreamAnalyzer(getAudioContext());
      this.analyzer.connectStream(this.stream);
      this.setState('idle');
    } catch (e) {
      this.setState('disconnected');
      this.emitError(e);
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyzer = null;
    this.setState('disconnected');
  }

  setMicEnabled(on: boolean): void {
    this.micOn = on;
    if (this.state === 'disconnected' || this.state === 'connecting') return;
    this.setState(on ? 'listening' : 'speaking');
  }

  getOutputLevel(): AgentAudioLevel {
    if (!this.analyzer) return { level: 0, brightness: 0 };
    const l = this.analyzer.read();
    // While "listening" the mouth stays shut, like a real agent would.
    return this.micOn ? { level: 0, brightness: 0 } : l;
  }
}

/**
 * Test agent that exercises the whole turn loop without an API: record while talk is held,
 * "think" briefly, then play the recording back as the agent's voice.
 */
export class EchoAgent extends BaseAgent {
  readonly name = 'echo';
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private analyzer: StreamAnalyzer | null = null;
  private player: HTMLAudioElement | null = null;
  private thinkTimer: number | undefined;

  async connect(): Promise<void> {
    this.setState('connecting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.analyzer = new StreamAnalyzer(getAudioContext());
      this.setState('idle');
    } catch (e) {
      this.setState('disconnected');
      this.emitError(e);
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    window.clearTimeout(this.thinkTimer);
    this.recorder?.state !== 'inactive' && this.recorder?.stop();
    this.recorder = null;
    this.player?.pause();
    this.player = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.setState('disconnected');
  }

  setMicEnabled(on: boolean): void {
    if (!this.stream || this.state === 'disconnected' || this.state === 'connecting') return;
    if (on) {
      // Barge-in: pressing talk cancels playback.
      this.player?.pause();
      this.player = null;
      window.clearTimeout(this.thinkTimer);
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (e) => e.data.size > 0 && this.chunks.push(e.data);
      this.recorder.onstop = () => this.playback();
      this.recorder.start();
      this.setState('listening');
    } else if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
      this.setState('thinking');
    }
  }

  private playback(): void {
    if (this.chunks.length === 0) {
      this.setState('idle');
      return;
    }
    const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' });
    this.emitTranscript('user', `(recorded ${Math.round(blob.size / 1024)} kB)`);
    this.thinkTimer = window.setTimeout(() => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const ctx = getAudioContext();
      const src = ctx.createMediaElementSource(audio);
      src.connect(this.analyzer!.analyser);
      src.connect(ctx.destination);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (this.player === audio) {
          this.player = null;
          this.setState('idle');
        }
      };
      audio.onerror = () => {
        this.emitError(new Error('echo playback failed'));
        this.setState('idle');
      };
      this.player = audio;
      this.emitTranscript('agent', '(echo)');
      this.setState('speaking');
      void audio.play().catch((e) => this.emitError(e));
    }, 700);
  }

  getOutputLevel(): AgentAudioLevel {
    if (!this.analyzer || this.state !== 'speaking') return { level: 0, brightness: 0 };
    return this.analyzer.read();
  }
}
