// Clearway — live air traffic from the OpenSky Network, checked against the launch hazard area.
// Shows which aircraft are inside (or near) the corridor right now, so the team can judge how
// busy that airspace is and how much a NOTAM will affect traffic. Positions are ADS-B reports
// from OpenSky's crowdsourced receiver network; coverage over open ocean is sparse.

const STATE = { icao: 0, callsign: 1, country: 2, lon: 5, lat: 6, baroAlt: 7, onGround: 8, velocity: 9, track: 10, vrate: 11, geoAlt: 13 };

export function bboxOf(polys, marginDeg = 1) {
  let lamin = 90, lamax = -90, lomin = 180, lomax = -180;
  for (const poly of polys) for (const [lon, lat] of poly) {
    lamin = Math.min(lamin, lat); lamax = Math.max(lamax, lat); lomin = Math.min(lomin, lon); lomax = Math.max(lomax, lon);
  }
  return {
    lamin: Math.max(-90, lamin - marginDeg), lamax: Math.min(90, lamax + marginDeg),
    lomin: Math.max(-180, lomin - marginDeg), lomax: Math.min(180, lomax + marginDeg),
    crossesAntimeridian: lomax - lomin > 180,
  };
}

/** Ray-casting point-in-polygon on lon/lat (fine for hazard areas of a few hundred km). */
export function inPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function classifyTraffic(states, polys) {
  return (states || [])
    .filter((s) => s[STATE.lon] != null && s[STATE.lat] != null)
    .map((s) => {
      const p = [s[STATE.lon], s[STATE.lat]];
      return {
        icao: s[STATE.icao], callsign: String(s[STATE.callsign] || '').trim() || s[STATE.icao], country: s[STATE.country],
        lon: p[0], lat: p[1], altM: s[STATE.geoAlt] ?? s[STATE.baroAlt], onGround: !!s[STATE.onGround],
        velMs: s[STATE.velocity], track: s[STATE.track], inside: polys.some((poly) => inPolygon(p, poly)),
      };
    })
    .filter((a) => !a.onGround)
    .sort((a, b) => Number(b.inside) - Number(a.inside));
}

export async function fetchTraffic(box) {
  if (box.crossesAntimeridian) throw new Error('The hazard area crosses the antimeridian; live traffic is not supported there yet.');
  const q = `lamin=${box.lamin.toFixed(3)}&lomin=${box.lomin.toFixed(3)}&lamax=${box.lamax.toFixed(3)}&lomax=${box.lomax.toFixed(3)}`;
  const get = async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (r.status === 429) throw new Error('OpenSky rate limit reached. Try again later, or add OpenSky credentials to the server.');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  let j;
  try { j = await get(`api/opensky?${q}`); } catch (e) { if (/rate limit/.test(e.message)) throw e; j = await get(`https://opensky-network.org/api/states/all?${q}`); }
  return { time: (j.time || Date.now() / 1000) * 1000, states: j.states || [] };
}
