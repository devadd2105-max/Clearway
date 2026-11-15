// Clearway Lunar — radio link budget and an optional relay satellite (planning grade).
//
// Direct to Earth: the standard link equation gives the carrier-to-noise density C/N0 at a Deep Space
// Network dish for the actual Earth–Moon distance at each step, and from it the highest data rate that
// still meets the required Eb/N0 plus a margin:
//   C/N0 = EIRP − L_fs − L_other + G_r − 10·log10(T_sys) + 228.6   (dB-Hz;  −228.6 dBW/K/Hz = Boltzmann)
//   R_max = C/N0 − (Eb/N0)_req − margin                              (dB-bit/s)
// Atmosphere, pointing loss beyond the fixed allowance, elevation-dependent noise and scheduling are not
// modelled. Every number is an input; the defaults are typical values, not a specific mission.
//
// Relay: one satellite on an elliptical lunar frozen orbit whose far point (apolune) sits over the south
// pole, the kind of orbit proposed for lunar south-pole relays. Its position is propagated with Kepler's
// equation in a Moon-centred inertial frame aligned with the Moon's spin axis, then rotated into the
// Moon-fixed frame. The relay link counts when the relay is above the site's real skyline and Earth is
// not hidden behind the Moon from the relay. Orbit perturbations are not modelled.

import { R_MOON, DEG, norm, sub, dot, rotZ, rotX } from './ephem.js';

export const C_LIGHT = 299792.458; // km/s
export const BANDS = {
  S: { label: 'S-band (2.25 GHz)', freqGHz: 2.25, sysNoiseK: 25 },
  X: { label: 'X-band (8.45 GHz)', freqGHz: 8.45, sysNoiseK: 30 },
  Ka: { label: 'Ka-band (32 GHz)', freqGHz: 32.0, sysNoiseK: 60 },
};

export const RADIO_DEFAULTS = {
  band: 'X', txPowerW: 10, txGainDbi: 10, lossesDb: 3,
  dishM: 34, dishEff: 0.6, ebn0ReqDb: 2.5, marginDb: 3,
};

const log10 = Math.log10;

/** Link budget at distance distKm (km). Returns dB quantities and the highest data rate (bit/s). */
export function linkBudget(distKm, cfg = {}) {
  const c = { ...RADIO_DEFAULTS, ...cfg };
  const band = BANDS[c.band] || BANDS.X;
  const f = (c.freqGHz ?? band.freqGHz) * 1e9;
  const lambda = (C_LIGHT * 1000) / f;                                    // m
  const T = c.sysNoiseK ?? band.sysNoiseK;
  const eirp = 10 * log10(c.txPowerW) + c.txGainDbi;                      // dBW
  const fspl = 20 * log10((4 * Math.PI * distKm * 1000) / lambda);        // dB
  const gr = 10 * log10(c.dishEff * ((Math.PI * c.dishM) / lambda) ** 2); // dBi
  const cn0 = eirp - fspl - c.lossesDb + gr - 10 * log10(T) + 228.6;      // dB-Hz
  const rateDb = cn0 - c.ebn0ReqDb - c.marginDb;
  return { freqGHz: f / 1e9, lambdaM: lambda, eirpDbw: eirp, fsplDb: fspl, grDbi: gr, sysNoiseK: T, cn0DbHz: cn0, maxRateBps: Math.max(0, 10 ** (rateDb / 10)) };
}

