// Clearway Lunar — Monte Carlo survival analysis.
//
// For each site the planned landing (its best window) is re-simulated many times with the uncertain
// inputs drawn at random:
//   touchdown point  one of the horizons computed for points 100 m around the site (or the site itself)
//   skyline error    the whole horizon raised/lowered by N(0, σ) degrees (map and boulder error)
//   panel efficiency × N(1, σ)          (cell degradation, dust, temperature)
//   loads            operating × N(1, σ), survival electronics × N(1, σ)
//   battery          capacity × U(1 − fade, 1)   (ageing, cold)
//   thermal          radiator area × N(1, σ)     (when the thermal model is on)
//   landing time     the planned time ± U(slip) hours (launch or descent slips)
//   touchdown slope  safe with the probability measured from the 5 m slope map within 100 m (if available)
// A scenario succeeds if the Sun and Earth are above the skyline at touchdown, the slope is within the
// lander's tilt limit and the battery never runs flat during the stay.
//
// The result is the fraction of sampled scenarios that succeed, with a 95% Wilson interval. It shows how
// fragile a plan is to these inputs; it is not a calibrated probability of mission success (that would
// need validated uncertainty distributions for a specific lander).

import { analyseSite, resolveOptions, sliceGrid } from './analysis.js';

export const MC_DEFAULTS = {
  iterations: 200, seed: 1,
  positionM: 100,            // uses the ring horizons built at this radius
  skylineSigmaDeg: 0.25,
  panelSigma: 0.05, loadSigma: 0.10, survivalSigma: 0.15,
  batteryFade: 0.15, radiatorSigma: 0.10,
  slipHours: 24,
  tiltLimitDeg: 10,
};

/** Deterministic PRNG (mulberry32) so a run can be reproduced from its seed. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  next.normal = () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = next();
    v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return next;
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k, n, z = 1.959964) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Probability that a touchdown within the landing circle is below the tilt limit (from the 5 m slope map). */
export function slopeSafeProbability(lander, limitDeg) {
  if (!lander?.fracBelow) return null;
  const keys = Object.keys(lander.fracBelow).map(Number).sort((x, y) => x - y);
  const below = keys.filter((k) => k <= limitDeg);
  if (!below.length) return lander.fracBelow[String(keys[0])] ?? null;
  const k = below[below.length - 1];
  if (k === limitDeg || k === keys[keys.length - 1]) return lander.fracBelow[String(k)];
  const hi = keys[keys.indexOf(k) + 1]; // interpolate between the stored limits
  const f = (limitDeg - k) / (hi - k);
  return lander.fracBelow[String(k)] * (1 - f) + lander.fracBelow[String(hi)] * f;
}

/**
 * Run the Monte Carlo for one site.
 * entry: {id, site, horizon, ring: [{horizon, heightM}], slope}; landingK: planned touchdown step.
 */
export function monteCarloSite(entry, grid, rawOpts, landingK, stayDays, cfg = {}) {
  const c = { ...MC_DEFAULTS, ...cfg };
  const opts = resolveOptions(rawOpts);
  const R = rng((c.seed * 2654435761 + hash(entry.id)) >>> 0);
  const perH = 3600000 / grid.step;
  const stay = Math.round(stayDays * 24 * perH);
  const slip = Math.round(c.slipHours * perH);
  const positions = [{ horizon: entry.horizon, heightM: entry.site.heightM || 0 }, ...(c.positionM > 0 ? entry.ring || [] : [])];
  const pSlope = slopeSafeProbability(entry.slope?.lander, c.tiltLimitDeg);
  const res = { id: entry.id, n: 0, ok: 0, fail: { touchdown: 0, battery: 0, slope: 0 }, minSoc: [], positions: positions.length, slopeP: pSlope };
  for (let i = 0; i < c.iterations; i++) {
    const pos = positions[Math.floor(R() * positions.length)];
    const dSky = R.normal() * c.skylineSigmaDeg;
    const k0 = Math.max(0, Math.min(grid.n - 1, landingK + Math.round((R() * 2 - 1) * slip)));
    const o = structuredClone(opts);
    o.panel.efficiency = Math.max(0.01, opts.panel.efficiency * (1 + R.normal() * c.panelSigma));
    o.battery.operatingLoadW = Math.max(0, opts.battery.operatingLoadW * (1 + R.normal() * c.loadSigma));
    const sv = 1 + R.normal() * c.survivalSigma;
    o.battery.survivalLoadW = Math.max(0, opts.battery.survivalLoadW * sv);
    o.battery.capacityWh = opts.battery.capacityWh * (1 - R() * c.batteryFade);
    if (o.thermal?.enabled) {
      o.thermal.survivalElecW = Math.max(0, opts.thermal.survivalElecW * sv);
      o.thermal.radiatorM2 = Math.max(0.05, opts.thermal.radiatorM2 * (1 + R.normal() * c.radiatorSigma));
    }
    const slopeOk = pSlope == null ? true : R() < pSlope;
    const g = sliceGrid(grid, k0, k0 + stay);
    if (g.n < 1) continue;
    const hz = dSky ? pos.horizon.shifted(dSky) : pos.horizon;
    const a = analyseSite({ ...entry.site, heightM: pos.heightM }, hz, g, o);
    res.n++;
    const touch = a.sunEl[0] - a.sunHz[0] >= 0.5 && a.earthEl[0] - a.earthHz[0] >= 0;
    // battery: full and warm at touchdown (analyseSite already simulated exactly the stay)
    const sim = a.metrics;
    const flat = !sim.survives;
    res.minSoc.push(sim.minSocPct);
    if (!touch) res.fail.touchdown++;
    else if (!slopeOk) res.fail.slope++;
    else if (flat) res.fail.battery++;
    else res.ok++;
  }
  res.rate = res.n ? res.ok / res.n : 0;
  res.ci = wilson(res.ok, res.n);
  res.minSoc.sort((x, y) => x - y);
  res.minSocP10 = res.minSoc.length ? res.minSoc[Math.floor(0.1 * (res.minSoc.length - 1))] : null;
  delete res.minSoc;
  return res;
}

function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Run every site, yielding to the browser between sites. onSite(result, index, total). */
export async function monteCarlo(entries, grid, opts, landings, stayDays, cfg = {}, { onSite = null, cancelled = () => false } = {}) {
  const out = new Map();
  for (let i = 0; i < entries.length; i++) {
    if (cancelled()) return null;
    const e = entries[i];
    const k = landings.get(e.id);
    if (k == null) { out.set(e.id, null); continue; }
    const r = monteCarloSite(e, grid, opts, k, stayDays, cfg);
    out.set(e.id, r);
    onSite?.(r, i, entries.length);
    await new Promise((res) => setTimeout(res, 0));
  }
  return out;
}

