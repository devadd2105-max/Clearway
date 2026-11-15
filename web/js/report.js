// Clearway — exports: mission report (standalone HTML), candidate table (CSV),
// full analysis (JSON) and hazard areas (GeoJSON).

import { dm } from './hazards.js';

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
export const fmtUtc = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
export const slug = (s) => String(s || 'mission').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mission';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function candidatesCsv(rows) {
  const head = ['t0_utc', 'window', 'pass', 'flight_azimuth_deg', 'plane_error_deg', 'dv_total_kms', 'collision_status', 'conjunctions', 'min_miss_km', 'max_pc', 'weather_status', 'weather_reasons', 'overall'];
  return [head.join(','), ...rows.map((r) => [
    iso(r.t0), r.windowId + 1, r.pass, r.azR.toFixed(2), r.planeErrDeg.toFixed(3), r.dvTotal.toFixed(3), r.col.status,
    r.col.events.length, Number.isFinite(r.col.minMiss) ? r.col.minMiss.toFixed(2) : '', r.col.maxPc ? r.col.maxPc.toExponential(2) : '0',
    r.wx.status, r.wx.reasons.join('; '), r.overall,
  ].map(csvCell).join(','))].join('\n');
}

export function reportHtml({ mission, plan, rec, candidates, hazards, stats, catalogInfo, generatedAt }) {
  const m = mission;
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const events = rec ? rec.col.events.slice(0, 25) : [];
  const windowsRows = plan.windows.map((w) => {
    const best = candidates.filter((c) => c.windowId === w.id).sort((a, b) => a.score - b.score)[0];
    return `<tr><td>${w.id + 1}</td><td>${w.pass === 'asc' ? 'Northbound' : 'Southbound'}</td><td>${w.tPlanar ? fmtUtc(w.tPlanar) : '—'}</td><td>${best ? fmtUtc(best.t0) : '—'}</td><td class="s-${best?.overall}">${best?.overall ?? '—'}</td><td>${best ? best.col.events.length : ''}</td><td>${best ? esc(best.wx.status) : ''}</td></tr>`;
  }).join('');
  const hz = hazards ? `
    <h2>Launch hazard areas</h2>
    <p>Approximate areas for coordination with the aviation and maritime authorities. Attach the GeoJSON export to the notice request.</p>
    <table>${row('Stage 1 impact centre', hazards.impactCenter ? esc(dm(hazards.impactCenter[1], hazards.impactCenter[0])) : 'Beyond modelled ascent')}
    ${row('Impact area', `${hazards.opts.impactAlongKm * 2} × ${hazards.opts.impactCrossKm * 2} km ellipse at ${hazards.opts.stage1Km} km downrange`)}
    ${row('Corridor', `±${hazards.opts.corridorHalfWidthKm} km either side of the ground track`)}
    ${row('Ground track length to insertion', `${hazards.trackLengthKm.toFixed(0)} km`)}</table>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.name)} — launch planning report</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#132033;max-width:900px;margin:32px auto;padding:0 20px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:2px solid #132033;padding-bottom:4px;text-transform:uppercase;letter-spacing:.06em}
.meta{color:#56647a}table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0}th,td{border-bottom:1px solid #d8dee8;padding:5px 8px;text-align:left;vertical-align:top}
th{width:34%;color:#56647a;font-weight:600}thead th{width:auto;background:#f2f4f7}.num{font-family:ui-monospace,Menlo,monospace;text-align:right}
.s-CLEAR,.s-GO{color:#12885a;font-weight:600}.s-CAUTION{color:#a86c00;font-weight:600}.s-NO-GO{color:#c8303a;font-weight:600}
.box{border:1px solid #d8dee8;border-left:5px solid #0b7f97;padding:12px 16px;margin:16px 0}.small{font-size:12px;color:#56647a}
</style></head><body>
<h1>${esc(m.name)}</h1>
<div class="meta">Launch planning report · generated ${fmtUtc(generatedAt)} by Clearway</div>
<div class="box">${rec ? `<b>Recommended T-0: ${fmtUtc(rec.t0)}</b><br>Overall: <span class="s-${rec.overall}">${rec.overall}</span> · Collision: <span class="s-${rec.col.status}">${rec.col.status}</span> · Weather: <span class="s-${rec.wx.status.replace(' ', '')}">${esc(rec.wx.status)}</span>` : '<b>No launch candidate available.</b>'}</div>
<h2>Mission</h2><table>
${row('Operator', esc(m.operator))}${row('Country of origin', esc(m.country))}${row('Licence / authorisation', esc(m.licence) || '—')}
${row('Launch vehicle', esc(m.vehicle))}${row('Payload', `${esc(m.payload)}${m.massKg ? ` (${m.massKg} kg)` : ''}`)}
${row('Objective', esc(m.objective) || '—')}${row('Launch site', `${esc(m.site.name)} (${m.site.lat.toFixed(4)}°, ${m.site.lon.toFixed(4)}°)`)}
${row('Target orbit', `${m.orbit.hKm} km circular, ${plan.perf.incDeg.toFixed(2)}° — ${esc(plan.planeLabel)}`)}
</table>
<h2>Trajectory and performance (first-order)</h2><table>
${rec ? row('Flight azimuth', `${(rec.azR * 180 / Math.PI).toFixed(2)}° (inertial ${(rec.azI * 180 / Math.PI).toFixed(2)}°)`) : ''}
${row('Orbital velocity', `${plan.perf.vOrb.toFixed(3)} km/s`)}${row('Orbital period', `${(plan.perf.period / 60).toFixed(1)} min`)}
${rec ? row('Earth-rotation assist', `${(rec.dvAssist * 1000).toFixed(0)} m/s`) : ''}
${rec ? row('Plane error at T-0', `${rec.planeErrDeg.toFixed(3)}° (${(rec.dvPlane * 1000).toFixed(1)} m/s to correct)`) : ''}
${rec ? row('Estimated Δv to orbit', `${rec.dvTotal.toFixed(2)} km/s incl. ${m.ascent.lossesKms} km/s gravity and drag losses`) : ''}
</table>
<h2>Launch windows</h2><table><thead><tr><th>#</th><th>Pass</th><th>In-plane instant</th><th>Best T-0</th><th>Status</th><th>Conj.</th><th>Weather</th></tr></thead><tbody>${windowsRows}</tbody></table>
<h2>Conjunctions for recommended T-0</h2>
${events.length ? `<table><thead><tr><th>Object</th><th>NORAD</th><th>Phase</th><th class="num">T+ (s)</th><th class="num">Miss (km)</th><th class="num">Rel. speed (km/s)</th><th class="num">Pc (indicative)</th></tr></thead><tbody>
${events.map((e) => `<tr><td>${esc(e.name)}</td><td>${e.norad}</td><td>${e.phase}</td><td class="num">${e.tau.toFixed(0)}</td><td class="num">${e.miss.toFixed(2)}</td><td class="num">${e.relV.toFixed(2)}</td><td class="num">${e.pc.toExponential(1)}</td></tr>`).join('')}</tbody></table>` : `<p>No tracked object passes within ${m.screening.reportKm} km during ascent and the first ${m.screening.orbits} orbit(s).</p>`}
<h2>Weather at recommended T-0</h2>
<p>${rec ? `${esc(rec.wx.status)}${rec.wx.reasons.length ? ': ' + esc(rec.wx.reasons.join('; ')) : ''}` : '—'}</p>
${hz}
<h2>Method and data</h2>
<p class="small">Catalog: ${esc(catalogInfo)}. Objects propagated with SGP4 from General Perturbations element sets. Vehicle trajectory: simplified direct ascent to the target altitude in ${m.ascent.tInsSec} s, then a circular orbit with J2 secular drift. Screened ${stats ? `${stats.objectsConsidered.toLocaleString()} objects` : ''} at a ${m.screening.stepSec} s step with linear interpolation and SGP4 refinement of each close approach. Pc is an indicative isotropic Gaussian estimate (vehicle 1σ ${m.screening.vehSigmaKm} km, object 1σ growing with element-set age). Weather: Open-Meteo forecast evaluated against the limits entered by the team.</p>
<p class="small"><b>This report supports planning only.</b> It does not replace launch collision avoidance screening by the 18th/19th Space Defense Squadron or the equivalent national service, range safety approval, or licensing by the competent authority.</p>
</body></html>`;
}
