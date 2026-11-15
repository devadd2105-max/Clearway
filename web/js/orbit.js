// Clearway — orbital mechanics core.
// Pure functions, no DOM. Units: km, s, rad, timestamps in ms (UTC epoch).
// Frames: ECEF (WGS-84) and a TEME-compatible pseudo-inertial frame obtained by
// rotating ECEF by GMST (IAU-82), the same convention SGP4 output uses.

export const MU = 398600.4418;         // km^3/s^2
export const RE = 6378.137;            // km, WGS-84 equatorial radius
export const J2 = 1.08262668e-3;
export const OMEGA_E = 7.2921159e-5;   // rad/s
export const DEG = Math.PI / 180;
export const TAU = 2 * Math.PI;
const WGS_F = 1 / 298.257223563;
const WGS_E2 = WGS_F * (2 - WGS_F);
const SIDEREAL_YEAR_RATE = TAU / (365.2421897 * 86400); // rad/s, required SSO nodal rate

// ---------- small vector helpers ----------
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

export function wrapPi(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
export function wrap2Pi(a) { a %= TAU; return a < 0 ? a + TAU : a; }

// ---------- time ----------
export const toJd = (tMs) => tMs / 86400000 + 2440587.5;

/** Greenwich Mean Sidereal Time (rad), IAU-82, identical to SGP4's gstime. */
export function gmst(tMs) {
  const t = (toJd(tMs) - 2451545.0) / 36525;
  let s = -6.2e-6 * t * t * t + 0.093104 * t * t + (876600 * 3600 + 8640184.812866) * t + 67310.54841;
  s = ((s * DEG) / 240) % TAU;
  return s < 0 ? s + TAU : s;
}

/** Right ascension of the mean sun (rad) — used for sun-synchronous local time of node. */
export function meanSunRa(tMs) {
  const utHours = ((tMs / 3600000) % 24 + 24) % 24;
  return wrap2Pi(gmst(tMs) - Math.PI - utHours * 15 * DEG);
}

// ---------- frames ----------
export function geodeticToEcef(lat, lon, altKm = 0) {
  const s = Math.sin(lat), c = Math.cos(lat);
  const N = RE / Math.sqrt(1 - WGS_E2 * s * s);
  return [(N + altKm) * c * Math.cos(lon), (N + altKm) * c * Math.sin(lon), (N * (1 - WGS_E2) + altKm) * s];
}

export function ecefToGeodetic(r) {
  const [x, y, z] = r;
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS_E2));
  let alt = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat);
    const N = RE / Math.sqrt(1 - WGS_E2 * s * s);
    alt = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - WGS_E2 * N / (N + alt)));
  }
  return { lat, lon, alt };
}

export function rotZ(r, th) {
  const c = Math.cos(th), s = Math.sin(th);
  return [r[0] * c - r[1] * s, r[0] * s + r[1] * c, r[2]];
}
export const ecefToEci = (r, theta) => rotZ(r, theta);
export const eciToEcef = (r, theta) => rotZ(r, -theta);
export const eciToGeodetic = (r, tMs) => ecefToGeodetic(eciToEcef(r, gmst(tMs)));

export function siteEci(site, tMs) {
  return ecefToEci(geodeticToEcef(site.lat * DEG, site.lon * DEG, (site.altM || 0) / 1000), gmst(tMs));
}

// ---------- orbit basics ----------
export const circularSpeed = (r) => Math.sqrt(MU / r);
export const periodSec = (a) => TAU * Math.sqrt(a * a * a / MU);
export const meanMotion = (a) => Math.sqrt(MU / (a * a * a));

/** Semi-major axis (km) from mean motion in rev/day. */
export const smaFromRevPerDay = (revDay) => Math.cbrt(MU / Math.pow(revDay * TAU / 86400, 2));

/** J2 secular nodal regression (rad/s). */
export function nodalRate(a, inc, e = 0) {
  const p = a * (1 - e * e);
  return -1.5 * meanMotion(a) * J2 * (RE / p) ** 2 * Math.cos(inc);
}

/** J2 secular rate of argument of latitude for a near-circular orbit (rad/s). */
export function argLatRate(a, inc) {
  const c2 = Math.cos(inc) ** 2;
  return meanMotion(a) * (1 + 0.75 * J2 * (RE / a) ** 2 * (8 * c2 - 2));
}

