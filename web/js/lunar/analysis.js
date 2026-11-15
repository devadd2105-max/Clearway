// Clearway Lunar — illumination, power, communications and battery analysis.
//
// The ephemeris is site-independent, so it is computed once per time step (ephemerisGrid) and
// every site is then evaluated with vector arithmetic only (analyseSite). A year at hourly steps
// for ten sites takes well under a second.
//
// Visibility is reported in tiers so results are hard to misread:
//   geometric  — above the horizon of a smooth Moon (no terrain)
//   terrain    — above the real skyline (line of sight)
//   DSN        — and a Deep Space Network complex sees the Moon
// Operational link availability (antenna pointing, link budget, scheduling) is NOT modelled.

import { moonCentredBodies, sitePosition, enuBasis, azEl, R_SUN, R_EARTH, R_MOON, AU, SOLAR_CONSTANT, DEG, rotZ, sub, norm, dot } from './ephem.js';
import { discFraction, Horizon } from './horizon.js';
import { resolveThermal, thermalStep } from './thermal.js';
import { gmst, geodeticToEcef } from '../orbit.js';
import { relayTrack, relaySeesEarth } from './radio.js';

/** Deep Space Network complexes (approximate antenna coordinates). */
export const DSN = [
  { id: 'gds', name: 'Goldstone', lat: 35.4267, lon: -116.89, altKm: 1.0 },
  { id: 'mad', name: 'Madrid', lat: 40.4314, lon: -4.2481, altKm: 0.83 },
  { id: 'cbr', name: 'Canberra', lat: -35.4014, lon: 148.9817, altKm: 0.69 },
];

export const PANELS = {
  'vertical-tracking': { label: 'Vertical, turns to face the Sun', inc: (el) => Math.cos(el * DEG) },
  'vertical-fixed': { label: 'Vertical, fixed direction', inc: (el, az, p) => Math.cos(el * DEG) * Math.max(0, Math.cos((az - p.azimuth) * DEG)) },
  horizontal: { label: 'Horizontal (flat on the deck)', inc: (el) => Math.max(0, Math.sin(el * DEG)) },
  'two-axis': { label: 'Two-axis tracking', inc: () => 1 },
};

export const PRIORITIES = { power: { label: 'Power first', weight: 0.8 }, balanced: { label: 'Balanced', weight: 0.5 }, comms: { label: 'Comms first', weight: 0.2 } };

export const DEFAULTS = {
  stepMin: 60,
  panel: { type: 'vertical-tracking', areaM2: 2, efficiency: 0.28, azimuth: 0 },
  battery: { capacityWh: 2000, usableFraction: 0.8, chargeEff: 0.95, dischargeEff: 0.95, operatingLoadW: 200, survivalLoadW: 120, startFull: true },
  comms: { minMarginDeg: 0.5, dsnMinElDeg: 10, requireDsn: false, relay: null },
  litThreshold: 0.5,
  observerHeightM: 2,
  thermal: { enabled: false },
};

export function resolveOptions(opts = {}) {
  const b = { ...DEFAULTS.battery, ...opts.battery };
  if (opts.battery?.loadW != null) { // single-load shorthand
    if (opts.battery.operatingLoadW == null) b.operatingLoadW = opts.battery.loadW;
    if (opts.battery.survivalLoadW == null) b.survivalLoadW = opts.battery.loadW;
  }
  return { ...DEFAULTS, ...opts, panel: { ...DEFAULTS.panel, ...opts.panel }, battery: b, comms: { ...DEFAULTS.comms, ...opts.comms }, thermal: resolveThermal(opts.thermal) };
}

/** Site-independent geometry on a regular time grid. */
export function ephemerisGrid(startMs, endMs, stepMin = 60) {
  const step = stepMin * 60000;
  const n = Math.max(1, Math.floor((endMs - startMs) / step) + 1);
  const sun = new Float64Array(3 * n), earth = new Float64Array(3 * n), dsn = new Uint8Array(n), sunDist = new Float64Array(n);
  const stations = DSN.map((s) => ({
    p: geodeticToEcef(s.lat * DEG, s.lon * DEG, s.altKm),
    up: [Math.cos(s.lat * DEG) * Math.cos(s.lon * DEG), Math.cos(s.lat * DEG) * Math.sin(s.lon * DEG), Math.sin(s.lat * DEG)],
  }));
  for (let k = 0; k < n; k++) {
    const t = startMs + k * step;
    const b = moonCentredBodies(t);
    sun.set(b.sun, 3 * k); earth.set(b.earth, 3 * k);
    sunDist[k] = norm(b.sun);
    const m = rotZ(b.moonGeoOfDate, -gmst(t));
    let best = -90;
    for (const s of stations) { const d = sub(m, s.p); best = Math.max(best, Math.asin(dot(d, s.up) / norm(d)) / DEG); }
    dsn[k] = Math.max(0, Math.min(90, Math.round(best))); // highest Moon elevation over the three complexes (deg, ≥ 0)
  }
  return { start: startMs, step, n, sun, earth, sunDist, dsnMaxEl: dsn };
}

