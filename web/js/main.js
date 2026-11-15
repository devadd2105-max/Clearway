// Clearway — application shell: wires the mission form, analysis pipeline, globe,
// catalog browser, weather view and telemetry console together.

import { SITES, siteById } from './sites.js';
import { Catalog, GROUPS, TYPES } from './catalog.js';
import * as O from './orbit.js';
import { planMission } from './planner.js';
import { screenCandidates } from './screening.js';
import { fetchForecast, evaluateWeather, DEFAULT_LIMITS, WMO_TEXT } from './weather.js';
import { Globe } from './globe.js';
import { computeHazards, hazardsGeoJson, dm } from './hazards.js';
import { Telemetry, drawStrip } from './telemetry.js';
import { download, candidatesCsv, reportHtml, fmtUtc, iso, slug } from './report.js';
import { fetchSpaceWeather, insertionAdvisory } from './spaceweather.js';
import { spaceWeatherFactor } from './covariance.js';
import { buildBriefing, buildCompliancePack } from './briefing.js';
import { decodeTopoLonLat } from './globe.js';
import { CesiumView } from './cesiumview.js';
import { startGame } from './game.js';
import { advancedSkeleton, bindAdvanced, onCandidateChanged, renderEncounter, renderEcon } from './advanced.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const D = O.DEG;
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const hms = (sec) => { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const RANK = { GO: 0, CLEAR: 0, CAUTION: 1, 'NO DATA': 1, 'NO-GO': 2 };
const OVERALL = ['GO', 'CAUTION', 'NO-GO'];

const state = {
  sgp4: null, catalog: null, globe: null, ecef: null,
  target: null, analysis: null, selId: null, forecast: null,
  timeMode: 'live', tau: 0, playing: false, abort: null,
  sw: null, landTopo: null, overlays: {}, view3d: null, follow: false, opt: null, ops: null, selEvent: null, catalogFetchedAt: null,
};
const app = { state, $: (s, el = document) => el.querySelector(s), esc: (s) => esc(s), fmt: (v, d) => fmt(v, d), hms: (x) => hms(x), toast: (m, ms) => toast(m, ms) };

// ------------------------------------------------------------------ utilities
function toast(msg, ms = 4000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function setChip(id, text, st) { const c = $(id); c.textContent = text; c.dataset.state = st; }
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => { s.remove(); rej(new Error(src)); };
    document.head.appendChild(s);
  });
}
async function loadSgp4() {
  const srcs = ['vendor/satellite.min.js', 'https://cdn.jsdelivr.net/npm/satellite.js@4.1.4/dist/satellite.min.js', 'https://unpkg.com/satellite.js@4.1.4/dist/satellite.min.js'];
  for (const src of srcs) {
    try { await loadScript(src); if (window.satellite?.twoline2satrec) return window.satellite; } catch { /* next */ }
  }
  throw new Error('Could not load the SGP4 propagator (satellite.js). Run "python server.py --fetch-vendor" once while online.');
}
async function loadLand() {
  for (const src of ['vendor/land-110m.json', 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json']) {
    try { const r = await fetch(src); if (r.ok) return await r.json(); } catch { /* next */ }
  }
  return null;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('clearway:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('clearway:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ------------------------------------------------------------------ theme, clock, tabs
function initChrome() {
  const saved = store.get('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next; store.set('theme', next);
    state.globe?.readColors(); renderCatalog(); renderTelemetry();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => state.globe?.readColors());
  const tick = () => { $('#utc-clock').textContent = new Date().toISOString().slice(11, 19) + 'Z'; };
  $('#lineage-btn').addEventListener('click', openLineage);
  $('#game-btn').addEventListener('click', openGame);
  setInterval(updateFreshness, 30000);
  tick(); setInterval(tick, 1000);

  const tabs = $$('.tab');
  const show = (tab) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
    if (tab.id === 't-catalog') renderCatalog();
    if (tab.id === 't-telemetry') renderTelemetry();
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t)));
  tabs.forEach((t, i) => t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); show(n);
  }));
  state.showTab = (id) => show($('#' + id));
}

// ------------------------------------------------------------------ mission form
const COUNTRIES = ['Argentina', 'Australia', 'Bahrain', 'Brazil', 'Canada', 'China', 'France', 'Germany', 'India', 'Indonesia', 'Israel', 'Italy', 'Japan', 'Kenya', 'Luxembourg', 'Malaysia', 'Mexico', 'New Zealand', 'Nigeria', 'Norway', 'Paraguay', 'Philippines', 'Russia', 'Saudi Arabia', 'Senegal', 'Singapore', 'South Africa', 'South Korea', 'Spain', 'Sweden', 'Thailand', 'Türkiye', 'United Arab Emirates', 'United Kingdom', 'United States', 'Vietnam'];

function tomorrowUtc() {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 16);
}

const EXAMPLES = {
  sso: { mission: 'Example — EO smallsat rideshare', operator: 'Example Orbital Ltd', country: 'United States', licence: '', objective: 'Deploy a 12U Earth-observation demonstrator into a 10:30 LTDN sun-synchronous orbit.', vehicle: 'Falcon 9 (rideshare)', payload: 'EXOS-12U', mass: 24, hbr: 5, site: 'vsfb-4e', alt: 550, mode: 'sso', node: '10:30', nodetype: 'desc', nodetol: 5, tol: 0.2, days: 3, step: 1 },
  iss: { mission: 'Example — station cargo flight', operator: 'Example Logistics', country: 'United States', licence: '', objective: 'Launch into the space station orbital plane for rendezvous.', vehicle: 'Falcon 9', payload: 'Cargo vehicle', mass: 6000, hbr: 10, site: 'ksc-39a', alt: 420, mode: 'object', target: 25544, inc: 51.64, tol: 0.1, days: 3, step: 1 },
  electron: { mission: 'Example — Electron smallsat to SSO', operator: 'Example University CubeSat Lab', country: 'New Zealand', licence: '', objective: 'Deploy a 6U CubeSat for an Earth-imaging technology demonstration.', vehicle: 'Electron', payload: 'Example 6U CubeSat', mass: 10, hbr: 2, site: 'mahia', alt: 520, mode: 'sso', node: '10:30', nodetype: 'desc', nodetol: 10, tol: 0.2, days: 3, step: 1 },
  leo: { mission: 'Example — broadband shell insertion', operator: 'Example Networks', country: 'United States', licence: '', objective: 'Insert a batch of broadband satellites into a 53° shell.', vehicle: 'Falcon 9', payload: 'Broadband batch', mass: 15000, hbr: 12, site: 'ccsfs-40', alt: 550, mode: 'inclination', inc: 53, pass: 'auto', tol: 0.2, duration: 90, step: 2 },
};

function initForm() {
  const sel = $('#f-site');
  sel.innerHTML = SITES.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#countries').innerHTML = COUNTRIES.map((c) => `<option value="${c}">`).join('');
  sel.addEventListener('change', () => applySite(sel.value));
  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', updateModeUi));
  ['#f-alt', '#f-inc', '#f-lat'].forEach((id) => $(id).addEventListener('input', updateOrbitHint));
  $('#scenario').addEventListener('change', (e) => { if (e.target.value) applyExample(e.target.value); });
  $('#scenario-run').addEventListener('click', async () => {
    const key = $('#scenario').value || 'sso';
    $('#scenario').value = key; applyExample(key);
    await runAnalysis({ autoplay: true });
  });
  $('#mission-form').addEventListener('submit', (e) => { e.preventDefault(); runAnalysis(); });
  $('#cancel-btn').addEventListener('click', () => state.abort?.abort());
  initTypeahead($('#f-target'), $('#target-list'), (o) => setTarget(o));
  applyExample('sso');
}

function applySite(id) {
  const s = siteById(id);
  if (id !== 'custom') {
    $('#f-lat').value = s.lat; $('#f-lon').value = s.lon;
    $('#f-azmin').value = s.corridor ? s.corridor.min : '';
    $('#f-azmax').value = s.corridor ? s.corridor.max : '';
  }
  updateOrbitHint();
  syncSiteOverlay();
}

function applyExample(key) {
  const x = EXAMPLES[key];
  const set = (id, v) => { if (v !== undefined) $(id).value = v; };
  set('#f-mission', x.mission); set('#f-operator', x.operator); set('#f-country', x.country); set('#f-licence', x.licence);
  set('#f-objective', x.objective); set('#f-vehicle', x.vehicle); set('#f-payload', x.payload); set('#f-mass', x.mass); set('#f-hbr', x.hbr);
  $('#f-site').value = x.site; applySite(x.site);
  set('#f-alt', x.alt); set('#f-tol', x.tol); set('#f-inc', x.inc); set('#f-pass', x.pass); set('#f-node', x.node); set('#f-nodetype', x.nodetype); set('#f-nodetol', x.nodetol);
  set('#f-days', x.days); set('#f-duration', x.duration); set('#f-step', x.step);
  $('#f-start').value = tomorrowUtc();
  let mode = x.mode;
  if (mode === 'object') {
    const o = state.catalog?.map.get(x.target);
    if (o) setTarget(o); else { mode = 'inclination'; toast('Catalog not loaded yet, so the ISS example uses its inclination instead of its plane.'); }
  }
  $(`input[name="mode"][value="${mode}"]`).checked = true;
  updateModeUi();
}

