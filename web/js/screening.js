// Clearway — launch collision avoidance (COLA-style) screening.
//
// For every candidate T-0 the nominal trajectory (ascent + N orbits) is compared with every
// catalog object that can physically reach the same altitude. Object ephemerides are sampled
// on a shared time grid and cached lazily, so neighbouring candidates reuse the work. Between
// grid points relative motion is treated as linear to find the closest approach, and every
// approach under the reporting threshold is then refined with direct SGP4 calls.
//
// Probability of collision uses a modelled RIC covariance for both the vehicle and the object,
// projected onto the encounter plane (see covariance.js). It is an engineering estimate, not a
// certified Pc: official screening uses owner/operator ephemerides and covariance.

import { buildTrajectory } from './orbit.js';
import { TYPES } from './catalog.js';
import { objectSigmas, vehicleSigmas, covarianceEci, encounterPc, addCov, ricQuaternion } from './covariance.js';

const MARGIN_KM = 30; // allowance for SGP4 short-period terms vs. mean perigee/apogee

/** Closed-form isotropic small-HBR Pc, kept as a cross-check for the covariance integrator. */
export function pcIndicative(missKm, sigmaKm, hbrKm) {
  const s2 = sigmaKm * sigmaKm;
  return Math.min(1, ((hbrKm * hbrKm) / (2 * s2)) * Math.exp(-(missKm * missKm) / (2 * s2)));
}


