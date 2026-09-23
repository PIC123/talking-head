import { BaseAgent, type AgentAudioLevel } from './types';
import { levelFromFrequencyData } from '../audio/analyzer';

export interface MuseOptions {
  /** WebSocket URL of the relay (server/relay.mjs). */
  relayUrl: string;
  relayToken: string;
  pushToTalk: boolean;
}

const SAMPLE_RATE = 24000;

/**
 * Talks to the relay, which runs Meta's Muse Voice Transcribe + Muse Spark + a text-to-speech
 * provider. The browser only captures the mic and plays PCM back; the key stays on the relay.
 *
 * Two transports, chosen by the relay URL:
 *   ws:// or wss://    long-lived WebSocket (supports open mic with server endpointing)
 *   http:// or https:// one POST per push-to-talk turn, streamed reply (serverless friendly)
 */
export class MuseAgent extends BaseAgent {
  readonly name = 'muse';
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private capture: AudioWorkletNode | ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freq = new Uint8Array(128);
  private micHeld = false;
  private sending = false;
  private playhead = 0;
  private sources: AudioBufferSourceNode[] = [];
  private speaking = false;
  private drainTimer: number | undefined;
  private thinkTimer: number | undefined;
  // HTTP turn mode
  private readonly http: boolean;
  private recording: Int16Array[] = [];
  private history: { role: 'user' | 'assistant'; content: string }[] = [];
  private turnCtl: AbortController | null = null;

  constructor(private readonly opts: MuseOptions) {
    super();
    this.http = /^https?:/i.test(opts.relayUrl) || opts.relayUrl.startsWith('/');
  }

  private get turnUrl(): string {
    return this.opts.relayUrl.startsWith('/') ? location.origin + this.opts.relayUrl : this.opts.relayUrl;
  }

  async connect(): Promise<void> {
    if (this.ws) return;
    this.setState('connecting');
    try {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.ctx.resume();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.4;
      this.analyser.connect(this.ctx.destination);
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      await this.startCapture();
      if (this.http) {
        if (!this.opts.pushToTalk) this.emitError(new Error('open mic needs the WebSocket relay; the HTTP endpoint is push-to-talk only'));
        await this.probeHttp();
        this.setState('idle');
        if (this.micHeld) this.beginTurn();
        return;
      }
      await this.openSocket();
      this.sending = !this.opts.pushToTalk;
      this.setState(this.opts.pushToTalk ? 'idle' : 'listening');
      // The press that triggered this connect is still down: open its turn now.
      if (this.micHeld && this.opts.pushToTalk) this.beginTurn();
    } catch (e) {
      await this.disconnect();
      this.emitError(e);
      throw e;
    }
  }

