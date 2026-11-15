// Clearway — space object catalog.
// Loads General Perturbations (GP) element sets in 3-line TLE form from CelesTrak
// (via the local caching server when available) or from a user-supplied file
// (e.g. a full catalog export from Space-Track.org), and propagates them with SGP4.

import { RE, MU, TAU, DEG, smaFromRevPerDay } from './orbit.js';

export const GROUPS = [
  { id: 'active', label: 'Active satellites', note: 'All operational payloads', defaultOn: true },
  { id: 'cosmos-1408-debris', label: 'COSMOS 1408 debris', note: '2021 ASAT test', defaultOn: true },
  { id: 'fengyun-1c-debris', label: 'FENGYUN 1C debris', note: '2007 ASAT test', defaultOn: true },
  { id: 'iridium-33-debris', label: 'IRIDIUM 33 debris', note: '2009 collision', defaultOn: true },
  { id: 'cosmos-2251-debris', label: 'COSMOS 2251 debris', note: '2009 collision', defaultOn: true },
  { id: 'last-30-days', label: 'Launched in last 30 days', note: 'New objects, incl. upper stages', defaultOn: true },
];

export const TYPES = {
  PAYLOAD: { label: 'Payload', radiusM: 3 },
  ROCKET_BODY: { label: 'Rocket body', radiusM: 3 },
  DEBRIS: { label: 'Debris', radiusM: 0.5 },
  CREWED: { label: 'Crewed', radiusM: 55 },
};

const CREWED = [/^ISS \(/, /^ISS$/, /^CSS \(/, /^TIANHE/, /^SHENZHOU/, /^SOYUZ[- ]MS/, /^CREW DRAGON/, /^STARLINER/];

export function classify(name) {
  const n = name.toUpperCase();
  if (CREWED.some((r) => r.test(n))) return 'CREWED';
  if (/\bR\/B\b|ROCKET BODY|\bAKM\b|\bPKM\b/.test(n)) return 'ROCKET_BODY';
  if (/\bDEB\b|DEBRIS|\bCOOLANT\b|\bFRAG\b/.test(n)) return 'DEBRIS';
  return 'PAYLOAD';
}

/** TLE epoch (cols 19-32 of line 1) to ms. */
export function tleEpochMs(line1) {
  const yy = parseInt(line1.substring(18, 20), 10);
  const doy = parseFloat(line1.substring(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
}

function checksumOk(line) {
  let s = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') s += +c; else if (c === '-') s += 1;
  }
  return s % 10 === +line[68];
}

/** Parse 2-line or 3-line element text. Returns [{name, l1, l2}]. */
export function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.length);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    if (a.startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      out.push({ name: `NORAD ${a.substring(2, 7).trim()}`, l1: a, l2: lines[i + 1] }); i += 1;
    } else if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      out.push({ name: a.replace(/^0 /, '').trim(), l1: lines[i + 1], l2: lines[i + 2] }); i += 2;
    }
  }
  return out.filter((r) => r.l1.length >= 69 && r.l2.length >= 69);
}

/** Mean elements straight from the TLE text (independent of the SGP4 library). */
export function elementsFromTle(l1, l2) {
  const inc = parseFloat(l2.substring(8, 16)) * DEG;
  const raan = parseFloat(l2.substring(17, 25)) * DEG;
  const e = parseFloat('0.' + l2.substring(26, 33).trim());
  const revDay = parseFloat(l2.substring(52, 63));
  const a = smaFromRevPerDay(revDay);
  return { inc, raanEpoch: raan, e, a, revDay, perigee: a * (1 - e) - RE, apogee: a * (1 + e) - RE, periodMin: 1440 / revDay };
}

/**
 * Build catalog records. `sgp4` is the satellite.js namespace (injected so the core can be tested).
 */
export function buildRecords(rows, sgp4, source, existing = new Map()) {
  let skipped = 0;
  for (const r of rows) {
    const norad = parseInt(r.l1.substring(2, 7), 10);
    if (!checksumOk(r.l1) || !checksumOk(r.l2)) { skipped++; continue; }
    let satrec;
    try { satrec = sgp4.twoline2satrec(r.l1, r.l2); } catch { skipped++; continue; }
    if (!satrec || satrec.error) { skipped++; continue; }
    const el = elementsFromTle(r.l1, r.l2);
    const epochMs = tleEpochMs(r.l1);
    const prev = existing.get(norad);
    if (prev && prev.epochMs >= epochMs) continue; // keep the fresher element set
    existing.set(norad, {
      norad, name: r.name, type: classify(r.name), intl: r.l1.substring(9, 17).trim(),
      l1: r.l1, l2: r.l2, satrec, epochMs, source, ...el,
    });
  }
  return { map: existing, skipped };
}