/** One battery step on usable energy E (Wh). Returns the new E (may go negative = shortfall). */
function batteryStep(E, netW, dtH, b) {
  return E + (netW >= 0 ? netW * b.chargeEff : netW / b.dischargeEff) * dtH;
}

/** A view of grid steps [k0, k1) as a grid of its own (no copying). */
export function sliceGrid(grid, k0, k1) {
  const a = Math.max(0, k0), b = Math.min(grid.n, k1);
  return {
    start: grid.start + a * grid.step, step: grid.step, n: Math.max(0, b - a),
    sun: grid.sun.subarray(3 * a, 3 * b), earth: grid.earth.subarray(3 * a, 3 * b),
    sunDist: grid.sunDist.subarray(a, b), dsnMaxEl: grid.dsnMaxEl.subarray(a, b),
  };
}

/**
 * Energy and thermal simulation over steps [k0, k1) of an analysed site, starting from a full battery
 * (or E0 Wh usable) and the touchdown temperature. Loads: operating while lit (≥ litThreshold of the
 * disc), otherwise survival — a fixed wattage, or with the thermal model the survival electronics plus
 * whatever heater power keeps the lander at its minimum temperature.
 * If `rec` is given, per-step load, heater, temperature and state of charge are written into it.
 */
export function simulateEnergy(a, grid, o, k0 = 0, k1 = grid.n, { E0 = null, rec = null } = {}) {
  const b = o.battery, th = o.thermal;
  const dtH = grid.step / 3600000, dtS = grid.step / 1000;
  const usable = b.capacityWh * b.usableFraction;
  let E = E0 ?? (b.startFull ? usable : 0);
  let T = Math.max(th.minC, th.startC) + 273.15;
  let minE = E, empty = 0, D = 0, minD = 0, heatWh = 0, peakHeat = 0, minT = Infinity, maxT = -Infinity;
  for (let k = k0; k < k1; k++) {
    const lit = a.sunFrac[k] >= o.litThreshold;
    let load, heater = 0;
    if (th.enabled) {
      const elec = lit ? b.operatingLoadW : th.survivalElecW;
      const qSun = th.absorptivity * th.sunAreaM2 * a.flux[k] * a.sunFrac[k] * Math.max(0, Math.cos(a.sunEl[k] * DEG));
      const r = thermalStep(T, dtS, qSun, elec, th);
      T = r.T; heater = r.heaterW;
      load = elec + heater;
      heatWh += heater * dtH; peakHeat = Math.max(peakHeat, heater);
      minT = Math.min(minT, T); maxT = Math.max(maxT, T);
    } else load = lit ? b.operatingLoadW : b.survivalLoadW;
    const net = a.power[k] - load;
    D = Math.min(0, batteryStep(D, net, dtH, b)); minD = Math.min(minD, D); // deficit below 'full' with an unlimited battery
    E = Math.min(usable, batteryStep(E, net, dtH, b));
    if (E <= 0) { empty++; E = 0; }
    minE = Math.min(minE, E);
    if (rec) { rec.load[k] = load; rec.heater[k] = heater; rec.temp[k] = th.enabled ? T - 273.15 : NaN; rec.soc[k] = E; }
  }
  return {
    usable, minE, emptyH: empty * dtH, emptySteps: empty, neededUsable: minD === 0 ? 0 : -minD,
    heaterKWh: heatWh / 1000, peakHeaterW: peakHeat, minTempC: Number.isFinite(minT) ? minT - 273.15 : null, maxTempC: Number.isFinite(maxT) ? maxT - 273.15 : null,
  };
}

/**
 * Evaluate one site on a grid. Returns per-step arrays and summary metrics.
 * @param site {lat, lon, heightM}  horizon: Horizon
 */
