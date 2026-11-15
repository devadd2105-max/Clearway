// Run with: node --test tests/
// Covers the orbital mechanics, planner and screening engine without a browser or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
globalThis.performance ??= performance;

import * as O from '../web/js/orbit.js';
import { planMission } from '../web/js/planner.js';
import { screenCandidates, pcIndicative, segmentMin } from '../web/js/screening.js';
import { parseTle, elementsFromTle, tleEpochMs, classify } from '../web/js/catalog.js';
import { evaluateWeather } from '../web/js/weather.js';

const D = O.DEG;
const KSC = { lat: 28.6082, lon: -80.6041, altM: 5, corridor: { min: 35, max: 120 } };
const VSFB = { lat: 34.6321, lon: -120.6106, altM: 120, corridor: { min: 147, max: 201 } };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('GMST at J2000.0 is 280.46°', () => {
  near(O.gmst(Date.UTC(2000, 0, 1, 12)) / D, 280.4606, 0.001, 'gmst');
});

test('sun-synchronous inclination matches published values', () => {
  near(O.ssoInclination(550) / D, 97.59, 0.05, 'SSO 550 km');
  near(O.ssoInclination(800) / D, 98.60, 0.05, 'SSO 800 km');
  assert.equal(O.ssoInclination(7000), null);
});

test('ISS-plane azimuth from KSC is ~45° inertial, ~43° relative to Earth', () => {
  const latc = O.geocentricLat(KSC.lat * D);
  const azI = O.inertialAzimuth(latc, 51.64 * D, 'asc');
  near(azI / D, 44.9, 0.4, 'inertial azimuth');
  const azR = O.rotatingAzimuth(azI, latc, O.circularSpeed(O.RE + 400));
  near(azR / D, 42.7, 0.8, 'rotating azimuth');
  assert.equal(O.inertialAzimuth(latc, 20 * D, 'asc'), null, 'inclination below latitude is unreachable');
});

test('corridor check handles wrap through north', () => {
  assert.ok(O.inCorridor(355, { min: 349.5, max: 93.5 }));
  assert.ok(O.inCorridor(10, { min: 349.5, max: 93.5 }));
  assert.ok(!O.inCorridor(180, { min: 349.5, max: 93.5 }));
});

test('planar launch times put the site in the target plane', () => {
  const inc = 51.64 * D, raan = 123 * D;
  const t0 = Date.UTC(2026, 10, 14);
  const times = O.findPlanarTimes(KSC, inc, () => raan, t0, t0 + 86400000);
  assert.equal(times.length, 2, 'two opportunities per day');
  const n = [Math.sin(raan) * Math.sin(inc), -Math.cos(raan) * Math.sin(inc), Math.cos(inc)];
  for (const { t } of times) {
    const r = O.unit(O.siteEci(KSC, t));
    near(O.dot(r, n), 0, 2e-5, 'site out of plane');
  }
});

test('trajectory reaches the requested orbit continuously', () => {
  const t0 = Date.UTC(2026, 10, 14, 3);
  const latc = O.geocentricLat(KSC.lat * D);
  const azI = O.inertialAzimuth(latc, 51.64 * D, 'asc');
  const tr = O.buildTrajectory({ site: KSC, t0, azInertial: azI, hTargetKm: 420, tInsSec: 540, downrangeKm: 1800 });
  near(tr.inc / D, 51.64, 0.05, 'inclination');
  near(O.norm(tr.at(0)), O.norm(O.siteEci(KSC, t0)), 1e-6, 'starts at pad');
  const a = tr.at(539.999), b = tr.at(540.001);
  near(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), 0, 0.05, 'continuity at insertion');
  near(O.norm(tr.at(3000)) - O.RE, 420, 1e-6, 'circular orbit altitude');
});

