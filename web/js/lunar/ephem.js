// Clearway Lunar — analytic ephemeris and lunar orientation.
//
// Sun:  Meeus, Astronomical Algorithms ch. 25 (≈0.01°), with annual aberration.
// Moon: Meeus ch. 47, the truncated ELP-2000/82 lunar theory (≈10" in longitude).
// Moon orientation: IAU WGCCRE 2009 model (Archinal et al. 2011), which approximates the
//       Mean Earth / polar axis frame used by LOLA maps and JPL Horizons lunar sites.
// Positions are geometric, in km, in the J2000 equatorial frame unless noted.
// Validated against JPL Horizons (DE441) in tests/lunar.test.mjs.

export const DEG = Math.PI / 180;
export const R_MOON = 1737.4;          // km, IAU mean radius (also LOLA reference sphere)
export const R_EARTH = 6378.137;       // km
export const R_SUN = 695700;           // km
export const AU = 149597870.7;         // km
export const SOLAR_CONSTANT = 1361;    // W/m² at 1 AU

const TT_MINUS_UTC = 37 + 32.184;      // s (leap seconds since 2017-01-01 + 32.184 s)
const sin = Math.sin, cos = Math.cos;
const wrap360 = (a) => ((a % 360) + 360) % 360;

/** Julian centuries (TT ≈ TDB) since J2000.0 for a UTC timestamp in ms. */
export function centuriesTT(tMs) {
  const jdTT = (tMs + TT_MINUS_UTC * 1000) / 86400000 + 2440587.5;
  return (jdTT - 2451545.0) / 36525;
}

// ---------------------------------------------------------------- rotations
export const rotX = (v, a) => { const c = cos(a), s = sin(a); return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]; };
export const rotZ = (v, a) => { const c = cos(a), s = sin(a); return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]]; };
export const rotY = (v, a) => { const c = cos(a), s = sin(a); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]; };
export const norm = (v) => Math.hypot(v[0], v[1], v[2]);
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Mean obliquity of the ecliptic of date (rad). */
export function obliquity(T) {
  return (23.439291111 - (46.815 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600) * DEG;
}

/** Mean ecliptic & equinox of date (λ, β, r) → mean equator of date, Cartesian. */
export function eclipticToEquatorial(lam, beta, r, T) {
  const v = [r * cos(beta) * cos(lam), r * cos(beta) * sin(lam), r * sin(beta)];
  return rotX(v, obliquity(T));
}

/** IAU 1976 precession: mean equator of date → J2000. */
export function precessToJ2000(v, T) {
  const as = DEG / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * as;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * as;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * as;
  // P(J2000→date) = R3(−z)·R2(θ)·R3(−ζ) with passive rotations; rotZ/rotY here are active,
  // so the inverse applies active rotZ(−z), then rotY(θ), then rotZ(−ζ).
  return rotZ(rotY(rotZ(v, -z), theta), -zeta);
}

// ---------------------------------------------------------------- Sun
/** Geocentric Sun, mean ecliptic of date: {lam, beta, r(km)}; apparent (aberration) longitude. */
export function sunEcliptic(T) {
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
  const nu = M + C * DEG;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * cos(nu));
  const lam = wrap360(L0 + C - 0.005691611 / R) * DEG; // − aberration (20.4898"/R)
  return { lam, beta: 0, r: R * AU };
}

// ---------------------------------------------------------------- Moon (Meeus 47)
// [D, M, M', F, Σl (1e-6 deg), Σr (1e-3 km)]
const LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149], [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210], [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056], [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0], [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897], [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0], [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0], [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165], [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];
// [D, M, M', F, Σb (1e-6 deg)]
const B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324], [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475], [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777], [4, 0, -2, 1, 671], [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491],
  [2, 0, -2, 1, -451], [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302], [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223], [0, 1, -2, -1, -220], [2, 1, -1, -1, -220],
  [1, 0, 1, 1, -185], [2, -1, -2, -1, 181], [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166],
  [1, 0, 1, -1, -164], [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
];

/** Geocentric Moon, mean ecliptic & equinox of date: {lam, beta (rad), r (km)}. */
export function moonEcliptic(T) {
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000) * DEG;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000) * DEG;
  const F = (93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000) * DEG;
  const A1 = (119.75 + 131.849 * T) * DEG, A2 = (53.09 + 479264.29 * T) * DEG, A3 = (313.45 + 481266.484 * T) * DEG;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const Lr = Lp * DEG;
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LR) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sl += l * e * sin(arg);
    sr += r * e * cos(arg);
  }
  for (const [d, m, mp, f, b] of B) {
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sb += b * e * sin(d * D + m * M + mp * Mp + f * F);
  }
  sl += 3958 * sin(A1) + 1962 * sin(Lr - F) + 318 * sin(A2);
  sb += -2235 * sin(Lr) + 382 * sin(A3) + 175 * sin(A1 - F) + 175 * sin(A1 + F) + 127 * sin(Lr - Mp) - 115 * sin(Lr + Mp);
  return { lam: wrap360(Lp + sl / 1e6) * DEG, beta: (sb / 1e6) * DEG, r: 385000.56 + sr / 1000 };
}

