import type { P } from './math';
import { regionGrow, type Region } from './detect';
import { CameraFeed, sleep } from './camera';

/** What the projector should show right now. */
export type CalFrame =
  | { kind: 'black' }
  | { kind: 'white' }
  | { kind: 'dot'; u: number; v: number }
  /** Gray-code stripe pattern: 2^bits stripes along `axis`, showing bit `bit` (0 = coarsest), or its inverse. */
  | { kind: 'stripes'; axis: 'x' | 'y'; bit: number; bits: number; inverse: boolean };

/** Per-camera-pixel projector coordinates decoded from the stripe patterns. */
export interface ScanResult {
  width: number;
  height: number;
  /** Projector-normalised u/v per camera pixel; meaningful only where valid[i] is set. */
  u: Float32Array;
  v: Float32Array;
  valid: Uint8Array;
  validCount: number;
  /** The flat-white camera frame, for the mask tap. */
  lit: ImageData;
}

export interface Placement {
  cornerPin: P[];
  ellipse: { cx: number; cy: number; rx: number; ry: number };
  flipH: boolean;
  flipV: boolean;
  /** Pixels of the mask region that carried a usable code. */
  coded: number;
  /** |correlation| between camera axes and projector axes; low values mean a rotated or noisy scan. */
  axisFit: number;
  /** Where the mask sits in the projector frame (normalised). */
  rect: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * The face contour's bounding box in canvas-normalised coordinates (the optional contour ellipse
 * is 340x420 about (0,20) on the 1024 canvas). Mapping this box onto the mask's bounding box puts
 * eyes and mouth where a real face has them.
 */
export const FACE_BOX = { x0: (512 - 340) / 1024, y0: (512 + 20 - 420) / 1024, x1: (512 + 340) / 1024, y1: (512 + 20 + 420) / 1024 };

/** Stripe resolution per axis: 2^6 = 64 stripes, about 13 px on an 854-wide projector. */
export const BITS = 6;

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function lumaOf(img: ImageData): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, k = 0; i < img.data.length; i += 4, k++) out[k] = luma(img.data, i);
  return out;
}

/** Gray code for stripe index i. */
export const gray = (i: number) => i ^ (i >> 1);
/** Inverse Gray code. */
export function ungray(g: number): number {
  let b = g;
  for (let m = g >> 1; m; m >>= 1) b ^= m;
  return b;
}

/**
 * Structured-light scan: for each axis and each bit, show the Gray-code stripe pattern and its
 * inverse and record which was brighter at every camera pixel. Decoding the bits gives the
 * projector coordinate each camera pixel is looking at, on whatever surface it lands on, so dots on
 * the mask and dots on the wall behind never get mixed. Ends with a flat-white frame for the mask tap.
 */
export async function runScan(cam: CameraFeed, show: (f: CalFrame) => void, status: (s: string) => void, settleMs = 300, minMargin = 8): Promise<ScanResult> {
  const grabLuma = async () => {
    await sleep(settleMs);
    cam.grab(); // discard one frame to ride out pipeline latency
    await sleep(40);
    return lumaOf(cam.grab());
  };
  show({ kind: 'black' });
  const dark = await grabLuma();
  show({ kind: 'white' });
  await sleep(settleMs);
  const litImg = cam.grab();
  const bright = await grabLuma();
  const n = cam.width * cam.height;
  const valid = new Uint8Array(n);
  let lit = 0;
  for (let i = 0; i < n; i++) if (bright[i] - dark[i] >= 20) { valid[i] = 1; lit++; }
  if (lit < n * 0.01) throw new Error('the camera sees almost no projector light. Dim the room, move closer, and make sure the projector output is this screen.');

  const codes: Record<'x' | 'y', Uint16Array> = { x: new Uint16Array(n), y: new Uint16Array(n) };
  const total = 2 * BITS;
  let step = 0;
  for (const axis of ['x', 'y'] as const) {
    for (let bit = 0; bit < BITS; bit++) {
      step++;
      status(`scanning ${step}/${total}: keep the phone still`);
      show({ kind: 'stripes', axis, bit, bits: BITS, inverse: false });
      const a = await grabLuma();
      show({ kind: 'stripes', axis, bit, bits: BITS, inverse: true });
      const b = await grabLuma();
      const shift = BITS - 1 - bit;
      for (let i = 0; i < n; i++) {
        if (!valid[i]) continue;
        const d = a[i] - b[i];
        if (Math.abs(d) < minMargin) { valid[i] = 0; continue; }
        if (d > 0) codes[axis][i] |= 1 << shift;
      }
    }
  }
  show({ kind: 'black' });
  const u = new Float32Array(n), v = new Float32Array(n);
  const stripes = 1 << BITS;
  let validCount = 0;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    validCount++;
    u[i] = (ungray(codes.x[i]) + 0.5) / stripes;
    v[i] = (ungray(codes.y[i]) + 0.5) / stripes;
  }
  if (validCount < 200) throw new Error(`only ${validCount} camera pixels decoded. Dim the room, hold the phone still, and try again.`);
  return { width: cam.width, height: cam.height, u, v, valid, validCount, lit: litImg };
}