test('SSO planner from Vandenberg flies south inside the corridor', () => {
  const m = {
    site: VSFB,
    orbit: { mode: 'sso', hKm: 550, nodeTime: '10:30', nodeType: 'desc', nodeTolMin: 5, planeTolDeg: 0.2 },
    window: { startMs: Date.UTC(2026, 10, 14), days: 2, candStepMin: 1, passPref: 'auto', durationMin: 60 },
    ascent: { tInsSec: 540, downrangeKm: 1800, lossesKms: 1.6 },
  };
  const p = planMission(m);
  assert.deepEqual(p.errors, []);
  assert.ok(p.windows.length >= 2, 'at least one window per day');
  for (const w of p.windows) {
    assert.equal(w.pass, 'desc');
    assert.ok(O.inCorridor(w.azR / D, VSFB.corridor));
  }
  const c = p.windows[0].candidates;
  const mid = c[Math.floor(c.length / 2)];
  assert.equal(mid.planeErr, 0);
  assert.equal(c.length, 11, '±5 min at 1 min spacing');
  assert.equal(c[0].planeErr, 0, 'SSO delay shifts node time, not plane');
  near(c[0].nodeShiftMin, -5, 0.02, 'node time shift');
  near(mid.dvTotal, 7.586 + 1.6 + 0.061, 0.02, 'Δv to orbit (retrograde launch loses Earth-rotation assist)');
});

test('planner rejects unreachable inclinations with a clear message', () => {
  const p = planMission({
    site: KSC, orbit: { mode: 'inclination', hKm: 500, incDeg: 10, planeTolDeg: 0.2 },
    window: { startMs: Date.UTC(2026, 10, 14), durationMin: 60, candStepMin: 5, passPref: 'auto' },
    ascent: { tInsSec: 540, downrangeKm: 1800, lossesKms: 1.6 },
  });
  assert.equal(p.windows.length, 0);
  assert.match(p.errors[0], /can't be reached directly/);
});

test('segment minimum finds a crossing between samples', () => {
  const [d, s] = segmentMin([0, 0, 0], [0, 0, 0], [-100, 5, 0, 100, 5, 0], [-100, 5, 0, 100, 5, 0], 0, 3);
  near(d, 5, 1e-9, 'miss'); near(s, 0.5, 1e-9, 'fraction');
});

test('indicative Pc falls with miss distance', () => {
  assert.ok(pcIndicative(0.1, 1, 0.01) > pcIndicative(3, 1, 0.01));
  near(pcIndicative(0, 1, 0.01), 5e-5, 1e-7, 'head-on value');
});

test('screening finds a planted 3 km conjunction and ignores a 40 km one', async () => {
  const mission = {
    site: KSC,
    orbit: { hKm: 420 },
    ascent: { tInsSec: 540, downrangeKm: 1800 },
    screening: { stepSec: 20, orbits: 1, reportKm: 25, amberKm: 10, redKm: 2, pcRed: 1e-4, pcAmber: 1e-5, crewedStandoffKm: 200, vehSigmaKm: 1, hbrM: 5 },
  };
  const t0 = Date.UTC(2026, 10, 14, 3);
  const latc = O.geocentricLat(KSC.lat * D);
  const azI = O.inertialAzimuth(latc, 51.64 * D, 'asc');
  const tr = O.buildTrajectory({ site: KSC, t0, azInertial: azI, hTargetKm: 420, tInsSec: 540, downrangeKm: 1800 });
  const tauStar = 540 + 1700;
  const tStar = t0 + tauStar * 1000;
  const p = O.unit(tr.at(tauStar));
  const v = O.unit([tr.at(tauStar + 1)[0] - tr.at(tauStar)[0], tr.at(tauStar + 1)[1] - tr.at(tauStar)[1], tr.at(tauStar + 1)[2] - tr.at(tauStar)[2]]);
  const w0 = O.cross(p, v); // perpendicular: rotate vehicle velocity 60° about p
  const w = O.unit([v[0] * 0.5 + w0[0] * 0.866, v[1] * 0.5 + w0[1] * 0.866, v[2] * 0.5 + w0[2] * 0.866]);
  const mk = (norad, offsetKm) => {
    const r = O.RE + 420 + offsetKm;
    const n = O.meanMotion(r);
    return {
      o: { norad, name: `TEST ${norad}`, type: 'DEBRIS', perigee: r - O.RE, apogee: r - O.RE, epochMs: t0, e: 0 },
      prop: (t) => { const th = n * (t - tStar) / 1000; return [0, 1, 2].map((i) => r * (Math.cos(th) * p[i] + Math.sin(th) * w[i])); },
    };
  };
  const objs = [mk(90001, 3), mk(90002, 40)];
  // Background traffic in the same shell to exercise the cache and timing
  for (let i = 0; i < 1500; i++) {
    const r = O.RE + 380 + Math.random() * 80, inc = Math.random() * Math.PI, W = Math.random() * O.TAU, u0 = Math.random() * O.TAU, n = O.meanMotion(r);
    objs.push({
      o: { norad: 100000 + i, name: 'BG', type: 'DEBRIS', perigee: r - O.RE, apogee: r - O.RE, epochMs: t0, e: 0 },
      prop: (t) => { const u = u0 + n * (t - t0) / 1000; return [r * (Math.cos(W) * Math.cos(u) - Math.sin(W) * Math.sin(u) * Math.cos(inc)), r * (Math.sin(W) * Math.cos(u) + Math.cos(W) * Math.sin(u) * Math.cos(inc)), r * Math.sin(u) * Math.sin(inc)]; },
    });
  }
  const byNorad = new Map(objs.map((x) => [x.o.norad, x.prop]));
  const t = performance.now();
  const { results, stats } = await screenCandidates({
    candidates: [{ id: 0, t0, azI }], mission, objects: objs.map((x) => x.o),
    propagate: (o, tm) => byNorad.get(o.norad)(tm),
  });
  const r = results.get(0);
  const ev = r.events.find((e) => e.norad === 90001);
  assert.ok(ev, 'planted conjunction detected');
  near(ev.miss, 3, 0.05, 'miss distance');
  near((ev.tca - tStar) / 1000, 0, 1, 'TCA');
  assert.equal(ev.phase, 'Orbit');
  assert.ok(!r.events.some((e) => e.norad === 90002), '40 km pass not reported');
  console.log(`  screened ${stats.objectsConsidered} objects, ${stats.propagations} propagations, ${(performance.now() - t).toFixed(0)} ms`);
});

test('TLE parsing, epoch and classification', () => {
  const txt = `ISS (ZARYA)
1 25544U 98067A   26277.51782528  .00016717  00000-0  30210-3 0  9993
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579 34567
0 COSMOS 1408 DEB
1 49863U 82092AB  26277.20000000  .00010000  00000-0  20000-3 0  9990
2 49863  82.5600 100.0000 0040000  10.0000 350.0000 15.20000000 12345`;
  const rows = parseTle(txt);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'COSMOS 1408 DEB');
  assert.equal(classify(rows[0].name), 'CREWED');
  assert.equal(classify(rows[1].name), 'DEBRIS');
  assert.equal(classify('FALCON 9 R/B'), 'ROCKET_BODY');
  const el = elementsFromTle(rows[0].l1, rows[0].l2);
  near(el.inc / D, 51.6416, 1e-9, 'inclination');
  near((el.perigee + el.apogee) / 2, 418, 6, 'ISS mean altitude');
  near(tleEpochMs(rows[0].l1), Date.UTC(2026, 0, 1) + 276.51782528 * 86400000, 1, 'epoch');
});