export function analyseSite(site, horizon, grid, opts = {}) {
  const o = resolveOptions(opts);
  const n = grid.n;
  const obsH = horizon.meta?.observerHeightM ?? o.observerHeightM;
  const p = sitePosition(site.lat, site.lon, (site.heightM || 0) + obsH);
  const basis = enuBasis(site.lat, site.lon);
  const dip = -Math.acos(R_MOON / (R_MOON + obsH / 1000)) / DEG; // smooth-Moon (geometric) horizon
  const out = {
    sunAz: new Float32Array(n), sunEl: new Float32Array(n), sunFrac: new Float32Array(n), sunHz: new Float32Array(n), sunGeo: new Uint8Array(n),
    earthAz: new Float32Array(n), earthEl: new Float32Array(n), earthFrac: new Float32Array(n), earthHz: new Float32Array(n), earthGeo: new Uint8Array(n),
    comms: new Uint8Array(n), dte: new Uint8Array(n), relay: new Uint8Array(n), power: new Float32Array(n), flux: new Float32Array(n),
    load: new Float32Array(n), heater: new Float32Array(n), temp: new Float32Array(n), soc: new Float32Array(n),
    dip,
  };
  const panel = PANELS[o.panel.type] || PANELS['vertical-tracking'];
  const v = [0, 0, 0];
  const dtH = grid.step / 3600000;
  const relay = o.comms.relay ? relayTrack(grid, o.comms.relay) : null;
  let energyWh = 0;
  for (let k = 0; k < n; k++) {
    v[0] = grid.sun[3 * k]; v[1] = grid.sun[3 * k + 1]; v[2] = grid.sun[3 * k + 2];
    const s = azEl(v, p, basis);
    const rs = Math.asin(R_SUN / s.dist) / DEG;
    const hs = horizon.at(s.az);
    const fs = discFraction(s.el, rs, hs);
    v[0] = grid.earth[3 * k]; v[1] = grid.earth[3 * k + 1]; v[2] = grid.earth[3 * k + 2];
    const e = azEl(v, p, basis);
    const re = Math.asin(R_EARTH / e.dist) / DEG;
    const he = horizon.at(e.az);
    out.sunAz[k] = s.az; out.sunEl[k] = s.el; out.sunFrac[k] = fs; out.sunHz[k] = hs; out.sunGeo[k] = s.el >= dip ? 1 : 0;
    out.earthAz[k] = e.az; out.earthEl[k] = e.el; out.earthHz[k] = he; out.earthFrac[k] = discFraction(e.el, re, he); out.earthGeo[k] = e.el >= dip ? 1 : 0;
    const dte = e.el - he >= o.comms.minMarginDeg ? 1 : 0;
    out.dte[k] = dte;
    let rel = 0;
    if (relay) {
      const rv = [relay[3 * k], relay[3 * k + 1], relay[3 * k + 2]];
      const r = azEl(rv, p, basis);
      rel = r.el - horizon.at(r.az) >= o.comms.minMarginDeg && relaySeesEarth(rv, v) ? 1 : 0;
    }
    out.relay[k] = rel;
    out.comms[k] = (dte || rel) && (!o.comms.requireDsn || grid.dsnMaxEl[k] >= o.comms.dsnMinElDeg) ? 1 : 0;
    const flux = SOLAR_CONSTANT * (AU / grid.sunDist[k]) ** 2;
    const w = o.panel.areaM2 * o.panel.efficiency * flux * fs * panel.inc(s.el, s.az, o.panel);
    out.flux[k] = flux; out.power[k] = w;
    energyWh += w * dtH;
  }
  const sim = simulateEnergy(out, grid, o, 0, n, { rec: out });
  out.metrics = summarise(out, grid, o, { ...sim, energyWh });
  out.opts = o;
  return out;
}

/**
 * Per-step trace of a surface stay that starts at step k0 with a full battery and a warm lander
 * (the full-period arrays carry battery and thermal history from the start of the search period).
 */
export function stayTrace(a, grid, k0, durationDays) {
  const end = Math.min(grid.n, k0 + Math.round((durationDays * 86400000) / grid.step));
  const m = Math.max(0, end - k0);
  const rec = { load: new Float32Array(grid.n), heater: new Float32Array(grid.n), temp: new Float32Array(grid.n), soc: new Float32Array(grid.n) };
  const sim = simulateEnergy(a, grid, a.opts, k0, end, { rec });
  return { k0, k1: end, steps: m, ...rec, sim };
}

/** Longest run of steps where pred(k) holds: {hours, k0}. */
export function longestRun(n, pred, dtH, from = 0, to = n) {
  let best = 0, bestK = -1, cur = 0;
  for (let k = from; k < to; k++) {
    if (pred(k)) { cur++; if (cur > best) { best = cur; bestK = k - cur + 1; } } else cur = 0;
  }
  return { hours: best * dtH, k0: bestK };
}

function summarise(a, grid, o, x) {
  const n = grid.n, dtH = grid.step / 3600000, b = o.battery;
  let sf = 0, lit = 0, sunGeo = 0, com = 0, dte = 0, geo = 0, dsn = 0, both = 0, pw = 0, earthAny = 0, rel = 0;
  for (let k = 0; k < n; k++) {
    sf += a.sunFrac[k];
    earthAny += a.earthFrac[k] > 0;
    const l = a.sunFrac[k] >= o.litThreshold;
    lit += l; sunGeo += a.sunGeo[k]; com += a.comms[k]; dte += a.dte[k]; geo += a.earthGeo[k]; rel += a.relay[k] && !a.dte[k];
    dsn += a.dte[k] && grid.dsnMaxEl[k] >= o.comms.dsnMinElDeg;
    both += l && a.comms[k]; pw += a.power[k];
  }
  const dark = longestRun(n, (k) => a.sunFrac[k] < o.litThreshold, dtH);
  const out = longestRun(n, (k) => !a.comms[k], dtH);
  const neededWh = x.neededUsable / b.usableFraction; // nominal capacity
  return {
    hours: n * dtH,
    sunPct: (100 * sf) / n,                 // mean fraction of the solar disc visible
    litPct: (100 * lit) / n,                // at least half the disc above the real skyline
    sunGeoPct: (100 * sunGeo) / n,          // Sun above a smooth-Moon horizon (no terrain)
    longestDarkH: dark.hours, longestDarkStart: dark.k0 >= 0 ? grid.start + dark.k0 * grid.step : null,
    earthGeoPct: (100 * geo) / n,           // Earth above a smooth-Moon horizon
    earthPct: (100 * dte) / n,              // terrain-clear line of sight (+ margin)
    dsnPct: (100 * dsn) / n,                // line of sight AND a DSN complex sees the Moon
    commsPct: (100 * com) / n,              // the link definition in use (DSN optional, relay optional)
    relayOnlyPct: (100 * rel) / n,          // link only through the relay (Earth hidden, relay visible)
    longestOutageH: out.hours, longestOutageStart: out.k0 >= 0 ? grid.start + out.k0 * grid.step : null,
    bothPct: (100 * both) / n,
    meanPowerW: pw / n,
    energyKWh: x.energyWh / 1000,
    minSocPct: x.usable ? (100 * x.minE) / x.usable : 0,
    hoursWithoutPower: x.emptyH,
    survives: x.emptyH === 0,
    batteryNeededWh: neededWh,              // smallest nominal battery that never runs flat over the period
    batteryMarginWh: b.capacityWh - neededWh,
    heaterKWh: x.heaterKWh, peakHeaterW: x.peakHeaterW, minTempC: x.minTempC, maxTempC: x.maxTempC,
    earthAnyPct: (100 * earthAny) / n,      // any part of Earth's disc above the skyline (Mazarico et al. definition)
  };
}