/** The mask region in the lit frame, grown from a tap. */
export function findMask(scan: ScanResult, tap: P, tol: number): Region {
  const region = regionGrow(scan.lit, tap, tol);
  if (!region) throw new Error('nothing found at the tap. Tap the middle of the mask in the picture.');
  return region;
}

function percentile(sorted: Float32Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

function corr(xs: Float32Array, ys: Float32Array): number {
  const n = xs.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy || 1);
}

/**
 * Where the mask sits in the projector's frame: the extent of the decoded projector coordinates
 * over the tapped region (robust percentiles). The face box is scaled onto that rectangle. Flips
 * come from the sign of the camera-to-projector correlation, so a mirror fold or an inverted mount
 * is handled. Assumes the projector faces the mask roughly square-on, which the rig does; the
 * camera can be anywhere it sees the mask.
 */
export function placeFace(scan: ScanResult, region: Region, W: number, H: number, size = 1): Placement {
  const us: number[] = [], vs: number[] = [], xs: number[] = [], ys: number[] = [];
  const w = scan.width;
  for (let i = 0; i < region.mask.length; i++) {
    if (!region.mask[i] || !scan.valid[i]) continue;
    us.push(scan.u[i]); vs.push(scan.v[i]); xs.push(i % w); ys.push(Math.floor(i / w));
  }
  if (us.length < 100) throw new Error(`only ${us.length} coded pixels on the mask. Is the mask lit by the projector? Dim the room and retry.`);
  const U = Float32Array.from(us).sort(), V = Float32Array.from(vs).sort();
  const pad = 0.5 / (1 << BITS);
  const rect = { x0: percentile(U, 0.02) - pad, x1: percentile(U, 0.98) + pad, y0: percentile(V, 0.02) - pad, y1: percentile(V, 0.98) + pad };
  // Optional manual size trim, about the mask centre.
  if (size !== 1) {
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2, hw = ((rect.x1 - rect.x0) / 2) * size, hh = ((rect.y1 - rect.y0) / 2) * size;
    rect.x0 = cx - hw; rect.x1 = cx + hw; rect.y0 = cy - hh; rect.y1 = cy + hh;
  }
  const cxu = corr(Float32Array.from(xs), Float32Array.from(us)), cyv = corr(Float32Array.from(ys), Float32Array.from(vs));
  const cxv = corr(Float32Array.from(xs), Float32Array.from(vs)), cyu = corr(Float32Array.from(ys), Float32Array.from(us));
  const axisFit = Math.min(Math.abs(cxu), Math.abs(cyv));
  if (Math.abs(cxv) + Math.abs(cyu) > Math.abs(cxu) + Math.abs(cyv)) throw new Error('the projector image looks rotated 90° relative to the camera. Rotate the phone to match the projector and retry.');
  const flipH = cxu < 0, flipV = cyv < 0;

  // The face canvas fills the shorter screen side, centred; flips mirror it about the centre.
  const fb = FACE_BOX;
  const bx0 = flipH ? 1 - fb.x1 : fb.x0, bx1 = flipH ? 1 - fb.x0 : fb.x1;
  const by0 = flipV ? 1 - fb.y1 : fb.y0, by1 = flipV ? 1 - fb.y0 : fb.y1;
  const S = Math.min(W, H);
  const ox = (W - S) / 2 / W, oy = (H - S) / 2 / H, sx = S / W, sy = S / H;
  const box = { x0: ox + bx0 * sx, x1: ox + bx1 * sx, y0: oy + by0 * sy, y1: oy + by1 * sy };
  // Affine map taking the box onto the rect, applied to the unit square = corner pin.
  const kx = (rect.x1 - rect.x0) / (box.x1 - box.x0), ky = (rect.y1 - rect.y0) / (box.y1 - box.y0);
  const map = ([x, y]: P): P => [rect.x0 + (x - box.x0) * kx, rect.y0 + (y - box.y0) * ky];
  const cornerPin = ([[0, 0], [1, 0], [1, 1], [0, 1]] as P[]).map(map);
  const ellipse = {
    cx: (box.x0 + box.x1) / 2,
    cy: (box.y0 + box.y1) / 2,
    rx: ((box.x1 - box.x0) / 2) * 1.12,
    ry: ((box.y1 - box.y0) / 2) * 1.08,
  };
  return { cornerPin, ellipse, flipH, flipV, coded: us.length, axisFit, rect };
}