function currentMode() { return $('input[name="mode"]:checked').value; }

function updateModeUi() {
  const mode = currentMode();
  $$('[data-mode]').forEach((el) => { el.hidden = el.dataset.mode !== mode; });
  $$('[data-show="planar"]').forEach((el) => { el.hidden = mode === 'inclination'; });
  $$('[data-show="free"]').forEach((el) => { el.hidden = mode !== 'inclination'; });
  $$('[data-only]').forEach((el) => { el.hidden = el.dataset.only !== mode; });
  updateOrbitHint();
}

function updateOrbitHint() {
  const h = parseFloat($('#f-alt').value), lat = parseFloat($('#f-lat').value);
  const parts = [];
  if (Number.isFinite(h) && h > 100) {
    const sso = O.ssoInclination(h);
    parts.push(`Period ${(O.periodSec(O.RE + h) / 60).toFixed(1)} min, ${O.circularSpeed(O.RE + h).toFixed(3)} km/s.`);
    if (currentMode() === 'sso' && sso) parts.push(`Sun-synchronous inclination ${(sso / D).toFixed(2)}°.`);
  }
  if (Number.isFinite(lat)) parts.push(`Lowest direct inclination from this site: ${Math.abs(O.geocentricLat(lat * D) / D).toFixed(2)}°.`);
  $('#orbit-hint').textContent = parts.join(' ');
  if (state.globe && $('#shell-filter').value === 'target') applyShellFilter();
}

function setTarget(o) {
  state.target = o;
  $('#f-target').value = `${o.name} (${o.norad})`;
  $('#f-alt').value = Math.round((o.perigee + o.apogee) / 2);
  $('#target-info').innerHTML = `<strong>${esc(o.name)}</strong>: ${fmt(o.perigee, 0)} × ${fmt(o.apogee, 0)} km, ${fmt(o.inc / D, 2)}°, elements ${fmt((Date.now() - o.epochMs) / 86400000, 1)} days old. The object itself is excluded from screening.`;
  updateOrbitHint();
}

function initTypeahead(input, list, onPick) {
  let items = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const draw = () => {
    list.innerHTML = items.map((o, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}"><span>${esc(o.name)}</span><span class="num">${o.norad}</span></li>`).join('');
    list.hidden = !items.length; input.setAttribute('aria-expanded', String(!!items.length));
  };
  input.addEventListener('input', () => { items = state.catalog ? state.catalog.search(input.value, 12) : []; active = -1; draw(); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); onPick(items[active]); close(); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); onPick(items[+li.dataset.i]); close(); } });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

function readMission() {
  const errs = [];
  $$('#mission-form [aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  const num = (id, { min = -Infinity, max = Infinity, required = true, label } = {}) => {
    const el = $(id); const raw = el.value.trim();
    if (!raw && !required) return null;
    const v = Number(raw);
    if (!raw || !Number.isFinite(v) || v < min || v > max) {
      el.setAttribute('aria-invalid', 'true');
      errs.push(`${label || el.closest('label')?.querySelector('span')?.textContent?.trim() || id}: enter a number${min > -Infinity ? ` from ${min}` : ''}${max < Infinity ? ` to ${max}` : ''}.`);
      return NaN;
    }
    return v;
  };
  const txt = (id, required = false) => {
    const el = $(id); const v = el.value.trim();
    if (required && !v) { el.setAttribute('aria-invalid', 'true'); errs.push(`${el.closest('label').querySelector('span').textContent.trim()} is required.`); }
    return v;
  };
  const siteId = $('#f-site').value;
  const azMin = num('#f-azmin', { min: 0, max: 360, required: false }), azMax = num('#f-azmax', { min: 0, max: 360, required: false });
  const mode = currentMode();
  const startRaw = $('#f-start').value;
  const startMs = Date.parse(startRaw + (startRaw.length === 16 ? ':00Z' : 'Z'));
  if (!Number.isFinite(startMs)) { $('#f-start').setAttribute('aria-invalid', 'true'); errs.push('Earliest launch: pick a date and time (UTC).'); }
  const pcRed = Number($('#s-pcred').value), pcAmber = Number($('#s-pcamber').value);
  if (!(pcRed > 0 && pcRed < 1)) errs.push('No-go Pc must be between 0 and 1, e.g. 1e-4.');
  if (!(pcAmber > 0 && pcAmber < 1)) errs.push('Caution Pc must be between 0 and 1, e.g. 1e-5.');
  const m = {
    name: txt('#f-mission', true), operator: txt('#f-operator'), country: txt('#f-country'), licence: txt('#f-licence'), objective: txt('#f-objective'),
    vehicle: txt('#f-vehicle', true), payload: txt('#f-payload', true), massKg: num('#f-mass', { min: 0, required: false }),
    site: {
      id: siteId, name: siteId === 'custom' ? 'Custom site' : siteById(siteId).name,
      lat: num('#f-lat', { min: -89, max: 89 }), lon: num('#f-lon', { min: -180, max: 180 }), altM: siteById(siteId).altM || 0,
      corridor: azMin != null && azMax != null && Number.isFinite(azMin) && Number.isFinite(azMax) ? { min: azMin, max: azMax } : null,
    },
    orbit: {
      mode, hKm: num('#f-alt', { min: 160, max: 2000 }), planeTolDeg: num('#f-tol', { min: 0.01, max: 5 }),
      incDeg: mode === 'inclination' ? num('#f-inc', { min: 0, max: 180 }) : null,
      nodeTime: $('#f-node').value, nodeType: $('#f-nodetype').value,
      nodeTolMin: mode === 'sso' ? num('#f-nodetol', { min: 0.5, max: 30 }) : 5, targetNorad: state.target?.norad ?? null,
    },
    window: {
      startMs, passPref: mode === 'inclination' ? $('#f-pass').value : 'both',
      days: mode === 'inclination' ? 1 : num('#f-days', { min: 1, max: 7 }),
      durationMin: mode === 'inclination' ? num('#f-duration', { min: 1, max: 360 }) : 0,
      candStepMin: num('#f-step', { min: 1, max: 60 }),
    },
    ascent: {
      tInsSec: num('#a-tins', { min: 200, max: 1500 }), downrangeKm: num('#a-down', { min: 300, max: 4000 }), lossesKms: num('#a-loss', { min: 0.5, max: 3 }),
      stage1Km: num('#a-s1', { min: 50, max: 2500 }), corridorKm: num('#a-corr', { min: 5, max: 200 }),
    },
    screening: {
      reportKm: num('#s-report', { min: 1, max: 100 }), amberKm: num('#s-amber', { min: 0.5, max: 100 }), redKm: num('#s-red', { min: 0.1, max: 50 }),
      crewedStandoffKm: num('#s-crew', { min: 0, max: 500 }), vehSigmaKm: num('#s-sigma', { min: 0.1, max: 50 }), orbits: num('#s-orbits', { min: 0.5, max: 3 }),
      stepSec: num('#s-step', { min: 5, max: 60 }), pcRed, pcAmber, hbrM: num('#f-hbr', { min: 0.1, max: 200 }),
      swFactor: spaceWeatherFactor(state.sw),
    },
    weatherLimits: {
      ...DEFAULT_LIMITS, surfaceWindMs: num('#w-wind'), gustMs: num('#w-gust'), upperWindMs: num('#w-upper'),
      upperWindCautionMs: 0.75 * num('#w-upper'), precipMm: num('#w-precip'), capeNoGo: num('#w-cape'), tempMinC: num('#w-tmin'),
    },
  };
  if (mode === 'object' && !state.target) { $('#f-target').setAttribute('aria-invalid', 'true'); errs.push('Pick the catalog object whose plane you want to match.'); }
  if (m.screening.amberKm > m.screening.reportKm) errs.push('Caution distance must not exceed the reporting distance.');
  if (m.screening.redKm > m.screening.amberKm) errs.push('No-go distance must not exceed the caution distance.');
  return { mission: m, errors: errs };
}