/** Weighted score 0–100: weight w on sunlight, 1−w on communications; battery failure costs 25 points. */
export function score(m, w = 0.5, { battery = true } = {}) {
  return Math.max(0, w * m.litPct + (1 - w) * m.commsPct - (battery && !m.survives ? 25 : 0));
}

/** Daily aggregates (UTC days) for heatmaps. */
export function daily(a, grid) {
  const perDay = Math.round(86400000 / grid.step);
  const days = Math.floor(grid.n / perDay);
  const sun = new Float32Array(days), comms = new Float32Array(days);
  for (let d = 0; d < days; d++) {
    let s = 0, c = 0;
    for (let k = d * perDay; k < (d + 1) * perDay; k++) { s += a.sunFrac[k]; c += a.comms[k]; }
    sun[d] = s / perDay; comms[d] = c / perDay;
  }
  return { days, sun, comms, start: grid.start };
}

/** Continuous periods where pred holds: [{start, end, hours, truncated}] (end exclusive). */
export function periods(a, grid, kind) {
  const o = a.opts;
  const pred = {
    sun: (k) => a.sunFrac[k] >= o.litThreshold,
    dark: (k) => a.sunFrac[k] < o.litThreshold,
    comms: (k) => a.comms[k] === 1,
    outage: (k) => a.comms[k] === 0,
  }[kind];
  const out = [];
  let k0 = -1;
  for (let k = 0; k <= grid.n; k++) {
    const on = k < grid.n && pred(k);
    if (on && k0 < 0) k0 = k;
    if (!on && k0 >= 0) {
      out.push({ start: grid.start + k0 * grid.step, end: grid.start + k * grid.step, hours: ((k - k0) * grid.step) / 3600000, k0, k1: k, truncated: k0 === 0 || k === grid.n });
      k0 = -1;
    }
  }
  return out;
}

/** What is limiting a site or surface stay, in plain words. */
export function limitingConstraint(m, o) {
  const kwh = (wh) => (wh / 1000).toFixed(wh >= 10000 ? 0 : 1);
  if (m.survives === false) return { key: 'battery', severity: 'nogo', text: `Battery runs flat: needs about ${kwh(m.batteryNeededWh)} kWh, has ${kwh(o.battery.capacityWh)} kWh` };
  if (m.longestOutageH > 72) return { key: 'outage', severity: 'caution', text: `Longest Earth-link outage ${(m.longestOutageH / 24).toFixed(1)} days` };
  if (m.longestDarkH > 72) return { key: 'dark', severity: 'caution', text: `Longest dark period ${(m.longestDarkH / 24).toFixed(1)} days` };
  if (Math.min(m.litPct, m.commsPct) >= 95) return { key: 'none', severity: 'go', text: `Nothing limiting: Sun up ${Math.round(m.litPct)}%, Earth link ${Math.round(m.commsPct)}%` };
  if (m.commsPct < m.litPct) return { key: 'comms', severity: m.commsPct < 40 ? 'caution' : 'go', text: `Earth link only ${Math.round(m.commsPct)}% of the time` };
  return { key: 'sun', severity: m.litPct < 40 ? 'caution' : 'go', text: `Sunlight only ${Math.round(m.litPct)}% of the time` };
}

/** Surface-stay metrics for a landing at step k0 lasting durationDays (battery full, lander warm at touchdown). */
export function windowAt(a, grid, k0, durationDays) {
  const o = a.opts, b = o.battery;
  const perH = 3600000 / grid.step, dtH = 1 / perH;
  const want = Math.round(durationDays * 24 * perH);
  const end = Math.min(grid.n, k0 + want);
  const W = Math.max(1, end - k0);
  let lit = 0, com = 0;
  for (let k = k0; k < end; k++) { lit += a.sunFrac[k] >= o.litThreshold; com += a.comms[k]; }
  const sim = simulateEnergy(a, grid, o, k0, end);
  const dark = longestRun(grid.n, (k) => a.sunFrac[k] < o.litThreshold, dtH, k0, end);
  const out = longestRun(grid.n, (k) => !a.comms[k], dtH, k0, end);
  const m = {
    litPct: (100 * lit) / W, commsPct: (100 * com) / W, survives: sim.emptySteps === 0, feasible: sim.emptySteps === 0,
    longestDarkH: dark.hours, longestOutageH: out.hours, hoursWithoutPower: sim.emptyH,
    minSocPct: sim.usable ? (100 * sim.minE) / sim.usable : 0, batteryNeededWh: sim.neededUsable / b.usableFraction,
    heaterKWh: sim.heaterKWh, peakHeaterW: sim.peakHeaterW, minTempC: sim.minTempC,
    complete: end - k0 === want,
  };
  m.batteryMarginWh = b.capacityWh - m.batteryNeededWh;
  m.limiting = limitingConstraint(m, o);
  return m;
}

