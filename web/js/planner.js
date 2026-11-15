// Clearway — launch opportunity planner.
// Turns a mission definition into launch windows and candidate T-0 instants,
// with the geometry and first-order performance numbers for each.

import {
  DEG, RE, OMEGA_E, circularSpeed, periodSec, ssoInclination, inertialAzimuth, rotatingAzimuth,
  rotationAssist, inCorridor, findPlanarTimes, halfWidthForTolerance, planeAngle, planeChangeDv,
  meanSunRa, nodalRate, geocentricLat, wrap2Pi,
} from './orbit.js';

export const MAX_CANDIDATES = 480;

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? h + mi / 60 : null;
}

/**
 * @param m mission definition (see main.js readMission)
 * @param target optional catalog object for 'object' mode: {name, inc, raanEpoch, epochMs, a, e}
 */
export function planMission(m, target = null) {
  const warnings = [];
  const errors = [];
  const lat = m.site.lat * DEG;
  const latc = geocentricLat(lat);
  const hKm = m.orbit.hKm;
  const rT = RE + hKm;
  const vOrb = circularSpeed(rT);

  // 1. Inclination and target plane
  let inc = null, raanAt = null, planeLabel = '';
  if (m.orbit.mode === 'sso') {
    inc = ssoInclination(hKm);
    if (inc == null) errors.push(`No sun-synchronous orbit exists at ${hKm} km.`);
    const t = parseHHMM(m.orbit.nodeTime);
    if (t == null) errors.push('Enter the local time of node as HH:MM.');
    else {
      const ltan = m.orbit.nodeType === 'desc' ? (t + 12) % 24 : t;
      raanAt = (tMs) => wrap2Pi(meanSunRa(tMs) + (ltan - 12) * 15 * DEG);
      planeLabel = `Sun-synchronous, LT${m.orbit.nodeType === 'desc' ? 'DN' : 'AN'} ${m.orbit.nodeTime}`;
    }
  } else if (m.orbit.mode === 'object') {
    if (!target) errors.push('Pick the catalog object whose orbital plane you want to match.');
    else {
      inc = target.inc;
      const rate = nodalRate(target.a, target.inc, target.e);
      raanAt = (tMs) => wrap2Pi(target.raanEpoch + rate * (tMs - target.epochMs) / 1000);
      planeLabel = `Plane of ${target.name}`;
    }
  } else {
    inc = m.orbit.incDeg * DEG;
    planeLabel = 'Any plane at this inclination';
  }
  if (errors.length) return { errors, warnings, windows: [] };

  // 2. Reachability from the site
  const minInc = Math.abs(latc);
  if (inc < minInc - 1e-9 || inc > Math.PI - minInc + 1e-9) {
    return {
      errors: [`An inclination of ${(inc / DEG).toFixed(2)}° can't be reached directly from latitude ${m.site.lat.toFixed(2)}°. ` +
        `The lowest direct inclination here is ${(minInc / DEG).toFixed(2)}°; a dog-leg or plane change is needed.`],
      warnings, windows: [],
    };
  }

  // 3. Passes, azimuths and range corridor
  const passInfo = {};
  for (const pass of ['asc', 'desc']) {
    const azI = inertialAzimuth(latc, inc, pass);
    const azR = rotatingAzimuth(azI, latc, vOrb);
    passInfo[pass] = { pass, azI, azR, corridorOk: inCorridor(azR / DEG, m.site.corridor) };
  }
  let passes = m.window.passPref === 'both' ? ['asc', 'desc'] : m.window.passPref === 'asc' ? ['asc'] : m.window.passPref === 'desc' ? ['desc'] : ['asc', 'desc'];
  passes = passes.filter((p) => passInfo[p].corridorOk);
  if (m.window.passPref === 'auto' && passes.length === 2 && m.orbit.mode === 'inclination') passes = [passes[0]];
  if (!passes.length) {
    const az = ['asc', 'desc'].map((p) => `${(passInfo[p].azR / DEG).toFixed(1)}°`).join(' or ');
    return { errors: [`The required flight azimuth (${az}) is outside this site's range corridor (${m.site.corridor.min}°–${m.site.corridor.max}°).`], warnings, windows: [] };
  }
  if (!m.site.corridor) warnings.push('No azimuth corridor is configured for this site. Confirm the flight azimuth with the range before relying on these windows.');

  // 4. Windows and candidate T-0s
  const stepMs = Math.max(1, m.window.candStepMin) * 60000;
  const windows = [];
  if (m.orbit.mode === 'inclination') {
    const n = Math.max(1, Math.floor((m.window.durationMin * 60000) / stepMs) + 1);
    for (const pass of passes) {
      const cands = [];
      for (let k = 0; k < n; k++) cands.push({ t0: m.window.startMs + k * stepMs, offsetSec: k * stepMs / 1000, planeErr: 0, dvPlane: 0 });
      windows.push({ pass, tPlanar: null, ...passInfo[pass], candidates: cands });
    }
  } else {
    const tEnd = m.window.startMs + m.window.days * 86400000;
    const planar = findPlanarTimes(m.site, inc, raanAt, m.window.startMs, tEnd, passes);
    if (!planar.length) errors.push('No in-plane launch opportunity was found in the search period. Extend the number of days.');
    // SSO: a launch delay shifts the local time of the node (about 1 min per min) but needs no
    // plane change, so the window is bounded by the node-time tolerance. Rendezvous/plane
    // matching: the delay leaves a plane error that costs a dog-leg or a later plane change.
    const sso = m.orbit.mode === 'sso';
    const hw = sso
      ? Math.min(m.orbit.nodeTolMin, 30) * 60000
      : Math.min(halfWidthForTolerance(inc, m.orbit.planeTolDeg * DEG) * 1000, 30 * 60000);
    // keep at least ±5 candidates in narrow windows (never finer than 10 s)
    const wStep = Math.max(10000, Math.min(stepMs, Math.floor(hw / 5 / 1000) * 1000 || 10000));
    const nHalf = Math.floor(hw / wStep);
    if (wStep < stepMs) warnings.push(`Windows are narrow (±${Math.round(hw / 1000)} s), so candidates are spaced ${wStep / 1000} s apart.`);
    for (const p of planar) {
      const cands = [];
      for (let k = -nHalf; k <= nHalf; k++) {
        const off = k * wStep;
        const err = sso ? 0 : planeAngle(inc, OMEGA_E * off / 1000);
        cands.push({ t0: p.t + off, offsetSec: off / 1000, planeErr: err, dvPlane: planeChangeDv(vOrb, err), nodeShiftMin: sso ? (off / 60000) * 1.00274 : 0 });
      }
      windows.push({ pass: p.pass, tPlanar: p.t, ...passInfo[p.pass], halfWidthSec: nHalf * wStep / 1000, candidates: cands });
    }
  }

  // 5. Keep the workload bounded
  let total = windows.reduce((s, w) => s + w.candidates.length, 0);
  if (total > MAX_CANDIDATES) {
    const thin = Math.ceil(total / MAX_CANDIDATES);
    for (const w of windows) {
      const mid = Math.floor(w.candidates.length / 2);
      w.candidates = w.candidates.filter((_, i) => (i - mid) % thin === 0);
    }
    total = windows.reduce((s, w) => s + w.candidates.length, 0);
    warnings.push(`Candidate spacing widened ${thin}× to keep the screening to ${total} launch times.`);
  }

  let id = 0;
  windows.forEach((w, wi) => {
    w.id = wi;
    for (const c of w.candidates) {
      c.id = id++; c.windowId = wi; c.pass = w.pass; c.azI = w.azI; c.azR = w.azR;
      const assist = rotationAssist(latc, w.azI);
      c.dvAssist = assist;
      c.dvTotal = vOrb - assist + m.ascent.lossesKms + c.dvPlane;
    }
  });

  return {
    errors, warnings, windows,
    inc, planeLabel, raanAt,
    perf: {
      vOrb, period: periodSec(rT), rT, hKm,
      incDeg: inc / DEG,
      ssoIncDeg: ssoInclination(hKm) ? ssoInclination(hKm) / DEG : null,
      minIncDeg: minInc / DEG,
      passes: passInfo,
    },
  };
}