/** Geocentric J2000 equatorial vectors (km) of Sun and Moon. */
export function geocentric(tMs) {
  const T = centuriesTT(tMs);
  const s = sunEcliptic(T), m = moonEcliptic(T);
  return {
    T,
    sun: precessToJ2000(eclipticToEquatorial(s.lam, s.beta, s.r, T), T),
    moon: precessToJ2000(eclipticToEquatorial(m.lam, m.beta, m.r, T), T),
    moonOfDate: eclipticToEquatorial(m.lam, m.beta, m.r, T),
  };
}

// ---------------------------------------------------------------- Moon orientation (IAU 2009)
/** Pole RA/Dec and prime-meridian angle W (rad) of the Moon. */
export function moonOrientation(T) {
  const d = T * 36525;
  const E = [
    125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.064993 * d, 276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d, 25.053 + 12.9590088 * d,
  ].map((x) => x * DEG);
  const [E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11, E12, E13] = E;
  const ra = 269.9949 + 0.0031 * T - 3.8787 * sin(E1) - 0.1204 * sin(E2) + 0.07 * sin(E3) - 0.0172 * sin(E4) + 0.0072 * sin(E6) - 0.0052 * sin(E10) + 0.0043 * sin(E13);
  const dec = 66.5392 + 0.013 * T + 1.5419 * cos(E1) + 0.0239 * cos(E2) - 0.0278 * cos(E3) + 0.0068 * cos(E4) - 0.0029 * cos(E6) + 0.0009 * cos(E7) + 0.0008 * cos(E10) - 0.0009 * cos(E13);
  const W = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.561 * sin(E1) + 0.1208 * sin(E2) - 0.0642 * sin(E3) + 0.0158 * sin(E4) + 0.0252 * sin(E5)
    - 0.0066 * sin(E6) - 0.0047 * sin(E7) - 0.0046 * sin(E8) + 0.0028 * sin(E9) + 0.0052 * sin(E10) + 0.004 * sin(E11) + 0.0019 * sin(E12) - 0.0044 * sin(E13);
  return { ra: ra * DEG, dec: dec * DEG, W: wrap360(W) * DEG };
}

/** J2000 inertial vector → Moon body-fixed (≈ Mean Earth / polar axis). */
export function toMoonFixed(v, o) {
  return rotZ(rotX(rotZ(v, -(Math.PI / 2 + o.ra)), -(Math.PI / 2 - o.dec)), -o.W);
}

/** Inverse of toMoonFixed. */
export function fromMoonFixed(v, o) {
  return rotZ(rotX(rotZ(v, o.W), Math.PI / 2 - o.dec), Math.PI / 2 + o.ra);
}

/** Sun and Earth positions relative to the Moon's centre, in the Moon-fixed frame (km). */
export function moonCentredBodies(tMs) {
  const g = geocentric(tMs);
  const o = moonOrientation(g.T);
  return {
    t: tMs, T: g.T, orient: o,
    sun: toMoonFixed(sub(g.sun, g.moon), o),
    earth: toMoonFixed([-g.moon[0], -g.moon[1], -g.moon[2]], o),
    moonGeoOfDate: g.moonOfDate, moonGeo: g.moon,
  };
}

/** Site position (km) in the Moon-fixed frame from planetocentric lat/lon (deg) and height above the sphere (m). */
export function sitePosition(latDeg, lonDeg, heightM = 0) {
  const la = latDeg * DEG, lo = lonDeg * DEG, r = R_MOON + heightM / 1000;
  return [r * cos(la) * cos(lo), r * cos(la) * sin(lo), r * sin(la)];
}

/** East-north-up basis at a site. */
export function enuBasis(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return {
    e: [-sin(lo), cos(lo), 0],
    n: [-sin(la) * cos(lo), -sin(la) * sin(lo), cos(la)],
    u: [cos(la) * cos(lo), cos(la) * sin(lo), sin(la)],
  };
}

/** Azimuth (deg, from north through east) and elevation (deg) of a Moon-fixed target vector seen from a site. */
export function azEl(target, sitePos, basis) {
  const d = sub(target, sitePos);
  const r = norm(d);
  const az = Math.atan2(dot(d, basis.e), dot(d, basis.n)) / DEG;
  return { az: (az + 360) % 360, el: Math.asin(dot(d, basis.u) / r) / DEG, dist: r };
}

/** Topocentric Sun and Earth for a site at one instant, with apparent angular radii (deg). */
export function skyAt(site, tMs) {
  const b = moonCentredBodies(tMs);
  const p = sitePosition(site.lat, site.lon, site.heightM || 0);
  const basis = enuBasis(site.lat, site.lon);
  const sun = azEl(b.sun, p, basis), earth = azEl(b.earth, p, basis);
  sun.radius = Math.asin(R_SUN / sun.dist) / DEG;
  earth.radius = Math.asin(R_EARTH / earth.dist) / DEG;
  return { t: tMs, sun, earth, bodies: b };
}

/** Sub-solar and sub-Earth points (deg) on the Moon. */
export function subPoints(b) {
  const ll = (v) => { const r = norm(v); return { lat: Math.asin(v[2] / r) / DEG, lon: Math.atan2(v[1], v[0]) / DEG }; };
  return { subSolar: ll(b.sun), subEarth: ll(b.earth) };
}
