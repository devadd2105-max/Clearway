// Clearway Lunar — Chandrayaan-3 historical analysis.
//
// Recomputes the lighting and Earth visibility at the Vikram landing site around the real landing on
// 23 August 2023, with the same engine as the rest of Clearway (ephemeris + LOLA skyline when the 60°S
// map is installed), and compares Clearway's predicted local sunset and sunrise with ISRO's published
// mission timeline. Facts below cite their sources; nothing about Vikram's internal design is assumed.

import { ephemerisGrid, analyseSite } from './analysis.js';
import { resolveThermal, steadyHeaterW, coolDownHours } from './thermal.js';

export const CH3 = {
  site: { id: 'ch3', name: 'Chandrayaan-3 Vikram landing site', lat: -69.3741, lon: 32.32, heightM: 532 },
  siteSource: 'NASA LRO / LROC image 1314 "Chandrayaan-3 Landing Site": 69.3741°S, 32.32°E, 532 m',
  landing: Date.parse('2023-08-23T12:33:00Z'),
  events: [
    { key: 'landing', t: '2023-08-23T12:33:00Z', label: 'Touchdown', detail: '23 Aug 2023, about 18:03 IST (12:33 UTC)', source: 'ISRO (widely reported touchdown time)' },
    { key: 'rover', t: '2023-09-02T12:00:00Z', label: 'Rover asleep', detail: 'Pragyan parked with a full battery and set to sleep (announced 2 Sep 2023)', source: 'ISRO announcement, 2 Sep 2023' },
    { key: 'lander', t: '2023-09-04T02:30:00Z', label: 'Lander asleep', detail: 'Vikram set to sleep around 08:00 IST on 4 Sep 2023, after its hop experiment', source: 'ISRO announcement, 4 Sep 2023' },
    { key: 'wake', t: '2023-09-22T00:00:00Z', label: 'Wake-up attempts', detail: 'ISRO tried to re-establish contact from about 22 Sep 2023, when sunlight returned; no signal was received', source: 'ISRO statements, Sep 2023' },
  ],
  designLife: 'One lunar daylight period, about 14 Earth days (ISRO Chandrayaan-3 brochure)',
};

const H = 3600000;

/**
 * Lighting and Earth visibility at the Vikram site around the landing.
 * horizon: the site's Horizon (LOLA if built, else smooth Moon). Returns plain numbers for display and tests.
 */
export function analyseLanding(horizon, { site = CH3.site, landing = CH3.landing, stepMin = 30, thermal = {} } = {}) {
  const start = landing - 20 * 86400000, end = landing + 50 * 86400000;
  const grid = ephemerisGrid(start, end, stepMin);
  const a = analyseSite(site, horizon, grid, {});
  const k0 = Math.round((landing - start) / grid.step);
  const lit = (k) => a.sunFrac[k] >= 0.5;
  const t = (k) => grid.start + k * grid.step;
  let sunrise = null, sunset = null, nextSunrise = null;
  for (let k = k0; k > 0; k--) if (lit(k) && !lit(k - 1)) { sunrise = t(k); break; }
  let ks = null;
  for (let k = k0; k < grid.n - 1; k++) if (lit(k) && !lit(k + 1)) { ks = k + 1; sunset = t(k + 1); break; }
  if (ks != null) for (let k = ks; k < grid.n - 1; k++) if (!lit(k) && lit(k + 1)) { nextSunrise = t(k + 1); break; }
  // Earth link and Sun height during the remaining daylight
  let link = 0, n = 0, maxSun = -90;
  for (let k = k0; k < (ks ?? grid.n); k++) { link += a.comms[k]; n++; maxSun = Math.max(maxSun, a.sunEl[k]); }
  const th = resolveThermal({ enabled: true, ...thermal });
  const nightH = sunset && nextSunrise ? (nextSunrise - sunset) / H : null;
  const cool = coolDownHours(th);
  const nightWh = nightH == null ? null : th.survivalElecW * nightH + steadyHeaterW(th) * Math.max(0, nightH - (Number.isFinite(cool) ? cool : nightH));
  const ev = Object.fromEntries(CH3.events.map((e) => [e.key, Date.parse(e.t)]));
  return {
    grid, a, k0, terrain: horizon.terrain,
    touchdown: {
      sunElDeg: a.sunEl[k0], sunAboveSkylineDeg: a.sunEl[k0] - a.sunHz[k0], sunVisible: a.sunFrac[k0],
      earthElDeg: a.earthEl[k0], earthAboveSkylineDeg: a.earthEl[k0] - a.earthHz[k0], earthLink: !!a.comms[k0],
    },
    sunrise, sunset, nextSunrise,
    daylightAfterLandingH: sunset ? (sunset - landing) / H : null,
    daylightTotalH: sunrise && sunset ? (sunset - sunrise) / H : null,
    nightH,
    maxSunElDeg: maxSun,
    earthLinkPctDaylight: n ? (100 * link) / n : null,
    landerSleepBeforeSunsetH: sunset ? (sunset - ev.lander) / H : null,
    wakeAfterSunriseH: nextSunrise ? (ev.wake - nextSunrise) / H : null,
    nightEnergyKWh: nightWh == null ? null : nightWh / 1000,
    thermal: th, coolDownH: cool,
  };
}