export class Catalog {
  constructor(sgp4) {
    this.sgp4 = sgp4;
    this.map = new Map();
    this.list = [];
    this.sources = [];
  }

  async loadGroups(groupIds, onProgress = () => {}) {
    const results = [];
    for (let i = 0; i < groupIds.length; i++) {
      const id = groupIds[i];
      onProgress({ done: i, total: groupIds.length, label: id });
      try {
        const { text, via, fetchedAt } = await fetchGroup(id);
        const rows = parseTle(text);
        const { skipped } = buildRecords(rows, this.sgp4, `CelesTrak: ${id}`, this.map);
        results.push({ id, ok: true, count: rows.length, skipped, via, fetchedAt });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    this.sources = results;
    this.refresh();
    onProgress({ done: groupIds.length, total: groupIds.length });
    return results;
  }

  importText(text, label) {
    const rows = parseTle(text);
    const { skipped } = buildRecords(rows, this.sgp4, `File: ${label}`, this.map);
    this.sources.push({ id: label, ok: true, count: rows.length, skipped, via: 'file', fetchedAt: Date.now() });
    this.refresh();
    return { count: rows.length, skipped };
  }

  refresh() {
    this.list = [...this.map.values()].sort((a, b) => a.norad - b.norad);
    this.list.forEach((o, i) => { o.index = i; });
  }

  get size() { return this.list.length; }

  /** SGP4 position (TEME, km) at tMs, or null if the propagator fails (decayed, bad elements). */
  position(obj, tMs) {
    const r = this.sgp4.sgp4(obj.satrec, (tMs - obj.epochMs) / 60000);
    if (!r || !r.position || obj.satrec.error) return null;
    const p = r.position;
    if (!Number.isFinite(p.x)) return null;
    return [p.x, p.y, p.z];
  }

  /** Positions of all objects into a Float32Array(3N); NaN for failures. */
  positionsAt(tMs, out) {
    const n = this.list.length;
    if (!out || out.length !== 3 * n) out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const p = this.position(this.list[i], tMs);
      if (p) { out[3 * i] = p[0]; out[3 * i + 1] = p[1]; out[3 * i + 2] = p[2]; } else { out[3 * i] = NaN; }
    }
    return out;
  }

  stats(nowMs = Date.now()) {
    const byType = { PAYLOAD: 0, ROCKET_BODY: 0, DEBRIS: 0, CREWED: 0 };
    const shells = new Array(20).fill(0); // 100 km bins, 0-2000 km
    let leo = 0, meo = 0, geo = 0, other = 0, ageSum = 0, oldest = 0;
    for (const o of this.list) {
      byType[o.type]++;
      const mean = (o.perigee + o.apogee) / 2;
      if (o.apogee < 2000) { leo++; const b = Math.floor(Math.max(0, mean) / 100); if (b < 20) shells[b]++; }
      else if (Math.abs(mean - 35786) < 1000 && o.e < 0.05) geo++;
      else if (mean < 35786) meo++;
      else other++;
      const age = (nowMs - o.epochMs) / 86400000;
      ageSum += age; oldest = Math.max(oldest, age);
    }
    return { total: this.list.length, byType, shells, leo, meo, geo, other, meanAgeDays: this.list.length ? ageSum / this.list.length : 0, oldestAgeDays: oldest };
  }

  search(q, limit = 30) {
    const s = q.trim().toUpperCase();
    if (!s) return [];
    const num = /^\d+$/.test(s) ? parseInt(s, 10) : null;
    const out = [];
    if (num != null && this.map.has(num)) out.push(this.map.get(num));
    for (const o of this.list) {
      if (out.length >= limit) break;
      if (o.norad === num) continue;
      if (o.name.toUpperCase().includes(s) || o.intl.toUpperCase().includes(s)) out.push(o);
    }
    return out;
  }
}

async function fetchText(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), headers: res.headers };
  } finally { clearTimeout(timer); }
}

/** Prefer the local caching server (respects CelesTrak's request limits); fall back to CelesTrak directly. */
export async function fetchGroup(id) {
  try {
    const { text, headers } = await fetchText(`api/catalog/${encodeURIComponent(id)}`);
    if (/(^|\n)1 /.test(text)) {
      return { text, via: headers.get('X-Clearway-Cache') || 'server', fetchedAt: Date.parse(headers.get('X-Clearway-Fetched') || '') || Date.now() };
    }
  } catch { /* no local server; try direct */ }
  const { text } = await fetchText(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(id)}&FORMAT=tle`);
  if (!/(^|\n)1 /.test(text)) throw new Error(text.trim().slice(0, 120) || 'Empty response');
  return { text, via: 'direct', fetchedAt: Date.now() };
}

export const meanAltitude = (o) => (o.perigee + o.apogee) / 2;
export const periodFromA = (a) => TAU * Math.sqrt(a ** 3 / MU);
