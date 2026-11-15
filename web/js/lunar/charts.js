// Clearway Lunar — canvas charts: horizon panorama, mission timeline, site × date heatmap and the
// south-polar Moon globe. All colours come from CSS tokens so both themes work.

import { DEG } from './ephem.js';

const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const FONT = '"IBM Plex Mono", ui-monospace, monospace';
const FONT_UI = '"IBM Plex Sans", system-ui, sans-serif';

export function setup(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const fmtDate = (t) => new Date(t).toISOString().slice(5, 10);

// ------------------------------------------------------------------ horizon panorama
/**
 * Terrain silhouette over 360° of azimuth with the Sun's and Earth's tracks for the period and
 * their discs (true angular size) at the cursor time.
 *   geometric: draw the smooth-Moon horizon (dashed) so terrain blocking is visible at a glance
 *   band:      draw the skyline ±band° (terrain-uncertainty overlay)
 */
export function drawPanorama(canvas, { horizon, a, k, trackStep = 3, centerAz = null, geometric = true, band = 0 }) {
  const { ctx, w, h } = setup(canvas);
  if (!w || !a) return null;
  const C = { sky: tok('--sky'), sky2: tok('--sky-2'), ground: tok('--ground'), rim: tok('--ground-rim'), sun: tok('--sun'), earth: tok('--earth-2'), muted: tok('--muted'), line: tok('--line'), fg: tok('--fg'), nogo: tok('--nogo'), caution: tok('--caution') };
  const L = 40, R = 10, T = 10, B = 24;
  const hs = horizon.stats();
  let lo = Math.min(hs.min - band, -1.5), hi = Math.max(hs.max + band, 1.5);
  for (let i = 0; i < a.sunEl.length; i += trackStep) { hi = Math.max(hi, a.sunEl[i] + 0.4); lo = Math.min(lo, a.sunEl[i] - 0.4); hi = Math.max(hi, a.earthEl[i] + 1.2); lo = Math.min(lo, a.earthEl[i] - 1.2); }
  if (hi - lo < 6) { const m = (hi + lo) / 2; hi = m + 3; lo = m - 3; }
  // a mid-latitude site sees the Sun climb high: keep the horizon readable by capping the view
  if (hi > 40) hi = 40;
  lo = Math.floor(lo); hi = Math.ceil(hi);
  // centre the view on Earth's mean direction so the comms-critical part of the sky is never split
  if (centerAz == null) {
    let sx = 0, sy = 0;
    for (let i = 0; i < a.earthAz.length; i += trackStep) { sx += Math.sin(a.earthAz[i] * DEG); sy += Math.cos(a.earthAz[i] * DEG); }
    centerAz = Math.round(Math.atan2(sx, sy) / DEG / 15) * 15;
  }
  const az0 = centerAz - 180;
  const X = (az) => L + ((((az - az0) % 360) + 360) % 360) / 360 * (w - L - R);
  const Y = (el) => T + (hi - el) / (hi - lo) * (h - T - B);
  const pxPerDegX = (w - L - R) / 360, pxPerDegY = (h - T - B) / (hi - lo);
  // sky
  const g = ctx.createLinearGradient(0, T, 0, h - B);
  g.addColorStop(0, C.sky); g.addColorStop(1, C.sky2);
  ctx.fillStyle = g; ctx.fillRect(L, T, w - L - R, h - T - B);
  // grid
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.font = `10px ${FONT}`; ctx.fillStyle = C.muted;
  const span = hi - lo;
  const step = span > 30 ? 10 : span > 14 ? 4 : span > 7 ? 2 : 1;
  for (let e = Math.ceil(lo / step) * step; e <= hi; e += step) {
    ctx.globalAlpha = e === 0 ? 0.9 : 0.4;
    ctx.beginPath(); ctx.moveTo(L, Y(e)); ctx.lineTo(w - R, Y(e)); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillText(`${e > 0 ? '+' : ''}${e}°`, 4, Y(e) + 3);
  }
  for (const [az, lab] of [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']]) {
    const x = X(az);
    if (x < L + 4 || x > w - R - 4) continue;
    ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(lab, x - (lab.length * 3), h - 8);
  }
  // tracks
  const n = a.sunEl.length;
  for (let i = 0; i < n; i += trackStep) {
    ctx.fillStyle = C.earth; ctx.globalAlpha = a.dte[i] ? 0.55 : 0.25;
    ctx.fillRect(X(a.earthAz[i]) - 1, Y(a.earthEl[i]) - 1, 2, 2);
    ctx.fillStyle = a.sunFrac[i] >= 0.5 ? C.sun : C.muted; ctx.globalAlpha = a.sunFrac[i] >= 0.5 ? 0.7 : 0.35;
    ctx.fillRect(X(a.sunAz[i]) - 1, Y(a.sunEl[i]) - 1, 2, 2);
  }
  ctx.globalAlpha = 1;
  const path = (off) => { for (let az = az0; az <= az0 + 360; az += 0.5) ctx.lineTo(X(az === az0 + 360 ? az - 1e-6 : az), Y(horizon.at(az) + off)); };
  // uncertainty band (drawn under the terrain so the upper half shows as a halo)
  if (band > 0) {
    ctx.beginPath(); ctx.moveTo(L, h - B); path(band); ctx.lineTo(w - R, h - B); ctx.closePath();
    ctx.fillStyle = C.caution; ctx.globalAlpha = 0.28; ctx.fill(); ctx.globalAlpha = 1;
  }
  // terrain
  ctx.beginPath(); ctx.moveTo(L, h - B); path(0); ctx.lineTo(w - R, h - B); ctx.closePath();
  ctx.fillStyle = C.ground; ctx.fill();
  ctx.strokeStyle = C.rim; ctx.lineWidth = 1.4; ctx.stroke();
  if (band > 0) {
    ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = C.caution; ctx.lineWidth = 1;
    ctx.beginPath(); path(-band); ctx.stroke(); ctx.restore();
  }
  // geometric (smooth-Moon) horizon
  if (geometric && a.dip != null && horizon.terrain) {
    ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = C.fg; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, Y(a.dip)); ctx.lineTo(w - R, Y(a.dip)); ctx.stroke(); ctx.restore();
    ctx.fillStyle = C.muted; ctx.font = `10px ${FONT}`; ctx.fillText('smooth-Moon horizon', L + 6, Y(a.dip) - 4);
  }
  // bodies at cursor (true angular size; ellipse because of vertical exaggeration)
  if (k != null) {
    const disc = (az, el, rDeg, col, blocked) => {
      ctx.save(); ctx.beginPath(); ctx.rect(L, T, w - L - R, h - T - B); ctx.clip();
      ctx.beginPath(); ctx.ellipse(X(az), Y(el), Math.max(2, rDeg * pxPerDegX), Math.max(2, rDeg * pxPerDegY), 0, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.globalAlpha = blocked ? 0.4 : 1; ctx.fill(); ctx.globalAlpha = 1;
      if (blocked) ctx.setLineDash([3, 2]);
      ctx.strokeStyle = blocked ? C.nogo : C.sky; ctx.lineWidth = blocked ? 2 : 1.2; ctx.stroke(); ctx.restore();
    };
    const elE = Math.min(hi - 0.5, a.earthEl[k]), elS = Math.min(hi - 0.3, a.sunEl[k]);
    disc(a.earthAz[k], elE, 0.95, C.earth, !a.dte[k]);
    disc(a.sunAz[k], elS, 0.267, C.sun, a.sunFrac[k] < 0.5);
    ctx.fillStyle = C.fg; ctx.font = `11px ${FONT_UI}`;
    const lbl = (txt, x, y) => { ctx.lineJoin = 'round'; ctx.strokeStyle = C.sky; ctx.lineWidth = 3; ctx.strokeText(txt, x, y); ctx.fillText(txt, x, y); };
    lbl(`Sun ${Math.round(a.sunFrac[k] * 100)}%`, Math.min(w - R - 60, X(a.sunAz[k]) + 8), Y(elS) - 8);
    const em = a.earthEl[k] - a.earthHz[k];
    lbl(`Earth ${em >= 0 ? '+' : ''}${em.toFixed(1)}°`, Math.min(w - R - 70, X(a.earthAz[k]) + 10), Y(elE) - 10);
  }
  ctx.fillStyle = C.muted; ctx.font = `10px ${FONT}`;
  const ex = pxPerDegY / pxPerDegX;
  ctx.fillText(`vertical ×${ex.toFixed(0)}`, w - R - 80, T + 12);
  return { exaggeration: ex, lo, hi };
}

// ------------------------------------------------------------------ timeline
/**
 * Synchronised rows: sunlight, Earth link (terrain line of sight, with the geometric tier hatched),
 * power against load (heater share hatched), usable battery charge and — with the thermal model —
 * lander temperature. `highlight` = {k0, k1} shades an interval. `trace` (from stayTrace) replaces the
 * whole-period battery/load/temperature series inside the planned stay.
 */
export function drawTimeline(canvas, { a, grid, k, highlight = null, from = 0, to = null, trace = null }) {
  const { ctx, w, h } = setup(canvas);
  if (!w || !a) return null;
  const C = { sun: tok('--sun'), earth: tok('--earth'), earth2: tok('--earth-2'), muted: tok('--muted'), line: tok('--line'), fg: tok('--fg'), go: tok('--go'), nogo: tok('--nogo'), caution: tok('--caution'), bg: tok('--panel') };
  const L = TL_L, R = TL_R, T = 6, B = 20;
  const thermal = a.opts.thermal?.enabled;
  const rows = [['Sunlight', 'sun'], ['Earth link', 'earth'], ['Power vs load', 'power'], ['Battery (usable)', 'soc']];
  if (thermal) rows.push(['Temperature', 'temp']);
  const rh = (h - T - B) / rows.length;
  const i0 = from, i1 = to == null ? grid.n - 1 : to;
  const span = Math.max(1, i1 - i0);
  const X = (i) => L + ((i - i0) / span) * (w - L - R);
  const cw = Math.max(1, (w - L - R) / span + 0.5);
  const src = (i) => (trace && i >= trace.k0 && i < trace.k1 ? trace : a);
  const load = (i) => src(i).load[i], soc = (i) => src(i).soc[i], heat = (i) => src(i).heater[i], temp = (i) => src(i).temp[i];
  let maxP = 1;
  for (let i = i0; i <= i1; i++) maxP = Math.max(maxP, a.power[i], load(i));
  const usable = a.opts.battery.capacityWh * a.opts.battery.usableFraction;
  const stride = Math.max(1, Math.floor(span / (w - L - R)));
  const hatch = hatchPattern(ctx, C.fg);
  if (highlight) {
    ctx.fillStyle = C.caution; ctx.globalAlpha = 0.18;
    ctx.fillRect(X(Math.max(i0, highlight.k0)), T, Math.max(2, X(Math.min(i1, highlight.k1)) - X(Math.max(i0, highlight.k0))), h - T - B);
    ctx.globalAlpha = 1;
  }
  let tLo = Infinity, tHi = -Infinity;
  if (thermal) { for (let i = i0; i <= i1; i++) { const v = temp(i); if (Number.isFinite(v)) { tLo = Math.min(tLo, v); tHi = Math.max(tHi, v); } } tLo = Math.min(tLo, a.opts.thermal.minC) - 10; tHi = Math.max(tHi, a.opts.thermal.maxC) + 10; }
  ctx.font = `11px ${FONT_UI}`;
  rows.forEach(([label, key], r) => {
    const y0 = T + r * rh, y1 = y0 + rh - 6, ih = rh - 10;
    ctx.fillStyle = C.muted; ctx.fillText(label, 6, y0 + rh / 2);
    ctx.strokeStyle = C.line; ctx.strokeRect(L, y0, w - L - R, rh - 6);
    ctx.save(); ctx.beginPath(); ctx.rect(L, y0, w - L - R, rh - 6); ctx.clip();
    if (key === 'earth') {
      for (let i = i0; i <= i1; i++) {
        if (a.comms[i]) { ctx.fillStyle = C.earth2; ctx.globalAlpha = 0.9; ctx.fillRect(X(i), y0 + 2, cw, ih); }
        else if (a.earthGeo[i]) { ctx.fillStyle = hatch; ctx.globalAlpha = 0.5; ctx.fillRect(X(i), y0 + 2, cw, ih); }
      }
      ctx.globalAlpha = 1;
    } else if (key === 'temp') {
      const Y = (v) => y1 - ((v - tLo) / (tHi - tLo)) * ih;
      ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = C.caution; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, Y(a.opts.thermal.minC)); ctx.lineTo(w - R, Y(a.opts.thermal.minC)); ctx.stroke(); ctx.restore();
      ctx.strokeStyle = C.fg; ctx.lineWidth = 1.3; ctx.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i += stride) { const v = temp(i); if (!Number.isFinite(v)) { pen = false; continue; } pen ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); pen = true; }
      ctx.stroke();
      ctx.fillStyle = C.muted; ctx.font = `10px ${FONT}`;
      ctx.fillText(`${Math.round(tHi - 10)} °C`, w - R - 44, y0 + 10); ctx.fillText(`${a.opts.thermal.minC} °C`, w - R - 44, Y(a.opts.thermal.minC) - 2);
      ctx.font = `11px ${FONT_UI}`;
    } else {
      const val = (i) => key === 'sun' ? a.sunFrac[i] : key === 'power' ? a.power[i] / maxP : usable ? soc(i) / usable : 0;
      ctx.beginPath(); ctx.moveTo(X(i0), y1);
      for (let i = i0; i <= i1; i += stride) ctx.lineTo(X(i), y1 - val(i) * ih);
      ctx.lineTo(X(i1), y1 - val(i1) * ih); ctx.lineTo(X(i1), y1); ctx.closePath();
      ctx.fillStyle = key === 'sun' ? C.sun : key === 'power' ? C.muted : C.go; ctx.globalAlpha = key === 'soc' ? 0.45 : key === 'sun' ? 0.8 : 0.55; ctx.fill(); ctx.globalAlpha = 1;
      if (key === 'power') {
        // heater share of the load, then the load line
        if (thermal) {
          ctx.fillStyle = hatch; ctx.globalAlpha = 0.55;
          for (let i = i0; i <= i1; i += stride) { const hw = heat(i); if (hw > 0.5) { const yl = y1 - (load(i) / maxP) * ih; ctx.fillRect(X(i), yl, Math.max(1, cw * stride), (hw / maxP) * ih); } }
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = C.fg; ctx.lineWidth = 1; ctx.beginPath();
        for (let i = i0; i <= i1; i += stride) { const y = y1 - (load(i) / maxP) * ih; i === i0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); }
        ctx.stroke();
      }
      if (key === 'soc') {
        let mi = i0;
        for (let i = i0; i <= i1; i++) { if (soc(i) <= 0) { ctx.fillStyle = C.nogo; ctx.globalAlpha = 0.8; ctx.fillRect(X(i), y0 + 2, cw, ih); ctx.globalAlpha = 1; } if (soc(i) < soc(mi)) mi = i; }
        ctx.fillStyle = C.fg; ctx.font = `10px ${FONT}`;
        const pct = usable ? Math.round((100 * soc(mi)) / usable) : 0;
        ctx.beginPath(); ctx.arc(X(mi), y1 - val(mi) * ih, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillText(`min ${pct}%`, Math.min(w - R - 50, X(mi) + 5), Math.max(y0 + 10, y1 - val(mi) * ih - 3));
        ctx.font = `11px ${FONT_UI}`;
      }
    }
    ctx.restore();
  });
  if (trace && trace.k0 >= i0 && trace.k0 <= i1) { // touchdown marker
    ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = C.go; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(X(trace.k0), T); ctx.lineTo(X(trace.k0), h - B); ctx.stroke(); ctx.restore();
  }
  // date ticks
  ctx.fillStyle = C.muted; ctx.font = `10px ${FONT}`;
  const days = (span * grid.step) / 86400000;
  const every = days > 200 ? 30 : days > 60 ? 14 : days > 20 ? 7 : days > 6 ? 2 : 1;
  const first = Math.ceil(((i0 * grid.step) / 86400000) - 1e-9);
  for (let d = first; d * 86400000 <= i1 * grid.step; d += every) {
    const i = Math.round((d * 86400000) / grid.step);
    if (X(i) > w - R - 20) break;
    ctx.fillText(fmtDate(grid.start + d * 86400000), X(i) - 14, h - 5);
  }
  if (k != null && k >= i0 && k <= i1) {
    ctx.strokeStyle = C.fg; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(k), T); ctx.lineTo(X(k), h - B); ctx.stroke();
  }
  return { L, R, i0, i1, toIndex: (x) => Math.round(i0 + ((x - L) / (w - L - R)) * span) };
}

