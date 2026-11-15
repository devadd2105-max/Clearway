// Clearway Lunar — local horizon masks.
// A mask is the terrain elevation angle (deg) seen from a site for every azimuth, built from
// LOLA elevation maps by tools/horizons.py (or the server's /api/horizon endpoint).
// Without terrain data, Clearway uses a smooth sphere: the horizon is the geometric dip
// for the observer's height above the surface.

import { R_MOON, DEG } from './ephem.js';

export class Horizon {
  /** @param elev array of horizon elevations (deg) at azimuths 0, step, 2*step, ... */
  constructor(elev, { azStep = 360 / elev.length, source = 'custom', meta = {} } = {}) {
    this.elev = Float32Array.from(elev);
    this.azStep = azStep;
    this.n = this.elev.length;
    this.source = source;
    this.meta = meta;
    this.terrain = source !== 'smooth';
  }

  /** Smooth-sphere horizon for an observer `heightM` above the surface. */
  static smooth(heightM = 2, n = 720) {
    const dip = -Math.acos(R_MOON / (R_MOON + heightM / 1000)) / DEG;
    return new Horizon(new Array(n).fill(dip), { source: 'smooth', meta: { observerHeightM: heightM } });
  }

  /** Horizon elevation (deg) at azimuth `az` (deg), linearly interpolated. */
  at(az) {
    const x = (((az % 360) + 360) % 360) / this.azStep;
    const i = Math.floor(x), f = x - i;
    const a = this.elev[i % this.n], b = this.elev[(i + 1) % this.n];
    return a + (b - a) * f;
  }

  /** Highest horizon elevation across an azimuth interval (deg), for discs wider than one step. */
  maxOver(az, halfWidth) {
    let m = -90;
    const steps = Math.max(1, Math.ceil((2 * halfWidth) / this.azStep));
    for (let k = 0; k <= steps; k++) m = Math.max(m, this.at(az - halfWidth + (2 * halfWidth * k) / steps));
    return m;
  }

  /** The same skyline raised (or lowered) by `deg` degrees — used for terrain sensitivity. */
  shifted(deg) { return new Horizon(Array.from(this.elev, (v) => v + deg), { azStep: this.azStep, source: this.source, meta: this.meta }); }

  stats() {
    let lo = Infinity, hi = -Infinity, s = 0;
    for (const v of this.elev) { lo = Math.min(lo, v); hi = Math.max(hi, v); s += v; }
    return { min: lo, max: hi, mean: s / this.n };
  }

  toJSON() { return { azStep: this.azStep, source: this.source, meta: this.meta, elev: Array.from(this.elev, (v) => Math.round(v * 1000) / 1000) }; }
}

/**
 * Fraction (0–1) of a disc of angular radius `radius` centred at elevation `el` that lies above a
 * locally straight horizon at elevation `h` (circular-segment area).
 */
export function discFraction(el, radius, h) {
  const d = (el - h) / radius;
  if (d >= 1) return 1;
  if (d <= -1) return 0;
  return 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
}

/** Short label for a build-added site; older builds cut it at 16 characters mid-word, so restore the full label. */
function shortName(s) {
  const label = String(s.name).replace(/\s*\(PGDA [^)]*\)\s*$/, '');
  if (!s.short) return label;
  return label.startsWith(s.short) && s.short.length < label.length ? label : s.short;
}

/**
 * Parse a horizons.json set (tools/horizons.py). Per site: the terrain horizon, its height, the
 * horizons of points around it (position uncertainty), slopes, the published NASA PGDA illumination
 * reference values and, for sites added by the build (PGDA 5 m tiles), their name and description.
 */
export function parseHorizonSet(j) {
  const out = new Map();
  const meta = j.meta || {};
  for (const [id, s] of Object.entries(j.sites || {})) {
    const src = s.resM && s.resM < 20 ? 'LOLA 5 m' : 'LOLA';
    const ringStep = meta.ring?.azStep || 1;
    out.set(id, {
      horizon: new Horizon(s.elev, { azStep: j.azStep, source: src, meta: { ...meta, heightM: s.heightM } }),
      heightM: s.heightM, resM: s.resM ?? null,
      ring: (s.ring || []).map((r) => ({ az: r.az, heightM: r.heightM, horizon: new Horizon(r.elev, { azStep: ringStep, source: src, meta: { ...meta, heightM: r.heightM } }) })),
      slope: s.slope || null, pgda: s.pgda || null,
      builtAt: { lat: s.lat, lon: s.lon }, selection: s.selection || null,
      info: s.name ? { id, name: s.name, short: shortName(s), lat: s.lat, lon: s.lon, kind: s.kind || 'Terrain build', note: s.note || '', source: s.source || 'horizons.json' } : null,
    });
  }
  return { sites: out, meta };
}

/** Load the horizon set produced by tools/horizons.py, if present. */
export async function loadHorizonSet(url = 'data/horizons.json') {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return parseHorizonSet(await r.json());
  } catch { return null; }
}

/** Ask the local server to compute a horizon for any site (needs a LOLA map on the server). */
export async function fetchHorizon(lat, lon) {
  const r = await fetch(`api/horizon?lat=${lat}&lon=${lon}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  const j = await r.json();
  return { horizon: new Horizon(j.elev, { azStep: j.azStep, source: j.resM && j.resM < 20 ? 'LOLA 5 m' : 'LOLA', meta: j.meta }), heightM: j.heightM, resM: j.resM ?? null, slope: j.slope || null, ring: [], pgda: null };
}
