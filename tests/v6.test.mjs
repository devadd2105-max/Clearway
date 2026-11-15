// Clearway 6 — tests for the radio link budget, the relay satellite, historical analysis
// (Chandrayaan-3), the new Simple-mode wording and the data-source register entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkBudget, fmtRate, fmtBits, relayPosition, relaySeesEarth, stayData, RELAY_PRESETS, RADIO_DEFAULTS } from '../web/js/lunar/radio.js';
import { ephemerisGrid, analyseSite } from '../web/js/lunar/analysis.js';
import { Horizon } from '../web/js/lunar/horizon.js';
import { CH3, analyseLanding } from '../web/js/lunar/chandrayaan.js';
import { simpleReasons, simpleAdvice } from '../web/js/lunar/simple.js';
import { DATA_SOURCES } from '../web/js/about.js';
import { SITES } from '../web/js/lunar/sites.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('radio: X-band link at the mean Earth–Moon distance matches a hand calculation', () => {
  // λ = 0.03548 m; EIRP 20 dBW; FSPL 222.68 dB; 34 m dish at 60% = 67.36 dBi; T = 30 K (14.77 dB-K)
  // C/N0 = 20 − 222.68 − 3 + 67.36 − 14.77 + 228.6 = 75.51 dB-Hz; rate = 75.51 − 2.5 − 3 = 70.0 dB-bit/s ≈ 10 Mbit/s
  const r = linkBudget(384400);
  near(r.lambdaM, 0.035478, 1e-5, 'wavelength');
  near(r.fsplDb, 222.68, 0.02, 'free-space loss');
  near(r.grDbi, 67.36, 0.02, 'dish gain');
  near(r.cn0DbHz, 75.51, 0.05, 'C/N0');
  assert.ok(r.maxRateBps > 9e6 && r.maxRateBps < 11e6, `rate ${r.maxRateBps}`);
  assert.equal(fmtRate(r.maxRateBps), '10 Mbit/s');
});

test('radio: twice the distance costs 6 dB, a 70 m dish gains 6.3 dB', () => {
  const base = linkBudget(384400);
  near(base.cn0DbHz - linkBudget(768800).cn0DbHz, 6.02, 0.01, 'inverse square');
  near(linkBudget(384400, { dishM: 70 }).cn0DbHz - base.cn0DbHz, 20 * Math.log10(70 / 34), 0.01, 'dish');
  // same lander antenna gain: Ka's higher dish gain is cancelled by its higher path loss, and its noise is higher
  assert.ok(linkBudget(384400, { band: 'Ka' }).cn0DbHz < base.cn0DbHz);
  assert.equal(linkBudget(384400, { txPowerW: 1e-12 }).maxRateBps > 0, true);
  assert.equal(fmtRate(0), '0 bit/s');
  assert.equal(fmtBits(8e9), '1.0 GB');
  assert.equal(RADIO_DEFAULTS.band, 'X');
});

test('relay: far point of the frozen orbit is over the south pole at the right distance', () => {
  const o = RELAY_PRESETS.elfo;
  const t = Date.UTC(2026, 0, 1); // epoch, mean anomaly 180° = apoapsis
  const r = relayPosition(t, o);
  const d = Math.hypot(...r);
  near(d, o.aKm * (1 + o.e), 1, 'apoapsis radius');
  assert.ok(r[2] < 0, 'apoapsis is south');
  near(Math.asin(r[2] / d) * 180 / Math.PI, -o.iDeg, 0.01, 'latitude of apoapsis = −inclination');
  // half a period later it is at periapsis over the north
  const P = 2 * Math.PI * Math.sqrt(o.aKm ** 3 / 4902.800066) * 1000;
  const q = relayPosition(t + P / 2, o);
  near(Math.hypot(...q), o.aKm * (1 - o.e), 1, 'periapsis radius');
  assert.ok(q[2] > 0, 'periapsis is north');
});

test('relay: Earth is hidden only when the Moon is in the way', () => {
  assert.equal(relaySeesEarth([0, 0, -5000], [0, 0, 384400]), false);
  assert.equal(relaySeesEarth([0, 0, -5000], [384400, 0, 0]), true);
  assert.equal(relaySeesEarth([0, 0, 5000], [0, 0, 384400]), true);
});