  /** Cheap reachability check so a wrong URL fails at connect time, not on the first turn. */
  private async probeHttp(): Promise<void> {
    try {
      const r = await fetch(this.turnUrl, { method: 'GET' });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
    } catch (e) {
      throw new Error(`turn endpoint not reachable at ${this.turnUrl}: ${String((e as Error).message ?? e)}`);
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.relayUrl);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', turnMode: this.opts.pushToTalk ? 'pushToTalk' : 'openMic', token: this.opts.relayToken || undefined }));
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => reject(new Error(`relay not reachable at ${this.opts.relayUrl} (start it with: npm run relay)`));
      ws.onclose = (ev) => {
        if (ev.code === 4001) this.emitError(new Error('relay refused the connection: unauthorized (check relayToken)'));
        if (this.ws === ws) {
          this.ws = null;
          this.stopPlayback();
          this.setState('disconnected');
        }
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
    });
  }

  private onMessage(data: ArrayBuffer | string): void {
    if (data instanceof ArrayBuffer) {
      this.enqueue(data);
      return;
    }
    let m: { type: string; state?: string; role?: 'user' | 'agent'; text?: string; message?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.type) {
      case 'state':
        if (m.state !== 'thinking') window.clearTimeout(this.thinkTimer);
        if (m.state === 'speaking') this.speaking = true;
        if (m.state === 'idle' || m.state === 'listening') {
          // The relay is done; hold "speaking" until the buffered audio has played out.
          this.speaking = false;
          this.scheduleIdle(m.state);
        } else if (m.state) this.setState(m.state as never);
        break;
      case 'transcript':
        if (m.role && m.text) this.emitTranscript(m.role, m.text);
        break;
      case 'speechEnd':
        this.speaking = false;
        break;
      case 'error':
        this.emitError(new Error(m.message ?? 'relay error'));
        break;
    }
  }

  private scheduleIdle(next: string): void {
    window.clearTimeout(this.drainTimer);
    const remaining = this.ctx ? Math.max(0, this.playhead - this.ctx.currentTime) : 0;
    this.drainTimer = window.setTimeout(() => {
      if (!this.speaking) this.setState(this.micHeld ? 'listening' : (next as never));
    }, remaining * 1000 + 50);
  }

  private enqueue(pcm: ArrayBuffer): void {
    if (!this.ctx || !this.analyser) return;
    const i16 = new Int16Array(pcm);
    const buf = this.ctx.createBuffer(1, i16.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    const startAt = Math.max(this.ctx.currentTime + 0.05, this.playhead);
    src.start(startAt);
    this.playhead = startAt + buf.duration;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
    };
    if (this.state !== 'speaking') this.setState('speaking');
  }

  private stopPlayback(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.playhead = 0;
  }

  private async startCapture(): Promise<void> {
    const ctx = this.ctx!;
    const src = ctx.createMediaStreamSource(this.mic!);
    const onPcm = (f32: Float32Array) => {
      if (!this.sending) return;
      const out = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
      if (this.http) {
        // Cap the buffered utterance at 60 s (serverless request-size limit).
        if (this.recording.reduce((n, c) => n + c.length, 0) < SAMPLE_RATE * 60) this.recording.push(out);
        return;
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(out.buffer);
    };
    if (ctx.audioWorklet) {
      const code = `class P extends AudioWorkletProcessor{constructor(){super();this.buf=[];this.n=0}process(inputs){const c=inputs[0]?.[0];if(!c)return true;this.buf.push(new Float32Array(c));this.n+=c.length;if(this.n>=1920){const o=new Float32Array(this.n);let k=0;for(const b of this.buf){o.set(b,k);k+=b.length}this.port.postMessage(o,[o.buffer]);this.buf=[];this.n=0}return true}}registerProcessor('pcm-capture',P)`;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (e) => onPcm(e.data as Float32Array);
      src.connect(node);
      this.capture = node;
    } else {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => onPcm(e.inputBuffer.getChannelData(0));
      src.connect(node);
      node.connect(ctx.destination);
      this.capture = node;
    }
  }

  async disconnect(): Promise<void> {
    window.clearTimeout(this.drainTimer);
    window.clearTimeout(this.thinkTimer);
    this.turnCtl?.abort();
    this.turnCtl = null;
    this.stopPlayback();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.capture?.disconnect();
    this.capture = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.setState('disconnected');
  }

  setMicEnabled(on: boolean): void {
    if (on === this.micHeld) return;
    this.micHeld = on;
    if (this.state === 'disconnected' || this.state === 'connecting') return;
    if (!this.http && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) return;
    if (!this.opts.pushToTalk && !this.http) return; // open mic: the relay's endpointing decides turns
    if (on) this.beginTurn();
    else this.endTurn();
  }

  private beginTurn(): void {
    if (this.http) {
      // Barge-in: abandon the reply in flight, start a fresh recording.
      this.turnCtl?.abort();
      this.turnCtl = null;
      this.stopPlayback();
      this.speaking = false;
      window.clearTimeout(this.thinkTimer);
      this.recording = [];
      this.sending = true;
      this.setState('listening');
      return;
    }
    if (!this.ws) return;
    window.clearTimeout(this.thinkTimer);
    // Barge-in: drop whatever is playing, then open a new turn.
    this.stopPlayback();
    this.speaking = false;
    this.ws.send(JSON.stringify({ type: 'interrupt' }));
    this.ws.send(JSON.stringify({ type: 'talk', on: true }));
    this.sending = true;
    this.setState('listening');
  }

  private endTurn(): void {
    if (this.http) {
      this.sending = false;
      const chunks = this.recording;
      this.recording = [];
      void this.postTurn(chunks);
      return;
    }
    if (!this.ws) return;
    this.sending = false;
    this.ws.send(JSON.stringify({ type: 'talk', on: false }));
    this.setState('thinking');
    // If the relay never answers (dead upstream), do not leave the face stuck thinking.
    window.clearTimeout(this.thinkTimer);
    this.thinkTimer = window.setTimeout(() => {
      if (this.state === 'thinking') {
        this.emitError(new Error('no reply from the relay within 15 s'));
        this.setState('idle');
      }
    }, 15000);
  }

  /** HTTP mode: send the utterance, stream the framed reply. */
  private async postTurn(chunks: Int16Array[]): Promise<void> {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total < SAMPLE_RATE * 0.25) {
      this.setState('idle');
      return;
    }
    const pcm = new Int16Array(total);
    let k = 0;
    for (const c of chunks) {
      pcm.set(c, k);
      k += c.length;
    }
    const meta = new TextEncoder().encode(JSON.stringify({ token: this.opts.relayToken || undefined, history: this.history, sampleRate: SAMPLE_RATE }));
    const body = new Uint8Array(4 + meta.length + pcm.byteLength);
    new DataView(body.buffer).setUint32(0, meta.length);
    body.set(meta, 4);
    body.set(new Uint8Array(pcm.buffer), 4 + meta.length);

    const ctl = new AbortController();
    this.turnCtl = ctl;
    this.setState('thinking');
    let userText = '';
    let assistantText = '';
    try {
      const res = await fetch(this.turnUrl, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' }, signal: ctl.signal });
      if (!res.ok || !res.body) {
        const msg = (await res.text().catch(() => '')).slice(0, 160);
        throw new Error(`turn HTTP ${res.status}${res.status === 401 ? ' unauthorized: relay token missing or wrong' : ''}: ${msg}`);
      }
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      let done = false;
      while (!done) {
        const r = await reader.read();
        if (r.value) {
          const nb = new Uint8Array(buf.length + r.value.length);
          nb.set(buf);
          nb.set(r.value, buf.length);
          buf = nb;
        }
        done = r.done;
        // Frames: [u8 type][u32 BE len][payload]
        while (buf.length >= 5) {
          const type = buf[0];
          const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
          if (buf.length < 5 + len) break;
          const payload = buf.slice(5, 5 + len);
          buf = buf.slice(5 + len);
          if (ctl.signal.aborted) break;
          if (type === 2) this.enqueue(payload.buffer);
          else if (type === 1) {
            const m = JSON.parse(new TextDecoder().decode(payload)) as { type: string; state?: string; role?: 'user' | 'agent'; text?: string; message?: string; assistantText?: string };
            if (m.type === 'transcript' && m.role === 'user' && m.text) userText = m.text;
            if (m.type === 'state' && m.state === 'idle' && m.assistantText !== undefined) assistantText = m.assistantText;
            this.onMessage(JSON.stringify(m));
          }
        }
      }
      if (userText) this.history.push({ role: 'user', content: userText });
      if (assistantText) this.history.push({ role: 'assistant', content: assistantText });
      this.history = this.history.slice(-12);
    } catch (e) {
      if (!ctl.signal.aborted) {
        this.emitError(e);
        this.setState('idle');
      }
    } finally {
      if (this.turnCtl === ctl) this.turnCtl = null;
    }
  }

  getOutputLevel(): AgentAudioLevel {
    if (!this.analyser || this.state !== 'speaking') return { level: 0, brightness: 0 };
    this.analyser.getByteFrequencyData(this.freq);
    // Bins up to ~8 kHz of a 12 kHz Nyquist.
    return levelFromFrequencyData(this.freq.subarray(0, Math.ceil(this.freq.length * (8000 / (SAMPLE_RATE / 2)))));
  }
}