/** Diagonal hatch pattern in the given colour (transparent background). */
export function hatchPattern(ctx, color, gap = 5) {
  const c = document.createElement('canvas'); c.width = c.height = gap;
  const x = c.getContext('2d');
  x.strokeStyle = color; x.lineWidth = 1;
  x.beginPath(); x.moveTo(0, gap); x.lineTo(gap, 0); x.stroke();
  return ctx.createPattern(c, 'repeat');
}
export const TL_L = 104, TL_R = 10;

// ------------------------------------------------------------------ landing calendar
/**
 * Month rows × day-of-month columns. Each cell is one landing day for the selected site:
 * green shades = feasible (darker = better score), red = battery runs flat, grey = no touchdown
 * possible (Sun or Earth below the skyline all day), hatched = too soon / beyond the period.
 */
export function drawCalendar(canvas, { days, selectedDay = null, bestDay = null }) {
  const { ctx, w, h } = setup(canvas);
  if (!w || !days.length) return null;
  const C = { go: tok('--go'), nogo: tok('--nogo'), muted: tok('--muted'), line: tok('--line'), fg: tok('--fg'), base: tok('--panel-2'), panel: tok('--panel') };
  const months = [];
  for (const d of days) {
    const dt = new Date(d.dayStart), key = dt.toISOString().slice(0, 7);
    if (!months.length || months[months.length - 1].key !== key) months.push({ key, cells: [] });
    months[months.length - 1].cells.push({ d, dom: dt.getUTCDate() });
  }
  const L = 64, R = 4, T = 16, B = 4;
  const cw = (w - L - R) / 31, ch = Math.min(22, (h - T - B) / months.length);
  const [gr, gg, gb] = hex(C.go), [br, bg, bb] = hex(C.base);
  const scores = days.filter((d) => d.status === 'ok').map((d) => d.score);
  const sMin = Math.min(...scores, 0), sMax = Math.max(...scores, 1);
  ctx.font = `10px ${FONT}`; ctx.fillStyle = C.muted;
  for (let dom = 1; dom <= 31; dom += dom < 5 ? 4 : 5) ctx.fillText(String(dom), L + (dom - 1) * cw + 2, 11);
  const hits = [];
  months.forEach((m, r) => {
    ctx.fillStyle = C.muted; ctx.font = `10px ${FONT}`; ctx.fillText(m.key, 4, T + r * ch + ch / 2 + 3);
    for (const { d, dom } of m.cells) {
      const x = L + (dom - 1) * cw, y = T + r * ch, ww = Math.max(1, cw - 1.5), hh = Math.max(1, ch - 2);
      if (d.status === 'ok') {
        const t = 0.25 + 0.75 * ((d.score - sMin) / Math.max(1e-6, sMax - sMin));
        ctx.fillStyle = `rgb(${Math.round(br + (gr - br) * t)},${Math.round(bg + (gg - bg) * t)},${Math.round(bb + (gb - bb) * t)})`;
        ctx.fillRect(x, y, ww, hh);
      } else if (d.status === 'infeasible') {
        ctx.fillStyle = C.nogo; ctx.globalAlpha = 0.75; ctx.fillRect(x, y, ww, hh); ctx.globalAlpha = 1;
      } else if (d.status === 'no-touchdown') {
        ctx.fillStyle = C.muted; ctx.globalAlpha = 0.45; ctx.fillRect(x, y, ww, hh); ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, ww - 1, hh - 1);
        ctx.beginPath(); ctx.moveTo(x, y + hh); ctx.lineTo(x + ww, y); ctx.stroke();
      }
      if (d.day === bestDay) { ctx.fillStyle = C.fg; ctx.font = `600 ${Math.min(12, hh)}px ${FONT_UI}`; ctx.fillText('★', x + ww / 2 - 4, y + hh / 2 + 4); }
      if (d.day === selectedDay) { ctx.strokeStyle = C.fg; ctx.lineWidth = 2; ctx.strokeRect(x - 0.5, y - 0.5, ww + 1, hh + 1); }
      hits.push({ x, y, w: ww, h: hh, d });
    }
  });
  return { hit: (x, y) => hits.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)?.d ?? null, height: T + months.length * ch + B };
}

