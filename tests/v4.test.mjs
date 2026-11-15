// Clearway 4 — tests for the thermal model, stay traces, Monte Carlo, the NASA cross-check and the
// horizon-set parser. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { THERMAL_DEFAULTS, resolveThermal, steadyHeaterW, coolDownHours, thermalStep, SIGMA } from '../web/js/lunar/thermal.js';
import { ephemerisGrid, analyseSite, windowAt, stayTrace, sliceGrid, simulateEnergy, resolveOptions, bestWindows } from '../web/js/lunar/analysis.js';
import { Horizon, parseHorizonSet } from '../web/js/lunar/horizon.js';
import { rng, wilson, slopeSafeProbability, monteCarloSite, monteCarlo } from '../web/js/lunar/montecarlo.js';
import { crossCheck, longTermSite, summarise, longGrid } from '../web/js/lunar/crosscheck.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const start = Date.UTC(2026, 9, 17);
const grid = ephemerisGrid(start, start + 60 * 86400000, 60);
const ON = { thermal: { enabled: true } };

// ------------------------------------------------------------------ thermal
test('thermal: steady-state heater power is the radiative balance at the minimum temperature', () => {
  const t = resolveThermal({ enabled: true });
  const T = t.minC + 273.15;
  near(steadyHeaterW(t), t.emissivity * SIGMA * t.radiatorM2 * (T ** 4 - t.sinkK ** 4) - t.survivalElecW, 1e-9, 'balance');
  assert.ok(steadyHeaterW(t) > 50 && steadyHeaterW(t) < 150, 'default lander needs about 90 W of heaters');
  // run long enough in the dark: the heater converges to the steady value and T sits at T_min
  let T0 = t.startC + 273.15, last;
  for (let h = 0; h < 120; h++) last = thermalStep(T0, 3600, 0, t.survivalElecW, t), T0 = last.T;
  near(last.T, T, 1e-6, 'held at T_min');
  near(last.heaterW, steadyHeaterW(t), 0.5, 'steady heater');
});

test('thermal: stored heat carries the lander through a short shadow; cooling time grows with heat capacity', () => {
  const t = resolveThermal({ enabled: true });
  const cool = coolDownHours(t);
  assert.ok(cool > 10 && cool < 40, `cool-down ${cool} h`);
  assert.ok(coolDownHours({ ...t, capacityKJperK: 2 * t.capacityKJperK }) > 1.8 * cool, 'twice the mass, about twice the time');
  // a 6 h shadow from warm: no heater at all
  let T = t.startC + 273.15, heat = 0;
  for (let h = 0; h < 6; h++) { const r = thermalStep(T, 3600, 0, t.survivalElecW, t); T = r.T; heat += r.heaterW; }
  assert.equal(heat, 0);
  // electronics alone above the radiative loss at T_min: never cools that far
  assert.equal(coolDownHours({ ...t, survivalElecW: 1000 }), Infinity);
});

test('thermal: louvres cap the temperature; energy is conserved within a step', () => {
  const t = resolveThermal({ enabled: true });
  const r = thermalStep(290, 3600, 2000, 300, t);
  near(r.T, t.maxC + 273.15, 1e-9, 'capped at T_max');
  // without clamping: C ΔT = (Qin − Qout) dt (check with one small sub-step)
  const T0 = 280, q = 100;
  const one = thermalStep(T0, 600, q, 0, t);
  const expect = T0 + ((q - t.emissivity * SIGMA * t.radiatorM2 * (T0 ** 4 - t.sinkK ** 4)) * 600) / (t.capacityKJperK * 1000);
  near(one.T, expect, 1e-9, 'explicit step');
});

