// Clearway Lunar — south-polar map from NASA data (built by tools/pgda.py).
// Layers: LOLA terrain shading, Mazarico et al. average sunlight, permanent shadow (overlay).
// Orientation matches the rest of the app: seen from below, 0° longitude (towards Earth) up, 90°E right.

const R = 1737400;
const imgCache = new Map();
const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export async function loadPolarMap(url = 'data/polar-map.json') {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    const meta = await r.json();
    await Promise.all(Object.values(meta.layers).map((l) => image(`data/${l.file}`).then((img) => { l.img = img; }).catch(() => { l.img = null; })));
    return meta;
  } catch { return null; }
}

function image(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  imgCache.set(src, p);
  return p;
}

/** lat/lon → projected X (right), Y (down) in metres. */
export function toXY(lat, lon) {
  const rho = 2 * R * Math.tan(((90 - Math.abs(lat)) * Math.PI) / 360);
  const l = (lon * Math.PI) / 180;
  return [rho * Math.sin(l), -rho * Math.cos(l)];
}
export function toLatLon(X, Y) {
  const rho = Math.hypot(X, Y);
  return [-(90 - (2 * Math.atan(rho / (2 * R)) * 180) / Math.PI), (Math.atan2(X, -Y) * 180) / Math.PI];
}

let psrCanvas = null;
function psrOverlay(img) {
  if (psrCanvas?.src === img.src) return psrCanvas.c;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const on = d.data[i] > 127;
    const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width);
    const hatch = ((px + py) % 6) < 2; // diagonal hatching: readable in black and white
    d.data[i] = d.data[i + 1] = d.data[i + 2] = hatch ? 255 : 0;
    d.data[i + 3] = on ? (hatch ? 230 : 150) : 0;
  }
  x.putImageData(d, 0, 0);
  psrCanvas = { src: img.src, c };
  return c;
}

/**
 * Draw the map. view = {cx, cy, half} in metres (centre and half-width shown).
 * sites: [{id, short, name, lat, lon}], statusOf(id) → 'go'|'caution'|'nogo'.
 */