/**
 * Landing opportunities for one site: for each day, the best touchdown hour (Sun and Earth above
 * the skyline) followed by `durationDays` on the surface. Infeasible stays (battery runs flat) are
 * kept but flagged, and always rank below feasible ones.
 */
export function landingCalendar(a, grid, { durationDays = 14, weight = 0.5, landingSunMarginDeg = 0.5, notBefore = -Infinity } = {}) {
  const perH = 3600000 / grid.step;
  const W = Math.round(durationDays * 24 * perH);
  const perDay = Math.round(24 * perH);
  const days = [];
  for (let d = 0; d * perDay < grid.n; d++) {
    const dayStart = grid.start + d * perDay * grid.step;
    let k0 = -1, bestMargin = -Infinity;
    for (let k = d * perDay; k < Math.min(grid.n, (d + 1) * perDay); k++) {
      const margin = Math.min(a.sunEl[k] - a.sunHz[k] - landingSunMarginDeg, a.earthEl[k] - a.earthHz[k]);
      if (margin > bestMargin) { bestMargin = margin; k0 = k; }
    }
    const entry = { day: d, dayStart, k0, landing: grid.start + k0 * grid.step };
    if (dayStart + 86400000 <= notBefore) { days.push({ ...entry, status: 'past' }); continue; }
    if (bestMargin < 0) { days.push({ ...entry, status: 'no-touchdown', reason: 'Sun or Earth below the skyline all day' }); continue; }
    if (k0 + W > grid.n) { days.push({ ...entry, status: 'beyond' }); continue; }
    const m = windowAt(a, grid, k0, durationDays);
    days.push({ ...entry, status: m.feasible ? 'ok' : 'infeasible', ...m, score: score(m, weight), landingSunEl: a.sunEl[k0], landingEarthEl: a.earthEl[k0] });
  }
  return days;
}

/** Best distinct landing windows (≥ 2 days apart), feasible first. */
export function bestWindows(a, grid, { top = 8, ...opts } = {}) {
  const cal = landingCalendar(a, grid, opts).filter((d) => d.status === 'ok' || d.status === 'infeasible');
  cal.sort((x, y) => (y.feasible - x.feasible) || (y.score - x.score) || (x.landing - y.landing));
  const picked = [];
  for (const w of cal) {
    if (picked.every((p) => Math.abs(p.landing - w.landing) > 2 * 86400000)) picked.push(w);
    if (picked.length >= top) break;
  }
  return picked;
}

// ------------------------------------------------------------------ ranking, sensitivity, explanation
/** Rank sites: [{id, score}] sorted best first. results: Map id → analysis. */
export function rankSites(results, weight, key = 'metrics') {
  return [...results.entries()].map(([id, a]) => ({ id, score: score(a[key] || a.metrics, weight, { battery: false }) })).sort((x, y) => y.score - x.score);
}

/** Which site wins at each power weight from 0 to 1. */
export function weightSweep(results, steps = 10) {
  const wins = new Map();
  const table = [];
  for (let i = 0; i <= steps; i++) {
    const w = i / steps;
    const r = rankSites(results, w);
    table.push({ weight: w, winner: r[0].id });
    if (!wins.has(r[0].id)) wins.set(r[0].id, []);
    wins.get(r[0].id).push(w);
  }
  return { table, wins };
}

/** Median of the other sites' metric values. */
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

const ASPECTS = [
  { key: 'litPct', label: 'sunlight', better: 'high', fmt: (v) => `${Math.round(v)}%`, unitGap: 5 },
  { key: 'commsPct', label: 'Earth-link time', better: 'high', fmt: (v) => `${Math.round(v)}%`, unitGap: 5 },
  { key: 'longestDarkH', label: 'longest dark period', better: 'low', fmt: (v) => (v >= 72 ? `${(v / 24).toFixed(1)} d` : `${Math.round(v)} h`), rel: 0.15 },
  { key: 'longestOutageH', label: 'longest comms outage', better: 'low', fmt: (v) => (v >= 72 ? `${(v / 24).toFixed(1)} d` : `${Math.round(v)} h`), rel: 0.15 },
  { key: 'batteryNeededWh', label: 'battery needed', better: 'low', fmt: (v) => `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kWh`, rel: 0.15 },
];

function compareAspect(asp, v, ref) {
  const d = asp.better === 'high' ? v - ref : ref - v; // positive = better
  const sig = asp.unitGap != null ? Math.abs(v - ref) >= asp.unitGap : Math.abs(v - ref) >= asp.rel * Math.max(1, Math.abs(ref));
  return { better: d > 0, sig, d };
}