// ------------------------------------------------------------------ analysis
async function runAnalysis({ autoplay = false } = {}) {
  if (!state.catalog?.size) { toast('The object catalog has not loaded yet. Check the Catalog tab.'); return; }
  const { mission, errors } = readMission();
  if (errors.length) { $('#form-status').textContent = errors[0]; return; }
  $('#form-status').textContent = '';
  state.showTab('t-results');
  const plan = planMission(mission, mission.orbit.mode === 'object' ? state.target : null);
  if (plan.errors.length) {
    $('#results-empty').hidden = true; $('#results-progress').hidden = true;
    const body = $('#results-body'); body.hidden = false;
    body.innerHTML = `<div class="empty"><h3>No launch window</h3>${plan.errors.map((e) => `<p class="hint">${esc(e)}</p>`).join('')}<div class="actions"><button class="btn small" type="button" id="back-to-mission">Edit mission</button></div></div>`;
    $('#back-to-mission').addEventListener('click', () => state.showTab('t-mission'));
    return;
  }

  const adv = insertionAdvisory(state.sw, mission.orbit.hKm);
  if (adv) plan.warnings.push(adv);
  const candidates = plan.windows.flatMap((w) => w.candidates);
  $('#results-empty').hidden = true; $('#results-body').hidden = true; $('#results-progress').hidden = false;
  $('#run-btn').disabled = true;
  $('#progress-label').textContent = `Screening ${candidates.length} launch times against ${state.catalog.size.toLocaleString()} objects`;
  $('#progress-bar').style.width = '0%';

  setChip('#chip-weather', 'Weather loading', 'busy');
  const wxPromise = fetchForecast(mission.site.lat, mission.site.lon)
    .then((fc) => { state.forecast = { ...fc, siteName: mission.site.name }; setChip('#chip-weather', 'Wx loaded', 'ok'); return fc; })
    .catch((e) => { setChip('#chip-weather', 'Weather unavailable', 'err'); console.warn(e); return null; });

  state.abort = new AbortController();
  let scr;
  try {
    scr = await screenCandidates({
      candidates, mission, objects: state.catalog.list,
      propagate: (o, t) => state.catalog.position(o, t),
      exemptNorad: mission.orbit.mode === 'object' ? state.target.norad : null,
      signal: state.abort.signal,
      onProgress: ({ done, total, propagations }) => {
        $('#progress-bar').style.width = `${(100 * done) / total}%`;
        $('#progress-detail').textContent = `${done} of ${total} launch times · ${propagations.toLocaleString()} orbit propagations`;
      },
    });
  } catch (e) {
    $('#run-btn').disabled = false; $('#results-progress').hidden = true;
    if (e.name === 'AbortError') { $('#results-empty').hidden = false; toast('Analysis cancelled.'); return; }
    throw e;
  }
  const fc = await wxPromise;
  $('#run-btn').disabled = false;

  const rows = candidates.map((c) => {
    const col = scr.results.get(c.id);
    const wx = evaluateWeather(fc, c.t0, mission.weatherLimits);
    const overall = OVERALL[Math.max(RANK[col.status], RANK[wx.status])];
    const pcTerm = col.maxPc > 0 ? Math.max(0, Math.log10(col.maxPc) + 10) : 0;
    const score = RANK[overall] * 1000 + pcTerm * 10 + c.dvPlane * 100 + Math.abs(c.offsetSec) / 3600;
    return { ...c, col, wx, overall, score, planeErrDeg: c.planeErr / D };
  });
  const rec = [...rows].sort((a, b) => a.score - b.score || a.t0 - b.t0)[0];
  state.analysis = { mission, plan, rows, rec, stats: scr.stats, fc, generatedAt: Date.now(), catalogInfo: catalogSummary() };
  $('#results-progress').hidden = true;
  $('#results-badge').textContent = String(plan.windows.length);
  state.opt = null; state.ops = null;
  renderResults();
  selectCandidate(rec.id);
  renderWeather();
  if (autoplay) setTimeout(() => $('#play-btn').click(), 400);
  // report back to the Lunar Mission Browser (same origin)
  store.set('launch-result', { t0: rec.t0, overall: rec.overall, collision: rec.col.status === 'CLEAR' ? 'GO' : rec.col.status, weather: rec.wx.status, mission: mission.name, at: Date.now() });
}

/** Prefill from the Lunar Mission Browser: launch.html?launch=ISO&park=185&name=… */
function applyLunarParams() {
  const q = new URLSearchParams(location.search);
  const launch = Date.parse(q.get('launch') || '');
  if (!Number.isFinite(launch)) return false;
  applyExample('leo');
  $('#scenario').value = '';
  $('#f-mission').value = `${q.get('name') || 'Lunar mission'} — launch`;
  if (q.get('operator')) $('#f-operator').value = q.get('operator');
  if (q.get('country')) $('#f-country').value = q.get('country');
  $('#f-objective').value = 'Launch into a parking orbit for trans-lunar injection.';
  $('#f-payload').value = 'Lunar lander';
  $('#f-alt').value = q.get('park') || 185;
  $('input[name="mode"][value="inclination"]').checked = true;
  $('#f-inc').value = 30;
  updateModeUi();
  $('#f-start').value = new Date(launch - 30 * 60000).toISOString().slice(0, 16);
  $('#f-duration').value = 60; $('#f-step').value = 2;
  toast('Launch time filled in from the Lunar Mission Browser. Press Run analysis.');
  return true;
}

function catalogSummary() {
  const s = state.catalog.stats();
  const src = state.catalog.sources.filter((x) => x.ok).map((x) => x.id).join(', ');
  return `${s.total.toLocaleString()} objects (${src}); mean element-set age ${s.meanAgeDays.toFixed(1)} days`;
}

function pill(label, status) { return `<span class="pill s-${status.replace(' ', '')}"><span class="k">${label}</span>${status}</span>`; }