test('weather rules', () => {
  const t = Date.UTC(2026, 10, 14, 0);
  const fc = {
    times: [t, t + 3600000],
    h: { wind_speed_10m: [5, 6], wind_gusts_10m: [8, 9], precipitation: [0, 0], cloud_cover: [20, 30], cape: [100, 200], temperature_2m: [24, 23], wind_speed_250hPa: [30, 50], wind_speed_200hPa: [20, 20], weather_code: [1, 2], visibility: [20000, 20000] },
  };
  assert.equal(evaluateWeather(fc, t + 1800000).status, 'CAUTION'); // 50 m/s upper wind
  fc.h.weather_code[1] = 95;
  assert.equal(evaluateWeather(fc, t + 1800000).status, 'NO-GO');
  assert.equal(evaluateWeather(fc, t + 40 * 86400000).status, 'NO DATA');
});

// ---------------------------------------------------------------- v2 modules
import { encounterPc, covarianceEci, objectSigmas, spaceWeatherFactor, eig2 } from '../web/js/covariance.js';
import { dvBudget, lifetimeImpact } from '../web/js/econ.js';
import { summarise, gScale, insertionAdvisory } from '../web/js/spaceweather.js';
import { optimizeHold } from '../web/js/optimize.js';
import { screenOrbitOps, inTrackShiftPerDv } from '../web/js/orbitops.js';

test('encounter-plane Pc matches the closed form for isotropic covariance', () => {
  const C = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const d of [0, 0.5, 2]) {
    const r = encounterPc([d, 0, 0], [0, 0, 10], C, 0.01);
    near(r.pc, pcIndicative(d, 1, 0.01), 2e-8, `miss ${d}`);
    near(r.miss, d, 1e-12, 'miss in plane');
  }
  // a large HBR saturates towards 1
  assert.ok(encounterPc([0, 0, 0], [0, 0, 10], C, 10).pc > 0.99);
});