/**
 * Explain why a site ranks where it does: strengths and weaknesses against the median of the
 * other sites, and the head-to-head trade-off with a rival.
 */
export function explainSite(id, results, rivalId = null) {
  const a = results.get(id), m = a.metrics;
  const others = [...results.entries()].filter(([k]) => k !== id).map(([, x]) => x.metrics);
  const strengths = [], weaknesses = [];
  for (const asp of ASPECTS) {
    const ref = median(others.map((x) => x[asp.key]));
    const c = compareAspect(asp, m[asp.key], ref);
    if (!c.sig) continue;
    (c.better ? strengths : weaknesses).push({ key: asp.key, text: `${c.better ? (asp.better === 'high' ? 'more' : 'shorter') : (asp.better === 'high' ? 'less' : 'longer')} ${asp.label} (${asp.fmt(m[asp.key])} vs typical ${asp.fmt(ref)})`.replace('shorter battery needed', 'smaller battery needed').replace('longer battery needed', 'larger battery needed') });
  }
  let vs = null;
  if (rivalId && results.has(rivalId)) {
    const r = results.get(rivalId).metrics;
    const wins = [], losses = [];
    for (const asp of ASPECTS) {
      const c = compareAspect(asp, m[asp.key], r[asp.key]);
      if (!c.sig) continue;
      (c.better ? wins : losses).push(`${asp.label} ${asp.fmt(m[asp.key])} vs ${asp.fmt(r[asp.key])}`);
    }
    vs = { rivalId, wins, losses };
  }
  return { strengths, weaknesses, limiting: limitingConstraint(m, a.opts), vs };
}

/**
 * Side-by-side comparison of several sites for the same landing time and surface stay.
 * entries: [{id, a}] → {rows, recommended, reason}
 */
export function tradeoff(entries, grid, landingMs, durationDays, weight) {
  const k0 = Math.max(0, Math.min(grid.n - 1, Math.round((landingMs - grid.start) / grid.step)));
  const cols = entries.map(({ id, a }) => {
    const w = windowAt(a, grid, k0, durationDays);
    const touch = { sun: a.sunEl[k0] - a.sunHz[k0], earth: a.earthEl[k0] - a.earthHz[k0] };
    return { id, ...w, touchSunDeg: touch.sun, touchEarthDeg: touch.earth, score: score(w, weight) };
  });
  const ROWS = [
    { key: 'touchSunDeg', label: 'Sun above skyline at touchdown', better: 'high', fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°` },
    { key: 'touchEarthDeg', label: 'Earth above skyline at touchdown', better: 'high', fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°` },
    { key: 'litPct', label: 'Sunlight during stay', better: 'high', fmt: (v) => `${Math.round(v)}%` },
    { key: 'longestDarkH', label: 'Longest dark period', better: 'low', fmt: (v) => (v >= 72 ? `${(v / 24).toFixed(1)} d` : `${Math.round(v)} h`) },
    { key: 'commsPct', label: 'Earth link during stay', better: 'high', fmt: (v) => `${Math.round(v)}%` },
    { key: 'longestOutageH', label: 'Longest link outage', better: 'low', fmt: (v) => (v >= 72 ? `${(v / 24).toFixed(1)} d` : `${Math.round(v)} h`) },
    { key: 'batteryNeededWh', label: 'Battery needed', better: 'low', fmt: (v) => `${(v / 1000).toFixed(1)} kWh` },
    { key: 'minSocPct', label: 'Lowest battery charge', better: 'high', fmt: (v) => `${Math.round(v)}%` },
    { key: 'score', label: 'Score', better: 'high', fmt: (v) => v.toFixed(1) },
  ];
  const rows = ROWS.map((r) => {
    const vals = cols.map((c) => c[r.key]);
    const best = r.better === 'high' ? Math.max(...vals) : Math.min(...vals);
    const tie = Math.max(...vals) - Math.min(...vals) < 1e-9;
    return { ...r, cells: cols.map((c) => ({ v: c[r.key], text: r.fmt(c[r.key]), best: !tie && Math.abs(c[r.key] - best) < 1e-9 })) };
  });
  const touchOk = (c) => c.touchSunDeg >= 0.5 && c.touchEarthDeg >= 0;
  const ranked = [...cols].sort((x, y) => (touchOk(y) && y.feasible) - (touchOk(x) && x.feasible) || y.score - x.score);
  const rec = ranked[0];
  let reason;
  if (!touchOk(rec)) reason = 'No candidate has both the Sun and Earth above the skyline at this touchdown time.';
  else if (!rec.feasible) reason = 'Every candidate runs its battery flat during this stay; increase the battery or shorten the stay.';
  else {
    const other = ranked[1];
    if (!other) reason = 'Only one site selected.';
    else if (!other.feasible) reason = `The alternative runs its battery flat (needs ${(other.batteryNeededWh / 1000).toFixed(1)} kWh).`;
    else if (!touchOk(other)) reason = 'The alternative does not have the Sun and Earth above its skyline at touchdown.';
    else reason = `Higher weighted score (${rec.score.toFixed(1)} vs ${other.score.toFixed(1)}): ${rec.litPct >= other.litPct ? `more sunlight (${Math.round(rec.litPct)}% vs ${Math.round(other.litPct)}%)` : `more Earth link (${Math.round(rec.commsPct)}% vs ${Math.round(other.commsPct)}%)`}.`;
  }
  return { cols, rows, recommended: rec.id, reason, k0 };
}

