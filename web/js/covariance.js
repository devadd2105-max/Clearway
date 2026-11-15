// Clearway — position covariance and probability of collision.
//
// Element sets (TLEs / GP data) are published without covariance, so Clearway uses an
// empirical covariance model in each object's radial / in-track / cross-track (RIC) frame:
// small radial and cross-track errors, a larger in-track error, all growing with element-set
// age and faster at low altitude and during high solar activity (drag uncertainty).
// Typical TLE accuracy: ~0.1-0.2 km radial, ~0.5-1 km in-track at epoch, in-track growth of
// roughly 1-3 km/day in LEO. Operators with owner/operator ephemerides and covariance (CDMs)
// should substitute those.
//
// Pc follows the standard short-encounter method (Foster/Chan): the combined covariance is
// projected onto the encounter plane perpendicular to the relative velocity, and the 2-D
// Gaussian is integrated over the combined hard-body circle.

import { dot, cross, unit } from './orbit.js';

/** Space-weather multiplier on drag-driven in-track error growth. */
export function spaceWeatherFactor(sw) {
  if (!sw) return 1;
  const f = 1 + 0.5 * ((sw.f107 ?? 150) - 150) / 100 + 0.15 * Math.max(0, (sw.kpMax ?? sw.kp ?? 2) - 3);
  return Math.min(4, Math.max(0.6, f));
}

/** Atmospheric-drag sensitivity by altitude (1 at 500 km, larger lower down). */
export const dragFactor = (altKm) => Math.min(6, Math.max(0.3, Math.exp((500 - altKm) / 120)));

/** 1-sigma RIC uncertainties (km) of a catalog object from its element-set age. */
export function objectSigmas(ageDays, altKm, swFactor = 1) {
  const a = Math.max(0, ageDays);
  const g = dragFactor(altKm) * swFactor;
  return {
    r: Math.min(10, 0.12 + 0.12 * a * Math.sqrt(g)),
    i: Math.min(60, 0.6 + 1.5 * a * g),
    c: Math.min(10, 0.15 + 0.10 * a),
  };
}

/** 1-sigma RIC uncertainties (km) of the launch vehicle (dispersion; larger during ascent). */
export function vehicleSigmas(sigmaKm, phase) {
  return phase === 'Ascent'
    ? { r: 2 * sigmaKm, i: 2.5 * sigmaKm, c: 1.5 * sigmaKm }
    : { r: 0.5 * sigmaKm, i: 1.5 * sigmaKm, c: 0.5 * sigmaKm };
}

/** Unit RIC axes from position and velocity. */
export function ricAxes(r, v) {
  const R = unit(r);
  const C = unit(cross(r, v));
  const I = cross(C, R);
  return { R, I, C };
}

/** 3x3 covariance (row-major array of 9) in the inertial frame from RIC sigmas. */
export function covarianceEci(r, v, s) {
  const { R, I, C } = ricAxes(r, v);
  const ax = [R, I, C], sg = [s.r * s.r, s.i * s.i, s.c * s.c];
  const M = new Array(9).fill(0);
  for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[3 * a + b] += sg[k] * ax[k][a] * ax[k][b];
  return M;
}

const quad = (M, x, y) => {
  // x^T M y for 3-vectors
  let s = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += x[a] * M[3 * a + b] * y[b];
  return s;
};

/** Eigen-decomposition of a symmetric 2x2 [[a,b],[b,c]]. Returns {l1,l2,angle} with l1 >= l2. */
export function eig2(a, b, c) {
  const t = (a + c) / 2, d = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  return { l1: t + d, l2: Math.max(0, t - d), angle: 0.5 * Math.atan2(2 * b, a - c) };
}

// 16-point Gauss-Legendre nodes/weights on [-1, 1]
const GL_X = [-0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.7554044083550030, -0.6178762444026438, -0.4580167776572274, -0.2816035507792589, -0.0950125098376374, 0.0950125098376374, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438, 0.7554044083550030, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
const GL_W = [0.0271524594117541, 0.0622535239386479, 0.0951585116824928, 0.1246289712555339, 0.1495959888165767, 0.1691565193950025, 0.1826034150449236, 0.1894506104550685, 0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767, 0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541];

/**
 * Probability of collision for a short encounter.
 * dr = r2 - r1 at TCA (km), dv = v2 - v1 (km/s), C = combined 3x3 covariance (km^2), hbr km.
 * Returns {pc, miss, sx, sy, angle, mx, my} — the encounter-plane picture for plotting.
 */
export function encounterPc(dr, dv, C, hbr) {
  const z = unit(dv);
  const perp = [dr[0] - dot(dr, z) * z[0], dr[1] - dot(dr, z) * z[1], dr[2] - dot(dr, z) * z[2]];
  let x = unit(perp);
  if (!Number.isFinite(x[0]) || Math.hypot(...perp) < 1e-9) x = unit(cross(z, Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const y = cross(z, x);
  const pxx = quad(C, x, x), pxy = quad(C, x, y), pyy = quad(C, y, y);
  const mx = dot(dr, x), my = dot(dr, y);
  const det = pxx * pyy - pxy * pxy;
  const e = eig2(pxx, pxy, pyy);
  const out = { miss: Math.hypot(mx, my), mx, my, sx: Math.sqrt(e.l1), sy: Math.sqrt(e.l2), angle: e.angle, pxx, pxy, pyy };
  if (!(det > 0) || hbr <= 0) { out.pc = 0; return out; }
  const ixx = pyy / det, ixy = -pxy / det, iyy = pxx / det;
  const norm = 1 / (2 * Math.PI * Math.sqrt(det));
  // integrate over the hard-body disc centred at the origin; the Gaussian is centred at (mx,my)
  let sum = 0;
  const NT = 48;
  for (let i = 0; i < 16; i++) {
    const rho = hbr * (GL_X[i] + 1) / 2;
    let ring = 0;
    for (let j = 0; j < NT; j++) {
      const th = (2 * Math.PI * (j + 0.5)) / NT;
      const ux = rho * Math.cos(th) - mx, uy = rho * Math.sin(th) - my;
      ring += Math.exp(-0.5 * (ixx * ux * ux + 2 * ixy * ux * uy + iyy * uy * uy));
    }
    sum += GL_W[i] * rho * ring * (2 * Math.PI / NT);
  }
  out.pc = Math.min(1, norm * sum * hbr / 2);
  return out;
}

/** Rotation matrix (columns R,I,C) as a quaternion [x,y,z,w] — used to orient 3-D ellipsoids. */
export function ricQuaternion(r, v) {
  const { R, I, C } = ricAxes(r, v);
  const m00 = R[0], m01 = I[0], m02 = C[0], m10 = R[1], m11 = I[1], m12 = C[1], m20 = R[2], m21 = I[2], m22 = C[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  return [x, y, z, w];
}

export const addCov = (A, B) => A.map((v, i) => v + B[i]);
