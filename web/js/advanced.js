// Clearway — advanced result panels: encounter view, cleanest-corridor optimiser, business
// impact, in-orbit advisory, live airspace and first contact. Rendered under the results by
// main.js, which passes in an `app` object with shared state and helpers.

import { optimizeHold, defaultTrims } from './optimize.js';
import { screenOrbitOps } from './orbitops.js';
import { lifetimeImpact } from './econ.js';
import { bboxOf, classifyTraffic, fetchTraffic } from './airspace.js';
import { fetchStations, firstContacts } from './groundstations.js';
import { drawEncounter, drawHoldChart } from './charts.js';
import { DEG } from './orbit.js';

const ISP = [['Cold gas', 70], ['Resistojet', 120], ['Monopropellant (hydrazine)', 220], ['Green monoprop', 250], ['Bipropellant', 310], ['Hall-effect electric', 1500]];

export function advancedSkeleton() {
  return `
  <section class="panel-block" id="adv-encounter">
    <header><span class="section-title">Encounter view</span><button class="btn small" type="button" id="enc-fly">Show ellipsoids in 3D</button></header>
    <p class="hint" id="enc-caption">Select a close approach to see its encounter plane.</p>
    <canvas class="enc-box" id="enc-canvas" aria-label="Encounter plane plot"></canvas>
  </section>
  <section class="panel-block" id="adv-opt">
    <header><span class="section-title">Cleanest corridor</span><button class="btn small" type="button" id="opt-run">Optimise hold</button></header>
    <p class="lead hint" id="opt-lead">Re-screens ±60 s around the selected T-0 in 2 s steps${''} and picks the hold with the lowest collision risk.</p>
    <canvas class="chart-box" id="opt-chart" hidden aria-label="Collision probability against hold time"></canvas>
    <div class="actions" id="opt-actions" hidden></div>
  </section>
  <section class="panel-block" id="adv-econ">
    <header><span class="section-title">Business impact</span></header>
    <p class="lead hint">What a late launch or an avoidance burn costs in propellant and operating life.</p>
    <div class="econ-grid">
      <label class="field"><span>Satellite wet mass <span class="unit">kg</span></span><input type="number" id="e-wet" min="1" step="any"></label>
      <label class="field"><span>Propellant <span class="unit">kg</span></span><input type="number" id="e-prop" min="0" step="any"></label>
      <label class="field"><span>Propulsion</span><select id="e-isp">${ISP.map(([n, v]) => `<option value="${v}" ${v === 220 ? 'selected' : ''}>${n} · ${v} s</option>`).join('')}</select></label>
      <label class="field"><span>Station-keeping <span class="unit">m/s/yr</span></span><input type="number" id="e-annual" min="0.1" step="any" value="10"></label>
      <label class="field"><span>Disposal reserve <span class="unit">m/s</span></span><input type="number" id="e-reserve" min="0" step="any" value="20"></label>
      <label class="field"><span>Revenue <span class="unit">$/month</span></span><input type="number" id="e-rev" min="0" step="any" placeholder="optional"></label>
    </div>
    <label class="field"><span id="e-slider-label">Launch time within the window</span><input type="range" id="e-slider" min="0" max="0" value="0"></label>
    <div class="kv" id="e-out"></div>
  </section>
  <section class="panel-block" id="adv-ops">
    <header><span class="section-title">In-orbit advisory</span>
      <span class="actions"><select id="ops-days" aria-label="Days to screen"><option value="1">1 day</option><option value="2" selected>2 days</option><option value="3">3 days</option><option value="7">7 days</option></select>
      <button class="btn small" type="button" id="ops-run">Screen orbit</button></span></header>
    <p class="lead hint">Screens the payload's predicted orbit after insertion and sizes an in-track avoidance burn for each risky approach.</p>
    <div id="ops-out"></div>
  </section>
  <section class="panel-block" id="adv-air">
    <header><span class="section-title">Live airspace</span><button class="btn small" type="button" id="air-run">Check live traffic</button></header>
    <p class="lead hint">Aircraft in and around the hazard corridor right now (OpenSky Network ADS-B).</p>
    <div id="air-out"></div>
  </section>
  <section class="panel-block" id="adv-contact">
    <header><span class="section-title">First contact</span><button class="btn small" type="button" id="gs-run">Find SatNOGS stations</button></header>
    <p class="lead hint">Open-network ground stations that can hear the payload's first beacon after insertion.</p>
    <div id="gs-out"></div>
  </section>`;
}

