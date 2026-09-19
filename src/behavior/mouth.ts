import type { Config } from '../config/schema';
import type { AgentAudioLevel } from '../agent/types';
import { clamp01, smoothK } from '../util/math';

/** Noise gate -> envelope follower -> gamma -> jitter. Returns mouth open/width in 0..1. */
export class MouthFollower {
  private env = 0;
  private bright = 0;
  private jitterPhase = 0;

  update(input: AgentAudioLevel, cfg: Config['mouth'], dtMs: number): { open: number; width: number } {
    let raw = input.level * cfg.gain;
    raw = raw < cfg.gate ? 0 : (raw - cfg.gate) / (1 - cfg.gate);
    raw = clamp01(raw);
    const k = smoothK(raw > this.env ? cfg.attackMs : cfg.releaseMs, dtMs);
    this.env += (raw - this.env) * k;
    this.bright += (input.brightness - this.bright) * smoothK(150, dtMs);

    let open = Math.pow(this.env, cfg.gamma);
    if (open > 0.02) {
      this.jitterPhase += dtMs * 0.02;
      open *= 1 + cfg.jitter * Math.sin(this.jitterPhase * 1.7) * Math.cos(this.jitterPhase * 0.9);
    }
    // Brighter (ee-ish) sounds narrow the mouth slightly; darker (oo-ish) sounds widen it less.
    const width = 1 - 0.25 * clamp01((this.bright - 0.2) / 0.4) * open;
    return { open: clamp01(open), width: clamp01(width) };
  }
}
