import { type P, type Mat3, apply, fitHomographyRobust, invert, fitHomography } from './math';
import { findDot, regionGrow, type Region } from './detect';
import { CameraFeed, sleep } from './camera';

/** What the projector should show right now. Coordinates are normalised output space. */
export type CalFrame = { kind: 'black' } | { kind: 'white' } | { kind: 'dot'; u: number; v: number };

export interface SweepResult {
  /** projector (normalised) -> camera (pixels, work resolution) */
  H: Mat3;
  dotsSeen: number;
  dotsTotal: number;
  rms: number;
  /** True once H comes from dots that all landed on the mask itself. */
  refined: boolean;
  /** The flat-white camera frame, for the mask tap. */
  lit: ImageData;
}

export interface Placement {
  cornerPin: P[];
  ellipse: { cx: number; cy: number; rx: number; ry: number };
}

/**
 * The face contour's bounding box in canvas-normalised coordinates (the optional contour ellipse
 * is 340x420 about (0,20) on the 1024 canvas). Mapping this box onto the mask's bounding box puts
 * eyes and mouth where a real face has them.
 */
export const FACE_BOX = { x0: (512 - 340) / 1024, y0: (512 + 20 - 420) / 1024, x1: (512 + 340) / 1024, y1: (512 + 20 + 420) / 1024 };

/** Coarse pass: a 4x4 grid over most of the projector frame. */
const GRID: P[] = [];
for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) GRID.push([0.15 + (0.7 * i) / 3, 0.15 + (0.7 * j) / 3]);

/** Flash each point in turn and return the (projector, camera) pairs that were seen. */
async function flashDots(cam: CameraFeed, show: (f: CalFrame) => void, status: (s: string) => void, pts: P[], label: string, settleMs: number): Promise<{ src: P[]; dst: P[] }> {
  show({ kind: 'black' });
  await sleep(settleMs * 2);
  let ref = cam.grab();
  const src: P[] = [], dst: P[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i % 4 === 0 && i > 0) {
      // Fresh dark reference every few dots so the phone's auto-exposure drift does not count as a dot.
      show({ kind: 'black' });
      await sleep(settleMs);
      ref = cam.grab();
    }
    const [u, v] = pts[i];
    show({ kind: 'dot', u, v });
    await sleep(settleMs);
    cam.grab(); // discard one frame to ride out pipeline latency
    await sleep(40);
    const hit = findDot(ref, cam.grab());
    status(`${label} dot ${i + 1}/${pts.length}: ${hit ? 'seen' : 'not seen'}`);
    if (hit) {
      src.push([u, v]);
      dst.push(hit.p);
    }
  }
  return { src, dst };
}

/**
 * Coarse sweep over the whole frame (dots land on the mask and whatever is around it), fit the
 * projector-to-camera homography, then capture a flat-white frame for the mask tap.
 */
export async function runSweep(cam: CameraFeed, show: (f: CalFrame) => void, status: (s: string) => void, settleMs = 320): Promise<SweepResult> {
  const { src, dst } = await flashDots(cam, show, status, GRID, 'coarse', settleMs);
  show({ kind: 'white' });
  await sleep(settleMs * 2);
  const lit = cam.grab();
  if (src.length < 5) throw new Error(`only ${src.length} of ${GRID.length} dots seen. Point the camera at the mask from near the projector, dim the room, and try again.`);
  const fit = fitHomographyRobust(src, dst, Math.max(3, cam.width * 0.03), 5);
  if (!fit) throw new Error('could not fit the projector-to-camera mapping');
  return { H: fit.H, dotsSeen: fit.used, dotsTotal: GRID.length, rms: fit.rms, refined: false, lit };
}

/** The mask region in the lit frame, grown from a tap. */
export function findMask(sweep: SweepResult, tap: P, tol: number): Region {
  const region = regionGrow(sweep.lit, tap, tol);
  if (!region) throw new Error('nothing found at the tap. Tap the middle of the mask in the picture.');
  return region;
}

/** Mask bounding box in camera pixels, slightly padded, as a quad (TL, TR, BR, BL). */
function maskQuadCam(region: Region, pad = 0.02): P[] {
  const b = region.bbox;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  return [
    [b.x0 - pad * w, b.y0 - pad * h],
    [b.x1 + pad * w, b.y0 - pad * h],
    [b.x1 + pad * w, b.y1 + pad * h],
    [b.x0 - pad * w, b.y1 + pad * h],
  ];
}

/**
 * Refined sweep: using the coarse mapping to aim, flash a grid of dots that all fall inside the mask
 * region, and refit from those alone. The mask sits in front of whatever the coarse dots hit, so
 * only dots on the mask describe its plane. Falls back to the coarse mapping if too few are seen.
 */