function renderResults() {
  const A = state.analysis; if (!A) return;
  const { plan, rows, rec, mission: m, stats } = A;
  const body = $('#results-body'); body.hidden = false;
  const counts = { GO: 0, CAUTION: 0, 'NO-GO': 0 };
  rows.forEach((r) => counts[r.overall]++);
  const statusVar = { GO: '--go', CAUTION: '--caution', 'NO-GO': '--nogo' }[rec.overall];

  const windowsHtml = plan.windows.map((w) => {
    const wr = rows.filter((r) => r.windowId === w.id);
    const best = [...wr].sort((a, b) => a.score - b.score)[0];
    const head = w.tPlanar ? `In-plane ${fmtUtc(w.tPlanar)}` : `${fmtUtc(wr[0].t0)} → ${fmtUtc(wr.at(-1).t0).slice(11)}`;
    return `<article class="window" data-window="${w.id}">
      <header><b>Window ${w.id + 1} · ${w.pass === 'asc' ? 'Northbound' : 'Southbound'} · ${fmt(w.azR / D, 1)}°</b><span class="num">${head}</span></header>
      <div class="cells" role="group" aria-label="Launch times in window ${w.id + 1}">${wr.map((r) => `<button type="button" class="cell${r.offsetSec === 0 && w.tPlanar ? ' planar' : ''}" data-id="${r.id}" data-s="${r.overall}" aria-pressed="false" title="${fmtUtc(r.t0)} · ${r.overall}"></button>`).join('')}</div>
      <span class="hint">Best: <span class="num">${fmtUtc(best.t0)}</span> · ${pill('', best.overall)}</span>
    </article>`;
  }).join('');

  body.innerHTML = `
    <div class="verdict" style="--status:var(${statusVar})">
      <span class="eyebrow">Recommended T-0</span>
      <div class="t0">${fmtUtc(rec.t0)}<small>${esc(m.vehicle)} · ${esc(m.payload)} · ${esc(m.site.name)}</small></div>
      <div class="pills">${pill('Overall', rec.overall)}${pill('Collision', rec.col.status === 'CLEAR' ? 'GO' : rec.col.status)}${pill('Weather', rec.wx.status)}</div>
    </div>
    <div class="stats">
      <div class="stat"><span class="k">Inclination</span><span class="v">${fmt(plan.perf.incDeg, 2)}°</span></div>
      <div class="stat"><span class="k">Flight azimuth</span><span class="v">${fmt(rec.azR / D, 1)}° <small>inertial ${fmt(rec.azI / D, 1)}°</small></span></div>
      <div class="stat"><span class="k">Δv to orbit (est.)</span><span class="v">${fmt(rec.dvTotal, 2)} <small>km/s</small></span></div>
      <div class="stat"><span class="k">Earth-rotation assist</span><span class="v">${fmt(rec.dvAssist * 1000, 0)} <small>m/s</small></span></div>
      <div class="stat"><span class="k">Orbital velocity</span><span class="v">${fmt(plan.perf.vOrb, 3)} <small>km/s</small></span></div>
      <div class="stat"><span class="k">Period</span><span class="v">${fmt(plan.perf.period / 60, 1)} <small>min</small></span></div>
      <div class="stat"><span class="k">Launch times screened</span><span class="v">${rows.length} <small>${counts.GO} go · ${counts.CAUTION} caution · ${counts['NO-GO']} no-go</small></span></div>
      <div class="stat"><span class="k">Objects in shell</span><span class="v">${stats.objectsInShell.toLocaleString()} <small>of ${stats.objectsConsidered.toLocaleString()} below ${m.orbit.hKm} km</small></span></div>
    </div>
    ${plan.warnings.length ? `<ul class="notes warn">${plan.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div style="display:grid;gap:8px"><span class="section-title">Launch windows · ${esc(plan.planeLabel)}</span><div class="window-list">${windowsHtml}</div></div>
    <div id="cand-detail" style="display:grid;gap:12px"></div>
    ${advancedSkeleton()}
    <div style="display:grid;gap:8px">
      <span class="section-title">Export</span>
      <div class="actions">
        <button class="btn small primary" type="button" data-export="brief">Flight Safety Brief (PDF)</button>
        <button class="btn small" type="button" data-export="pack">Compliance data pack (PDF)</button>
        <button class="btn small" type="button" data-export="report">Mission report (HTML)</button>
        <button class="btn small" type="button" data-export="geojson">Hazard areas (GeoJSON)</button>
        <button class="btn small" type="button" data-export="csv">Launch times (CSV)</button>
        <button class="btn small" type="button" data-export="json">Full analysis (JSON)</button>
      </div>
    </div>
    <p class="hint">Screened ${fmt(stats.durationSec / 60, 0)} min after each T-0 at a ${m.screening.stepSec} s step · ${stats.propagations.toLocaleString()} propagations in ${fmt(stats.ms / 1000, 1)} s. Planning aid only: it does not replace official launch collision avoidance screening, range approval or licensing.</p>`;

  $$('.cell', body).forEach((b) => b.addEventListener('click', () => selectCandidate(+b.dataset.id)));
  $$('[data-export]', body).forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));
  bindAdvanced(app);
}

function selectCandidate(idOrRow) {
  const A = state.analysis; if (!A) return;
  const r = typeof idOrRow === 'object' ? idOrRow : A.rows.find((x) => x.id === idOrRow); if (!r) return;
  const id = r.id;
  state.selId = id;
  $$('.cell').forEach((c) => c.setAttribute('aria-pressed', String(+c.dataset.id === id)));
  $$('.window').forEach((w) => w.setAttribute('aria-current', String(+w.dataset.window === r.windowId)));
  const m = A.mission;
  const traj = O.buildTrajectory({ site: m.site, t0: r.t0, azInertial: r.azI, hTargetKm: m.orbit.hKm, tInsSec: m.ascent.tInsSec, downrangeKm: m.ascent.downrangeKm });
  const hz = computeHazards(traj, m.site, { corridorHalfWidthKm: m.ascent.corridorKm, stage1Km: m.ascent.stage1Km });
  state.sel = { r, traj, hz, dur: A.stats.durationSec };

  const ev = r.col.events;
  $('#cand-detail').innerHTML = `
    <div style="display:grid;gap:6px">
      <span class="section-title">Selected T-0</span>
      <div class="actions"><span class="num" style="font-size:15px">${fmtUtc(r.t0)}</span>${pill('', r.overall)}</div>
      <span class="hint">Window ${r.windowId + 1}, ${r.offsetSec >= 0 ? '+' : ''}${fmt(r.offsetSec / 60, Math.abs(r.offsetSec) % 60 ? 1 : 0)} min from ${A.plan.windows[r.windowId].tPlanar ? 'the in-plane instant' : 'window open'} · ${A.mission.orbit.mode === 'sso' ? `node time ${r.nodeShiftMin >= 0 ? '+' : ''}${fmt(r.nodeShiftMin, 1)} min from ${esc(A.mission.orbit.nodeTime)}` : `plane error ${fmt(r.planeErrDeg, 3)}° (${fmt(r.dvPlane * 1000, 1)} m/s)`} · Δv ${fmt(r.dvTotal, 2)} km/s</span>
      <span class="hint">Weather: <strong>${esc(r.wx.status)}</strong>${r.wx.reasons.length ? ' — ' + esc(r.wx.reasons.join('; ')) : ''}</span>
      <span class="hint">Stage 1 impact centre: <span class="num">${hz.impactCenter ? dm(hz.impactCenter[1], hz.impactCenter[0]) : 'beyond modelled ascent'}</span></span>
    </div>
    <div style="display:grid;gap:6px">
      <span class="section-title">Close approaches (${ev.length})</span>
      ${ev.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Object</th><th>Phase</th><th class="num">T+</th><th class="num">Miss km</th><th class="num">Rel km/s</th><th class="num">Pc</th></tr></thead>
        <tbody>${ev.slice(0, 60).map((e, i) => `<tr data-ev="${i}" title="NORAD ${e.norad} · elements ${fmt(e.ageDays, 1)} d old · altitude ${fmt(e.altKm, 0)} km"><td><span class="sev ${e.severity}"></span>${esc(e.name)}</td><td>${e.phase}</td><td class="num">${hms(e.tau)}</td><td class="num">${fmt(e.miss, 2)}</td><td class="num">${fmt(e.relV, 2)}</td><td class="num">${e.pc ? e.pc.toExponential(1) : '0'}</td></tr>`).join('')}</tbody>
      </table></div>` : `<p class="hint">No tracked object comes within ${m.screening.reportKm} km during ascent and the first ${m.screening.orbits} orbit(s).</p>`}
    </div>`;
  $$('#cand-detail tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    const e = ev[+tr.dataset.ev];
    state.selEvent = e;
    renderEncounter(app);
    enterMissionTime(e.tau);
    const o = state.catalog.map.get(e.norad);
    if (o) selectObject(o.index);
    if (state.view3d) show3dEvent();
  }));
  state.selEvent = ev.find((e) => e.severity !== 'info') || ev[0] || null;

  // globe overlays: the path is sampled once and coloured by screening severity
  const samples = [];
  for (let tau = 0; tau <= state.sel.dur; tau += 20) {
    let sev = 'info';
    for (const e of ev) if (Math.abs(e.tau - tau) <= 40 && (e.severity === 'red' || (e.severity === 'amber' && sev !== 'red'))) sev = e.severity;
    samples.push({ tau, p: traj.at(tau), sev });
  }
  state.sel.samples = samples;
  pushOverlays({
    orbitEci: null, aircraft: null,
    groundTrack: O.groundTrack(traj, 0, state.sel.dur, 30).map(([lon, lat]) => [lon, lat]),
    hazards: [hz.corridor, hz.impact].filter(Boolean),
    events: ev.map((e) => ({ posEci: e.posEci, severity: e.severity })),
    ellipsoids: null,
  });
  state.globe.centerOn(m.site.lat - 10, m.site.lon + 25);
  state.view3d?.centerOn(m.site.lat - 5, m.site.lon + 10);
  onCandidateChanged(app);
  enterMissionTime(0);
}

app.applyOptimised = (b) => {
  const base = state.sel.r;
  const row = { ...base, id: `opt-${base.id}-${b.hold}-${b.trim}`, t0: b.t0, azI: b.azI, col: b.result, offsetSec: base.offsetSec + b.hold, optimised: true };
  row.overall = OVERALL[Math.max(RANK[row.col.status], RANK[row.wx.status])];
  selectCandidate(row);
  toast(`T-0 moved ${b.hold > 0 ? '+' : ''}${b.hold} s to the cleanest corridor.`);
};

function pathSegments(samples, tauNow) {
  const segs = [];
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const future = s.tau > tauNow;
    if (!cur || cur.sev !== s.sev || cur.future !== future) {
      if (cur) cur.pts.push(s.p);
      cur = { sev: s.sev, future, pts: i ? [samples[i - 1].p, s.p] : [s.p] };
      segs.push(cur);
    } else cur.pts.push(s.p);
  }
  return segs;
}

function pushOverlays(o) {
  state.overlays = { ...state.overlays, ...o };
  state.globe.setOverlays(o);
  sync3d();
}

let last3d = 0, pending3d = null;
function sync3d(force = false) {
  if (!state.view3d) return;
  const now = performance.now();
  if (!force && now - last3d < 250) { clearTimeout(pending3d); pending3d = setTimeout(() => sync3d(true), 260); return; }
  last3d = now;
  try { state.view3d.setOverlays(state.overlays, state.globe.displayTime); } catch (e) { console.warn(e); }
}

function show3dEvent() {
  const e = state.selEvent; if (!e) return;
  pushOverlays({ ellipsoids: [{ kind: 'vehicle', posEci: e.posEci, qEci: e.qVeh, sig: e.sigVeh }, { kind: 'object', posEci: e.objPosEci, qEci: e.qObj, sig: e.sigObj }] });
  enterMissionTime(e.tau);
  const go = () => state.view3d.flyTo(e.posEci, state.sel.r.t0 + e.tau * 1000, Math.max(20, 8 * e.sigObj.i + e.miss * 3));
  if (state.view3d) go(); else toggle3d(true).then((ok) => ok && setTimeout(go, 600));
}
app.show3dEvent = show3dEvent;
app.pushOverlays = (o) => pushOverlays(o);

