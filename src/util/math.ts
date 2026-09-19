export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** Exponential smoothing factor for a time constant `tauMs` and a frame `dtMs`. */
export const smoothK = (tauMs: number, dtMs: number): number => (tauMs <= 0 ? 1 : 1 - Math.exp(-dtMs / tauMs));

export const easeInOut = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
};

export const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