/** Status words for the horizon view at step k. */
export function statusAt(a, grid, k) {
  const o = a.opts;
  const f = a.sunFrac[k];
  const sun = f >= 0.99 ? 'SUN UP' : f > 0.01 ? `SUN ${Math.round(f * 100)}% VISIBLE` : a.sunGeo[k] ? 'SUN BLOCKED BY TERRAIN' : 'SUN BELOW HORIZON';
  const sunState = f >= 0.99 ? 'go' : f > 0.01 ? 'caution' : 'nogo';
  const margin = a.earthEl[k] - a.earthHz[k];
  let earth, earthState;
  if (margin < 0) { earth = a.earthGeo[k] ? 'LINK BLOCKED BY TERRAIN' : 'EARTH BELOW HORIZON'; earthState = 'nogo'; }
  else if (margin < o.comms.minMarginDeg) { earth = 'LINK MARGINAL'; earthState = 'caution'; }
  else if (o.comms.requireDsn && grid.dsnMaxEl[k] < o.comms.dsnMinElDeg) { earth = 'NO DSN STATION IN VIEW'; earthState = 'caution'; }
  else { earth = 'LINK AVAILABLE'; earthState = 'go'; }
  return { sun, sunState, earth, earthState };
}

/** Plain-language summary for the public / educator view. */
export function explainMetrics(name, m) {
  const pct = (x) => `${Math.round(x)}%`;
  const parts = [`At ${name}, the Sun is up ${pct(m.litPct)} of the time and Earth is in view ${pct(m.earthPct)} of the time.`];
  parts.push(m.longestDarkH >= 48 ? `The longest night lasts about ${Math.round(m.longestDarkH / 24)} days.` : `The longest stretch without sunlight is about ${Math.round(m.longestDarkH)} hours.`);
  if (m.batteryNeededWh != null) {
    const kwh = m.batteryNeededWh / 1000;
    parts.push(kwh < 0.05 ? 'The panels cover the load all the time, so almost no battery is needed.' : `To stay powered through every dark period in the whole search period, the lander would need about ${kwh >= 10 ? Math.round(kwh) : kwh.toFixed(1)} kWh of battery.`);
  } else parts.push(m.survives ? 'The battery lasts through every dark period with these settings.' : `The battery runs flat for about ${Math.round(m.hoursWithoutPower)} hours in total.`);
  return parts.join(' ');
}

// ------------------------------------------------------------------ recommendation
/**
 * The recommended site: the highest-ranked site whose best landing survives the surface stay
 * (falls back to the top-ranked site when none survives). dopts = {durationDays, notBefore}.
 */
export const ROBUST_MIN_RATE = 0.6;

/**
 * The recommended site: the highest-ranked site whose best landing survives the surface stay. When
 * Monte Carlo survival rates are supplied (dopts.robust: Map id → share of scenarios that succeed), a
 * site must also survive at least ROBUST_MIN_RATE of them; if none does, the most robust surviving site
 * is chosen. Falls back to the top-ranked site when none survives at all.
 */
export function recommend(results, grid, weight, dopts = {}) {
  const ranked = rankSites(results, weight);
  const dec = siteDecisions(results, grid, { ...dopts, weight });
  const ok = ranked.filter((r) => dec.get(r.id)?.feasible);
  let pool = ok, robustApplied = false;
  if (dopts.robust && ok.length) {
    const rate = (id) => dopts.robust.get(id) ?? 0;
    const robust = ok.filter((r) => rate(r.id) >= (dopts.minRate ?? ROBUST_MIN_RATE));
    pool = robust.length ? robust : [...ok].sort((x, y) => rate(y.id) - rate(x.id) || y.score - x.score);
    robustApplied = true;
  }
  const pick = pool[0] || ranked[0];
  const next = (pool.length ? pool : ranked).find((r) => r.id !== pick.id) || null;
  return { id: pick.id, feasible: ok.length > 0, robustApplied, runnerUp: next?.id ?? null, margin: pick.score - (next?.score ?? 0), ranked, dec };
}

/** Which site is recommended at each power weight from 0 to 1 (survivability-aware). */
export function recommendationSweep(results, grid, dopts = {}, steps = 10) {
  const table = [], wins = new Map();
  for (let i = 0; i <= steps; i++) {
    const w = i / steps;
    const id = recommend(results, grid, w, dopts).id;
    table.push({ weight: w, winner: id });
    if (!wins.has(id)) wins.set(id, []);
    wins.get(id).push(w);
  }
  return { table, wins };
}

