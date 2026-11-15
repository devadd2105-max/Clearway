// Clearway Lunar — validation of the lunar ephemeris and analysis modules.
// Reference values: JPL Horizons (DE441), observer = coord@301 (Moon, Mean Earth frame,
// sphere R = 1737.4 km), QUANTITIES=4 (apparent airless azimuth/elevation), retrieved 2026-10-15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skyAt, moonOrientation, moonEcliptic, DEG } from '../web/js/lunar/ephem.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(5)} vs ${b} (±${tol})`);
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

import { HORIZONS } from '../web/js/lunar/reference.js';

test('Sun and Earth az/el match JPL Horizons at four lunar sites', () => {
  let worstSun = 0, worstEarth = 0;
  for (const h of HORIZONS) {
    const s = skyAt({ lat: h.site[1], lon: h.site[0] }, Date.parse(h.t))[h.body];
    const dEl = Math.abs(s.el - h.el);
    // azimuth error expressed as an angle on the sky (scaled by cos el)
    const dAz = Math.abs(angDiff(s.az, h.az)) * Math.cos(h.el * DEG);
    const err = Math.hypot(dEl, dAz);
    if (h.body === 'sun') worstSun = Math.max(worstSun, err); else worstEarth = Math.max(worstEarth, err);
    const tol = h.site[1] === 0 ? 0.05 : 0.01; // near-zenith azimuths are ill-conditioned
    assert.ok(dEl < 0.01, `${h.body} el at ${h.site} ${h.t}: ${s.el.toFixed(4)} vs ${h.el}`);
    assert.ok(dAz < tol, `${h.body} az at ${h.site} ${h.t}: ${s.az.toFixed(4)} vs ${h.az}`);
  }
  console.log(`  worst angular error: Sun ${(worstSun * 3600).toFixed(0)}", Earth ${(worstEarth * 3600).toFixed(0)}"`);
});

test('Meeus example 47.a reproduces the published Moon position', () => {
  // 1992 April 12, 0h TT (Meeus example 47.a): T = −0.077221081451
  const Tex = -0.077221081451;
  const m = moonEcliptic(Tex);
  near(m.lam / DEG, 133.162655, 2e-5, 'λ');
  near(m.beta / DEG, -3.229126, 2e-5, 'β');
  near(m.r, 368409.7, 0.2, 'Δ');
});

test('IAU Moon pole points near RA 270°, Dec 66.5°', () => {
  const o = moonOrientation(0.27);
  near(o.ra / DEG, 270, 5, 'RA'); near(o.dec / DEG, 66.5, 2, 'Dec');
});

// ---------------------------------------------------------------- horizon, analysis, transfer
import { Horizon, discFraction } from '../web/js/lunar/horizon.js';
import { ephemerisGrid, analyseSite, daily, bestWindows, score, PANELS, explainMetrics } from '../web/js/lunar/analysis.js';
import { lunarTransfer, missionTimeline } from '../web/js/lunar/transfer.js';
import { SITES, isPolar } from '../web/js/lunar/sites.js';

test('disc fraction is a circular segment', () => {
  near(discFraction(0, 0.25, 0), 0.5, 1e-12, 'centre on horizon');
  assert.equal(discFraction(1, 0.25, 0), 1); assert.equal(discFraction(-1, 0.25, 0), 0);
  near(discFraction(0.125, 0.25, 0), 1 - (Math.acos(0.5) - 0.5 * Math.sqrt(0.75)) / Math.PI, 1e-12, 'half-radius above');
  assert.ok(discFraction(0.1, 0.25, 0) > discFraction(0.05, 0.25, 0));
});

test('horizon interpolation wraps through north and smooth horizon equals the dip', () => {
  const h = new Horizon([0, 1, 2, 3], { azStep: 90 });
  near(h.at(45), 0.5, 1e-6, 'interp'); near(h.at(315), 1.5, 1e-6, 'wrap'); near(h.at(-45), 1.5, 1e-6, 'negative az');
  near(Horizon.smooth(2).at(10), -0.0870, 2e-4, '2 m dip');
  near(h.maxOver(0, 45), 1.5, 1e-6, 'max over disc width');
});