/** Human-readable data rate. */
export function fmtRate(bps) {
  if (!(bps > 0)) return '0 bit/s';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbit/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(bps >= 1e4 ? 0 : 1)} kbit/s`;
  return `${Math.round(bps)} bit/s`;
}

// ------------------------------------------------------------------ relay orbit
export const RELAY_PRESETS = {
  none: { label: 'None (direct to Earth only)' },
  elfo: {
    label: 'One relay on an elliptical frozen orbit over the south pole (illustrative)',
    // semi-major axis 6,142 km, e = 0.6 (periapsis ≈ 720 km altitude, apoapsis ≈ 8,090 km), i = 57.8°,
    // argument of periapsis 90°: periapsis over the north, apoapsis (slow, long dwell) over the south pole.
    aKm: 6142.4, e: 0.6, iDeg: 57.82, argPeriDeg: 90, raanDeg: 0, m0Deg: 180,
  },
};

const MU_MOON = 4902.800066; // km³/s²
const EPOCH = Date.UTC(2026, 0, 1); // orbit phase reference
const W_RATE = 13.17635815;  // deg/day: the Moon's rotation (IAU 2009 mean rate)

function kepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 30; i++) { const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-12) break; }
  return E;
}

/** Relay position (km, Moon-fixed frame) at time tMs. */
export function relayPosition(tMs, orbit) {
  const n = Math.sqrt(MU_MOON / orbit.aKm ** 3);                        // rad/s
  const M = (orbit.m0Deg * DEG + n * ((tMs - EPOCH) / 1000)) % (2 * Math.PI);
  const E = kepler(M, orbit.e);
  const x = orbit.aKm * (Math.cos(E) - orbit.e), y = orbit.aKm * Math.sqrt(1 - orbit.e ** 2) * Math.sin(E);
  // perifocal → Moon-centred inertial (z = spin axis): R3(Ω)·R1(i)·R3(ω)
  let v = rotZ([x, y, 0], orbit.argPeriDeg * DEG);
  v = rotX(v, orbit.iDeg * DEG);
  v = rotZ(v, orbit.raanDeg * DEG);
  // inertial → Moon-fixed: undo the Moon's rotation since the epoch
  const dW = (((tMs - EPOCH) / 86400000) * W_RATE) % 360;
  return rotZ(v, -dW * DEG);
}

/** Relay positions for every grid step (cached on the grid). */
export function relayTrack(grid, orbit) {
  const key = JSON.stringify(orbit);
  grid._relay ??= new Map();
  if (grid._relay.has(key)) return grid._relay.get(key);
  const out = new Float64Array(3 * grid.n);
  for (let k = 0; k < grid.n; k++) out.set(relayPosition(grid.start + k * grid.step, orbit), 3 * k);
  grid._relay.set(key, out);
  return out;
}

/** True when the straight line from the relay towards Earth passes clear of the Moon. */
export function relaySeesEarth(relay, earth) {
  const d = sub(earth, relay), L = norm(d);
  const u = [d[0] / L, d[1] / L, d[2] / L];
  const t = -dot(relay, u);           // closest approach of the line to the Moon's centre
  if (t <= 0) return true;            // Earth lies away from the Moon
  const c = [relay[0] + u[0] * t, relay[1] + u[1] * t, relay[2] + u[2] * t];
  return norm(c) > R_MOON;
}

/**
 * Direct-to-Earth data during steps [k0, k1): hours with a link, the data-rate range and the data volume
 * that could be returned (bits), using the Earth–Moon distance at each step. Relay hops are not counted.
 */
export function stayData(a, grid, k0, k1, cfg = {}) {
  let hours = 0, bits = 0, lo = Infinity, hi = 0;
  const dtS = grid.step / 1000;
  for (let k = Math.max(0, k0); k < Math.min(grid.n, k1); k++) {
    if (!a.dte[k]) continue;
    const d = Math.hypot(grid.earth[3 * k], grid.earth[3 * k + 1], grid.earth[3 * k + 2]);
    const r = linkBudget(d, cfg).maxRateBps;
    hours += dtS / 3600; bits += r * dtS; lo = Math.min(lo, r); hi = Math.max(hi, r);
  }
  return { hours, bits, minRateBps: hours ? lo : 0, maxRateBps: hi };
}

/** Human-readable data volume. */
export function fmtBits(bits) {
  const B = bits / 8;
  if (B >= 1e12) return `${(B / 1e12).toFixed(1)} TB`;
  if (B >= 1e9) return `${(B / 1e9).toFixed(B >= 1e10 ? 0 : 1)} GB`;
  if (B >= 1e6) return `${(B / 1e6).toFixed(B >= 1e7 ? 0 : 1)} MB`;
  return `${Math.round(B / 1e3)} kB`;
}