/** Inclination (rad) that makes a circular orbit at altitude h sun-synchronous, or null. */
export function ssoInclination(hKm) {
  const a = RE + hKm;
  const cosi = -SIDEREAL_YEAR_RATE / (1.5 * meanMotion(a) * J2 * (RE / a) ** 2);
  return Math.abs(cosi) <= 1 ? Math.acos(cosi) : null;
}

/** Geocentric latitude from geodetic latitude (rad). */
export const geocentricLat = (lat) => Math.atan((1 - WGS_E2) * Math.tan(lat));

/**
 * Inertial launch azimuth (rad, from north, clockwise) to reach inclination `inc`
 * from latitude `lat`. pass = 'asc' (northbound) or 'desc' (southbound). Null if unreachable.
 */
export function inertialAzimuth(lat, inc, pass) {
  const s = Math.cos(inc) / Math.cos(lat);
  if (Math.abs(s) > 1) return null;
  const b = Math.asin(s);
  return wrap2Pi(pass === 'asc' ? b : Math.PI - b);
}

/** Azimuth relative to the rotating Earth (what the range sees), rad. */
export function rotatingAzimuth(azI, lat, vOrb) {
  const vx = vOrb * Math.sin(azI) - OMEGA_E * RE * Math.cos(lat);
  const vy = vOrb * Math.cos(azI);
  return wrap2Pi(Math.atan2(vx, vy));
}

/** Eastward velocity the launch site contributes along the flight azimuth (km/s). */
export const rotationAssist = (lat, azI) => OMEGA_E * RE * Math.cos(lat) * Math.sin(azI);

/** Is azimuth (deg) inside a range corridor [min,max] (deg), handling wrap through north? */
export function inCorridor(azDeg, corridor) {
  if (!corridor) return true;
  const a = ((azDeg % 360) + 360) % 360;
  const { min, max } = corridor;
  return min <= max ? a >= min && a <= max : a >= min || a <= max;
}