const grid = ephemerisGrid(Date.UTC(2026, 10, 1), Date.UTC(2027, 1, 1), 60);
const year = ephemerisGrid(Date.UTC(2026, 10, 1), Date.UTC(2027, 10, 1), 60); // one full polar 'year' of seasons

test('south-pole sunlight is seasonal and terrain matters', () => {
  const site = { lat: -89.5, lon: 0 };
  const summer = analyseSite(site, Horizon.smooth(2), grid);
  assert.equal(summer.metrics.litPct, 100, 'southern summer (Nov–Jan 2026–27): the Sun never sets at 89.5°S on a smooth Moon');
  const flat = analyseSite(site, Horizon.smooth(2), year);
  assert.ok(flat.metrics.litPct > 30 && flat.metrics.litPct < 80, `flat lit ${flat.metrics.litPct}`);
  assert.ok(flat.metrics.longestDarkH > 24 * 30, 'months-long winter darkness');
  const sunElMax = Math.max(...flat.sunEl), sunElMin = Math.min(...flat.sunEl);
  assert.ok(sunElMax < 2.1 && sunElMin > -2.1, 'Sun stays within ~1.6° of the horizon at 89.5°S');
  const wall = analyseSite(site, new Horizon(new Array(720).fill(8)), grid); // Earth reaches ~6.7° at the pole through libration
  assert.equal(wall.metrics.litPct, 0); assert.equal(wall.metrics.earthPct, 0);
  assert.equal(wall.metrics.survives, false);
  const sunk = analyseSite(site, new Horizon(new Array(720).fill(-3)), grid);
  assert.equal(sunk.metrics.litPct, 100, 'a peak with the horizon 3° down is always lit');
  assert.ok(sunk.metrics.survives);
});

test('panel orientation: vertical beats horizontal by ~40× at the pole', () => {
  const site = { lat: -89.5, lon: 0 }, hz = new Horizon(new Array(720).fill(-3));
  const v = analyseSite(site, hz, grid, { panel: { type: 'vertical-tracking' } }).metrics.meanPowerW;
  const h = analyseSite(site, hz, grid, { panel: { type: 'horizontal' } }).metrics.meanPowerW;
  assert.ok(v / h > 30, `${v.toFixed(0)} W vs ${h.toFixed(1)} W`);
  near(v, 2 * 0.28 * 1361, 40, 'tracking vertical panel ≈ area × efficiency × solar constant');
  assert.ok(Object.keys(PANELS).length >= 4);
});

test('battery simulation and weighted score', () => {
  const site = { lat: -89.5, lon: 0 };
  const a = analyseSite(site, Horizon.smooth(2), year, { battery: { capacityWh: 1e7, loadW: 50 } });
  assert.ok(a.metrics.survives);
  const b = analyseSite(site, Horizon.smooth(2), year, { battery: { capacityWh: 100, loadW: 500 } });
  assert.ok(!b.metrics.survives && b.metrics.hoursWithoutPower > 0);
  assert.equal(score({ litPct: 80, commsPct: 40, survives: true }, 1), 80);
  assert.equal(score({ litPct: 80, commsPct: 40, survives: false }, 0), 15);
  assert.match(explainMetrics('Test', a.metrics), /Sun is up \d+%/);
});

test('Earth stays near a fixed direction (libration only) and DSN sees the Moon most of the time', () => {
  const a = analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid);
  const azs = Array.from(a.earthAz).map((z) => ((z + 180) % 360) - 180);
  assert.ok(Math.max(...azs) - Math.min(...azs) < 25, 'Earth wanders only by libration');
  const els = Array.from(a.earthEl);
  assert.ok(Math.max(...els) - Math.min(...els) < 16, 'elevation range set by libration');
  assert.ok(a.metrics.dsnPct <= a.metrics.earthPct);
  let dsnUp = 0; for (let k = 0; k < grid.n; k++) dsnUp += grid.dsnMaxEl[k] >= 10;
  assert.ok(dsnUp / grid.n > 0.8, `DSN coverage ${(100 * dsnUp / grid.n).toFixed(0)}%`);
});