test('covariance is oriented in-track and shrinks Pc for an in-track miss less than a cross-track miss', () => {
  const r = [7000, 0, 0], v = [0, 7.5, 0];
  const Cm = covarianceEci(r, v, { r: 0.1, i: 2, c: 0.1 });
  near(Cm[4], 4, 1e-9, 'in-track variance on y'); near(Cm[0], 0.01, 1e-12, 'radial on x');
  const dvRel = [0, 0, 12]; // relative velocity cross-track: encounter plane = radial/in-track
  const pcInTrack = encounterPc([0, 1, 0], dvRel, Cm, 0.01).pc;
  const pcRadial = encounterPc([1, 0, 0], dvRel, Cm, 0.01).pc;
  assert.ok(pcInTrack > pcRadial * 1e10, 'same 1 km miss is far likelier along the long axis');
  const e = eig2(4, 0, 1); near(e.l1, 4, 1e-12, 'eig'); near(e.l2, 1, 1e-12, 'eig');
});

test('object uncertainty grows with age, low altitude and space weather', () => {
  const a = objectSigmas(0, 550), b = objectSigmas(3, 550), c = objectSigmas(3, 300), d = objectSigmas(3, 550, spaceWeatherFactor({ f107: 250, kpMax: 7 }));
  assert.ok(b.i > a.i && c.i > b.i && d.i > b.i);
  assert.equal(spaceWeatherFactor(null), 1);
});

test('propellant and lifetime economics', () => {
  near(dvBudget(10, 1, 220), 227.30, 0.05, 'Tsiolkovsky');
  const r = lifetimeImpact({ wetKg: 10, propKg: 1, ispS: 220, annualDv: 20, reserveDv: 27.3, extraDv: 10, revenuePerMonth: 5000 });
  near(r.lifeYears, 10, 0.01, 'life'); near(r.monthsLost, 6, 0.01, 'months lost'); near(r.revenueLost, 30000, 1, 'revenue');
});

test('space weather parsing handles both SWPC payload shapes', () => {
  const now = Date.UTC(2026, 9, 4, 12);
  const s = summarise({
    kp: [['time_tag', 'Kp', 'a_running', 'station_count'], ['2026-10-04 09:00:00.000', '3.33', '18', '8']],
    kpForecast: [['time_tag', 'kp', 'observed', 'noaa_scale'], ['2026-10-05 00:00:00', '5.67', 'predicted', 'G1']],
    f107: [{ time_tag: '2026-10-03T20:00:00', frequency: 2800, flux: 182 }],
  }, now);
  near(s.kp, 3.33, 1e-9, 'kp'); near(s.kpMax, 5.67, 1e-9, 'forecast max'); assert.equal(s.f107, 182); assert.equal(s.gMax, 'G1');
  assert.equal(gScale(7.3), 'G3');
  assert.match(insertionAdvisory(s, 210), /low altitude/);
  const s2 = summarise({ kp: [{ time_tag: '2026-10-04T09:00:00', kp_index: 2 }], kpForecast: [], f107: [] }, now);
  assert.equal(s2.kp, 2);
});

// Shared planted-conjunction fixture for the hold optimiser and in-orbit mode
function plantedFixture(tauStar, offsetKm) {
  const t0 = Date.UTC(2026, 10, 14, 3);
  const latc = O.geocentricLat(KSC.lat * D);
  const azI = O.inertialAzimuth(latc, 51.64 * D, 'asc');
  const tr = O.buildTrajectory({ site: KSC, t0, azInertial: azI, hTargetKm: 420, tInsSec: 540, downrangeKm: 1800 });
  const tStar = t0 + tauStar * 1000;
  const p = O.unit(tr.at(tauStar));
  const a = tr.at(tauStar), b = tr.at(tauStar + 1);
  const v = O.unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const w0 = O.cross(p, v);
  const w = O.unit([v[0] * 0.5 + w0[0] * 0.866, v[1] * 0.5 + w0[1] * 0.866, v[2] * 0.5 + w0[2] * 0.866]);
  const r = O.RE + 420 + offsetKm, n = O.meanMotion(r);
  const obj = { norad: 90001, name: 'PLANTED', type: 'DEBRIS', perigee: r - O.RE, apogee: r - O.RE, epochMs: t0, e: 0 };
  const prop = (o, t) => { const th = n * (t - tStar) / 1000; return [0, 1, 2].map((i) => r * (Math.cos(th) * p[i] + Math.sin(th) * w[i])); };
  const mission = {
    site: KSC, orbit: { hKm: 420, mode: 'inclination' }, ascent: { tInsSec: 540, downrangeKm: 1800 },
    screening: { stepSec: 20, orbits: 1, reportKm: 25, amberKm: 10, redKm: 2, pcRed: 1e-4, pcAmber: 1e-5, crewedStandoffKm: 200, vehSigmaKm: 1, hbrM: 5, swFactor: 1 },
  };
  return { t0, azI, tr, obj, prop, mission, tStar };
}

