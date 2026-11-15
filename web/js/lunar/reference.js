// Clearway Lunar — reference positions from JPL Horizons (DE441) used to self-check the ephemeris.
// Observer: coord@301 (Moon, Mean Earth frame, sphere R = 1737.4 km); QUANTITIES=4, apparent
// airless azimuth/elevation; retrieved 2026-10-15 from ssd.jpl.nasa.gov.
import { skyAt, DEG } from './ephem.js';

export const HORIZONS = [
  // site [lonE, lat], body, UTC, az, el
  { site: [0, -89.5], body: 'sun', t: '2026-11-14T00:00Z', az: 126.627333, el: 1.258335 },
  { site: [0, -89.5], body: 'sun', t: '2026-11-14T12:00Z', az: 120.534441, el: 1.30262 },
  { site: [0, -89.5], body: 'sun', t: '2026-11-15T00:00Z', az: 114.442858, el: 1.349506 },
  { site: [0, -89.5], body: 'earth', t: '2026-11-14T00:00Z', az: 358.773423, el: -4.148545 },
  { site: [0, -89.5], body: 'earth', t: '2026-11-14T12:00Z', az: 358.078065, el: -3.621837 },
  { site: [0, -89.5], body: 'earth', t: '2026-11-15T00:00Z', az: 357.381171, el: -3.053516 },
  { site: [31.2, -84.3], body: 'sun', t: '2027-03-02T00:00Z', az: 222.313318, el: -4.812306 },
  { site: [31.2, -84.3], body: 'sun', t: '2027-03-04T00:00Z', az: 197.856651, el: -6.054034 },
  { site: [31.2, -84.3], body: 'earth', t: '2027-03-02T00:00Z', az: 331.729513, el: -0.433785 },
  { site: [31.2, -84.3], body: 'earth', t: '2027-03-04T00:00Z', az: 328.877453, el: 1.633603 },
  { site: [210, -88], body: 'sun', t: '2027-07-20T00:00Z', az: 134.468686, el: -1.816657 },
  { site: [210, -88], body: 'sun', t: '2027-07-22T00:00Z', az: 110.078301, el: -1.048286 },
  { site: [210, -88], body: 'earth', t: '2027-07-20T00:00Z', az: 149.009592, el: -1.963169 },
  { site: [210, -88], body: 'earth', t: '2027-07-22T00:00Z', az: 146.307423, el: 0.832196 },
  { site: [0, 0], body: 'earth', t: '2026-12-01T00:00Z', az: 78.564004, el: 83.165165 },
  { site: [0, 0], body: 'earth', t: '2026-12-03T00:00Z', az: 58.896523, el: 82.008926 },
];

/** Largest angular difference (deg) between this ephemeris and the Horizons reference set. */
export function selfCheck() {
  let sun = 0, earth = 0;
  for (const h of HORIZONS) {
    const s = skyAt({ lat: h.site[1], lon: h.site[0] }, Date.parse(h.t))[h.body];
    const dAz = Math.abs(((s.az - h.az + 540) % 360) - 180) * Math.cos(h.el * DEG);
    const err = Math.hypot(s.el - h.el, dAz);
    if (h.body === 'sun') sun = Math.max(sun, err); else earth = Math.max(earth, err);
  }
  return { sun, earth, n: HORIZONS.length };
}