function doExport(kind) {
  const A = state.analysis; if (!A) return;
  const base = slug(A.mission.name);
  const sel = state.sel?.r || A.rec;
  if (kind === 'report') download(`${base}-report.html`, reportHtml({ mission: A.mission, plan: A.plan, rec: sel, candidates: A.rows, hazards: state.sel?.hz, stats: A.stats, catalogInfo: A.catalogInfo, generatedAt: A.generatedAt }), 'text/html');
  if (kind === 'brief' || kind === 'pack') {
    const ctx = { mission: A.mission, plan: A.plan, rec: sel, rows: A.rows, hazards: state.sel.hz, stats: A.stats, catalogInfo: A.catalogInfo, spaceWeather: state.sw, generatedAt: Date.now(), land: state.landLonLat, optimisation: sel.optimised ? state.opt : null, orbitOps: state.ops };
    if (!ctx.land && state.landTopo) ctx.land = state.landLonLat = decodeTopoLonLat(state.landTopo);
    const bytes = kind === 'brief' ? buildBriefing(ctx) : buildCompliancePack(ctx);
    download(`${base}-${kind === 'brief' ? 'flight-safety-brief' : 'compliance-data-pack-DRAFT'}.pdf`, bytes, 'application/pdf');
    return;
  }
  if (kind === 'csv') download(`${base}-launch-times.csv`, candidatesCsv(A.rows), 'text/csv');
  if (kind === 'geojson' && state.sel) download(`${base}-hazards.geojson`, JSON.stringify(hazardsGeoJson(state.sel.hz, { mission: A.mission.name, t0: iso(sel.t0), vehicle: A.mission.vehicle }), null, 2), 'application/geo+json');
  if (kind === 'json') {
    const out = {
      generatedAt: iso(A.generatedAt), tool: 'Clearway', mission: A.mission, catalog: A.catalogInfo,
      plane: A.plan.planeLabel, performance: A.plan.perf, recommended: iso(A.rec.t0), stats: A.stats,
      candidates: A.rows.map((r) => ({
        t0: iso(r.t0), window: r.windowId + 1, pass: r.pass, flightAzimuthDeg: +(r.azR / D).toFixed(3), planeErrorDeg: +r.planeErrDeg.toFixed(4),
        dvTotalKms: +r.dvTotal.toFixed(4), overall: r.overall, weather: r.wx,
        collision: { status: r.col.status, events: r.col.events.map(({ posEci, ...e }) => ({ ...e, tca: iso(e.tca) })) },
      })),
    };
    download(`${base}-analysis.json`, JSON.stringify(out, null, 2), 'application/json');
  }
}

// ------------------------------------------------------------------ time & globe
let posBusy = false;
function updatePositions(t) {
  if (!state.catalog?.size || posBusy) return;
  posBusy = true;
  const buf = state.catalog.positionsAt(t, state.ecef);
  const th = O.gmst(t), c = Math.cos(th), s = Math.sin(th);
  for (let i = 0; i < buf.length; i += 3) {
    const x = buf[i], y = buf[i + 1];
    buf[i] = x * c + y * s; buf[i + 1] = -x * s + y * c;
  }
  state.ecef = buf;
  state.globe.setObjects(state.catalog.list, buf);
  state.globe.setDisplayTime(t);
  if (state.view3d) { try { state.view3d.setObjects(state.catalog.list, buf, state.globe.visible, state.globe.shell); } catch (e) { console.warn(e); } }
  posBusy = false;
}

function enterMissionTime(tau) {
  if (!state.sel) return;
  state.timeMode = 'mission';
  state.tau = Math.max(0, Math.min(state.sel.dur, tau));
  $('#time-mode').textContent = 'Mission';
  $('#time-slider').hidden = false; $('#play-btn').hidden = false; $('#live-btn').hidden = false;
  $('#time-slider').value = String(Math.round((1000 * state.tau) / state.sel.dur));
  drawMissionTime();
}

let rafPending = false;
function drawMissionTime() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const { r, traj } = state.sel;
    const S = state.analysis.mission.screening;
    const t = r.t0 + state.tau * 1000;
    updatePositions(t);
    const veh = traj.at(state.tau);
    // screening sphere: objects currently within the reporting distance of the vehicle
    const th = O.gmst(t), vE = O.eciToEcef(veh, th), near = [];
    const buf = state.ecef, list = state.catalog.list, R = S.reportKm, R2 = R * R;
    for (let i = 0; i < list.length; i++) {
      const dx = buf[3 * i] - vE[0]; if (!(dx < R && dx > -R)) continue;
      const dy = buf[3 * i + 1] - vE[1], dz = buf[3 * i + 2] - vE[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R2) { const d = Math.sqrt(d2); near.push({ i, d, ecef: [buf[3 * i], buf[3 * i + 1], buf[3 * i + 2]], sev: d < S.redKm ? 'red' : d < S.amberKm ? 'amber' : 'info' }); }
    }
    near.sort((a, b) => a.d - b.d);
    const pathSev = state.sel.samples[Math.min(state.sel.samples.length - 1, Math.round(state.tau / 20))]?.sev || 'info';
    const status = near.some((n) => n.sev === 'red') ? 'red' : near.some((n) => n.sev === 'amber') || pathSev === 'amber' ? 'amber' : pathSev;
    pushOverlays({
      vehicleEci: veh, vehicleStatus: status, sphereKm: R, proximity: near.slice(0, 12).map((n) => ({ ecef: n.ecef, sev: n.sev })),
      pathSegments: pathSegments(state.sel.samples, state.tau),
      events: r.col.events.map((e) => ({ posEci: e.posEci, severity: e.severity, highlight: Math.abs(e.tau - state.tau) < 30 })),
    });
    const px = $('#proximity');
    px.hidden = false;
    px.style.setProperty('--status', `var(${status === 'red' ? '--nogo' : status === 'amber' ? '--caution' : '--go'})`);
    px.innerHTML = `<b>Screening sphere · ${R} km</b>${near.length ? near.slice(0, 4).map((n) => `<div class="row-p"><span>${esc(list[n.i].name)}</span><span>${n.d.toFixed(1)} km</span></div>`).join('') : '<div class="row-p"><span>No tracked object inside</span><span></span></div>'}`;
    if (state.follow) {
      const g = O.ecefToGeodetic(vE);
      state.globe.lat0 = g.lat; state.globe.lon0 = g.lon; state.globe.dirty = true;
    }
    $('#time-text').textContent = `T+${hms(state.tau)} · ${fmtUtc(t)} · ${fmt(traj.altitudeAt(state.tau), 0)} km`;
  });
}

function goLive() {
  state.timeMode = 'live'; state.playing = false;
  $('#time-mode').textContent = 'Live';
  $('#time-slider').hidden = true; $('#play-btn').hidden = true; $('#live-btn').hidden = true;
  $('#play-btn').textContent = 'Play';
  pushOverlays({ vehicleEci: null, proximity: null, sphereKm: null });
  $('#proximity').hidden = true;
  liveTick();
}
function liveTick() {
  if (state.timeMode !== 'live') return;
  const t = Date.now();
  updatePositions(t);
  $('#time-text').textContent = `${fmtUtc(t)} · ${state.catalog?.size?.toLocaleString() ?? 0} objects`;
}

function initGlobe() {
  const tip = $('#tooltip');
  state.globe = new Globe($('#globe'), {
    onHover: (i, x, y) => {
      if (i == null) { tip.hidden = true; return; }
      const o = state.catalog.list[i];
      const r = [state.ecef[3 * i], state.ecef[3 * i + 1], state.ecef[3 * i + 2]];
      const alt = O.ecefToGeodetic(r).alt;
      tip.innerHTML = `<b>${esc(o.name)}</b><span class="num">NORAD ${o.norad} · ${TYPES[o.type].label}<br>Alt ${fmt(alt, 0)} km · ${fmt(o.perigee, 0)}×${fmt(o.apogee, 0)} km · ${fmt(o.inc / D, 1)}°</span>`;
      tip.hidden = false;
      const st = $('.stage').getBoundingClientRect();
      tip.style.left = `${Math.min(x + 14, st.width - 270)}px`; tip.style.top = `${Math.max(8, y - 10)}px`;
    },
    onSelect: (i) => selectObject(i),
  });
  $('#zoom-in').addEventListener('click', () => state.globe.zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => state.globe.zoomBy(0.8));
  $('#recenter').addEventListener('click', () => { const lat = +$('#f-lat').value, lon = +$('#f-lon').value; state.globe.centerOn(lat, lon); });
  $$('#legend input[type="checkbox"]').forEach((cb) => cb.addEventListener('change', () => { state.globe.visible[cb.dataset.type] = cb.checked; state.globe.dirty = true; }));
  $('#shell-filter').addEventListener('change', applyShellFilter);
  $('#follow-btn').addEventListener('click', () => {
    state.follow = !state.follow;
    $('#follow-btn').setAttribute('aria-pressed', String(state.follow));
    if (state.follow) { state.globe.zoom = Math.max(state.globe.zoom, 14); if (state.timeMode !== 'mission') toast('Follow works during mission playback: select a launch time first.'); drawMissionTime(); }
    else { state.globe.zoom = 0.82; state.globe.dirty = true; }
  });
  $('#view3d-btn').addEventListener('click', () => toggle3d(!state.view3dOn));
  $('#time-slider').addEventListener('input', (e) => { state.tau = (+e.target.value / 1000) * state.sel.dur; drawMissionTime(); });
  $('#live-btn').addEventListener('click', goLive);
  $('#play-btn').addEventListener('click', () => {
    state.playing = !state.playing;
    $('#play-btn').textContent = state.playing ? 'Pause' : 'Play';
    let last = performance.now();
    const step = (now) => {
      if (!state.playing || state.timeMode !== 'mission') return;
      state.tau += ((now - last) / 1000) * 60; last = now; // 60× real time
      if (state.tau >= state.sel.dur) { state.tau = state.sel.dur; state.playing = false; $('#play-btn').textContent = 'Play'; }
      $('#time-slider').value = String(Math.round((1000 * state.tau) / state.sel.dur));
      drawMissionTime();
      requestAnimationFrame(step);
    };
    if (state.playing) { if (state.tau >= state.sel.dur) state.tau = 0; requestAnimationFrame(step); }
  });
  setInterval(liveTick, 2000);
  syncSiteOverlay();
}