test('hold optimiser moves T-0 away from a planted head-on approach', async () => {
  const f = plantedFixture(540 + 1700, 0.05);
  const out = await optimizeHold({ candidate: { t0: f.t0, azI: f.azI }, mission: f.mission, objects: [f.obj], propagate: f.prop, rangeSec: 20, stepSec: 2 });
  assert.equal(out.base.status, 'NO-GO');
  assert.ok(out.improved, 'found a better hold');
  assert.notEqual(out.best.hold, 0);
  assert.ok(out.best.minMiss > out.base.minMiss);
});

test('in-orbit mode finds a day-1 approach and sizes an avoidance burn', async () => {
  const f = plantedFixture(540 + 30000, 0.2);
  const out = await screenOrbitOps({ traj: f.tr, mission: f.mission, objects: [f.obj], propagate: f.prop, days: 1, stepSec: 60, reportKm: 10 });
  const ev = [...out.events].sort((a, b) => Math.abs(a.tca - f.tStar) - Math.abs(b.tca - f.tStar))[0];
  assert.ok(ev, 'approach found');
  near((ev.tca - f.tStar) / 1000, 0, 1, 'TCA');
  assert.equal(ev.severity, 'red');
  const burn = ev.burns.find((b) => b.dvMs != null);
  assert.ok(out.events.filter((e) => e.burns).some((e) => e.burns.some((b) => b.notNeeded)), 'distance-only cautions need no burn');
  assert.ok(burn && burn.dvMs > 0 && burn.dvMs < 2, `burn ${burn?.dvMs} m/s`);
  assert.ok(burn.newPc <= 1.01e-6);
  assert.ok(inTrackShiftPerDv(O.meanMotion(O.RE + 420), 5554) > 3 * 5554 * 0.9);
});

// ---------------------------------------------------------------- feeds, 3-D, PDF, telemetry
import { qEciToEcef, qmul } from '../web/js/cesiumview.js';
import { ricQuaternion } from '../web/js/covariance.js';
import { inPolygon, classifyTraffic, bboxOf } from '../web/js/airspace.js';
import { firstContacts } from '../web/js/groundstations.js';
import { PdfDoc, winAnsi, wrap } from '../web/js/pdf.js';
import { compliancePackText, simplify } from '../web/js/briefing.js';
import { computeHazards } from '../web/js/hazards.js';
import { dynamicPressure, airDensity, parseLine } from '../web/js/telemetry.js';

const rotate = (q, v) => { // rotate vector v by quaternion q
  const [x, y, z, w] = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [x, y, z];
};

test('ellipsoid orientation: RIC quaternion maps x to radial and survives the ECEF rotation', () => {
  const r = [5000, 3000, 2000], v = [-2, 6, 3];
  const q = ricQuaternion(r, v);
  const R = O.unit(r);
  rotate(q, [1, 0, 0]).forEach((c, i) => near(c, R[i], 1e-9, 'x → radial'));
  const th = 1.234;
  const qe = qEciToEcef(q, th);
  const Re = O.eciToEcef(R, th);
  rotate(qe, [1, 0, 0]).forEach((c, i) => near(c, Re[i], 1e-9, 'radial in ECEF'));
});

