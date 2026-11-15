// Clearway — in-orbit advisory mode.
// After insertion, screens the payload's predicted orbit against the catalog for the first
// days of operations, and sizes an in-track collision-avoidance burn for any risky approach.
// Uses a streaming two-buffer sweep (memory stays flat for multi-day horizons). Once the
// payload has its own catalog entry, operators should screen that element set instead.

import { meanMotion } from './orbit.js';
import { TYPES } from './catalog.js';
import { objectSigmas, covarianceEci, encounterPc, addCov, ricAxes } from './covariance.js';
import { segmentMin } from './screening.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Payload uncertainty after insertion: dispersion that grows in-track until it is tracked. */
export function payloadSigmas(baseKm, daysSinceInsertion) {
  const d = Math.max(0, daysSinceInsertion);
  return { r: 0.5 * baseKm + 0.1 * d, i: 1.5 * baseKm + 2 * d, c: 0.5 * baseKm + 0.1 * d };
}

/** In-track displacement (km) per km/s of tangential Δv applied `lead` seconds before TCA (Clohessy-Wiltshire). */
export const inTrackShiftPerDv = (n, lead) => Math.abs((4 / n) * Math.sin(n * lead) - 3 * lead);

/**
 * Smallest in-track Δv (m/s) that brings Pc below targetPc, for a burn `lead` seconds before TCA.
 * Returns {dvMs, shiftKm, newPc, newMiss} or null if not achievable within 2 m/s.
 */
export function sizeAvoidance(ev, n, lead, targetPc = 1e-6) {
  const { I } = ricAxes(ev.posEci, ev.velEci);
  const dr0 = [ev.objPosEci[0] - ev.posEci[0], ev.objPosEci[1] - ev.posEci[1], ev.objPosEci[2] - ev.posEci[2]];
  const dv = [ev.objVelEci[0] - ev.velEci[0], ev.objVelEci[1] - ev.velEci[1], ev.objVelEci[2] - ev.velEci[2]];
  const k = inTrackShiftPerDv(n, lead);
  const pcAt = (shift, sign) => {
    const dr = [dr0[0] - sign * shift * I[0], dr0[1] - sign * shift * I[1], dr0[2] - sign * shift * I[2]];
    return encounterPc(dr, dv, ev.cov, ev.hbrKm);
  };
  const now = pcAt(0, 1);
  if (now.pc <= targetPc) return { dvMs: 0, shiftKm: 0, newPc: now.pc, newMiss: now.miss, notNeeded: true };
  let best = null;
  for (const sign of [1, -1]) {
    let lo = 0, hi = 0.05;
    while (pcAt(hi, sign).pc > targetPc && hi < 0.002 * k) hi *= 2; // Δv cap 2 m/s
    const r = pcAt(hi, sign);
    if (r.pc > targetPc) continue;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (pcAt(mid, sign).pc > targetPc) lo = mid; else hi = mid; }
    const e = pcAt(hi, sign);
    const cand = { dvMs: (hi / k) * 1000, shiftKm: hi, newPc: e.pc, newMiss: e.miss, direction: sign > 0 ? 'prograde' : 'retrograde' };
    if (!best || cand.dvMs < best.dvMs) best = cand;
  }
  return best;
}

