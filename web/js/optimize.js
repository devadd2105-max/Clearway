// Clearway — "cleanest corridor" hold optimisation.
// Around a chosen T-0, re-screens the trajectory at fine hold offsets (default ±60 s every 2 s)
// and, for inclination-only missions, small azimuth trims, then picks the combination with
// the lowest collision risk. Because every offset shares the same ephemeris grid, the extra
// cost is mostly geometry, not propagation.

import { screenCandidates } from './screening.js';
import { DEG, buildTrajectory } from './orbit.js';

const RANK = { CLEAR: 0, CAUTION: 1, 'NO-GO': 2 };

export async function optimizeHold({ candidate, mission, objects, propagate, exemptNorad = null, rangeSec = 60, stepSec = 2, azTrimsDeg = [0], onProgress, signal }) {
  const cands = [];
  let id = 0;
  for (const trim of azTrimsDeg) {
    for (let h = -rangeSec; h <= rangeSec + 1e-9; h += stepSec) {
      cands.push({ id: id++, t0: candidate.t0 + h * 1000, azI: candidate.azI + trim * DEG, hold: h, trim });
    }
  }
  const { results } = await screenCandidates({ candidates: cands, mission, objects, propagate, exemptNorad, onProgress, signal });
  const series = cands.map((c) => {
    const r = results.get(c.id);
    return { hold: c.hold, trim: c.trim, t0: c.t0, azI: c.azI, status: r.status, minMiss: r.minMiss, maxPc: r.maxPc, events: r.events.length, result: r };
  });
  const score = (s) => RANK[s.status] * 1e6 + (s.maxPc > 0 ? Math.log10(s.maxPc) + 20 : 0) * 100 - Math.min(s.minMiss, 1e4) / 100 + Math.abs(s.hold) / 1e4 + Math.abs(s.trim);
  const best = [...series].sort((a, b) => score(a) - score(b))[0];
  const base = series.find((s) => s.hold === 0 && s.trim === 0) || series[Math.floor(series.length / 2)];
  // inclination change from an azimuth trim (reported so the team can judge it)
  let incDelta = 0;
  if (best.trim) {
    const t = buildTrajectory({ site: mission.site, t0: best.t0, azInertial: best.azI, hTargetKm: mission.orbit.hKm, tInsSec: mission.ascent.tInsSec, downrangeKm: mission.ascent.downrangeKm });
    const t0 = buildTrajectory({ site: mission.site, t0: best.t0, azInertial: candidate.azI, hTargetKm: mission.orbit.hKm, tInsSec: mission.ascent.tInsSec, downrangeKm: mission.ascent.downrangeKm });
    incDelta = (t.inc - t0.inc) / DEG;
  }
  return { series, best, base, incDelta, improved: score(best) < score(base) };
}

/** Azimuth trims allowed for a mission: only inclination-only missions can trim freely. */
export const defaultTrims = (mission) => (mission.orbit.mode === 'inclination' ? [-0.2, -0.1, 0, 0.1, 0.2] : [0]);