test('analysis with the thermal model: short darkness costs less than a fixed survival load, long darkness similar', () => {
  // permanently dark pit (horizon at +20°) for 60 days: energy is the steady heater most of the time
  const pit = new Horizon(new Array(720).fill(20));
  const site = { lat: -89, lon: 0 };
  const fixed = analyseSite(site, pit, grid, { battery: { survivalLoadW: 139 } });
  const thermal = analyseSite(site, pit, grid, ON);
  const t = resolveThermal({ enabled: true });
  near(thermal.metrics.peakHeaterW, steadyHeaterW(t), 1, 'peak heater is the steady value in a long night');
  assert.ok(thermal.metrics.heaterKWh > 0.9 * steadyHeaterW(t) * 24 * 60 / 1000 - 10, 'heaters run nearly all the time');
  near(thermal.metrics.minTempC, t.minC, 1e-6, 'held at the minimum');
  assert.ok(thermal.load[grid.n - 1] > 130 && thermal.load[grid.n - 1] < 150);
  assert.ok(Math.abs(thermal.metrics.batteryNeededWh - fixed.metrics.batteryNeededWh) / fixed.metrics.batteryNeededWh < 0.05, 'steady state ≈ fixed 139 W');
  // a sunny ridge with short dips: the thermal model needs far less heater energy than a fixed 120 W would cost
  const ridge = analyseSite({ lat: -89.5, lon: 0 }, new Horizon(new Array(720).fill(-3)), grid, ON);
  assert.ok(ridge.metrics.heaterKWh < 1, `ridge heaters ${ridge.metrics.heaterKWh} kWh`);
});

test('windowAt and stayTrace start from a full battery and a warm lander', () => {
  const site = { lat: -86, lon: 0 };
  const a = analyseSite(site, Horizon.smooth(2), grid, ON);
  const k0 = 24 * 20;
  const w = windowAt(a, grid, k0, 10);
  const tr = stayTrace(a, grid, k0, 10);
  assert.equal(tr.k1 - tr.k0, 240);
  const usable = a.opts.battery.capacityWh * a.opts.battery.usableFraction;
  let minE = usable;
  for (let k = tr.k0; k < tr.k1; k++) minE = Math.min(minE, tr.soc[k]);
  near(100 * minE / usable, w.minSocPct, 1e-6, 'trace and window agree');
  assert.ok(tr.temp[tr.k0] > a.opts.thermal.minC, 'warm at touchdown');
  // simulateEnergy on a slice equals simulateEnergy on the same range of the full grid
  const s1 = simulateEnergy(a, grid, a.opts, k0, k0 + 240);
  const sub = sliceGrid(grid, k0, k0 + 240);
  const b = analyseSite(site, Horizon.smooth(2), sub, ON);
  near(b.metrics.minSocPct, (100 * s1.minE) / s1.usable, 1e-6, 'slice matches');
  assert.equal(sub.n, 240);
  assert.equal(sub.start, grid.start + k0 * grid.step);
});

test('library default keeps the fixed survival load (backwards compatible)', () => {
  const o = resolveOptions({});
  assert.equal(o.thermal.enabled, false);
  const a = analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid, { battery: { survivalLoadW: 77 } });
  for (let k = 0; k < grid.n; k += 13) if (a.sunFrac[k] < 0.5) assert.equal(a.load[k], 77);
  assert.equal(a.metrics.heaterKWh, 0);
});

// ------------------------------------------------------------------ Monte Carlo
test('PRNG is deterministic and the normal deviates have unit variance', () => {
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const r = rng(7);
  let s = 0, s2 = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) { const x = r.normal(); s += x; s2 += x * x; }
  near(s / n, 0, 0.03, 'mean'); near(s2 / n, 1, 0.04, 'variance');
});

test('Wilson interval', () => {
  const [lo, hi] = wilson(186, 200);
  near(lo, 0.8857, 0.002, 'lower'); near(hi, 0.9573, 0.002, 'upper');
  assert.deepEqual(wilson(0, 0), [0, 1]);
  assert.ok(wilson(200, 200)[1] > 0.9999 && wilson(200, 200)[0] > 0.98);
});

test('slope-safe probability interpolates the stored distribution', () => {
  const L = { fracBelow: { 5: 0.1, 8: 0.5, 10: 0.8, 12: 0.9, 15: 1, 20: 1 } };
  assert.equal(slopeSafeProbability(L, 10), 0.8);
  near(slopeSafeProbability(L, 11), 0.85, 1e-9, 'between 10 and 12');
  assert.equal(slopeSafeProbability(L, 30), 1);
  assert.equal(slopeSafeProbability(L, 3), 0.1);
  assert.equal(slopeSafeProbability(null, 10), null);
});