test('daily aggregation and best landing windows', () => {
  const a = analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid);
  const d = daily(a, grid);
  assert.equal(d.days, Math.floor(grid.n / 24));
  const w = bestWindows(a, grid, { durationDays: 10, top: 5 });
  assert.ok(w.length > 0);
  for (let i = 1; i < w.length; i++) assert.ok(w[i - 1].score >= w[i].score);
  for (const x of w) assert.ok(x.landingSunEl > a.sunHz[x.k0] && x.landingEarthEl > a.earthHz[x.k0], 'Sun and Earth up at touchdown');
});

test('transfer Δv matches textbook Hohmann values', () => {
  const t = lunarTransfer({ parkAltKm: 185, tofDays: 10, lloAltKm: 100 });
  near(t.dv.tli, 3.135, 0.01, 'TLI from 185 km');
  near(t.tofDays, 4.98, 0.03, 'Hohmann time of flight');
  near(t.dv.loi, 0.824, 0.01, 'LOI into 100 km orbit');
  assert.ok(t.clamped);
  const fast = lunarTransfer({ parkAltKm: 185, tofDays: 3, lloAltKm: 100 });
  near(fast.tofDays, 3, 1e-6, 'fast transfer');
  assert.ok(fast.dv.tli > t.dv.tli && fast.dv.loi > t.dv.loi, 'faster costs more');
  const tl = missionTimeline(Date.UTC(2027, 0, 10), { parkHours: 2, tofDays: 4, lloDays: 1 });
  assert.equal(tl.launch, Date.UTC(2027, 0, 10) - (5 * 86400000 + 2 * 3600000));
});

