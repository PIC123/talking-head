import type { P } from './math';

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Find the brightest blob that appeared between `ref` (dark frame) and `lit` (one dot shown).
 * Returns the centroid in pixels and the peak brightness gain, or null when nothing lit up.
 */
export function findDot(ref: ImageData, lit: ImageData, minGain = 28): { p: P; gain: number } | null {
  const w = ref.width, h = ref.height, a = ref.data, b = lit.data;
  const diff = new Float32Array(w * h);
  let max = 0;
  for (let i = 0, k = 0; i < a.length; i += 4, k++) {
    const d = luma(b, i) - luma(a, i);
    diff[k] = d > 0 ? d : 0;
    if (d > max) max = d;
  }
  if (max < minGain) return null;
  // Centroid of pixels within the top half of the gain, weighted by gain, restricted to the
  // neighbourhood of the peak so a second faint reflection cannot pull it.
  let peak = 0;
  for (let k = 1; k < diff.length; k++) if (diff[k] > diff[peak]) peak = k;
  const px = peak % w, py = Math.floor(peak / w);
  const R = Math.max(8, Math.round(Math.min(w, h) * 0.08));
  let sx = 0, sy = 0, sw = 0;
  for (let y = Math.max(0, py - R); y < Math.min(h, py + R); y++) {
    for (let x = Math.max(0, px - R); x < Math.min(w, px + R); x++) {
      const v = diff[y * w + x];
      if (v >= max * 0.5) {
        sx += x * v;
        sy += y * v;
        sw += v;
      }
    }
  }
  return { p: [sx / sw, sy / sw], gain: max };
}

export interface Region {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  count: number;
  mask: Uint8Array;
}

/**
 * Grow a region from `seed` over pixels whose colour is within `tol` (RGB distance) of the seed's
 * local average. Used to find the mask after tapping it in the lit camera frame.
 */
export function regionGrow(img: ImageData, seed: P, tol = 60): Region | null {
  const w = img.width, h = img.height, d = img.data;
  const sx = Math.round(seed[0]), sy = Math.round(seed[1]);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  // Seed colour: 5x5 average.
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, sy - 2); y <= Math.min(h - 1, sy + 2); y++)
    for (let x = Math.max(0, sx - 2); x <= Math.min(w - 1, sx + 2); x++) {
      const i = (y * w + x) * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
  r /= n; g /= n; b /= n;
  const mask = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  mask[stack[0]] = 1;
  let count = 0;
  let x0 = sx, y0 = sy, x1 = sx, y1 = sy;
  const tol2 = tol * tol;
  while (stack.length) {
    const k = stack.pop()!;
    count++;
    const x = k % w, y = (k - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const nb = [k - 1, k + 1, k - w, k + w];
    for (const m of nb) {
      if (m < 0 || m >= w * h || mask[m]) continue;
      if ((m === k - 1 && x === 0) || (m === k + 1 && x === w - 1)) continue;
      const i = m * 4;
      const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
      if (dr * dr + dg * dg + db * db <= tol2) {
        mask[m] = 1;
        stack.push(m);
      }
    }
  }
  if (count < 50) return null;
  return { bbox: { x0, y0, x1, y1 }, count, mask };
}