// ------------------------------------------------------------------ heatmap
/** rows: [{label, values: Float32Array (0–1)}]; returns hit-test helper. */
export function drawHeatmap(canvas, { rows, start, days, metric = 'sun', selected = null, dayCursor = null }) {
  const { ctx, w, h } = setup(canvas);
  if (!w || !rows.length) return null;
  const C = { muted: tok('--muted'), fg: tok('--fg'), line: tok('--line'), a: tok(metric === 'sun' ? '--sun' : '--earth-2'), base: tok('--panel-2') };
  const L = 92, R = 8, T = 18, B = 6;
  const cw = (w - L - R) / days, ch = (h - T - B) / rows.length;
  const [ar, ag, ab] = hex(C.a), [br, bg, bb] = hex(C.base);
  rows.forEach((row, r) => {
    for (let d = 0; d < days; d++) {
      const v = row.values[d] ?? 0;
      const t = Math.pow(v, 0.8);
      ctx.fillStyle = `rgb(${Math.round(br + (ar - br) * t)},${Math.round(bg + (ag - bg) * t)},${Math.round(bb + (ab - bb) * t)})`;
      ctx.fillRect(L + d * cw, T + r * ch, Math.ceil(cw), Math.ceil(ch) - 1);
    }
    ctx.fillStyle = row.id === selected ? C.fg : C.muted;
    ctx.font = `${row.id === selected ? '600 ' : ''}11px ${FONT_UI}`;
    ctx.fillText(row.label, 6, T + r * ch + ch / 2 + 4);
  });
  ctx.fillStyle = C.muted; ctx.font = `10px ${FONT}`;
  let lastM = -1;
  for (let d = 0; d < days; d++) {
    const dt = new Date(start + d * 86400000);
    if (dt.getUTCMonth() !== lastM && dt.getUTCDate() <= 7) { lastM = dt.getUTCMonth(); ctx.fillText(dt.toISOString().slice(0, 7), L + d * cw, 11); }
  }
  if (dayCursor != null) { ctx.strokeStyle = C.fg; ctx.lineWidth = 1.5; ctx.strokeRect(L + dayCursor * cw, T, Math.max(2, cw), h - T - B); }
  return { hit: (x, y) => (x < L || y < T ? null : { row: Math.floor((y - T) / ch), day: Math.floor((x - L) / cw) }) };
}

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const r = /rgba?\(([^)]+)\)/.exec(c);
  return r ? r[1].split(',').slice(0, 3).map(Number) : [128, 128, 128];
}