test('Monte Carlo: a comfortable plan survives, a starved one fails, results are reproducible', () => {
  const site = { lat: -89.5, lon: 0, heightM: 0 };
  const sunny = new Horizon(new Array(720).fill(-3), { source: 'LOLA' });
  const a = analyseSite(site, sunny, grid, ON);
  const w = bestWindows(a, grid, { durationDays: 7, top: 1 })[0];
  const e = { id: 'ridge', site, horizon: sunny, ring: [], slope: null };
  const r1 = monteCarloSite(e, grid, ON, w.k0, 7, { iterations: 60, seed: 3 });
  const r2 = monteCarloSite(e, grid, ON, w.k0, 7, { iterations: 60, seed: 3 });
  assert.deepEqual(r1, r2, 'same seed, same answer');
  assert.ok(r1.rate > 0.9, `ridge survives ${r1.rate}`);
  // the same site with a tiny battery and a big load fails on battery
  const hungry = { ...ON, battery: { capacityWh: 50, operatingLoadW: 2000 } };
  const r3 = monteCarloSite(e, grid, hungry, w.k0, 7, { iterations: 40, seed: 3 });
  assert.ok(r3.rate < 0.1 && r3.fail.battery > 30);
  // slope: a landing circle with only 20% safe ground fails ~80% of scenarios on slope
  const steep = { ...e, slope: { lander: { fracBelow: { 5: 0, 8: 0.1, 10: 0.2, 12: 0.5, 15: 0.9, 20: 1 } } } };
  const r4 = monteCarloSite(steep, grid, ON, w.k0, 7, { iterations: 400, seed: 9, tiltLimitDeg: 10 });
  near(r4.fail.slope / r4.n, 0.8, 0.07, 'slope failures');
  assert.equal(r4.slopeP, 0.2);
});

test('Monte Carlo samples the ring of touchdown points', async () => {
  const site = { lat: -89.5, lon: 0, heightM: 0 };
  const centre = new Horizon(new Array(720).fill(-3), { source: 'LOLA' });
  const wall = new Horizon(new Array(360).fill(30), { azStep: 1, source: 'LOLA' }); // a point in a pit: never lit
  const a = analyseSite(site, centre, grid, ON);
  const w = bestWindows(a, grid, { durationDays: 3, top: 1 })[0];
  const e = { id: 'x', site, horizon: centre, ring: Array.from({ length: 6 }, () => ({ horizon: wall, heightM: 0 })), slope: null };
  const r = monteCarloSite(e, grid, ON, w.k0, 3, { iterations: 350, seed: 1, slipHours: 0, skylineSigmaDeg: 0 });
  near(r.ok / r.n, 1 / 7, 0.05, 'only the centre point survives');
  assert.equal(r.positions, 7);
  const off = monteCarloSite(e, grid, ON, w.k0, 3, { iterations: 50, seed: 1, slipHours: 0, positionM: 0 });
  assert.equal(off.positions, 1);
  const all = await monteCarlo([e], grid, ON, new Map([['x', w.k0]]), 3, { iterations: 20 });
  assert.equal(all.get('x').n, 20);
});

// ------------------------------------------------------------------ cross-check
test('cross-check: 18.6-year averages and the difference summary', async () => {
  const g = longGrid({ stepH: 24 });
  near((g.n - 1) * 24 / 24 / 365.25, 18.6, 0.01, '18.6 years');
  const flat = longTermSite({ lat: -85, lon: 0 }, Horizon.smooth(2), g);
  assert.ok(flat.sun > 0.4 && flat.sun < 0.6, `smooth Moon: about half the time ${flat.sun}`);
  const pit = longTermSite({ lat: -89.6, lon: 0 }, new Horizon(new Array(720).fill(20)), g);
  assert.equal(pit.sun, 0); assert.equal(pit.earth, 0);
  const entries = [
    { id: 'a', name: 'A', site: { lat: -85, lon: 0 }, horizon: Horizon.smooth(2), pgda: { sun: { value: flat.sun + 0.03, min: flat.sun - 0.01, max: flat.sun + 0.05 }, earth: { value: flat.earth, min: flat.earth, max: flat.earth } } },
    { id: 'b', name: 'B', site: { lat: -89.6, lon: 0 }, horizon: new Horizon(new Array(720).fill(20)), pgda: { sun: { value: 0.1, min: 0.05, max: 0.15 } } },
    { id: 'c', name: 'C', site: { lat: -86, lon: 0 }, horizon: Horizon.smooth(2), pgda: null },
  ];
  const res = await crossCheck(entries, { grid: g });
  assert.equal(res.rows.length, 2, 'sites without a reference are skipped');
  near(res.rows[0].sunDiff, -0.03, 1e-9, 'difference A');
  assert.equal(res.rows[0].sunWithinSpread, true);
  assert.equal(res.rows[1].sunWithinSpread, false);
  near(res.summary.sun.medianAbsPts, 6.5, 1e-6, 'median of 3 and 10 points');
  assert.equal(res.summary.sun.worstId, 'b');
  assert.equal(res.summary.earth.n, 1);
  assert.deepEqual(summarise([]), {});
});