export async function screenOrbitOps({ traj, mission, objects, propagate, days = 2, stepSec = 60, reportKm = 10, onProgress = () => {}, signal }) {
  const S = mission.screening;
  const hT = mission.orbit.hKm;
  const tau0 = traj.tInsSec, tau1 = tau0 + days * 86400;
  const t0 = traj.t0;
  const band = objects.filter((o) => o.perigee - reportKm - 30 <= hT && o.apogee + reportKm + 30 >= hT);
  const N = band.length;
  let A = new Float64Array(3 * N), B = new Float64Array(3 * N);
  const okA = new Uint8Array(N), okB = new Uint8Array(N);
  const fill = (buf, ok, tau) => {
    const t = t0 + tau * 1000;
    for (let j = 0; j < N; j++) {
      const p = propagate(band[j], t);
      if (p) { buf[3 * j] = p[0]; buf[3 * j + 1] = p[1]; buf[3 * j + 2] = p[2]; ok[j] = 1; } else ok[j] = 0;
    }
  };
  const period = traj.period;
  const best = new Map(); // key object index * 1e5 + orbit number
  fill(A, okA, tau0);
  const P0 = traj.at(tau0), P1 = [0, 0, 0];
  const steps = Math.ceil((tau1 - tau0) / stepSec);
  let last = performance.now(), propagations = N;
  for (let k = 0; k < steps; k++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const ta = tau0 + k * stepSec, tb = ta + stepSec;
    traj.at(tb, P1);
    fill(B, okB, tb); propagations += N;
    for (let j = 0; j < N; j++) {
      if (!okA[j] || !okB[j]) continue;
      const [d, s] = segmentMin(P0, P1, A, B, 3 * j, 3 * j);
      if (d < reportKm) {
        const tau = ta + s * stepSec;
        const key = j * 1e5 + Math.floor((tau - tau0) / period);
        const prev = best.get(key);
        if (!prev || d < prev.d) best.set(key, { j, d, tau });
      }
    }
    [A, B] = [B, A]; okA.set(okB);
    P0[0] = P1[0]; P0[1] = P1[1]; P0[2] = P1[2];
    if (performance.now() - last > 40) { onProgress({ done: k, total: steps, propagations }); await tick(); last = performance.now(); }
  }

  const n = meanMotion(traj.rT);
  const events = [];
  for (const b of best.values()) {
    const o = band[b.j];
    const dist = (tau) => { const p = propagate(o, t0 + tau * 1000); if (!p) return Infinity; const v = traj.at(tau); return Math.hypot(p[0] - v[0], p[1] - v[1], p[2] - v[2]); };
    let lo = b.tau - stepSec, hi = b.tau + stepSec;
    for (let i = 0; i < 40 && hi - lo > 0.02; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (dist(m1) < dist(m2)) hi = m2; else lo = m1; }
    const tau = (lo + hi) / 2;
    const po = propagate(o, t0 + tau * 1000), pa = propagate(o, t0 + (tau - 0.5) * 1000), pb = propagate(o, t0 + (tau + 0.5) * 1000);
    if (!po || !pa || !pb) continue;
    const pv = traj.at(tau), va = traj.at(tau - 0.5), vb = traj.at(tau + 0.5);
    const vObj = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], vVeh = [vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]];
    const dr = [po[0] - pv[0], po[1] - pv[1], po[2] - pv[2]], dv = [vObj[0] - vVeh[0], vObj[1] - vVeh[1], vObj[2] - vVeh[2]];
    const tca = t0 + tau * 1000;
    const sObj = objectSigmas((tca - o.epochMs) / 86400000, (o.perigee + o.apogee) / 2, S.swFactor ?? 1);
    const sVeh = payloadSigmas(S.vehSigmaKm, (tau - tau0) / 86400);
    const cov = addCov(covarianceEci(po, vObj, sObj), covarianceEci(pv, vVeh, sVeh));
    const hbrKm = (S.hbrM + (TYPES[o.type]?.radiusM ?? 1)) / 1000;
    const enc = encounterPc(dr, dv, cov, hbrKm);
    const miss = Math.hypot(...dr);
    if (miss > reportKm) continue;
    const severity = miss < S.redKm || enc.pc >= S.pcRed || (o.type === 'CREWED' && miss < S.crewedStandoffKm) ? 'red' : miss < S.amberKm || enc.pc >= S.pcAmber ? 'amber' : 'info';
    const ev = { norad: o.norad, name: o.name, type: o.type, tca, tau, miss, relV: Math.hypot(...dv), pc: enc.pc, severity, posEci: pv, objPosEci: po, velEci: vVeh, objVelEci: vObj, cov, hbrKm, enc };
    if (severity !== 'info') {
      const leads = [period, 0.5 * 86400].filter((L) => tau - L >= tau0);
      ev.burns = leads.map((L) => ({ leadSec: L, burnTime: tca - L * 1000, ...(sizeAvoidance(ev, n, L) || { dvMs: null }) }));
    }
    events.push(ev);
  }
  events.sort((a, b) => a.tca - b.tca);
  return { events, objects: N, propagations, days, stepSec };
}
