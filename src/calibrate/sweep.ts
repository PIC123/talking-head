import { type P, type Mat3, apply, fitHomographyRobust, invert, fitHomography } from './math';
import { findDot, regionGrow } from './detect';
import { CameraFeed, sleep } from './camera';

/** What the projector should show right now. Coordinates are normalised output space. */
export type CalFrame = { kind: 'black' } | { kind: 'white' } | { kind: 'dot'; u: number; v: number };

export interface SweepResult {
  /** projector (normalised) -> camera (pixels, work resolution) */
  H: Mat3;
  dotsSeen: number;
  dotsTotal: number;
  rms: number;
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

const GRID: P[] = [];
for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) GRID.push([0.15 + (0.7 * i) / 3, 0.15 + (0.7 * j) / 3]);

/**
 * Flash dots one at a time, find each in the camera, fit the projector-to-camera homography,
 * then capture a flat-white frame for the mask tap.
 */
export async function runSweep(cam: CameraFeed, show: (f: CalFrame) => void, status: (s: string) => void, settleMs = 320): Promise<SweepResult> {
  show({ kind: 'black' });
  await sleep(settleMs * 2);
  let ref = cam.grab();
  const src: P[] = [], dst: P[] = [];
  for (let i = 0; i < GRID.length; i++) {
    if (i % 4 === 0 && i > 0) {
      show({ kind: 'black' });
      await sleep(settleMs);
      ref = cam.grab();
    }
    const [u, v] = GRID[i];
    show({ kind: 'dot', u, v });
    await sleep(settleMs);
    cam.grab(); // discard one frame to ride out pipeline latency
    await sleep(40);
    const hit = findDot(ref, cam.grab());
    status(`dot ${i + 1}/${GRID.length}: ${hit ? 'seen' : 'not seen'}`);
    if (hit) {
      src.push([u, v]);
      dst.push(hit.p);
    }
  }
  show({ kind: 'white' });
  await sleep(settleMs * 2);
  const lit = cam.grab();
  if (src.length < 5) throw new Error(`only ${src.length} of ${GRID.length} dots seen. Point the camera at the mask from near the projector, dim the room, and try again.`);
  const fit = fitHomographyRobust(src, dst, Math.max(3, cam.width * 0.02), 5);
  if (!fit) throw new Error('could not fit the projector-to-camera mapping');
  return { H: fit.H, dotsSeen: fit.used, dotsTotal: GRID.length, rms: fit.rms, lit };
}

/**
 * Given the camera-space mask region (from a tap) and the sweep's homography, compute the corner pin
 * that puts the face box onto the mask, and an ellipse that trims spill to roughly the mask.
 */
export function placeFace(sweep: SweepResult, tap: P, tol: number, W: number, H: number): { placement: Placement; region: ReturnType<typeof regionGrow> } {
  const region = regionGrow(sweep.lit, tap, tol);
  if (!region) throw new Error('nothing found at the tap. Tap the middle of the mask in the picture.');
  const Hinv = invert(sweep.H);
  if (!Hinv) throw new Error('mapping not invertible');
  const b = region.bbox;
  const pad = 0.02;
  // Mask corners in camera pixels -> projector-normalised.
  const camCorners: P[] = [
    [b.x0 - pad * (b.x1 - b.x0), b.y0 - pad * (b.y1 - b.y0)],
    [b.x1 + pad * (b.x1 - b.x0), b.y0 - pad * (b.y1 - b.y0)],
    [b.x1 + pad * (b.x1 - b.x0), b.y1 + pad * (b.y1 - b.y0)],
    [b.x0 - pad * (b.x1 - b.x0), b.y1 + pad * (b.y1 - b.y0)],
  ];
  const maskQuad = camCorners.map((p) => apply(Hinv, p));
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
  return { placement: { cornerPin, ellipse }, region };
}