test('airspace: polygon test and traffic classification', () => {
  const sq = [[-121, 33], [-120, 33], [-120, 34], [-121, 34]];
  assert.ok(inPolygon([-120.5, 33.5], sq));
  assert.ok(!inPolygon([-119.5, 33.5], sq));
  const t = classifyTraffic([['a', 'UAL1 ', 'US', 0, 0, -120.5, 33.5, 9000, false, 230, 180], ['b', 'X', 'US', 0, 0, -119, 33.5, 9000, false, 230, 180], ['c', 'GND', 'US', 0, 0, -120.5, 33.5, 0, true, 0, 0]], [sq]);
  assert.equal(t.length, 2, 'aircraft on the ground are dropped');
  assert.equal(t[0].callsign, 'UAL1'); assert.ok(t[0].inside); assert.ok(!t[1].inside);
  const b = bboxOf([sq], 1); assert.equal(b.lamin, 32); assert.equal(b.lomax, -119);
});

test('first contact finds the station under the ground track first', () => {
  const t0 = Date.UTC(2026, 10, 14, 3);
  const azI = O.inertialAzimuth(O.geocentricLat(KSC.lat * D), 51.64 * D, 'asc');
  const tr = O.buildTrajectory({ site: KSC, t0, azInertial: azI, hTargetKm: 420, tInsSec: 540, downrangeKm: 1800 });
  const g = O.eciToGeodetic(tr.at(540 + 300), t0 + 840000);
  const stations = [{ id: 1, name: 'Under track', lat: g.lat / D, lng: g.lon / D, altitude: 0, min_horizon: 0 }, { id: 2, name: 'Antipode', lat: -g.lat / D, lng: g.lon / D + 180, altitude: 0, min_horizon: 0 }];
  const passes = firstContacts(tr, stations, { hours: 2 });
  assert.equal(passes[0].station.id, 1);
  assert.ok(passes[0].maxEl > 70, `overhead pass (${passes[0].maxEl.toFixed(1)}°)`);
});

test('PDF writer produces a structurally valid file', () => {
  const d = new PdfDoc({ title: 'Test' });
  const p = d.addPage();
  p.text(40, 60, 'Δv 9.2 km/s — 97.6° ± 0.1', { size: 12 }).rect(40, 80, 100, 20, { stroke: '#000000' }).poly([[40, 120], [90, 140], [140, 120]], { fill: '#ff0000', alpha: 0.3, close: true });
  const bytes = d.toBytes();
  const s = String.fromCharCode(...bytes);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const xref = +/startxref\n(\d+)/.exec(s)[1];
  assert.equal(s.slice(xref, xref + 4), 'xref', 'startxref points at the xref table');
  for (const m of s.matchAll(/(\d{10}) 00000 n /g)) assert.match(s.slice(+m[1], +m[1] + 12), /^\d+ 0 obj/, 'every xref offset points at an object');
  assert.equal(winAnsi('Δv →'), 'dv ->');
  assert.ok(wrap('a '.repeat(200), 100, 10).length > 5);
});

test('compliance pack: NOTAM coordinates and times', () => {
  const t0 = Date.UTC(2026, 10, 14, 3, 7);
  const azI = O.inertialAzimuth(O.geocentricLat(KSC.lat * D), 51.64 * D, 'asc');
  const tr = O.buildTrajectory({ site: KSC, t0, azInertial: azI, hTargetKm: 420, tInsSec: 540, downrangeKm: 1800 });
  const hz = computeHazards(tr, KSC, { corridorHalfWidthKm: 25, stage1Km: 600 });
  const txt = compliancePackText({ mission: { vehicle: 'Test Rocket' }, rec: {}, hazards: hz, plan: { windows: [{ candidates: [{ t0 }] }] } });
  assert.match(txt.notam[1], /B\) 2611140237 {2}C\) 2611140407/);
  assert.match(txt.notam[3], /^E\) ROCKET LAUNCH TEST ROCKET WILL TAKE PLACE WI AREA BOUNDED BY: \d{4}N\d{5}W/);
  assert.ok(simplify(hz.corridor, 10).length === 10);
});

test('telemetry: ISA density, dynamic pressure and packet parsing', () => {
  near(airDensity(0), 1.225, 1e-9, 'sea level'); near(airDensity(5000), 0.736, 0.002, '5 km');
  near(dynamicPressure(0, 100), 6125, 0.5, 'q at 100 m/s');
  const p = parseLine('CW,7,350,12,-5,4010,21.5,100900,-61');
  assert.equal(p.seq, 7); near(p.az, 4.01, 1e-9, 'g'); assert.equal(p.rssi, -61);
  assert.equal(parseLine('garbage'), null);
});