/** Plane angle between two orbits of equal inclination separated by dRaan (rad). */
export function planeAngle(inc, dRaan) {
  const c = Math.cos(inc) ** 2 + Math.sin(inc) ** 2 * Math.cos(dRaan);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Delta-v (km/s) of a single-impulse plane change of angle theta at speed v. */
export const planeChangeDv = (v, theta) => 2 * v * Math.sin(theta / 2);

/** Launch-delay half width (s) at which the plane error reaches tolRad. */
export function halfWidthForTolerance(inc, tolRad) {
  const s2 = Math.sin(inc) ** 2;
  if (s2 < 1e-9) return 3600;
  const c = (Math.cos(tolRad) - Math.cos(inc) ** 2) / s2;
  const dRaan = Math.acos(Math.max(-1, Math.min(1, c)));
  return dRaan / OMEGA_E;
}

/**
 * Find launch instants when the site lies in a target plane.
 * raanAt(tMs) -> RAAN (rad) of the target plane at that time.
 * Returns [{t, pass}] sorted by time.
 */
export function findPlanarTimes(site, inc, raanAt, tStart, tEnd, passes = ['asc', 'desc']) {
  const latc = geocentricLat(site.lat * DEG);
  const sinu = Math.sin(latc) / Math.sin(inc);
  if (Math.abs(sinu) > 1) return [];
  const out = [];
  for (const pass of passes) {
    const u = pass === 'asc' ? Math.asin(sinu) : Math.PI - Math.asin(sinu);
    const dAlpha = Math.atan2(Math.cos(inc) * Math.sin(u), Math.cos(u));
    const f = (t) => {
      const r = siteEci(site, t);
      return wrapPi(Math.atan2(r[1], r[0]) - raanAt(t) - dAlpha);
    };
    const step = 120000;
    let tPrev = tStart, fPrev = f(tStart);
    for (let t = tStart + step; t <= tEnd + step; t += step) {
      const fv = f(t);
      if (fPrev < 0 && fv >= 0 && fv - fPrev < Math.PI) {
        let lo = tPrev, hi = t;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          if (f(mid) < 0) lo = mid; else hi = mid;
        }
        const tp = (lo + hi) / 2;
        if (tp >= tStart && tp <= tEnd) out.push({ t: Math.round(tp), pass });
      }
      tPrev = t; fPrev = fv;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Simplified vehicle trajectory: a gravity-turn-like ascent in a fixed inertial plane
 * from the pad to direct insertion at the target altitude, then a circular orbit with
 * J2 secular drift. Planning-grade, not a flight trajectory.
 */
export function buildTrajectory({ site, t0, azInertial, hTargetKm, tInsSec, downrangeKm }) {
  const r0 = siteEci(site, t0);
  const R0 = norm(r0);
  const rhat = unit(r0);
  const east = unit(cross([0, 0, 1], rhat));
  const north = cross(rhat, east);
  const ca = Math.cos(azInertial), sa = Math.sin(azInertial);
  const d = [north[0] * ca + east[0] * sa, north[1] * ca + east[1] * sa, north[2] * ca + east[2] * sa];
  const rT = RE + hTargetKm;
  const thIns = downrangeKm / R0;

  const h = unit(cross(rhat, d));
  const inc = Math.acos(Math.max(-1, Math.min(1, h[2])));
  let node = cross([0, 0, 1], h);
  node = norm(node) < 1e-9 ? [1, 0, 0] : unit(node);
  const raan0 = Math.atan2(node[1], node[0]);
  const pIns = [rhat[0] * Math.cos(thIns) + d[0] * Math.sin(thIns), rhat[1] * Math.cos(thIns) + d[1] * Math.sin(thIns), rhat[2] * Math.cos(thIns) + d[2] * Math.sin(thIns)];
  const hn = cross(h, node);
  const u0 = Math.atan2(dot(pIns, hn), dot(pIns, node));
  const raanDot = nodalRate(rT, inc);
  const uDot = argLatRate(rT, inc);
  const ci = Math.cos(inc), si = Math.sin(inc);

  function at(tau, out = [0, 0, 0]) {
    if (tau < tInsSec) {
      const s = Math.max(0, tau / tInsSec);
      const g = Math.pow(Math.sin((Math.PI * s) / 2), 1.6);
      const rad = R0 + (rT - R0) * g;
      const th = thIns * Math.pow(s, 1.7);
      const c = Math.cos(th) * rad, sn = Math.sin(th) * rad;
      out[0] = rhat[0] * c + d[0] * sn; out[1] = rhat[1] * c + d[1] * sn; out[2] = rhat[2] * c + d[2] * sn;
      return out;
    }
    const dt = tau - tInsSec;
    const W = raan0 + raanDot * dt, u = u0 + uDot * dt;
    const cW = Math.cos(W), sW = Math.sin(W), cu = Math.cos(u), su = Math.sin(u);
    out[0] = rT * (cW * cu - sW * su * ci);
    out[1] = rT * (sW * cu + cW * su * ci);
    out[2] = rT * (su * si);
    return out;
  }
  const siteAltKm = (site.altM || 0) / 1000;
  const altitudeAt = (tau) => (tau >= tInsSec ? hTargetKm : siteAltKm + (hTargetKm - siteAltKm) * Math.pow(Math.sin((Math.PI * Math.max(0, tau / tInsSec)) / 2), 1.6));
  return { t0, tInsSec, inc, raan0, u0, rT, hTargetKm, period: periodSec(rT), at, altitudeAt };
}

/** Ground track (deg) of a trajectory between tau0 and tau1 (s). */
export function groundTrack(traj, tau0, tau1, stepSec = 10) {
  const pts = [];
  for (let tau = tau0; tau <= tau1 + 1e-6; tau += stepSec) {
    const g = eciToGeodetic(traj.at(tau), traj.t0 + tau * 1000);
    pts.push([g.lon / DEG, g.lat / DEG, g.alt]);
  }
  return pts;
}

/** Destination point (deg) along a great circle from (lat,lon) deg with bearing deg and distance km. */
export function destination(latDeg, lonDeg, bearingDeg, distKm) {
  const d = distKm / 6371.0088, b = bearingDeg * DEG, la = latDeg * DEG, lo = lonDeg * DEG;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [((lo2 / DEG + 540) % 360) - 180, la2 / DEG];
}

export function bearing(lat1, lon1, lat2, lon2) {
  const a = lat1 * DEG, b = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  return (Math.atan2(Math.sin(dl) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(dl)) / DEG + 360) % 360;
}

export function surfaceDistanceKm(lat1, lon1, lat2, lon2) {
  const a = lat1 * DEG, b = lat2 * DEG, dl = (lon2 - lon1) * DEG, dp = b - a;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a) * Math.cos(b) * Math.sin(dl / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