/** Sun-visible and Earth-link strip with the ISRO timeline marked (canvas). */
export function drawLandingStrip(canvas, r, { tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() } = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const { grid, a } = r;
  const t0 = CH3.landing - 3 * 86400000, t1 = CH3.landing + 34 * 86400000;
  const L = 74, R = 10, top = 8, rowH = 22, gap = 10;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (w - L - R);
  const fg = tok('--fg'), muted = tok('--muted'), line = tok('--line'), sun = tok('--sun') || '#ffd34d', earth = tok('--earth-2') || '#6fb7ff';
  ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif'; ctx.textBaseline = 'middle';
  const rows = [['Sun visible', (k) => a.sunFrac[k], sun], ['Earth link', (k) => a.comms[k], earth]];
  rows.forEach(([label, val, col], i) => {
    const y = top + i * (rowH + gap);
    ctx.fillStyle = muted; ctx.fillText(label, 4, y + rowH / 2);
    ctx.strokeStyle = line; ctx.strokeRect(L, y, w - L - R, rowH);
    ctx.fillStyle = col;
    for (let k = 0; k < grid.n; k++) {
      const t = grid.start + k * grid.step; if (t < t0 || t > t1) continue;
      const v = val(k); if (!v) continue;
      ctx.globalAlpha = 0.25 + 0.75 * v;
      ctx.fillRect(X(t), y + 1, Math.max(1, X(t + grid.step) - X(t)), rowH - 2);
    }
    ctx.globalAlpha = 1;
  });
  // ISRO timeline markers
  const yb = top + 2 * (rowH + gap);
  CH3.events.forEach((e, i) => {
    const x = X(Date.parse(e.t));
    ctx.strokeStyle = fg; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, yb + 4 + i * 14); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = fg;
    const tw = ctx.measureText(e.label).width;
    ctx.textAlign = x + 3 + tw > w - R ? 'right' : 'left';
    ctx.fillText(e.label, x + (ctx.textAlign === 'left' ? 3 : -3), yb + 12 + i * 14); // one row per event: labels never overlap
  });
  ctx.textAlign = 'left';
  // date ticks every 7 days
  ctx.fillStyle = muted; ctx.font = '11px "IBM Plex Mono", monospace';
  for (let t = Date.parse('2023-08-21T00:00:00Z'); t < t1; t += 7 * 86400000) ctx.fillText(new Date(t).toISOString().slice(5, 10), X(t) - 14, yb + 12 + CH3.events.length * 14 + 8);
}
