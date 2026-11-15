// Clearway — space weather from NOAA's Space Weather Prediction Center (SWPC).
// Geomagnetic activity (Kp) and solar radio flux (F10.7) heat and expand the upper
// atmosphere, increasing drag in low Earth orbit. Clearway uses them to (1) inflate the
// in-track uncertainty of LEO objects, and (2) warn when a low insertion orbit meets a
// geomagnetic storm (in February 2022, 38 of 49 newly deployed Starlink satellites re-entered
// after a storm raised drag at their ~210 km deployment altitude).

const BASE = 'https://services.swpc.noaa.gov';
export const SWPC_PATHS = {
  kp: '/products/noaa-planetary-k-index.json',
  kpForecast: '/products/noaa-planetary-k-index-forecast.json',
  f107: '/json/f107_cm_flux.json',
};

/** Accepts SWPC's array-of-arrays (header row first) or array-of-objects shapes. */
export function rows(json) {
  if (!Array.isArray(json) || !json.length) return [];
  if (Array.isArray(json[0])) {
    const head = json[0].map((h) => String(h).toLowerCase());
    return json.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  return json.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v])));
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const timeOf = (r) => Date.parse(String(r.time_tag ?? r.time ?? '').replace(' ', 'T') + (String(r.time_tag ?? '').endsWith('Z') ? '' : 'Z'));
const kpOf = (r) => num(r.kp ?? r.kp_index ?? r.estimated_kp);

export function gScale(kp) {
  if (kp == null) return null;
  return kp >= 9 ? 'G5' : kp >= 8 ? 'G4' : kp >= 7 ? 'G3' : kp >= 6 ? 'G2' : kp >= 5 ? 'G1' : 'G0';
}

/** Normalise the three SWPC payloads into one summary. */
export function summarise({ kp, kpForecast, f107 }, now = Date.now()) {
  const obs = rows(kp).map((r) => ({ t: timeOf(r), kp: kpOf(r) })).filter((r) => r.kp != null && Number.isFinite(r.t));
  const fc = rows(kpForecast).map((r) => ({ t: timeOf(r), kp: kpOf(r), kind: String(r.observed ?? '').toLowerCase() }))
    .filter((r) => r.kp != null && Number.isFinite(r.t) && r.t > now);
  const flux = rows(f107).map((r) => ({ t: timeOf(r), f: num(r.flux ?? r.f107 ?? r['f10.7']) })).filter((r) => r.f != null && Number.isFinite(r.t));
  const last = obs.sort((a, b) => a.t - b.t).at(-1) || null;
  const next72 = fc.filter((r) => r.t <= now + 72 * 3600000);
  const kpMax = next72.length ? Math.max(...next72.map((r) => r.kp)) : last?.kp ?? null;
  const fl = flux.sort((a, b) => a.t - b.t).at(-1) || null;
  return {
    kp: last?.kp ?? null, kpTime: last?.t ?? null, kpMax, gNow: gScale(last?.kp), gMax: gScale(kpMax),
    f107: fl?.f ?? null, f107Time: fl?.t ?? null, forecast: next72, fetchedAt: now,
  };
}

/** Advisory text for the mission, or null. */
export function insertionAdvisory(sw, insertionAltKm) {
  if (!sw || sw.kpMax == null) return null;
  if (sw.kpMax >= 5 && insertionAltKm < 350) return `Geomagnetic storm forecast (${sw.gMax}, Kp ${sw.kpMax.toFixed(1)}) with insertion at ${insertionAltKm} km: drag can rise sharply at low altitude. Consider a higher insertion or a later date.`;
  if (sw.kpMax >= 5) return `Geomagnetic storm forecast (${sw.gMax}, Kp ${sw.kpMax.toFixed(1)}): catalog positions in LEO are less certain than usual; screening uncertainty is inflated.`;
  if ((sw.f107 ?? 0) > 200) return `High solar flux (F10.7 ${sw.f107.toFixed(0)} sfu): elevated drag in LEO; screening uncertainty is inflated.`;
  return null;
}

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function fetchSpaceWeather() {
  const out = {};
  await Promise.all(Object.entries(SWPC_PATHS).map(async ([k, path]) => {
    try { out[k] = await getJson(`api/swpc${path}`); }
    catch { try { out[k] = await getJson(BASE + path); } catch { out[k] = []; } }
  }));
  const s = summarise(out);
  if (s.kp == null && s.f107 == null) throw new Error('Space weather data unavailable');
  return s;
}