async function toggle3d(on) {
  const btn = $('#view3d-btn');
  if (!on) {
    state.view3dOn = false; btn.setAttribute('aria-pressed', 'false');
    $('#cesium').hidden = true; $('#globe').hidden = false;
    state.view3d?.destroy(); state.view3d = null;
    return false;
  }
  btn.disabled = true; btn.textContent = '…';
  try {
    const st = getComputedStyle(document.documentElement);
    const v = (n) => st.getPropertyValue(n).trim();
    $('#cesium').hidden = false;
    state.view3d = await CesiumView.create($('#cesium'), {
      PAYLOAD: v('--obj-payload'), ROCKET_BODY: v('--obj-rb'), DEBRIS: v('--obj-debris'), CREWED: v('--obj-crewed'),
      path: v('--accent'), red: v('--nogo'), amber: v('--caution'), hazard: v('--hazard'), track: v('--track'), muted: v('--muted'), oceanEdge: v('--globe-ocean-edge'),
    });
    state.view3dOn = true; btn.setAttribute('aria-pressed', 'true');
    $('#globe').hidden = true;
    if (state.ecef) state.view3d.setObjects(state.catalog.list, state.ecef, state.globe.visible, state.globe.shell);
    sync3d(true);
    const lat = +$('#f-lat').value, lon = +$('#f-lon').value;
    state.view3d.centerOn(lat, lon);
    return true;
  } catch (e) {
    $('#cesium').hidden = true; state.view3d = null;
    toast(`${e.message} Staying on the built-in globe.`, 7000);
    return false;
  } finally { btn.disabled = false; btn.textContent = '3D'; }
}

function applyShellFilter() {
  const v = $('#shell-filter').value;
  const h = parseFloat($('#f-alt').value);
  state.globe.shell = v === 'leo' ? { lo: 0, hi: 2000 } : v === 'target' && Number.isFinite(h) ? { lo: h - 50, hi: h + 50 } : null;
  state.globe.dirty = true;
}

function syncSiteOverlay() {
  const lat = parseFloat($('#f-lat').value), lon = parseFloat($('#f-lon').value);
  if (!state.globe || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  state.globe.setOverlays({ site: { lat, lon } });
}

function selectObject(i) {
  const card = $('#objcard');
  state.globe.selected = i; state.globe.dirty = true;
  if (i == null) { card.hidden = true; state.globe.setOverlays({ selectedOrbit: null }); return; }
  const o = state.catalog.list[i];
  const t = state.globe.displayTime;
  const th = O.gmst(t);
  const P = o.periodMin * 60000;
  const ring = [];
  for (let k = 0; k <= 120; k++) { const p = state.catalog.position(o, t + (k / 120) * P); if (p) ring.push(O.eciToEcef(p, th)); }
  state.globe.setOverlays({ selectedOrbit: ring });
  const age = (Date.now() - o.epochMs) / 86400000;
  card.innerHTML = `<button class="icon-btn close" type="button" aria-label="Close">×</button>
    <h4>${esc(o.name)}</h4>
    <dl>
      <dt>NORAD ID</dt><dd>${o.norad}</dd><dt>Int. designator</dt><dd>${esc(o.intl)}</dd><dt>Type</dt><dd>${TYPES[o.type].label}</dd>
      <dt>Perigee × apogee</dt><dd>${fmt(o.perigee, 0)} × ${fmt(o.apogee, 0)} km</dd><dt>Inclination</dt><dd>${fmt(o.inc / D, 2)}°</dd>
      <dt>Period</dt><dd>${fmt(o.periodMin, 1)} min</dd><dt>Element age</dt><dd>${fmt(age, 1)} d</dd><dt>Source</dt><dd>${esc(o.source)}</dd>
    </dl>
    <div class="actions"><button class="btn small" type="button" id="use-target">Match this plane</button></div>`;
  card.hidden = false;
  $('.close', card).addEventListener('click', () => selectObject(null));
  $('#use-target').addEventListener('click', () => {
    setTarget(o);
    $('input[name="mode"][value="object"]').checked = true; updateModeUi();
    state.showTab('t-mission'); toast(`Target plane set to ${o.name}.`);
  });
}

// ------------------------------------------------------------------ catalog
function initCatalog() {
  const enabled = store.get('groups', GROUPS.filter((g) => g.defaultOn).map((g) => g.id));
  $('#cat-groups').innerHTML = GROUPS.map((g) => `<label class="check"><input type="checkbox" value="${g.id}" ${enabled.includes(g.id) ? 'checked' : ''}><span>${esc(g.label)}<small>${esc(g.note)} · CelesTrak group “${g.id}”</small></span></label>`).join('');
  $('#cat-reload').addEventListener('click', () => {
    const ids = $$('#cat-groups input:checked').map((c) => c.value);
    store.set('groups', ids);
    loadCatalog(ids, true);
  });
  $('#cat-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const { count, skipped } = state.catalog.importText(await f.text(), f.name);
    toast(`Imported ${count.toLocaleString()} element sets from ${f.name}${skipped ? ` (${skipped} rejected by checksum)` : ''}.`);
    afterCatalogChange(); e.target.value = '';
  });
  initTypeahead($('#cat-search'), $('#cat-list'), (o) => {
    selectObject(o.index);
    const r = [state.ecef[3 * o.index], state.ecef[3 * o.index + 1], state.ecef[3 * o.index + 2]];
    if (Number.isFinite(r[0])) { const g = O.ecefToGeodetic(r); state.globe.centerOn(g.lat / D, g.lon / D); }
  });
  $('#weather-fetch').addEventListener('click', async () => {
    const lat = +$('#f-lat').value, lon = +$('#f-lon').value;
    setChip('#chip-weather', 'Weather loading', 'busy');
    try {
      state.forecast = { ...(await fetchForecast(lat, lon)), siteName: siteById($('#f-site').value).name };
      setChip('#chip-weather', 'Wx loaded', 'ok'); renderWeather();
    } catch (e) { setChip('#chip-weather', 'Weather unavailable', 'err'); toast(`Forecast could not be loaded: ${e.message}`); }
  });
  return enabled;
}

async function loadCatalog(ids, fresh = false) {
  if (fresh) state.catalog = new Catalog(state.sgp4);
  setChip('#chip-catalog', 'Catalog loading', 'busy');
  const res = await state.catalog.loadGroups(ids, ({ done, total, label }) => {
    if (label) setChip('#chip-catalog', `Loading ${label} (${done + 1}/${total})`, 'busy');
  });
  const failed = res.filter((r) => !r.ok);
  if (!state.catalog.size) {
    setChip('#chip-catalog', 'Catalog unavailable', 'err');
    toast('No orbital data could be downloaded. Check your connection, start server.py, or import a TLE file in the Catalog tab.', 8000);
  } else setChip('#chip-catalog', `${state.catalog.size.toLocaleString()} objects${failed.length ? ` · ${failed.length} failed` : ''}`, failed.length ? 'warn' : 'ok');
  afterCatalogChange();
  updateFreshness();
}

function afterCatalogChange() {
  state.ecef = null;
  const st = state.catalog.stats();
  for (const k of Object.keys(st.byType)) { const el = $(`[data-count="${k}"]`); if (el) el.textContent = st.byType[k].toLocaleString(); }
  if (state.timeMode === 'live') liveTick(); else drawMissionTime();
  renderCatalog();
}

function renderCatalog() {
  if (!state.catalog || $('#tab-catalog').hidden) return;
  const s = state.catalog.stats();
  $('#cat-stats').innerHTML = [
    ['Tracked objects', s.total.toLocaleString()], ['Low Earth orbit', s.leo.toLocaleString()],
    ['Medium / elliptical', (s.meo + s.other).toLocaleString()], ['Geostationary', s.geo.toLocaleString()],
    ['Mean element age', `${fmt(s.meanAgeDays, 1)} <small>days</small>`], ['Oldest element set', `${fmt(s.oldestAgeDays, 0)} <small>days</small>`],
  ].map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  const max = Math.max(1, ...Object.values(s.byType));
  const color = { PAYLOAD: '--obj-payload', ROCKET_BODY: '--obj-rb', DEBRIS: '--obj-debris', CREWED: '--obj-crewed' };
  $('#cat-types').innerHTML = Object.entries(s.byType).map(([k, v]) => `<div class="type-bar"><span>${TYPES[k].label}</span><span class="track"><i style="width:${(100 * v) / max}%;background:var(${color[k]})"></i></span><span class="num">${v.toLocaleString()}</span></div>`).join('');
  $('#cat-sources').innerHTML = state.catalog.sources.map((r) => `<div><span>${esc(r.id)}</span><span class="num" style="color:var(${r.ok ? '--muted' : '--nogo'})">${r.ok ? `${r.count.toLocaleString()} · ${esc(r.via)}` : esc(r.error)}</span></div>`).join('');
  drawHisto($('#cat-histo'), s.shells);
}