/** Closest approach of linear relative motion over one step. Returns [dist, s]. */
export function segmentMin(p0, p1, o0, o1, o0i, o1i) {
  const rx = o0[o0i] - p0[0], ry = o0[o0i + 1] - p0[1], rz = o0[o0i + 2] - p0[2];
  const vx = o1[o1i] - p1[0] - rx, vy = o1[o1i + 1] - p1[1] - ry, vz = o1[o1i + 2] - p1[2] - rz;
  const vv = vx * vx + vy * vy + vz * vz;
  let s = vv > 0 ? -(rx * vx + ry * vy + rz * vz) / vv : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const dx = rx + s * vx, dy = ry + s * vy, dz = rz + s * vz;
  return [Math.sqrt(dx * dx + dy * dy + dz * dz), s];
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {object} args
 *   candidates: [{id, t0, azI}]  mission: definition  objects: catalog list
 *   propagate(obj, tMs) -> [x,y,z] | null    exemptNorad: rendezvous target to skip
 */
export async function screenCandidates({ candidates, mission, objects, propagate, exemptNorad = null, onProgress = () => {}, signal }) {
  const S = mission.screening;
  const hT = mission.orbit.hKm;
  const tIns = mission.ascent.tInsSec;
  const stepSec = S.stepSec;
  const dtMs = stepSec * 1000;
  const started = performance.now();
  let propagations = 0;

  const trajFor = (c) => buildTrajectory({ site: mission.site, t0: c.t0, azInertial: c.azI, hTargetKm: hT, tInsSec: tIns, downrangeKm: mission.ascent.downrangeKm });
  const sample = trajFor(candidates[0]);
  const D = tIns + S.orbits * sample.period; // seconds screened after T-0

  // Per-object altitude envelope including its keep-out distance
  const objs = [];
  for (const o of objects) {
    if (o.norad === exemptNorad) continue;
    const keep = o.type === 'CREWED' ? Math.max(S.reportKm, S.crewedStandoffKm) : S.reportKm;
    const lo = o.perigee - keep - MARGIN_KM, hi = o.apogee + keep + MARGIN_KM;
    if (lo > hT) continue; // always above the vehicle
    objs.push({ o, keep, lo, hi, orbitBand: hi >= hT });
  }
  objs.sort((a, b) => a.lo - b.lo);
  const orbitList = objs.filter((x) => x.orbitBand);

  // Cluster candidates whose screening spans overlap
  const sorted = [...candidates].sort((a, b) => a.t0 - b.t0);
  const clusters = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && c.t0 - last.at(-1).t0 <= D * 1000) last.push(c); else clusters.push([c]);
  }

  const results = new Map();
  let done = 0, lastYield = performance.now();

  for (const cl of clusters) {
    const tA = cl[0].t0;
    const tB = cl.at(-1).t0 + D * 1000;
    const G = Math.ceil((tB - tA) / dtMs) + 2;
    const Gasc = Math.min(G, Math.ceil((cl.at(-1).t0 - tA + tIns * 1000) / dtMs) + 3);
    const cache = new Map();
    const eph = (x, k) => {
      let buf = cache.get(x);
      if (!buf) {
        buf = new Float32Array(3 * (x.orbitBand ? G : Gasc)).fill(NaN);
        cache.set(x, buf);
      }
      const i = 3 * k;
      if (i >= buf.length) return -1;
      if (buf[i] !== buf[i]) { // NaN: not computed yet
        const p = propagate(x.o, tA + k * dtMs);
        propagations++;
        if (!p) { buf[i] = Infinity; return -1; }
        buf[i] = p[0]; buf[i + 1] = p[1]; buf[i + 2] = p[2];
      }
      return buf[i] === Infinity ? -1 : i;
    };

    for (const c of cl) {
      if (signal?.aborted) throw new DOMException('Screening cancelled', 'AbortError');
      const traj = trajFor(c);
      const kStart = Math.ceil((c.t0 - tA) / dtMs);
      const kEnd = Math.floor((c.t0 + D * 1000 - tA) / dtMs) - 1;
      const best = new Map();
      let P0 = traj.at((tA + kStart * dtMs - c.t0) / 1000, [0, 0, 0]);
      const P1 = [0, 0, 0];

      for (let k = kStart; k <= kEnd; k++) {
        const tau0 = (tA + k * dtMs - c.t0) / 1000;
        const tau1 = tau0 + stepSec;
        traj.at(tau1, P1);
        let list;
        let hMin = hT, hMax = hT;
        if (tau0 < tIns) {
          hMin = traj.altitudeAt(tau0); hMax = traj.altitudeAt(tau1);
          list = objs;
        } else list = orbitList;

        for (let j = 0; j < list.length; j++) {
          const x = list[j];
          if (x.lo > hMax) { if (list === objs) break; continue; }
          if (x.hi < hMin) continue;
          const i0 = eph(x, k); if (i0 < 0) continue;
          const i1 = eph(x, k + 1); if (i1 < 0) continue;
          const buf = cache.get(x);
          const [d, s] = segmentMin(P0, P1, buf, buf, i0, i1);
          if (d < x.keep) {
            const prev = best.get(x);
            if (!prev || d < prev.d) best.set(x, { d, t: tA + (k + s) * dtMs });
          }
        }
        P0[0] = P1[0]; P0[1] = P1[1]; P0[2] = P1[2];

        if (performance.now() - lastYield > 30) {
          onProgress({ done, total: candidates.length, propagations });
          await tick();
          lastYield = performance.now();
        }
      }

      // Refine each approach with direct propagation
      const events = [];
      for (const [x, b] of best) {
        const dist = (t) => {
          const p = propagate(x.o, t); propagations++;
          if (!p) return Infinity;
          const v = traj.at((t - c.t0) / 1000);
          return Math.hypot(p[0] - v[0], p[1] - v[1], p[2] - v[2]);
        };
        let lo = Math.max(c.t0, b.t - dtMs), hi = Math.min(c.t0 + D * 1000, b.t + dtMs);
        for (let it = 0; it < 36 && hi - lo > 20; it++) {
          const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
          if (dist(m1) < dist(m2)) hi = m2; else lo = m1;
        }
        const tca = (lo + hi) / 2;
        const miss = Math.min(dist(tca), b.d);
        if (!(miss < x.keep)) continue;
        const pa = propagate(x.o, tca - 500), pb = propagate(x.o, tca + 500), po = propagate(x.o, tca);
        const va = traj.at((tca - 500 - c.t0) / 1000), vb = traj.at((tca + 500 - c.t0) / 1000), pv = traj.at((tca - c.t0) / 1000);
        propagations += 3;
        if (!pa || !pb || !po) continue;
        const vObj = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const vVeh = [vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]];
        const dr = [po[0] - pv[0], po[1] - pv[1], po[2] - pv[2]];
        const dv = [vObj[0] - vVeh[0], vObj[1] - vVeh[1], vObj[2] - vVeh[2]];
        const relV = Math.hypot(...dv);
        const tau = (tca - c.t0) / 1000;
        const phase = tau < tIns ? 'Ascent' : 'Orbit';
        const ageDays = (tca - x.o.epochMs) / 86400000;
        const sObj = objectSigmas(ageDays, (x.o.perigee + x.o.apogee) / 2, S.swFactor ?? 1);
        const sVeh = vehicleSigmas(S.vehSigmaKm, phase);
        const hbrKm = (S.hbrM + (TYPES[x.o.type]?.radiusM ?? 1)) / 1000;
        const enc = encounterPc(dr, dv, addCov(covarianceEci(po, vObj, sObj), covarianceEci(pv, vVeh, sVeh)), hbrKm);
        const pc = enc.pc;
        const sigma = Math.sqrt(enc.sx * enc.sy);
        const crewedHit = x.o.type === 'CREWED' && miss < S.crewedStandoffKm;
        const severity = miss < S.redKm || pc >= S.pcRed || crewedHit ? 'red' : miss < S.amberKm || pc >= S.pcAmber ? 'amber' : 'info';
        events.push({
          norad: x.o.norad, name: x.o.name, type: x.o.type, tca, tau, phase, miss, relV, pc, sigma,
          altKm: traj.altitudeAt(tau), ageDays, severity, crewedHit, hbrKm,
          posEci: pv, objPosEci: po, velEci: vVeh, objVelEci: vObj,
          sigVeh: sVeh, sigObj: sObj, qVeh: ricQuaternion(pv, vVeh), qObj: ricQuaternion(po, vObj),
          enc: { mx: enc.mx, my: enc.my, sx: enc.sx, sy: enc.sy, angle: enc.angle },
        });
      }
      events.sort((a, b) => a.miss - b.miss);
      const red = events.filter((e) => e.severity === 'red').length;
      const amber = events.filter((e) => e.severity === 'amber').length;
      results.set(c.id, {
        events, red, amber, info: events.length - red - amber,
        minMiss: events.length ? events[0].miss : Infinity,
        maxPc: events.reduce((m, e) => Math.max(m, e.pc), 0),
        status: red ? 'NO-GO' : amber ? 'CAUTION' : 'CLEAR',
      });
      done++;
      onProgress({ done, total: candidates.length, propagations });
    }
  }

  return {
    results,
    stats: {
      durationSec: D, objectsConsidered: objs.length, objectsInShell: orbitList.length,
      propagations, ms: performance.now() - started, clusters: clusters.length,
    },
  };
}