// ------------------------------------------------------------------ Moon globe
/**
 * Orthographic view of the Moon from outside, shaded by the Sun direction at the cursor time
 * (smooth sphere: it shows the terminator, not terrain shadows).
 *   polar view (all shown sites near the south pole): looking up at the south pole, 0° longitude
 *     at the top and 90°E on the right — the same orientation as LOLA south-polar maps.
 *   otherwise: the hemisphere centred on the selected site, north up, east on the right.
 */
export function drawMoonGlobe(canvas, { sunDir, earthDir, sites, selected, statusOf, view = 'auto' }) {
  const { ctx, w, h } = setup(canvas);
  if (!w) return null;
  const C = { fg: tok('--fg'), muted: tok('--muted'), sun: tok('--sun'), earth: tok('--earth'), line: tok('--line'), lit: tok('--moon-lit'), dark: tok('--moon-dark'), bg: tok('--panel') };
  const sel = sites.find((x) => x.id === selected) || sites[0];
  const polar = view === 'polar' || (view === 'auto' && (!sel || sel.lat <= -75));
  const unit = (lat, lon) => { const c = Math.cos(lat * DEG); return [c * Math.cos(lon * DEG), c * Math.sin(lon * DEG), Math.sin(lat * DEG)]; };
  let c, up, extent;
  if (polar) {
    c = [0, 0, -1]; up = [1, 0, 0];
    const colat = Math.max(6, ...sites.filter((x) => x.lat <= -75).map((x) => 90 + x.lat + 1.5));
    extent = Math.min(20, colat);
  } else {
    c = unit(sel.lat, sel.lon);
    up = [-Math.sin(sel.lat * DEG) * Math.cos(sel.lon * DEG), -Math.sin(sel.lat * DEG) * Math.sin(sel.lon * DEG), Math.cos(sel.lat * DEG)];
    extent = 90;
  }
  const right = cross(up, c); // camera looks along −c, so screen-right = up × c
  const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2 - 22;
  const s = rad / Math.sin(extent * DEG);
  const dpr = canvas.width / w;
  const img = ctx.createImageData(canvas.width, canvas.height);
  const [lr, lg, lb] = hex(C.lit), [dr, dg, db] = hex(C.dark);
  const sd = sunDir ? norm3(sunDir) : [1, 0, 0];
  for (let py = 0; py < canvas.height; py++) {
    for (let px = 0; px < canvas.width; px++) {
      const X = px / dpr - cx, Y = py / dpr - cy;
      if (X * X + Y * Y > rad * rad) continue;
      const u = X / s, v = -Y / s, q = 1 - u * u - v * v;
      if (q < 0) continue;
      const z = Math.sqrt(q);
      const nx = u * right[0] + v * up[0] + z * c[0], ny = u * right[1] + v * up[1] + z * c[1], nz = u * right[2] + v * up[2] + z * c[2];
      const d = nx * sd[0] + ny * sd[1] + nz * sd[2];
      const t = Math.max(0, Math.min(1, d * (polar ? 18 : 6) + 0.5));
      const i = 4 * (py * canvas.width + px);
      img.data[i] = dr + (lr - dr) * t; img.data[i + 1] = dg + (lg - dg) * t; img.data[i + 2] = db + (lb - db) * t; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const P = (lat, lon) => { const p = unit(lat, lon); return { x: cx + s * dot3(p, right), y: cy - s * dot3(p, up), vis: dot3(p, c) > 0 }; };
  const inView = (q) => q.vis && (q.x - cx) ** 2 + (q.y - cy) ** 2 <= rad * rad + 1;
  const poly = (pts) => { ctx.beginPath(); let pen = false; for (const q of pts) { if (inView(q)) { pen ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); pen = true; } else pen = false; } ctx.stroke(); };
  // graticule
  ctx.strokeStyle = C.line; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.8;
  const lats = polar ? Array.from({ length: Math.floor(extent / 2) }, (_, i) => -88 + 2 * i) : [-60, -30, 0, 30, 60];
  const lonStep = 30;
  for (const lat of lats) poly(Array.from({ length: 121 }, (_, i) => P(lat, i * 3)));
  for (let lon = 0; lon < 360; lon += lonStep) poly(Array.from({ length: 91 }, (_, i) => P(-90 + i * 2, lon)));
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.muted; ctx.font = `10px ${FONT}`;
  if (polar) {
    for (const [lon, lab] of [[0, '0°'], [90, '90°E'], [180, '180°'], [270, '90°W']]) {
      const q = P(-90 + extent * 0.93, lon);
      ctx.fillText(lab, q.x - ctx.measureText(lab).width / 2, q.y + 4);
    }
  } else {
    ctx.fillText('N', cx - 3, cy - rad - 6);
    const eq = P(0, sel.lon + 60);
    if (inView(eq)) ctx.fillText('E', cx + rad + 4, cy + 4);
  }
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  // sun & earth direction markers on the rim (direction projected onto the screen)
  const rim = (vec, col, label) => {
    if (!vec) return;
    const v = norm3(vec), ang = Math.atan2(dot3(v, right), dot3(v, up));
    const x = cx + (rad + 12) * Math.sin(ang), y = cy - (rad + 12) * Math.cos(ang);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.fg; ctx.font = `10px ${FONT_UI}`;
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, x + 8 + tw > w ? x - 8 - tw : x + 8, y + 3);
  };
  rim(sunDir, C.sun, 'Sun'); rim(earthDir, C.earth, 'Earth');
  // sites (selected first, then labels placed only where they do not collide)
  const hits = [], boxes = [];
  const ordered = [...sites].sort((p1, p2) => (p2.id === selected) - (p1.id === selected));
  for (const site of ordered) {
    const q = P(site.lat, site.lon);
    if (!inView(q)) continue;
    const { x, y } = q;
    const st = statusOf?.(site.id);
    ctx.fillStyle = st === 'go' ? tok('--go') : st === 'caution' ? tok('--caution') : st === 'nogo' ? tok('--nogo') : C.fg;
    ctx.strokeStyle = C.bg; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, site.id === selected ? 6 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (site.id === selected) { ctx.strokeStyle = C.fg; ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke(); }
    ctx.font = `${site.id === selected ? '600 ' : ''}10.5px ${FONT_UI}`;
    const label = site.short || site.name, tw = ctx.measureText(label).width;
    const fits = (bx) => bx >= 0 && bx + tw <= w && !boxes.some((b) => bx < b.x + b.w && bx + tw > b.x && y - 9 < b.y + 12 && y + 3 > b.y);
    const bx = fits(x + 8) ? x + 8 : fits(x - 8 - tw) ? x - 8 - tw : null;
    if (bx != null) { ctx.lineJoin = 'round'; ctx.strokeStyle = C.bg; ctx.lineWidth = 3; ctx.strokeText(label, bx, y + 3); ctx.fillStyle = C.fg; ctx.fillText(label, bx, y + 3); boxes.push({ x: bx, y: y - 9, w: tw }); }
    hits.push({ id: site.id, x, y });
  }
  return { polar, project: (lat, lon) => P(lat, lon), hit: (x, y) => { let b = null, bd = 196; for (const p of hits) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; b = p.id; } } return b; } };
}

const norm3 = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; };
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