function drawHisto(cv, bins) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const st = getComputedStyle(document.documentElement);
  const accent = st.getPropertyValue('--accent').trim(), muted = st.getPropertyValue('--muted').trim(), line = st.getPropertyValue('--line').trim(), fg = st.getPropertyValue('--fg').trim();
  const max = Math.max(1, ...bins), L = 34, B = 18, bw = (w - L - 4) / bins.length;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = muted; ctx.strokeStyle = line;
  for (const f of [0, 0.5, 1]) {
    const y = 6 + (1 - f) * (h - B - 6);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - 4, y); ctx.stroke();
    ctx.fillText(Math.round(max * f).toLocaleString(), 0, y + 3);
  }
  const target = parseFloat($('#f-alt').value);
  bins.forEach((v, i) => {
    const bh = (v / max) * (h - B - 6);
    ctx.fillStyle = target >= i * 100 && target < (i + 1) * 100 ? fg : accent;
    ctx.fillRect(L + i * bw + 1, h - B - bh, bw - 2, bh);
  });
  ctx.fillStyle = muted;
  for (let k = 0; k <= 2000; k += 500) ctx.fillText(`${k}`, Math.min(w - 26, L + (k / 100) * bw - 6), h - 4);
}

// ------------------------------------------------------------------ weather tab
function renderWeather() {
  const fc = state.forecast; if (!fc) return;
  $('#weather-empty').hidden = true;
  const body = $('#weather-body'); body.hidden = false;
  const A = state.analysis;
  const limits = A?.mission.weatherLimits || DEFAULT_LIMITS;
  let from = Date.now(), to = from + 48 * 3600000;
  if (A) { from = Math.min(...A.rows.map((r) => r.t0)) - 3 * 3600000; to = Math.max(...A.rows.map((r) => r.t0)) + 3 * 3600000; }
  const idx = fc.times.map((t, i) => [t, i]).filter(([t]) => t >= from && t <= to).slice(0, 200);
  const rec = A?.rec;
  const recHour = rec ? Math.floor(rec.t0 / 3600000) * 3600000 : null;
  const v = (k, i, d = 0) => fmt(fc.h[k]?.[i], d);
  body.innerHTML = `
    <div style="display:grid;gap:6px">
      <span class="section-title">${esc(fc.siteName || 'Launch site')} forecast</span>
      <span class="hint">Open-Meteo, ${fc.lat.toFixed(3)}°, ${fc.lon.toFixed(3)}° · fetched ${fmtUtc(fc.fetchedAt)} · wind in m/s</span>
      ${rec ? `<div class="actions">${pill('At recommended T-0', rec.wx.status)}<span class="hint">${esc(rec.wx.reasons.join('; ') || 'All limits met')}</span></div>` : ''}
    </div>
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table>
      <thead><tr><th>UTC</th><th>Status</th><th class="num">Wind</th><th class="num">Gust</th><th class="num">Upper</th><th class="num">Rain</th><th class="num">Cloud</th><th class="num">CAPE</th><th>Conditions</th></tr></thead>
      <tbody>${idx.map(([t, i]) => {
        const e = evaluateWeather(fc, t + 1, limits);
        const upper = Math.max(fc.h.wind_speed_250hPa?.[i] ?? 0, fc.h.wind_speed_200hPa?.[i] ?? 0);
        return `<tr ${t === recHour ? 'style="background:var(--accent-soft)"' : ''} title="${esc(e.reasons.join('; '))}"><td class="num">${new Date(t).toISOString().slice(5, 16).replace('T', ' ')}</td><td class="s-${e.status.replace(' ', '')}">${e.status}</td><td class="num">${v('wind_speed_10m', i, 1)}</td><td class="num">${v('wind_gusts_10m', i, 1)}</td><td class="num">${fmt(upper, 0)}</td><td class="num">${v('precipitation', i, 1)}</td><td class="num">${v('cloud_cover', i)}%</td><td class="num">${v('cape', i)}</td><td>${esc(WMO_TEXT[fc.h.weather_code?.[i]] || '')}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="hint">Upper-level wind is the stronger of the 250 hPa and 200 hPa winds (about 10–12 km), a proxy for the wind shear limits most vehicles fly against. Lightning rules are approximated from thunderstorm codes and CAPE.</p>`;
}

// ------------------------------------------------------------------ telemetry
const tm = new Telemetry(() => { if (!tmPending) { tmPending = true; requestAnimationFrame(() => { tmPending = false; renderTelemetry(); }); } });
let tmPending = false;
function initTelemetry() {
  $('#tm-connect').addEventListener('click', async () => {
    try { await tm.connectSerial(); toast('micro:bit connected. Waiting for packets.'); } catch (e) { if (e.name !== 'NotFoundError') toast(e.message, 6000); }
  });
  $('#tm-sim').addEventListener('click', () => tm.startSim());
  $('#tm-relay').addEventListener('click', () => { tm.connectRelay(); toast('Listening to the server relay (python server.py --serial PORT).'); });
  $('#tm-split').addEventListener('change', (e) => { $('#tm-overlay').hidden = !e.target.checked; renderTelemetry(true); });
  $('#tm-stop').addEventListener('click', () => tm.stop());
  $('#tm-zero').addEventListener('click', () => { tm.zero(); toast('Altitude will re-zero on the next 20 samples.'); });
  $('#tm-export').addEventListener('click', () => { if (tm.samples.length) download(`clearway-telemetry-${Date.now()}.csv`, tm.toCsv(), 'text/csv'); else toast('No telemetry recorded yet.'); });
  renderTelemetry();
}
function renderTelemetry(force = false) {
  renderTelemetryOverlay();
  if ($('#tab-telemetry').hidden && !force) return;
  if ($('#tab-telemetry').hidden) return;
  const s = tm.samples.at(-1);
  const lossPct = tm.received ? (100 * tm.lost) / (tm.received + tm.lost) : 0;
  const cells = [
    ['Link', tm.status === 'serial' ? 'USB serial' : tm.status === 'relay' ? (tm.relayError ? 'Relay lost' : 'Network relay') : tm.status === 'sim' ? 'Simulator' : 'Idle'], ['Phase', tm.state],
    ['Altitude', s?.alt != null ? `${fmt(s.alt, 1)} <small>m</small>` : '—'], ['Vertical speed', s ? `${fmt(s.vs, 1)} <small>m/s</small>` : '—'],
    ['Acceleration', s ? `${fmt(s.g, 2)} <small>g</small>` : '—'], ['Temperature', s ? `${fmt(s.temp, 1)} <small>°C</small>` : '—'],
    ['Max altitude', `${fmt(tm.maxAlt, 1)} <small>m</small>`], ['Max load', `${fmt(tm.maxG, 2)} <small>g</small>`],
    ['Dynamic pressure', s?.q != null ? `${fmt(s.q / 1000, 2)} <small>kPa</small>` : '—'], ['Max-Q', `${fmt(tm.maxQ / 1000, 2)} <small>kPa</small>`],
    ['Packets', `${tm.received.toLocaleString()} <small>${fmt(lossPct, 1)}% lost</small>`],
  ];
  $('#tm-readouts').innerHTML = cells.map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  const st = getComputedStyle(document.documentElement);
  drawStrip($('#tm-alt'), [{ values: tm.samples.filter((x) => x.alt != null).map((x) => [x.t, x.alt]), color: st.getPropertyValue('--accent').trim() }], { span: 60, label: 'Altitude', unit: 'm' });
  drawStrip($('#tm-acc'), [{ values: tm.samples.map((x) => [x.t, x.g]), color: st.getPropertyValue('--obj-debris').trim() }], { span: 60, label: 'Acceleration', unit: 'g' });
  drawStrip($('#tm-q'), [{ values: tm.samples.filter((x) => x.q != null).map((x) => [x.t, x.q / 1000]), color: st.getPropertyValue('--caution').trim() }], { span: 60, label: 'Dynamic pressure', unit: 'kPa' });
  $('#tm-events').innerHTML = tm.events.length
    ? tm.events.map((e) => `<tr><td>${e.name}</td><td class="num">${fmt(e.t, 2)}</td><td class="num">${fmt(e.alt, 1)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="hint">No flight events yet</td></tr>';
}

function renderTelemetryOverlay() {
  if ($('#tm-overlay').hidden) return;
  const s = tm.samples.at(-1);
  $('#tmo-state').textContent = tm.state;
  $('#tmo-readouts').innerHTML = [['Alt', s?.alt != null ? `${fmt(s.alt, 0)} m` : '—'], ['Vel', s ? `${fmt(s.v, 1)} m/s` : '—'], ['Q', s?.q != null ? `${fmt(s.q / 1000, 2)} kPa` : '—'], ['Load', s ? `${fmt(s.g, 2)} g` : '—'], ['Max alt', `${fmt(tm.maxAlt, 0)} m`], ['Max-Q', `${fmt(tm.maxQ / 1000, 2)} kPa`]]
    .map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');
  const st = getComputedStyle(document.documentElement);
  drawStrip($('#tmo-alt'), [{ values: tm.samples.filter((x) => x.alt != null).map((x) => [x.t, x.alt]), color: st.getPropertyValue('--accent').trim() }], { span: 60, label: 'Alt', unit: 'm' });
  drawStrip($('#tmo-q'), [{ values: tm.samples.filter((x) => x.q != null).map((x) => [x.t, x.q / 1000]), color: st.getPropertyValue('--caution').trim() }], { span: 60, label: 'Q', unit: 'kPa' });
}

// ------------------------------------------------------------------ freshness, lineage, game
function updateFreshness() {
  const c = state.catalog;
  if (!c?.size) return;
  const fetched = Math.min(...c.sources.filter((x) => x.ok && x.fetchedAt).map((x) => x.fetchedAt));
  const ageH = (Date.now() - fetched) / 3600000;
  const s = c.stats();
  setChip('#chip-fresh', `Fetched ${fmt(ageH, 1)} h ago · epoch ${fmt(s.meanAgeDays, 1)} d`, ageH < 3 ? 'ok' : ageH < 12 ? 'warn' : 'err');
}

function openLineage() {
  const c = state.catalog;
  const ok = (x) => (x ? 'ok' : 'err');
  const rows = [
    ['US Space Force catalog (GP element sets)', 'CelesTrak (republishes 18th/19th SDS data)', c ? `${c.size.toLocaleString()} objects · ${c.sources.filter((x) => x.ok && x.via !== 'file').map((x) => esc(x.id)).join(', ')}` : 'not loaded', 'Positions of every tracked object (SGP4)', ok(c?.size), 'https://celestrak.org/NORAD/documentation/gp-data-formats.php'],
    ['Full catalog (optional import)', 'Space-Track.org, US Space Force', c?.sources.some((x) => x.via === 'file') ? c.sources.filter((x) => x.via === 'file').map((x) => esc(x.id)).join(', ') : 'none imported', 'All tracked debris and rocket bodies', c?.sources.some((x) => x.via === 'file') ? 'ok' : '', 'https://www.space-track.org/documentation#/user_agree'],
    ['Weather forecast', 'Open-Meteo (national weather service models)', state.forecast ? `fetched ${fmtUtc(state.forecast.fetchedAt)}` : 'loads with an analysis', 'Surface and upper-level wind, rain, CAPE, cloud', ok(state.forecast), 'https://open-meteo.com/en/terms'],
    ['Space weather (Kp, F10.7)', 'NOAA Space Weather Prediction Center', state.sw ? `Kp ${fmt(state.sw.kp, 1)}, F10.7 ${fmt(state.sw.f107, 0)} · ${fmtUtc(state.sw.fetchedAt)}` : 'unavailable', 'Inflates LEO position uncertainty; storm advisories', ok(state.sw), 'https://www.swpc.noaa.gov/'],
    ['Live air traffic', 'OpenSky Network (ADS-B)', state.traffic ? `${state.traffic.traffic.length} aircraft at ${new Date(state.traffic.time).toISOString().slice(11, 19)}Z` : 'on request', 'Aircraft in the hazard corridor', state.traffic ? 'ok' : '', 'https://opensky-network.org/about/terms-of-use'],
    ['Ground stations', 'SatNOGS Network (Libre Space Foundation)', state.stations ? `${state.stations.length} online stations` : 'on request', 'First-contact planning', state.stations ? 'ok' : '', 'https://network.satnogs.org/'],
    ['SGP4 propagator', 'satellite.js (Vallado SGP4)', state.sgp4 ? 'loaded' : 'not loaded', 'Orbit propagation of GP element sets', ok(state.sgp4), 'https://github.com/shashwatak/satellite-js'],
    ['Coastlines', 'Natural Earth via world-atlas', state.landTopo ? 'loaded' : 'not loaded', 'Globe and printed hazard maps', ok(state.landTopo), 'https://www.naturalearthdata.com/about/terms-of-use/'],
  ];
  $('#lineage-body').innerHTML = `
    <p class="hint">Every number in Clearway comes from these open sources. Status reflects this session.</p>
    <div class="table-wrap"><table><thead><tr><th>Data</th><th>Provider</th><th>This session</th><th>Used for</th><th>Terms</th></tr></thead><tbody>
    ${rows.map(([d, p, s, u, st, link]) => `<tr><td><span class="sev ${st === 'ok' ? '' : st === 'err' ? 'red' : 'amber'}" style="${st === 'ok' ? 'background:var(--go)' : ''}"></span>${d}</td><td>${p}</td><td>${s}</td><td>${u}</td><td><a href="${link}" target="_blank" rel="noopener">Terms</a></td></tr>`).join('')}
    </tbody></table></div>
    <div style="display:grid;gap:8px"><span class="section-title">Processing pipeline</span>
    <div class="flow">
      <div class="step"><b>Ingest</b>GP element sets, forecasts, Kp/F10.7, ADS-B</div><span class="arrow">→</span>
      <div class="step"><b>Validate</b>TLE checksums, freshest set per object, epoch age</div><span class="arrow">→</span>
      <div class="step"><b>Propagate</b>SGP4 for objects, ascent model + J2 for the vehicle</div><span class="arrow">→</span>
      <div class="step"><b>Screen</b>Altitude filter, 20 s grid, SGP4 refinement</div><span class="arrow">→</span>
      <div class="step"><b>Assess</b>Modelled covariance, encounter-plane Pc, weather rules</div><span class="arrow">→</span>
      <div class="step"><b>Report</b>Brief, compliance pack, GeoJSON, CSV, JSON</div>
    </div></div>
    <p class="hint">Element sets carry no covariance; Clearway models position uncertainty from element-set age, altitude and space weather. NASA's ORDEM debris model would add the untracked small-debris flux, a planned extension.</p>`;
  $('#lineage-dlg').showModal();
}

let stopGame = null;
function openGame() {
  const A = state.analysis;
  const sel = state.sel?.r;
  const risky = sel?.col.events.find((e) => e.severity !== 'info') || sel?.col.events[0];
  const w = A && sel ? A.plan.windows[sel.windowId] : null;
  const windowMin = !A ? 60 : w?.tPlanar ? Math.max(1, Math.round((2 * (w.halfWidthSec || 0)) / 60)) : A.mission.window.durationMin;
  const ctx = {
    mission: A?.mission.name || 'Practice mission', limits: A?.mission.weatherLimits, windowMin,
    conjunction: risky ? { name: risky.name, norad: risky.norad, miss: risky.miss, pc: risky.pc, tau: risky.tau, risky: risky.severity !== 'info', hold: state.opt?.improved && state.opt.forId === sel.id ? state.opt.best.hold : null } : null,
  };
  $('#game-dlg').showModal();
  stopGame?.();
  stopGame = startGame($('#game-body'), ctx, { onClose: () => { stopGame?.(); $('#game-dlg').close(); } });
}

// ------------------------------------------------------------------ boot
async function boot() {
  initChrome();
  initGlobe();
  initForm();
  initTelemetry();
  $('#game-close').addEventListener('click', () => { stopGame?.(); $('#game-dlg').close(); });
  $('#game-dlg').addEventListener('close', () => stopGame?.());
  loadLand().then((topo) => { if (topo) { state.landTopo = topo; state.globe.setLand(topo); } });
  fetchSpaceWeather().then((sw) => {
    state.sw = sw;
    setChip('#chip-sw', `Kp ${fmt(sw.kp, 1)}${sw.kpMax != null && sw.kpMax >= 5 ? ` · ${sw.gMax} fcst` : ''} · F10.7 ${fmt(sw.f107, 0)}`, sw.kpMax >= 5 ? 'warn' : 'ok');
  }).catch(() => setChip('#chip-sw', 'Space weather unavailable', 'err'));
  try {
    state.sgp4 = await loadSgp4();
    setChip('#chip-engine', 'SGP4', 'ok');
  } catch (e) {
    setChip('#chip-catalog', 'Propagator unavailable', 'err');
    setChip('#chip-engine', 'SGP4 not loaded', 'err');
    toast(e.message, 10000);
    return;
  }
  state.catalog = new Catalog(state.sgp4);
  const ids = initCatalog();
  await loadCatalog(ids);
  applyLunarParams();
}

boot().catch((e) => { console.error(e); toast(`Something went wrong: ${e.message}`, 10000); });