test('relay: adds contact time at a far-side-facing polar site and never removes any', () => {
  const grid = ephemerisGrid(Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1), 60);
  const site = { lat: -89.5, lon: 180 };
  const h = Horizon.smooth(2);
  const direct = analyseSite(site, h, grid, {});
  const relayed = analyseSite(site, h, grid, { comms: { relay: RELAY_PRESETS.elfo } });
  let gained = 0;
  for (let k = 0; k < grid.n; k++) {
    assert.ok(relayed.comms[k] >= direct.comms[k], 'a relay never takes contact away');
    if (relayed.comms[k] && !direct.dte[k]) gained++;
  }
  assert.ok(gained > 0, 'the relay covers some hours with Earth below the horizon');
  assert.ok(relayed.metrics.commsPct >= direct.metrics.commsPct);
  const d = stayData(direct, grid, 0, grid.n);
  assert.ok(d.hours > 0 && d.bits > 0 && d.minRateBps <= d.maxRateBps);
});

test('Chandrayaan-3: the engine reproduces the shape of ISRO\'s timeline on a smooth Moon', () => {
  const r = analyseLanding(Horizon.smooth(2));
  assert.ok(r.sunrise < CH3.landing, 'the Sun had already risen at touchdown');
  assert.ok(r.touchdown.sunElDeg > 0 && r.touchdown.sunElDeg < 15, `low Sun at touchdown (${r.touchdown.sunElDeg})`);
  assert.ok(r.touchdown.earthLink, 'Earth in view at touchdown');
  assert.ok(r.daylightTotalH > 280 && r.daylightTotalH < 380, `about two weeks of daylight (${r.daylightTotalH} h)`);
  assert.ok(r.landerSleepBeforeSunsetH > 0 && r.landerSleepBeforeSunsetH < 72, `lander put to sleep shortly before sunset (${r.landerSleepBeforeSunsetH} h)`);
  assert.ok(r.wakeAfterSunriseH > 0 && r.wakeAfterSunriseH < 120, `wake-up attempts started after the next sunrise (${r.wakeAfterSunriseH} h)`);
  assert.ok(r.nightH > 300 && r.nightH < 400, `about two weeks of night (${r.nightH} h)`);
  assert.ok(r.nightEnergyKWh > 0);
  assert.equal(r.terrain, false);
});

test('Chandrayaan-3 site is listed but off by default', () => {
  const s = SITES.find((x) => x.id === 'ch3');
  assert.ok(s, 'site present');
  assert.equal(s.on, false);
  near(s.lat, CH3.site.lat, 1e-4, 'same latitude as the analysis');
});

test('simple: honest advice for past dates, short searches and a near-flat battery', () => {
  assert.match(simpleAdvice(null, { reason: 'past', stayDays: 14 }), /historical analysis/);
  assert.match(simpleAdvice(null, { reason: 'short', stayDays: 200 }), /200-day/);
  assert.match(simpleAdvice(null, { stayDays: 14, searchDays: 90 }), /90 days/);
  const r = simpleReasons({ litPct: 70, commsPct: 60, longestDarkH: 50, minSocPct: 4, batteryMarginWh: 20, feasible: true }, { stayDays: 14, batteryWh: 2000 });
  assert.equal(r[2].warn, true);
  assert.match(r[2].title, /nearly runs out/);
  assert.doesNotMatch(r[2].title, /never below 0%/);
  const withLink = simpleReasons({ litPct: 90, commsPct: 80, longestDarkH: 0, minSocPct: 100, feasible: true }, { stayDays: 14, link: { hours: 100, bits: 8e12, maxRateBps: 1e7, dishM: 34 } });
  assert.match(withLink[1].text, /10 Mbit\/s.*1\.0 TB/);
});

test('data register cites the new sources', () => {
  const names = DATA_SOURCES.map((d) => d.name).join(' | ');
  assert.match(names, /Shape-from-shading/);
  assert.match(names, /Chandrayaan-3/);
  assert.match(names, /Radio link budget/);
  const sfs = DATA_SOURCES.find((d) => /Shape-from-shading/.test(d.name));
  assert.match(sfs.source, /10\.5281\/zenodo\.17954508/);
  assert.equal(sfs.status({ meta: { tiles: [{ name: 'Haworth', product: 'PGDA 104 (shape-from-shading)', calibration: { corr: 0.99 } }] } }), 'Installed: Haworth (r = 0.990)');
});
