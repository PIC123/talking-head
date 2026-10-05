export type P = [number, number];
/** Row-major 3x3. */
export type Mat3 = number[];

/** Solve a small dense linear system A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Normalising transform (translate to centroid, scale to mean distance sqrt(2)) for numerical stability. */
function normaliser(pts: P[]): Mat3 {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n || 1;
  const s = Math.SQRT2 / d;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

export function apply(H: Mat3, p: P): P {
  const x = H[0] * p[0] + H[1] * p[1] + H[2];
  const y = H[3] * p[0] + H[4] * p[1] + H[5];
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [x / w, y / w];
}

export function mul(A: Mat3, B: Mat3): Mat3 {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function invert(H: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
  return [A, D, G, B, E, Hh, C, F, I].map((v) => v / det);
}

/**
 * Least-squares homography mapping src[i] -> dst[i] (direct linear transform, h33 = 1), n >= 4.
 * Returns null when the points are degenerate.
 */
export function fitHomography(src: P[], dst: P[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const Ts = normaliser(src), Td = normaliser(dst);
  const s = src.map((p) => apply(Ts, p)), d = dst.map((p) => apply(Td, p));
  // Normal equations for the 8 unknowns.
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < s.length; k++) {
    const [x, y] = s[k], [u, v] = d[k];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn: Mat3 = [...h, 1];
  const Tdi = invert(Td);
  if (!Tdi) return null;
  return mul(Tdi, mul(Hn, Ts));
}

/** Fit with outlier rejection: drop the worst point while its error exceeds `tol` and enough points remain. */
export function fitHomographyRobust(src: P[], dst: P[], tol: number, minPoints = 5): { H: Mat3; used: number; rms: number } | null {
  let S = [...src], D = [...dst];
  while (S.length >= Math.max(4, minPoints)) {
    const H = fitHomography(S, D);
    if (!H) return null;
    const errs = S.map((p, i) => Math.hypot(...(apply(H, p).map((v, k) => v - D[i][k]) as [number, number])));
    const worst = errs.indexOf(Math.max(...errs));
    const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
    if (errs[worst] <= tol || S.length === Math.max(4, minPoints)) return { H, used: S.length, rms };
    S.splice(worst, 1);
    D.splice(worst, 1);
  }
  return null;
}