export function bindAdvanced(app) {
  const { $, esc, fmt, toast } = app;
  const A = () => app.state.analysis;

  // ---------- encounter view
  $('#enc-fly').addEventListener('click', () => app.show3dEvent());

  // ---------- optimiser
  $('#opt-run').addEventListener('click', async () => {
    const sel = app.state.sel; if (!sel) return;
    const btn = $('#opt-run'); btn.disabled = true; btn.textContent = 'Optimising…';
    try {
      const m = A().mission;
      const opt = await optimizeHold({
        candidate: sel.r, mission: m, objects: app.state.catalog.list, propagate: (o, t) => app.state.catalog.position(o, t),
        exemptNorad: m.orbit.mode === 'object' ? app.state.target?.norad : null, azTrimsDeg: defaultTrims(m),
        onProgress: ({ done, total }) => { btn.textContent = `Optimising ${Math.round((100 * done) / total)}%`; },
      });
      app.state.opt = { ...opt, forId: sel.r.id };
      renderOpt(app);
    } catch (e) { toast(`Optimisation failed: ${e.message}`); }
    btn.disabled = false; btn.textContent = 'Optimise hold';
  });

  // ---------- economics
  ['#e-wet', '#e-prop', '#e-isp', '#e-annual', '#e-reserve', '#e-rev', '#e-slider'].forEach((id) => $(id).addEventListener('input', () => renderEcon(app)));

  // ---------- in-orbit
  $('#ops-run').addEventListener('click', async () => {
    const sel = app.state.sel; if (!sel) return;
    const btn = $('#ops-run'); btn.disabled = true;
    const days = +$('#ops-days').value;
    app.state.opsAbort = new AbortController();
    $('#ops-out').innerHTML = `<div class="progress"><div class="bar"><i id="ops-bar"></i></div><span class="hint num" id="ops-detail">Starting…</span><div class="actions"><button class="btn small" type="button" id="ops-cancel">Cancel</button></div></div>`;
    $('#ops-cancel').addEventListener('click', () => app.state.opsAbort.abort());
    try {
      const res = await screenOrbitOps({
        traj: sel.traj, mission: A().mission, objects: app.state.catalog.list, propagate: (o, t) => app.state.catalog.position(o, t), days, stepSec: 60,
        reportKm: Math.min(A().mission.screening.reportKm, 15), signal: app.state.opsAbort.signal,
        onProgress: ({ done, total, propagations }) => { $('#ops-bar').style.width = `${(100 * done) / total}%`; $('#ops-detail').textContent = `${Math.round((100 * done) / total)}% · ${propagations.toLocaleString()} propagations`; },
      });
      app.state.ops = res;
      renderOps(app); renderEcon(app);
    } catch (e) { $('#ops-out').innerHTML = `<p class="hint">${e.name === 'AbortError' ? 'Cancelled.' : esc(e.message)}</p>`; }
    btn.disabled = false;
  });

  // ---------- airspace
  $('#air-run').addEventListener('click', async () => {
    const hz = app.state.sel?.hz; if (!hz) return;
    const polys = [hz.corridor, hz.impact].filter(Boolean);
    $('#air-out').innerHTML = '<p class="hint">Querying OpenSky…</p>';
    try {
      const { time, states } = await fetchTraffic(bboxOf(polys, 1.5));
      const traffic = classifyTraffic(states, polys);
      app.state.traffic = { time, traffic };
      app.pushOverlays({ aircraft: traffic });
      const inside = traffic.filter((a) => a.inside);
      $('#air-out').innerHTML = `<div class="actions"><span class="big-num">${inside.length}</span><span class="hint">aircraft inside the hazard area now · ${traffic.length} within 1.5° · ADS-B at ${new Date(time).toISOString().slice(11, 19)}Z</span></div>
        ${traffic.length ? `<div class="table-wrap"><table><thead><tr><th>Flight</th><th>Origin</th><th class="num">Alt m</th><th class="num">Speed m/s</th><th>Zone</th></tr></thead><tbody>
        ${traffic.slice(0, 25).map((a) => `<tr><td>${esc(a.callsign)}</td><td>${esc(a.country)}</td><td class="num">${fmt(a.altM, 0)}</td><td class="num">${fmt(a.velMs, 0)}</td><td>${a.inside ? '<span class="sev red"></span>Inside' : 'Nearby'}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <p class="hint">Live positions are a snapshot, not a forecast for launch day. The hazard area is published to pilots through the NOTAM in the compliance pack.</p>`;
    } catch (e) { $('#air-out').innerHTML = `<p class="hint">Live traffic unavailable: ${esc(e.message)}</p>`; }
  });

  // ---------- first contact
  $('#gs-run').addEventListener('click', async () => {
    const sel = app.state.sel; if (!sel) return;
    $('#gs-out').innerHTML = '<p class="hint">Loading SatNOGS stations…</p>';
    try {
      app.state.stations ??= await fetchStations();
      const passes = firstContacts(sel.traj, app.state.stations, { hours: 12 });
      app.state.contacts = passes;
      $('#gs-out').innerHTML = passes.length ? `<p class="hint">${passes.length} of ${app.state.stations.length} online stations see the payload within 12 h of insertion. First AOS ${app.hms((passes[0].aos - sel.r.t0) / 1000)} after T-0.</p>
        <div class="table-wrap"><table><thead><tr><th>Station</th><th class="num">AOS (T+)</th><th class="num">Max el.</th><th class="num">Pass</th></tr></thead><tbody>
        ${passes.slice(0, 15).map((p) => `<tr><td><a href="https://network.satnogs.org/stations/${p.station.id}/" target="_blank" rel="noopener">${esc(p.station.name)}</a></td><td class="num">${app.hms((p.aos - sel.r.t0) / 1000)}</td><td class="num">${fmt(p.maxEl, 0)}°</td><td class="num">${fmt(p.durationSec / 60, 1)} min</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">Schedule observations on network.satnogs.org once the satellite and its transmitter are in SatNOGS DB.</p>` : '<p class="hint">No station sees the payload above 10° in the first 12 hours.</p>';
    } catch (e) { $('#gs-out').innerHTML = `<p class="hint">SatNOGS unavailable: ${esc(e.message)}</p>`; }
  });
}

/** Called whenever the selected candidate changes. */
export function onCandidateChanged(app) {
  const { $ } = app;
  const sel = app.state.sel;
  const m = app.state.analysis.mission;
  if (!$('#e-wet').value) $('#e-wet').value = m.massKg || 12;
  if (!$('#e-prop').value) $('#e-prop').value = Math.max(0.1, +((m.massKg || 12) * 0.08).toFixed(2));
  const wr = app.state.analysis.rows.filter((r) => r.windowId === sel.r.windowId);
  const sl = $('#e-slider');
  sl.max = String(wr.length - 1);
  sl.value = String(Math.max(0, wr.findIndex((r) => r.id === sel.r.id)));
  if (app.state.opt && app.state.opt.forId !== sel.r.id) { $('#opt-chart').hidden = true; $('#opt-actions').hidden = true; }
  if (app.state.ops && app.state.ops.forT0 !== sel.r.t0) { $('#ops-out').innerHTML = ''; app.state.ops = null; }
  $('#air-out').innerHTML = ''; $('#gs-out').innerHTML = '';
  renderEcon(app);
  renderEncounter(app);
}

export function renderEncounter(app) {
  const { $ } = app;
  const ev = app.state.selEvent;
  const c = $('#enc-canvas');
  if (!ev) { $('#enc-caption').textContent = 'No close approach for this T-0. Pick another launch time to see its encounter plane.'; c.hidden = true; $('#enc-fly').disabled = true; return; }
  c.hidden = false; $('#enc-fly').disabled = false;
  $('#enc-caption').textContent = `${ev.name} (NORAD ${ev.norad}) at T+${app.hms(ev.tau)} · relative speed ${ev.relV.toFixed(2)} km/s. Plane perpendicular to the relative velocity; ellipses are the combined position uncertainty of both objects.`;
  drawEncounter(c, ev);
}

function renderOpt(app) {
  const { $, esc, fmt } = app;
  const o = app.state.opt;
  const c = $('#opt-chart'); c.hidden = false;
  drawHoldChart(c, o);
  const b = o.best, base = o.base;
  const act = $('#opt-actions'); act.hidden = false;
  act.innerHTML = o.improved
    ? `<span class="hint">Hold <strong>${b.hold > 0 ? '+' : ''}${b.hold} s</strong>${b.trim ? ` with a ${b.trim > 0 ? '+' : ''}${b.trim}° azimuth trim (inclination ${o.incDelta >= 0 ? '+' : ''}${o.incDelta.toFixed(3)}°)` : ''}: ${esc(base.status)} → ${esc(b.status)}, max Pc ${base.maxPc ? base.maxPc.toExponential(1) : '0'} → ${b.maxPc ? b.maxPc.toExponential(1) : '0'}, closest ${fmt(base.minMiss, 1)} → ${fmt(b.minMiss, 1)} km.</span><button class="btn small primary" type="button" id="opt-apply">Use this T-0</button>`
    : `<span class="hint">The selected T-0 is already the cleanest within ±60 s (max Pc ${base.maxPc ? base.maxPc.toExponential(1) : '0'}).</span>`;
  $('#opt-apply')?.addEventListener('click', () => app.applyOptimised(b));
}

function renderOps(app) {
  const { $, esc, fmt } = app;
  const res = app.state.ops;
  res.forT0 = app.state.sel.r.t0;
  const risky = res.events.filter((e) => e.severity !== 'info');
  const burns = risky.map((e) => (e.burns || []).filter((b) => b.dvMs != null && !b.notNeeded).sort((a, b) => a.dvMs - b.dvMs)[0]).filter(Boolean);
  res.totalBurnDv = burns.reduce((s, b) => s + b.dvMs, 0);
  $('#ops-out').innerHTML = `<p class="hint">${res.objects.toLocaleString()} objects in the shell screened for ${res.days} day(s): ${res.events.length} approaches within ${fmt(Math.min(app.state.analysis.mission.screening.reportKm, 15), 0)} km, ${risky.length} needing attention${burns.length ? `, avoidance Δv ${res.totalBurnDv.toFixed(2)} m/s in total` : ''}.</p>
    ${res.events.length ? `<div class="table-wrap"><table><thead><tr><th>Object</th><th class="num">TCA (after insertion)</th><th class="num">Miss km</th><th class="num">Pc</th><th>Recommendation</th></tr></thead><tbody>
    ${res.events.slice(0, 40).map((e) => {
      const b = (e.burns || []).filter((x) => x.dvMs != null).sort((x, y) => x.dvMs - y.dvMs)[0];
      const rec = e.severity === 'info' ? 'Monitor' : !b ? 'Re-screen with tracking data' : b.notNeeded ? 'No burn needed (Pc below 1e-6)' : `${b.direction} ${b.dvMs.toFixed(2)} m/s, ${(b.leadSec / 3600).toFixed(1)} h before TCA`;
      return `<tr><td><span class="sev ${e.severity}"></span>${esc(e.name)}</td><td class="num">${app.hms(e.tau - app.state.sel.traj.tInsSec)}</td><td class="num">${fmt(e.miss, 2)}</td><td class="num">${e.pc ? e.pc.toExponential(1) : '0'}</td><td>${esc(rec)}</td></tr>`;
    }).join('')}</tbody></table></div>` : ''}
    <p class="hint">Predicted from the nominal insertion. Once the payload is catalogued, screen its own element set or the operator ephemeris.</p>`;
}

export function renderEcon(app) {
  const { $, fmt } = app;
  const A = app.state.analysis; if (!A || !app.state.sel) return;
  const wr = A.rows.filter((r) => r.windowId === app.state.sel.r.windowId);
  const r = wr[+$('#e-slider').value] || app.state.sel.r;
  const sso = A.mission.orbit.mode === 'sso';
  const planeDv = r.dvPlane * 1000;
  const burnDv = app.state.ops?.totalBurnDv || 0;
  const p = { wetKg: +$('#e-wet').value, propKg: +$('#e-prop').value, ispS: +$('#e-isp').value, annualDv: +$('#e-annual').value, reserveDv: +$('#e-reserve').value, revenuePerMonth: +$('#e-rev').value || null };
  const base = lifetimeImpact({ ...p, extraDv: 0 });
  const late = lifetimeImpact({ ...p, extraDv: planeDv + burnDv });
  $('#e-slider-label').textContent = `Launch at ${new Date(r.t0).toISOString().slice(11, 19)}Z (${r.offsetSec >= 0 ? '+' : ''}${fmt(r.offsetSec / 60, 1)} min) · ${r.overall}`;
  const cells = [
    ['Δv budget', `${fmt(base.budget, 1)} m/s`],
    ['Design lifetime', Number.isFinite(base.lifeYears) ? `${fmt(base.lifeYears, 1)} years` : '—'],
    [sso ? 'Node time shift' : 'Plane correction', sso ? `${fmt(r.nodeShiftMin, 1)} min (no Δv)` : `${fmt(planeDv, 1)} m/s`],
    ['Avoidance burns (in-orbit)', app.state.ops ? `${fmt(burnDv, 2)} m/s` : 'Run in-orbit advisory'],
    ['Propellant used', `${fmt(late.propUsedKg * 1000, 0)} g`],
    ['Lifetime lost', late.exceedsBudget ? 'Exceeds budget' : `${fmt(late.monthsLost, 1)} months`],
  ];
  if (late.revenueLost != null) cells.push(['Revenue at risk', `$${Math.round(late.revenueLost).toLocaleString()}`], ['Remaining lifetime', `${fmt(late.lifeYearsAfter, 1)} years`]);
  $('#e-out').innerHTML = cells.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
}

export { DEG };
