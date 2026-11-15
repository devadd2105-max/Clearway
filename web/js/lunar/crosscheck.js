// Clearway Lunar — cross-check against NASA's published illumination maps.
//
// Mazarico et al. (2011, Icarus 211, 1066–1081; NASA PGDA product 69) computed, for every pixel near the
// poles, the average fraction of the solar disc that is visible and the fraction of time any part of
// Earth is visible, over 18.6 years (one lunar nodal cycle) at hourly steps, from LOLA topography.
// The terrain build samples those maps at each site. Here Clearway computes the same two quantities with
// its own ephemeris and horizon over an 18.6-year span and reports the difference, as measured.
//
// Expected sources of difference (reported, not hidden): the horizon map resolution and extent, the
// observer height (Clearway: panel 2 m above the ground), the exact 18.6-year span, the Sun-disc model
// and the step size; and the spread of the published value across ±1 map pixel around the site.

import { ephemerisGrid, analyseSite } from './analysis.js';

export const CYCLE_YEARS = 18.6;

/** One shared ephemeris grid for the 18.6-year span (built once; ~27 000 steps at 6 h). */
export function longGrid({ startIso = '2010-01-01T00:00:00Z', years = CYCLE_YEARS, stepH = 6 } = {}) {
  const start = Date.parse(startIso);
  return ephemerisGrid(start, start + years * 365.25 * 86400000, stepH * 60);
}

/** Clearway's 18.6-year averages for one site (fractions 0–1). */
export function longTermSite(site, horizon, grid) {
  const a = analyseSite(site, horizon, grid, {});
  let any = 0;
  for (let k = 0; k < grid.n; k++) any += a.sunFrac[k] > 0;
  return { sun: a.metrics.sunPct / 100, earth: a.metrics.earthAnyPct / 100, sunLit: a.metrics.litPct / 100, sunAny: any / grid.n };
}

/**
 * Compare with the published reference for every site that has one.
 * entries: [{id, name, site, horizon, pgda}] → {rows, summary}
 */
export async function crossCheck(entries, { onProgress = null, grid = null, stepH = 6 } = {}) {
  const withRef = entries.filter((e) => e.pgda && (e.pgda.sun || e.pgda.earth));
  if (!withRef.length) return null;
  const g = grid || longGrid({ stepH });
  const rows = [];
  for (let i = 0; i < withRef.length; i++) {
    const e = withRef[i];
    const c = longTermSite(e.site, e.horizon, g);
    // a site whose point was chosen using NASA's sunlight map is shown but left out of the summary
    // (choosing the brightest pixel biases the published value upwards)
    const row = { id: e.id, name: e.name, clearway: c, ref: e.pgda, selectedOnMap: !!e.selectedOnMap };
    if (e.pgda.sun) {
      row.sunDiff = c.sun - e.pgda.sun.value;
      row.sunWithinSpread = e.pgda.sun.min != null && c.sun >= e.pgda.sun.min - 1e-9 && c.sun <= e.pgda.sun.max + 1e-9;
    }
    if (e.pgda.earth) {
      row.earthDiff = c.earth - e.pgda.earth.value;
      row.earthWithinSpread = e.pgda.earth.min != null && c.earth >= e.pgda.earth.min - 1e-9 && c.earth <= e.pgda.earth.max + 1e-9;
    }
    rows.push(row);
    onProgress?.(i + 1, withRef.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { rows, summary: summarise(rows), steps: g.n, stepH, years: CYCLE_YEARS, start: g.start };
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

export function summarise(rows) {
  const out = {};
  for (const key of ['sun', 'earth']) {
    const d = rows.filter((r) => r[`${key}Diff`] != null && !r.selectedOnMap).map((r) => ({ id: r.id, v: r[`${key}Diff`] }));
    if (!d.length) continue;
    const abs = d.map((x) => Math.abs(x.v));
    const worst = d.reduce((a, b) => (Math.abs(b.v) > Math.abs(a.v) ? b : a));
    const meanBias = d.reduce((s, x) => s + x.v, 0) / d.length;
    out[key] = {
      n: d.length,
      medianAbsPts: 100 * med(abs),          // percentage points
      meanBiasPts: 100 * meanBias,
      worstPts: 100 * worst.v, worstId: worst.id,
      within5: d.filter((x) => Math.abs(x.v) <= 0.05).length,
      rmsPts: 100 * Math.sqrt(abs.reduce((s, x) => s + x * x, 0) / abs.length),
    };
  }
  return out;
}