export async function refineSweep(cam: CameraFeed, show: (f: CalFrame) => void, status: (s: string) => void, sweep: SweepResult, region: Region, settleMs = 320): Promise<SweepResult> {
  const Hinv = invert(sweep.H);
  if (!Hinv) throw new Error('mapping not invertible');
  // The mask box in projector space (coarse estimate), shrunk a little so dots stay on the mask.
  const q = maskQuadCam(region, -0.1).map((p) => apply(Hinv, p));
  const pts: P[] = [];
  const N = 4;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const s = i / (N - 1), t = j / (N - 1);
    // Bilinear point inside the quad.
    const top: P = [q[0][0] + (q[1][0] - q[0][0]) * s, q[0][1] + (q[1][1] - q[0][1]) * s];
    const bot: P = [q[3][0] + (q[2][0] - q[3][0]) * s, q[3][1] + (q[2][1] - q[3][1]) * s];
    const x = top[0] + (bot[0] - top[0]) * t, y = top[1] + (bot[1] - top[1]) * t;
    if (x > 0.01 && x < 0.99 && y > 0.01 && y < 0.99) pts.push([x, y]);
  }
  if (pts.length < 5) throw new Error('the mask maps outside the projector frame; re-aim the projector or the camera and retry');
  const { src, dst } = await flashDots(cam, show, status, pts, 'mask', settleMs);
  if (src.length < 5) {
    status(`only ${src.length} dots seen on the mask; using the coarse mapping`);
    return sweep;
  }
  const fit = fitHomographyRobust(src, dst, Math.max(3, cam.width * 0.02), 5);
  if (!fit) return sweep;
  return { ...sweep, H: fit.H, dotsSeen: fit.used, dotsTotal: pts.length, rms: fit.rms, refined: true };
}

/**
 * Given the camera-space mask region and the sweep's homography, compute the corner pin that puts
 * the face box onto the mask, and an ellipse that trims spill to roughly the mask.
 */
export function placeFace(sweep: SweepResult, region: Region, W: number, H: number): Placement {
  const Hinv = invert(sweep.H);
  if (!Hinv) throw new Error('mapping not invertible');
  const maskQuad = maskQuadCam(region).map((p) => apply(Hinv, p));
  // The face canvas is drawn centred, filling the shorter screen side. Its FACE_BOX in
  // output-normalised coordinates:
  const S = Math.min(W, H);
  const ox = (W - S) / 2 / W, oy = (H - S) / 2 / H, sx = S / W, sy = S / H;
  const box: P[] = [
    [ox + FACE_BOX.x0 * sx, oy + FACE_BOX.y0 * sy],
    [ox + FACE_BOX.x1 * sx, oy + FACE_BOX.y0 * sy],
    [ox + FACE_BOX.x1 * sx, oy + FACE_BOX.y1 * sy],
    [ox + FACE_BOX.x0 * sx, oy + FACE_BOX.y1 * sy],
  ];
  // M maps output-normalised -> projector-normalised such that the face box lands on the mask quad.
  const M = fitHomography(box, maskQuad);
  if (!M) throw new Error('degenerate mask region');
  const cornerPin = ([[0, 0], [1, 0], [1, 1], [0, 1]] as P[]).map((p) => apply(M, p));
  const ellipse = {
    cx: (box[0][0] + box[2][0]) / 2,
    cy: (box[0][1] + box[2][1]) / 2,
    rx: ((box[2][0] - box[0][0]) / 2) * 1.12,
    ry: ((box[2][1] - box[0][1]) / 2) * 1.08,
  };
  return { cornerPin, ellipse };
}

/**
 * Why a corner pin would show nothing: a corner thrown behind the projection plane (w <= 0, the
 * CSS transform then culls it) or a quad far outside the frame. Returns a message or null.
 */
export function pinProblem(cornerPin: P[]): string | null {
  const M = fitHomography([[0, 0], [1, 0], [1, 1], [0, 1]], cornerPin);
  if (!M) return 'mapping is degenerate';
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]] as P[]) {
    if (M[6] * x + M[7] * y + M[8] <= 0) return 'mapping folds over itself (a corner lands behind the screen)';
  }
  if (cornerPin.some(([x, y]) => Math.abs(x - 0.5) > 6 || Math.abs(y - 0.5) > 6)) return 'mapping is far outside the frame';
  const area = Math.abs(cornerPin.reduce((a, [x, y], i) => { const [nx, ny] = cornerPin[(i + 1) % 4]; return a + x * ny - nx * y; }, 0)) / 2;
  if (area < 0.002) return 'mapping collapses the face to almost nothing';
  return null;
}