export function drawPolarMap(canvas, meta, { layer = 'terrain', psr = true, view, sites = [], selected = null, statusOf = () => null, cursor = null }) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = tok('--panel-2'); ctx.fillRect(0, 0, w, h);
  if (!meta) return null;
  const half = view.half, s = Math.min(w, h) / (2 * half);
  const px = (X) => w / 2 + (X - view.cx) * s, py = (Y) => h / 2 + (Y - view.cy) * s;
  const rmax = meta.rhoMaxM, size = meta.size, mpp = (2 * rmax) / size;
  const src = (X0, Y0, X1, Y1) => [(X0 + rmax) / mpp, (Y0 + rmax) / mpp, (X1 - X0) / mpp, (Y1 - Y0) / mpp];
  const X0 = view.cx - w / 2 / s, Y0 = view.cy - h / 2 / s, X1 = view.cx + w / 2 / s, Y1 = view.cy + h / 2 / s;
  const L = meta.layers[layer]?.img ? meta.layers[layer] : meta.layers.terrain;
  ctx.imageSmoothingEnabled = half > 20000;
  if (L?.img) ctx.drawImage(L.img, ...src(X0, Y0, X1, Y1), 0, 0, w, h);
  if (psr && meta.layers.psr?.img) ctx.drawImage(psrOverlay(meta.layers.psr.img), ...src(X0, Y0, X1, Y1), 0, 0, w, h);
  // graticule
  ctx.strokeStyle = tok('--line-strong'); ctx.lineWidth = 0.7; ctx.globalAlpha = 0.7;
  for (let lat = -88; lat >= -80; lat -= 2) {
    const r = 2 * R * Math.tan(((90 + lat) * Math.PI) / 360);
    ctx.beginPath(); ctx.arc(px(0), py(0), r * s, 0, Math.PI * 2); ctx.stroke();
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const [xa, ya] = toXY(-79.5, lon);
    ctx.beginPath(); ctx.moveTo(px(0), py(0)); ctx.lineTo(px(xa), py(ya)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // scale bar
  const target = half / 3, pow = 10 ** Math.floor(Math.log10(target)), bar = [1, 2, 5].map((m) => m * pow).filter((v) => v <= target).pop() || pow;
  ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(12, h - 14); ctx.lineTo(12 + bar * s, h - 14); ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(12, h - 14); ctx.lineTo(12 + bar * s, h - 14); ctx.stroke();
  ctx.font = '11px "IBM Plex Mono", monospace'; ctx.lineJoin = 'round';
  const sb = bar >= 1000 ? `${bar / 1000} km` : `${bar} m`;
  ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(sb, 14, h - 20); ctx.fillStyle = '#fff'; ctx.fillText(sb, 14, h - 20);
  // sites
  const hits = [];
  const shape = (x, y, st, r) => {
    ctx.beginPath();
    if (st === 'go') ctx.arc(x, y, r, 0, Math.PI * 2);
    else if (st === 'caution') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y + r); ctx.lineTo(x - r - 1, y + r); ctx.closePath(); }
    else ctx.rect(x - r, y - r, 2 * r, 2 * r);
  };
  const boxes = [];
  const ordered = [...sites].sort((p1, p2) => (p2.id === selected) - (p1.id === selected));
  const labels = [];
  for (const site of ordered) {
    if (site.lat > -79.5) continue;
    const [X, Y] = toXY(site.lat, site.lon);
    const x = px(X), y = py(Y);
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
    const st = statusOf(site.id), sel = site.id === selected, r = sel ? 6 : 4.5;
    shape(x, y, st, r);
    ctx.fillStyle = st === 'go' ? tok('--go') : st === 'caution' ? tok('--caution') : st === 'nogo' ? tok('--nogo') : '#ffffff';
    ctx.fill(); ctx.lineWidth = 1.6; ctx.strokeStyle = '#000000'; ctx.stroke();
    if (sel) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke(); }
    boxes.push({ x: x - r - 1, y: y - r - 1, w: 2 * r + 2, h: 2 * r + 2 }); // markers block labels too
    labels.push({ site, x, y, sel });
    hits.push({ id: site.id, x, y });
  }
  // labels after all markers, placed where they collide with nothing (selected site first)
  const free = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h && !boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  for (const { site, x, y, sel } of labels) {
    ctx.font = `${sel ? '600 ' : ''}11px "IBM Plex Sans", system-ui, sans-serif`;
    const label = site.short || site.name, tw = ctx.measureText(label).width;
    const cands = [[x + 9, y - 7], [x - 9 - tw, y - 7], [x - tw / 2, y - 22], [x - tw / 2, y + 9], [x + 9, y - 18], [x + 9, y + 4], [x - 9 - tw, y + 4], [x - 9 - tw, y - 18]];
    const pos = cands.map(([bx, by]) => ({ x: bx, y: by, w: tw, h: 14 })).find(free);
    if (!pos) continue;
    boxes.push(pos);
    ctx.lineJoin = 'round'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3.5; ctx.strokeText(label, pos.x, pos.y + 11);
    ctx.fillStyle = '#fff'; ctx.fillText(label, pos.x, pos.y + 11);
  }
  if (cursor) {
    const [X, Y] = toXY(cursor.lat, cursor.lon);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(px(X) - 8, py(Y)); ctx.lineTo(px(X) + 8, py(Y)); ctx.moveTo(px(X), py(Y) - 8); ctx.lineTo(px(X), py(Y) + 8); ctx.stroke();
  }
  return {
    hit(x, y) { let b = null, bd = 144; for (const p of hits) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; b = p.id; } } return b; },
    latlon(x, y) { return toLatLon(view.cx + (x - w / 2) / s, view.cy + (y - h / 2) / s); },
    sample(layerKey, lat, lon) { // grey value of a layer at a point (0–1), for the hover read-out
      const l = meta.layers[layerKey]; if (!l?.img) return null;
      const [X, Y] = toXY(lat, lon);
      const i = Math.floor((X + rmax) / mpp), j = Math.floor((Y + rmax) / mpp);
      if (i < 0 || j < 0 || i >= size || j >= size) return null;
      return readPixel(l.img, i, j);
    },
  };
}

const pixCache = new Map();
function readPixel(img, i, j) {
  let d = pixCache.get(img.src);
  if (!d) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
    d = { data: x.getImageData(0, 0, c.width, c.height).data, w: c.width };
    pixCache.set(img.src, d);
  }
  return d.data[4 * (j * d.w + i)] / 255;
}