// ------------------------------------------------------------------ stress tests
/**
 * Re-run the ranking under plausible changes to the inputs and report whether the winner changes.
 * entries: [{id, site (with heightM), horizon, terrain: bool}]; results: the baseline Map id → analysis.
 * Returns {base, tests: [{id, label, detail, winner, changed, runnerUp, margin}], held, total, smooth}.
 * `smooth` (Map id → analysis on a smooth Moon) is filled when any site has real terrain.
 */
export function stressTests(entries, grid, opts, weight, results, dopts = { durationDays: 14 }) {
  const base = recommend(results, grid, weight, dopts).id;
  const tests = [];
  const add = (id, label, detail, r) => tests.push({ id, label, detail, winner: r.id, runnerUp: r.runnerUp, margin: r.margin, changed: r.id !== base });
  const rankSites = (res, w) => recommend(res, grid, w, dopts); // the recommendation (survivability-aware), not just the score ranking
  const rerun = (mk) => {
    const res = new Map();
    for (const e of entries) { const x = mk(e); res.set(e.id, analyseSite(e.site, x.horizon, grid, x.opts)); }
    return res;
  };
  const lo = Math.max(0, Math.round((weight - 0.2) * 100) / 100), hi = Math.min(1, Math.round((weight + 0.2) * 100) / 100);
  if (lo !== weight) add('w-lo', `Priority ${Math.round(lo * 100)}% power`, 'Mission cares 20 points more about the Earth link', rankSites(results, lo));
  if (hi !== weight) add('w-hi', `Priority ${Math.round(hi * 100)}% power`, 'Mission cares 20 points more about sunlight', rankSites(results, hi));
  add('hz-up', 'Skyline 0.5° higher', 'Every horizon raised by 0.5° (map error, boulders, lander deck)', rankSites(rerun((e) => ({ horizon: e.horizon.shifted(0.5), opts })), weight));
  add('hz-down', 'Skyline 0.5° lower', 'Every horizon lowered by 0.5° (taller mast)', rankSites(rerun((e) => ({ horizon: e.horizon.shifted(-0.5), opts })), weight));
  add('margin', 'Link needs 2° clearance', 'Earth must clear the skyline by 2° (antenna beam, multipath)', rankSites(rerun((e) => ({ horizon: e.horizon, opts: { ...opts, comms: { ...opts.comms, minMarginDeg: 2 } } })), weight));
  let smooth = null;
  if (entries.some((e) => e.terrain)) {
    smooth = rerun((e) => ({ horizon: Horizon.smooth(opts.observerHeightM ?? 2), opts }));
    add('smooth', 'No terrain (smooth Moon)', 'What a terrain-blind tool would recommend', rankSites(smooth, weight));
  }
  const held = tests.filter((t) => !t.changed).length;
  return { base, tests, held, total: tests.length, smooth };
}

/** Best landing for every site (feasible first) — the answer to "where and when?". */
export function siteDecisions(results, grid, opts) {
  const out = new Map();
  for (const [id, a] of results) out.set(id, bestWindows(a, grid, { ...opts, top: 1 })[0] || null);
  return out;
}

/** Plain-language difference between two trade-off results (for "what changed"). */
export function describeChange(prev, next, names = (id) => id) {
  if (!prev) return null;
  if (prev.recommended !== next.recommended) {
    const a = next.cols.find((c) => c.id === next.recommended);
    const b = next.cols.find((c) => c.id === prev.recommended);
    const why = [];
    if (b && !b.feasible && a.feasible) why.push(`${names(b.id)} now runs its battery flat`);
    if (b && a.litPct - b.litPct >= 3) why.push(`${names(a.id)} has more sunlight (${Math.round(a.litPct)}% vs ${Math.round(b.litPct)}%)`);
    if (b && a.commsPct - b.commsPct >= 3) why.push(`${names(a.id)} has more Earth link (${Math.round(a.commsPct)}% vs ${Math.round(b.commsPct)}%)`);
    if (b && b.longestDarkH - a.longestDarkH >= 6) why.push(`a shorter longest night (${Math.round(a.longestDarkH)} h vs ${Math.round(b.longestDarkH)} h)`);
    return { changed: true, text: `Recommendation changed from ${names(prev.recommended)} to ${names(next.recommended)}${why.length ? `: ${why.join('; ')}` : ''}.` };
  }
  const p = prev.cols.find((c) => c.id === prev.recommended), n = next.cols.find((c) => c.id === next.recommended);
  const bits = [];
  if (p && n) {
    if (Math.abs(n.litPct - p.litPct) >= 1) bits.push(`sunlight ${Math.round(p.litPct)}% → ${Math.round(n.litPct)}%`);
    if (Math.abs(n.commsPct - p.commsPct) >= 1) bits.push(`Earth link ${Math.round(p.commsPct)}% → ${Math.round(n.commsPct)}%`);
    if (Math.abs(n.batteryNeededWh - p.batteryNeededWh) >= 50) bits.push(`battery needed ${(p.batteryNeededWh / 1000).toFixed(1)} → ${(n.batteryNeededWh / 1000).toFixed(1)} kWh`);
    if (p.feasible !== n.feasible) bits.push(n.feasible ? 'now survives the stay' : 'now runs its battery flat');
  }
  return { changed: false, text: `Still ${names(next.recommended)}${bits.length ? ` (${bits.join(', ')})` : ''}.` };
}
