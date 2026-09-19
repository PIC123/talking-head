import type { AgentAudioLevel } from '../agent/types';
import { clamp01 } from '../util/math';

/**
 * Turns byte frequency data (0..255 per bin, low to high frequency) into a loudness
 * level and a brightness value. Works for both a WebAudio AnalyserNode and the
 * ElevenLabs SDK's `getOutputByteFrequencyData()`.
 */
export function levelFromFrequencyData(bins: Uint8Array): AgentAudioLevel {
  const n = bins.length;
  if (n === 0) return { level: 0, brightness: 0 };
  // Loudness: RMS over the lower ~60% of bins (voice energy), which tracks speech better than a flat mean.
  const voiceEnd = Math.max(1, Math.floor(n * 0.6));
  let sumSq = 0;
  let lowSum = 0;
  let highSum = 0;
  for (let i = 0; i < n; i++) {
    const v = bins[i] / 255;
    if (i < voiceEnd) sumSq += v * v;
    if (i < n * 0.3) lowSum += v;
    else highSum += v;
  }
  const level = Math.sqrt(sumSq / voiceEnd);
  const total = lowSum + highSum;
  const brightness = total > 0.001 ? highSum / total : 0;
  return { level: clamp01(level), brightness: clamp01(brightness) };
}

/** Wraps an AnalyserNode so any MediaStream / audio element can drive the mouth. */
export class StreamAnalyzer {
  readonly analyser: AnalyserNode;
  private buf: Uint8Array<ArrayBuffer>;

  constructor(readonly ctx: AudioContext, fftSize = 512) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = 0.5;
    this.buf = new Uint8Array(this.analyser.frequencyBinCount);
  }

  connectStream(stream: MediaStream): MediaStreamAudioSourceNode {
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.analyser);
    return src;
  }

  read(): AgentAudioLevel {
    this.analyser.getByteFrequencyData(this.buf);
    // Only the bins up to ~8 kHz matter for voice.
    const nyquist = this.ctx.sampleRate / 2;
    const cutoff = Math.min(this.buf.length, Math.ceil((8000 / nyquist) * this.buf.length));
    return levelFromFrequencyData(this.buf.subarray(0, cutoff));
  }
}

let sharedCtx: AudioContext | null = null;
export function getAudioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  return sharedCtx;
}