// ------------------------------------------------------------------ horizon set parser
test('parseHorizonSet reads rings, slopes, NASA references and build-added sites', () => {
  const set = parseHorizonSet({
    azStep: 0.5, meta: { ring: { n: 2, radiusM: 100, azStep: 1 }, tiles: [{ site: 'Site01' }] },
    sites: {
      im2: { lat: -84.79, lon: 29.2, heightM: 5000, resM: 240, elev: new Array(720).fill(-1), ring: [{ az: 0, heightM: 5001, elev: new Array(360).fill(-0.5) }], slope: { regionalDeg: 3 }, pgda: { sun: { value: 0.6 } } },
      'pgda-site01': { lat: -89.45, lon: -137.3, heightM: 1800, resM: 5, elev: new Array(720).fill(0), name: 'Connecting ridge (PGDA Site01)', short: 'Connecting ridge', kind: 'PGDA 5 m site' },
    },
  });
  const a = set.sites.get('im2');
  assert.equal(a.ring.length, 1);
  assert.equal(a.ring[0].horizon.azStep, 1);
  near(a.ring[0].horizon.at(200), -0.5, 1e-6, 'ring horizon');
  assert.equal(a.info, null);
  assert.equal(a.horizon.source, 'LOLA');
  const b = set.sites.get('pgda-site01');
  assert.equal(b.horizon.source, 'LOLA 5 m');
  assert.equal(b.info.short, 'Connecting ridge');
  assert.equal(b.info.lat, -89.45);
});

test('thermal defaults are documented in one place', () => {
  assert.equal(THERMAL_DEFAULTS.enabled, false);
  for (const k of ['capacityKJperK', 'radiatorM2', 'emissivity', 'sinkK', 'minC', 'maxC', 'survivalElecW', 'sunAreaM2', 'absorptivity', 'startC']) assert.ok(Number.isFinite(THERMAL_DEFAULTS[k]), k);
});

import { recommend } from '../web/js/lunar/analysis.js';

test('recommendation requires Monte Carlo survival when rates are supplied', () => {
  const results = new Map([
    ['ridge', analyseSite({ lat: -89.5, lon: 0 }, new Horizon(new Array(720).fill(-3)), grid)],
    ['plain', analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid)],
  ]);
  const base = recommend(results, grid, 0.5, { durationDays: 7 });
  assert.equal(base.robustApplied, false);
  const other = base.id === 'ridge' ? 'plain' : 'ridge';
  // the paper winner fails most scenarios → the other surviving site is recommended
  const r = recommend(results, grid, 0.5, { durationDays: 7, robust: new Map([[base.id, 0.24], [other, 0.95]]) });
  if (r.dec.get(other)?.feasible) assert.equal(r.id, other); else assert.equal(r.id, base.id);
  assert.equal(r.robustApplied, true);
  // nobody reaches the threshold → the most robust surviving site
  const q = recommend(results, grid, 0.5, { durationDays: 7, robust: new Map([[base.id, 0.3], [other, 0.1]]) });
  assert.equal(q.id, base.id);
});

test('cross-check summary leaves out points chosen on NASA\'s own map', async () => {
  const g = longGrid({ stepH: 48 });
  const flat = longTermSite({ lat: -85, lon: 0 }, Horizon.smooth(2), g);
  const res = await crossCheck([
    { id: 'a', site: { lat: -85, lon: 0 }, horizon: Horizon.smooth(2), pgda: { sun: { value: flat.sun + 0.02, min: 0, max: 1 } } },
    { id: 'b', site: { lat: -85, lon: 0 }, horizon: Horizon.smooth(2), pgda: { sun: { value: flat.sun + 0.30, min: 0, max: 1 } }, selectedOnMap: true },
  ], { grid: g });
  assert.equal(res.rows.length, 2);
  assert.equal(res.summary.sun.n, 1);
  near(res.summary.sun.medianAbsPts, 2, 1e-6, 'only the unbiased site counts');
});
