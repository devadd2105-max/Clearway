// Clearway — first-contact planning with the SatNOGS open ground-station network.
// Predicts which volunteer stations will see the payload on its first passes after insertion,
// so a university team knows where its first beacon can be heard. Scheduling observations is
// done on network.satnogs.org with a SatNOGS account, once the satellite and its transmitter
// are listed in SatNOGS DB.

import { DEG, gmst, eciToEcef, geodeticToEcef } from './orbit.js';

export async function fetchStations() {
  const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  try { return await get('api/satnogs/stations'); }
  catch {
    const raw = await get('https://network.satnogs.org/api/stations/?format=json&status=Online');
    return (Array.isArray(raw) ? raw : raw.results || []).map((s) => ({ id: s.id, name: s.name, lat: +s.lat, lng: +s.lng, altitude: +s.altitude || 0, min_horizon: +s.min_horizon || 0 }));
  }
}

function elevation(stEcef, up, satEcef) {
  const dx = satEcef[0] - stEcef[0], dy = satEcef[1] - stEcef[1], dz = satEcef[2] - stEcef[2];
  const r = Math.hypot(dx, dy, dz);
  return { el: Math.asin((dx * up[0] + dy * up[1] + dz * up[2]) / r) / DEG, range: r };
}

/**
 * First pass of the payload over each station after insertion.
 * Returns [{station, aos, los, maxEl, durationSec, rangeKm}] sorted by AOS.
 */
export function firstContacts(traj, stations, { hours = 12, minElev = 10, stepSec = 20 } = {}) {
  const tau0 = traj.tInsSec, tau1 = tau0 + hours * 3600;
  const sats = [];
  for (let tau = tau0; tau <= tau1; tau += stepSec) {
    const t = traj.t0 + tau * 1000;
    sats.push([t, eciToEcef(traj.at(tau), gmst(t))]);
  }
  const out = [];
  for (const st of stations) {
    const la = st.lat * DEG, lo = st.lng * DEG;
    const s = geodeticToEcef(la, lo, (st.altitude || 0) / 1000);
    const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const thr = Math.max(minElev, st.min_horizon || 0);
    let aos = null, maxEl = -90, minRange = Infinity;
    for (const [t, p] of sats) {
      const { el, range } = elevation(s, up, p);
      if (el >= thr) {
        if (aos == null) aos = t;
        if (el > maxEl) maxEl = el;
        minRange = Math.min(minRange, range);
      } else if (aos != null) {
        out.push({ station: st, aos, los: t, maxEl, durationSec: (t - aos) / 1000, rangeKm: minRange });
        break;
      }
    }
  }
  return out.sort((a, b) => a.aos - b.aos);
}