test('site list is well formed: south-pole set plus flown CLPS contrast sites', () => {
  const ids = new Set();
  for (const s of SITES) {
    assert.ok(s.lat >= -90 && s.lat <= 90 && s.lon >= -180 && s.lon <= 360, s.id);
    assert.ok(s.source && s.name && s.short, s.id);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`); ids.add(s.id);
  }
  assert.ok(SITES.filter(isPolar).length >= 10, 'the south polar region is the focus');
  for (const id of ['im1', 'im2', 'blueghost']) assert.ok(ids.has(id), id);
  near(SITES.find((s) => s.id === 'blueghost').lat, 18.56, 0.01, 'Blue Ghost M1 in Mare Crisium');
});

test('battery needed equals the deepest energy deficit; windows respect the lead time', () => {
  const site = { lat: -89.5, lon: 0 };
  const ideal = { capacityWh: 1e9, loadW: 100, usableFraction: 1, chargeEff: 1, dischargeEff: 1 };
  const a = analyseSite(site, Horizon.smooth(2), year, { battery: ideal });
  const full = 100 * a.metrics.longestDarkH; // a night with no sun needs load × duration (less a little twilight power)
  assert.ok(a.metrics.batteryNeededWh <= full * 1.01 && a.metrics.batteryNeededWh > full * 0.9, `${a.metrics.batteryNeededWh} vs ${full}`);
  const lit = analyseSite(site, new Horizon(new Array(720).fill(-3)), grid);
  assert.equal(lit.metrics.batteryNeededWh, 0, 'always lit: no battery needed');
  const real = analyseSite(site, Horizon.smooth(2), year, { battery: { ...ideal, usableFraction: 0.8, dischargeEff: 0.95 } });
  near(real.metrics.batteryNeededWh, a.metrics.batteryNeededWh / 0.8 / 0.95, a.metrics.batteryNeededWh * 0.02, 'usable fraction and discharge efficiency raise the nominal size');
  const late = bestWindows(analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid), grid, { durationDays: 5, notBefore: grid.start + 30 * 86400000 });
  for (const w of late) assert.ok(w.landing >= grid.start + 30 * 86400000);
  assert.equal(score({ litPct: 80, commsPct: 40, survives: false }, 1, { battery: false }), 80);
});

// ---------------------------------------------------------------- decision support
import { periods, windowAt, landingCalendar, rankSites, weightSweep, explainSite, tradeoff, statusAt, stressTests, siteDecisions, describeChange, limitingConstraint } from '../web/js/lunar/analysis.js';

const lit = new Horizon(new Array(720).fill(-3));   // a peak: always lit, Earth always clear
const wall = new Horizon(new Array(720).fill(8));    // a pit: never lit, Earth never in view

test('periods partition the timeline and agree with the metrics', () => {
  const a = analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), year);
  const sun = periods(a, year, 'sun'), dark = periods(a, year, 'dark');
  const total = [...sun, ...dark].reduce((s, p) => s + p.hours, 0);
  near(total, year.n, 1e-6, 'sunlit + dark cover every hour');
  near(Math.max(...dark.map((p) => p.hours)), a.metrics.longestDarkH, 1e-9, 'longest dark period');
  near(sun.reduce((s, p) => s + p.hours, 0) / year.n * 100, a.metrics.litPct, 1e-6, 'lit fraction');
  for (let i = 1; i < sun.length; i++) assert.ok(sun[i].start >= sun[i - 1].end, 'chronological, non-overlapping');
  assert.ok(dark[0].k0 === 0 || sun[0].k0 === 0, 'first period starts at the beginning');
  const out = periods(a, year, 'outage'), up = periods(a, year, 'comms');
  near([...out, ...up].reduce((s, p) => s + p.hours, 0), year.n, 1e-6, 'link up + outage cover every hour');
});

test('windowAt: battery feasibility, margin and limiting constraint', () => {
  const site = { lat: -89.5, lon: 0 };
  const sunny = windowAt(analyseSite(site, lit, grid), grid, 0, 14);
  assert.ok(sunny.feasible && sunny.complete);
  assert.equal(sunny.minSocPct, 100); assert.equal(sunny.batteryNeededWh, 0);
  assert.equal(sunny.batteryMarginWh, 2000);
  const pit = analyseSite(site, wall, grid, { battery: { capacityWh: 2000, survivalLoadW: 120 } });
  const w = windowAt(pit, grid, 0, 14);
  assert.ok(!w.feasible, 'a dark pit drains the battery');
  // usable 1600 Wh at 95% discharge efficiency lasts 1600 × 0.95 / 120 ≈ 12.7 h
  near(w.hoursWithoutPower, 14 * 24 - Math.ceil(1600 * 0.95 / 120), 1.01, 'flat after the usable energy runs out');
  near(w.batteryNeededWh, (120 * 14 * 24) / 0.95 / 0.8, 1, 'nominal size for the whole stay');
  assert.ok(w.batteryMarginWh < 0);
  assert.equal(w.limiting.key, 'battery'); assert.equal(w.limiting.severity, 'nogo');
  assert.equal(limitingConstraint({ survives: true, longestOutageH: 100, longestDarkH: 10, commsPct: 50, litPct: 60 }, w).key === 'outage', true);
});

test('operating and survival loads switch with sunlight', () => {
  const a = analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid, { battery: { operatingLoadW: 300, survivalLoadW: 90 } });
  for (let k = 0; k < grid.n; k += 37) assert.equal(a.load[k], a.sunFrac[k] >= 0.5 ? 300 : 90);
  const usable = 2000 * 0.8;
  for (let k = 0; k < grid.n; k += 41) assert.ok(a.soc[k] >= 0 && a.soc[k] <= usable + 1e-6);
});

test('landing calendar flags past, no-touchdown, infeasible and beyond-the-period days', () => {
  const site = { lat: -86, lon: 0 };
  const a = analyseSite(site, Horizon.smooth(2), grid);
  const cal = landingCalendar(a, grid, { durationDays: 14, notBefore: grid.start + 5 * 86400000 });
  assert.equal(cal.length, Math.ceil(grid.n / 24));
  assert.ok(cal.slice(0, 4).every((d) => d.status === 'past'));
  assert.ok(cal.slice(-10).every((d) => d.status === 'beyond' || d.status === 'no-touchdown'));
  assert.ok(cal.some((d) => d.status === 'ok'));
  const pit = landingCalendar(analyseSite(site, wall, grid), grid, { durationDays: 5 });
  assert.ok(pit.every((d) => d.status === 'no-touchdown' || d.status === 'beyond'), 'Sun and Earth behind terrain: no touchdown');
  const starved = landingCalendar(analyseSite({ lat: -89.5, lon: 0 }, new Horizon(new Array(720).fill(-3)), grid, { battery: { capacityWh: 1, operatingLoadW: 5000 } }), grid, { durationDays: 3 });
  assert.ok(starved.some((d) => d.status === 'infeasible'), 'load above array output runs the battery flat');
  const best = bestWindows(analyseSite(site, Horizon.smooth(2), grid, { battery: { capacityWh: 1, operatingLoadW: 5000 } }), grid, { durationDays: 3, top: 3 });
  assert.ok(best.every((w) => !w.feasible));
});

function threeSites() {
  const results = new Map();
  // 'sunny' always lit, Earth blocked; 'talk' Earth always visible, never lit; 'mixed' smooth Moon
  const sunnyHz = new Horizon(Array.from({ length: 720 }, (_, i) => (Math.abs(((i * 0.5) - 0 + 540) % 360 - 180) < 40 ? 12 : -3)));
  results.set('sunny', analyseSite({ lat: -89.5, lon: 0 }, sunnyHz, grid));
  results.set('talk', analyseSite({ lat: -89.5, lon: 0 }, new Horizon(Array.from({ length: 720 }, (_, i) => (Math.abs(((i * 0.5) + 540) % 360 - 180) < 40 ? -3 : 12))), grid));
  results.set('mixed', analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid));
  return results;
}

test('weight sweep: a power site wins at high weight, a comms site at low weight', () => {
  const r = threeSites();
  const ms = Object.fromEntries([...r].map(([id, a]) => [id, a.metrics]));
  assert.ok(ms.sunny.litPct > ms.talk.litPct && ms.talk.commsPct > ms.sunny.commsPct, JSON.stringify({ s: [ms.sunny.litPct, ms.sunny.commsPct], t: [ms.talk.litPct, ms.talk.commsPct] }));
  const sw = weightSweep(r, 10);
  assert.equal(sw.table.length, 11);
  assert.equal(sw.table[10].winner, rankSites(r, 1)[0].id);
  assert.equal(rankSites(r, 1)[0].id === 'talk', false, 'pure power weight never picks the site that is always dark');
  assert.equal(rankSites(r, 0)[0].id === 'sunny', false, 'pure comms weight never picks the site whose Earth is always blocked');
  assert.ok([...sw.wins.values()].reduce((s, w) => s + w.length, 0) === 11);
});

test('explainSite names strengths, weaknesses and the head-to-head trade-off', () => {
  const r = threeSites();
  const x = explainSite('sunny', r, 'talk');
  assert.ok(x.strengths.some((s) => s.key === 'litPct'), JSON.stringify(x.strengths));
  assert.ok(x.weaknesses.some((s) => s.key === 'commsPct'), JSON.stringify(x.weaknesses));
  assert.ok(x.vs.wins.some((t) => t.startsWith('sunlight')) && x.vs.losses.some((t) => t.startsWith('Earth-link')));
  assert.ok(x.limiting.text.length > 5);
});

test('trade-off explorer: recommendation follows the priority and explains changes', () => {
  const r = threeSites();
  const entries = ['sunny', 'talk'].map((id) => ({ id, a: r.get(id) }));
  const t0 = grid.start + 10 * 86400000;
  const power = tradeoff(entries, grid, t0, 7, 0.9);
  const comms = tradeoff(entries, grid, t0, 7, 0.1);
  assert.equal(power.cols.length, 2);
  assert.ok(power.rows.find((x) => x.key === 'litPct').cells.some((c) => c.best));
  // 'talk' is never lit, so its battery dies and it cannot be recommended whatever the weight
  assert.equal(power.recommended, 'sunny');
  assert.equal(comms.recommended, 'sunny');
  assert.match(comms.reason, /battery|skyline/);
  const ch = describeChange(power, comms, (id) => id.toUpperCase());
  assert.equal(ch.changed, false); assert.match(ch.text, /^Still SUNNY/);
  const flipped = describeChange({ ...power, recommended: 'talk' }, power, (id) => id);
  assert.equal(flipped.changed, true); assert.match(flipped.text, /from talk to sunny/);
});

test('horizon status words distinguish geometry from terrain blocking', () => {
  const a = analyseSite({ lat: -89.5, lon: 0 }, wall, grid);
  const st = statusAt(a, grid, 10);
  assert.equal(st.earthState, 'nogo');
  assert.match(st.earth, /BLOCKED BY TERRAIN|BELOW HORIZON/);
  if (a.sunGeo[10]) assert.equal(st.sun, 'SUN BLOCKED BY TERRAIN');
  const b = analyseSite({ lat: -89.5, lon: 0 }, lit, grid);
  assert.equal(statusAt(b, grid, 10).earth, 'LINK AVAILABLE');
  assert.equal(statusAt(b, grid, 10).sun, 'SUN UP');
  assert.ok(b.metrics.dsnPct <= b.metrics.earthPct, 'DSN tier is a subset of line of sight');
  assert.ok(b.metrics.earthPct >= b.metrics.earthGeoPct, 'a summit sees past the smooth-Moon horizon');
});

test('shifted skyline and stress tests', () => {
  const h = new Horizon([0, 1, 2, 3], { azStep: 90, source: 'LOLA' });
  near(h.shifted(0.5).at(45), 1.0, 1e-6, 'raised by 0.5°');
  assert.equal(h.shifted(0.5).terrain, true);
  const sites = [
    { id: 'peak', site: { lat: -89.5, lon: 0, heightM: 0 }, horizon: new Horizon(new Array(720).fill(-2.5), { source: 'LOLA' }), terrain: true },
    { id: 'flat', site: { lat: -86, lon: 0, heightM: 0 }, horizon: Horizon.smooth(2), terrain: false },
  ];
  const results = new Map(sites.map((e) => [e.id, analyseSite(e.site, e.horizon, grid)]));
  const st = stressTests(sites, grid, {}, 0.5, results);
  assert.equal(st.base, 'peak');
  assert.ok(st.total >= 5 && st.held <= st.total);
  assert.ok(st.smooth instanceof Map && st.smooth.has('peak'), 'terrain-vs-smooth comparison when terrain is present');
  assert.ok(st.tests.every((t) => typeof t.changed === 'boolean' && t.winner));
  const dec = siteDecisions(results, grid, { durationDays: 7 });
  assert.ok(dec.get('peak').feasible);
});

import { recommend, recommendationSweep } from '../web/js/lunar/analysis.js';

test('the recommendation skips a higher-ranked site that cannot survive the stay', () => {
  const site = { lat: -89.5, lon: 0 };
  const results = new Map([
    // high score, but a load the array can never cover: battery always runs flat
    ['hungry', analyseSite(site, new Horizon(new Array(720).fill(-3)), grid, { battery: { capacityWh: 1, operatingLoadW: 5000, survivalLoadW: 5000 } })],
    ['modest', analyseSite({ lat: -86, lon: 0 }, Horizon.smooth(2), grid)],
  ]);
  assert.equal(rankSites(results, 0.5)[0].id, 'hungry', 'it scores higher');
  const r = recommend(results, grid, 0.5, { durationDays: 7 });
  assert.equal(r.id, 'modest');
  assert.equal(r.feasible, true);
  const sw = recommendationSweep(results, grid, { durationDays: 7 }, 4);
  assert.ok(sw.table.every((x) => x.winner === 'modest'), 'survivability beats score at every weight');
});
