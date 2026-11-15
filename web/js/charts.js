// Clearway — small canvas charts: the encounter-plane (B-plane) plot and the hold-optimiser chart.

const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function setup(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * Encounter-plane plot: the combined covariance ellipses (1, 2, 3 sigma) centred on the
 * object's position relative to the vehicle, and the combined hard-body circle at the origin.
 */
export function drawEncounter(canvas, ev) {
  const { ctx, w, h } = setup(canvas);
  if (!w) return;
  const fg = tok('--fg'), muted = tok('--muted'), line = tok('--line'), red = tok('--nogo'), amber = tok('--caution'), accent = tok('--accent');
  const { mx, my, sx, sy, angle } = ev.enc;
  const ext = Math.max(Math.abs(mx) + 3.4 * sx, Math.abs(my) + 3.4 * sx, 3.4 * sx, 0.05) * 1.1;
  const pad = 34, cw = w - pad - 12, ch = h - 30 - 12;
  const s = Math.min(cw, ch) / (2 * ext);
  const ox = pad + cw / 2, oy = 12 + ch / 2;
  const X = (x) => ox + x * s, Y = (y) => oy - y * s;
  // grid
  const step = niceStep(ext / 2);
  ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.fillStyle = muted; ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
  for (let v = -Math.floor(ext / step) * step; v <= ext; v += step) {
    ctx.beginPath(); ctx.moveTo(X(v), Y(-ext)); ctx.lineTo(X(v), Y(ext)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(-ext), Y(v)); ctx.lineTo(X(ext), Y(v)); ctx.stroke();
    if (Math.abs(v) > 1e-9) { ctx.fillText(fmtKm(v), X(v) - 8, h - 6); ctx.fillText(fmtKm(v), 2, Y(v) + 3); }
  }
  // ellipses
  const sev = ev.severity === 'red' ? red : ev.severity === 'amber' ? amber : accent;
  for (const [k, a] of [[3, 0.08], [2, 0.12], [1, 0.2]]) {
    ctx.save(); ctx.translate(X(mx), Y(my)); ctx.rotate(-angle);
    ctx.beginPath(); ctx.ellipse(0, 0, k * sx * s, k * sy * s, 0, 0, Math.PI * 2);
    ctx.globalAlpha = a; ctx.fillStyle = sev; ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = sev; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = sev; ctx.fillText(`${k}σ`, X(mx) + Math.cos(angle) * k * sx * s + 3, Y(my) - Math.sin(angle) * k * sx * s);
  }
  // miss vector, object, hard-body circle
  ctx.strokeStyle = fg; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(mx), Y(my)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = sev; ctx.beginPath(); ctx.arc(X(mx), Y(my), 3.5, 0, Math.PI * 2); ctx.fill();
  const hbrPx = ev.hbrKm * s;
  ctx.strokeStyle = fg; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(0), Y(0), Math.max(3, hbrPx), 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = fg; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
  ctx.fillText(`Vehicle + ${Math.round(ev.hbrKm * 1000)} m hard-body radius${hbrPx < 3 ? ' (enlarged)' : ''}`, X(0) + 8, Y(0) + 16);
  ctx.fillStyle = muted;
  ctx.fillText(`Miss ${ev.miss.toFixed(2)} km · Pc ${ev.pc ? ev.pc.toExponential(1) : '0'} · 1σ ${sx.toFixed(2)} × ${sy.toFixed(2)} km`, pad, h - 18);
}

/** Collision risk against hold time: bars of log10(Pc), coloured by status, best hold marked. */
export function drawHoldChart(canvas, opt) {
  const { ctx, w, h } = setup(canvas);
  if (!w) return;
  const muted = tok('--muted'), line = tok('--line'), fg = tok('--fg');
  const col = { CLEAR: tok('--go'), CAUTION: tok('--caution'), 'NO-GO': tok('--nogo') };
  const byHold = new Map();
  for (const s of opt.series) { const b = byHold.get(s.hold); if (!b || rank(s) < rank(b)) byHold.set(s.hold, s); }
  const pts = [...byHold.values()].sort((a, b) => a.hold - b.hold);
  const hMin = pts[0].hold, hMax = pts.at(-1).hold;
  const L = 40, R = 10, T = 12, B = 26;
  const X = (x) => L + ((x - hMin) / (hMax - hMin || 1)) * (w - L - R);
  const lo = -12, hi = 0;
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace'; ctx.strokeStyle = line; ctx.fillStyle = muted;
  for (const v of [-12, -9, -6, -4, -3, 0]) {
    ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - R, Y(v)); ctx.stroke();
    ctx.fillText(v === 0 ? '1' : `1e${v}`, 2, Y(v) + 3);
  }
  const bw = Math.max(2, (w - L - R) / pts.length - 1);
  for (const p of pts) {
    const v = p.maxPc > 0 ? Math.max(lo, Math.log10(p.maxPc)) : lo;
    ctx.fillStyle = col[p.status];
    ctx.fillRect(X(p.hold) - bw / 2, Y(v), bw, Y(lo) - Y(v) || 1.5);
  }
  for (let x = Math.ceil(hMin / 10) * 10; x <= hMax; x += hMax - hMin > 100 ? 30 : 10) { ctx.fillStyle = muted; ctx.fillText(`${x > 0 ? '+' : ''}${x}s`, X(x) - 10, h - 8); }
  ctx.strokeStyle = fg; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(opt.best.hold), T); ctx.lineTo(X(opt.best.hold), h - B); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = fg; ctx.fillText(`best ${opt.best.hold > 0 ? '+' : ''}${opt.best.hold}s`, Math.min(w - 70, X(opt.best.hold) + 4), T + 10);
  ctx.fillStyle = muted; ctx.fillText('max Pc', L + 4, T + 10);
}

const rank = (s) => ({ CLEAR: 0, CAUTION: 1, 'NO-GO': 2 }[s.status] * 100 + (s.maxPc > 0 ? Math.log10(s.maxPc) : -20));
const fmtKm = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
