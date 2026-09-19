export type Pt = [number, number];

/**
 * Solve the 3x3 homography mapping the unit square (0,0),(1,0),(1,1),(0,1) to the four
 * given points. Uses the standard adjugate construction, so straight lines stay straight.
 */
export function homographyFromUnitSquare(dst: Pt[]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = dst;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  return [a, b, c, d, e, f, g, h, 1];
}

/**
 * CSS `matrix3d()` string that applies homography H (row-major 3x3, in pixel space with
 * transform-origin 0 0) to an element of size w x h whose corners should land on `dstPx`.
 */
export function cssCornerPin(dstPx: Pt[], w: number, h: number): string {
  // Map the unit square to the destination, then pre-scale the element into the unit square.
  const H = homographyFromUnitSquare(dstPx);
  const [a, b, c, d, e, f, g, hh, i] = H;
  // Column-major 4x4 for matrix3d: x' = a*x/w + b*y/h + c, etc.
  const m = [
    a / w, d / w, 0, g / w,
    b / h, e / h, 0, hh / h,
    0, 0, 1, 0,
    c, f, 0, i,
  ];
  return `matrix3d(${m.map((v) => (Number.isFinite(v) ? v.toFixed(6) : 0)).join(',')})`;
}

export const isIdentityPin = (pts: Pt[]): boolean =>
  pts.length === 4 &&
  Math.abs(pts[0][0]) < 1e-6 && Math.abs(pts[0][1]) < 1e-6 &&
  Math.abs(pts[1][0] - 1) < 1e-6 && Math.abs(pts[1][1]) < 1e-6 &&
  Math.abs(pts[2][0] - 1) < 1e-6 && Math.abs(pts[2][1] - 1) < 1e-6 &&
  Math.abs(pts[3][0]) < 1e-6 && Math.abs(pts[3][1] - 1) < 1e-6;
