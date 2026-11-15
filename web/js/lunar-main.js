// Clearway Lunar Mission Browser — application shell (v4).
//
// The board follows one question: "Which candidate landing site gives our lander the best chance of
// surviving its surface mission while maintaining contact with Earth?"
//   verdict → compare (with robustness across priorities) → NASA south-pole map → why → horizon
//   geometry, slopes and resources → when to land → trade-off explorer → survival under uncertainty
//   (Monte Carlo) → how much to trust it (stress tests, cross-check with NASA illumination maps)
//   → verification → export.

import { SITES, isPolar } from './lunar/sites.js';
import { skyAt, moonCentredBodies } from './lunar/ephem.js';
import { Horizon, loadHorizonSet, fetchHorizon } from './lunar/horizon.js';
import {
  ephemerisGrid, analyseSite, daily, bestWindows, windowAt, PANELS, PRIORITIES, explainMetrics, rankSites, recommendationSweep,
  explainSite, periods, landingCalendar, tradeoff, statusAt, stressTests, siteDecisions, describeChange, stayTrace, recommend, ROBUST_MIN_RATE,
} from './lunar/analysis.js';
import { resolveThermal, steadyHeaterW, coolDownHours } from './lunar/thermal.js';
import { monteCarlo, slopeSafeProbability, MC_DEFAULTS } from './lunar/montecarlo.js';
import { crossCheck } from './lunar/crosscheck.js';
import { loadPolarMap, drawPolarMap, toXY } from './lunar/polarmap.js';
import { lunarTransfer, missionTimeline } from './lunar/transfer.js';
import { drawPanorama, drawTimeline, drawHeatmap, drawMoonGlobe, drawCalendar } from './lunar/charts.js';
import { selfCheck } from './lunar/reference.js';
import { buildLunarBrief } from './lunar/brief.js';
import { startTour } from './lunar/tour.js';
import { LANDER_PRESETS, simpleToPlanner, simpleReasons, simpleAdvice, survivalBand } from './lunar/simple.js';
import { parseAboutMd, renderDataSources } from './about.js';
import { CH3, analyseLanding, drawLandingStrip } from './lunar/chandrayaan.js';
import { linkBudget, fmtRate, fmtBits, stayData, RELAY_PRESETS, RADIO_DEFAULTS } from './lunar/radio.js';
import { setPdfLogo } from './briefing.js';
import { fetchSpaceWeather } from './spaceweather.js';
import { startGame } from './game.js';
import { download } from './report.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const utc = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const day = (t) => new Date(t).toISOString().slice(0, 10);
const hrs = (h) => (h >= 72 ? `${fmt(h / 24, 1)} d` : `${fmt(h, 0)} h`);
const kwh = (wh) => (wh < 50 ? '< 0.1 kWh' : `${wh >= 10000 ? Math.round(wh / 1000) : fmt(wh / 1000, 1)} kWh`);
const signed = (v, d = 1) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;
// black-and-white identity for sites: grey levels (with patterns in the strip) instead of hues
const PALETTE = ['#ffffff', '#b5b5b5', '#7a7a7a', '#d9d9d9', '#9a9a9a', '#5c5c5c', '#eaeaea', '#c6c6c6', '#8a8a8a', '#a8a8a8', '#6b6b6b', '#cfcfcf', '#4e4e4e', '#e2e2e2'];
const PATTERNS = ['none', 'repeating-linear-gradient(135deg, rgba(0,0,0,.35) 0 2px, transparent 2px 6px)', 'repeating-linear-gradient(45deg, rgba(0,0,0,.35) 0 2px, transparent 2px 6px)', 'repeating-linear-gradient(90deg, rgba(0,0,0,.3) 0 2px, transparent 2px 5px)', 'radial-gradient(rgba(0,0,0,.4) 1px, transparent 1.5px) 0 0/5px 5px'];

const state = {
  sites: SITES.map((s) => ({ ...s, on: s.on !== false })),
  horizons: new Map(), horizonMeta: null,
  grid: null, results: new Map(), daily: new Map(), ranked: [], decisions: new Map(),
  rec: null, prevRec: null, changeNote: '',
  selId: null, k: 0, playing: false, heatMetric: 'sun', perKind: 'sun', tlRange: 'stay', highlight: null,
  calendar: [], calDay: null, landing: null, landingSite: null, windows: [],
  sw: null, check: null, validation: null, stress: null, stressToken: 0,
  extras: new Map(), polar: null, mapView: null, mapLayer: 'terrain', mapHit: null, mapCursor: null,
  mc: null, mcToken: 0, mcKey: null, xc: null, xcToken: 0, xcKey: null, trace: null,
  tradeSel: new Set(), tradePrev: null, trade: null,
  phases: [], transfer: null, timeline: null,
};

function toast(msg, ms = 4000) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }
function setChip(id, text, st, title) { const c = $(id); c.textContent = text; c.dataset.state = st; if (title) c.title = title; }
const store = {
  get(k, d) { try { const v = localStorage.getItem('clearway:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('clearway:' + k, JSON.stringify(v)); } catch { /* unavailable */ } },
};
const siteOf = (id) => state.sites.find((s) => s.id === id);
const nameOf = (id) => siteOf(id)?.short || siteOf(id)?.name || id;
const colorOf = (id) => PALETTE[Math.max(0, state.sites.findIndex((s) => s.id === id)) % PALETTE.length];
const patternOf = (id) => PATTERNS[Math.floor(Math.max(0, state.sites.findIndex((s) => s.id === id)) / 3) % PATTERNS.length];
const swatch = (id, extra = '') => `<span class="sev" style="background:${colorOf(id)};background-image:${patternOf(id) === 'none' ? 'none' : patternOf(id)}${extra}"></span>`;
const stayDays = () => Math.min(365, Math.max(1, Math.round(+$('#m-days').value) || 14));
const weight = () => +$('#w-slider').value / 100;
const advanced = () => document.body.classList.contains('adv-mode');

// ------------------------------------------------------------------ chrome
function initChrome() {
  const saved = store.get('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'dark';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next; store.set('theme', next); redraw();
  });
  const tick = () => { $('#utc-clock').textContent = new Date().toISOString().slice(11, 19) + 'Z'; };
  tick(); setInterval(tick, 1000);
  const tabs = $$('#panel .tab');
  tabs.forEach((t) => t.addEventListener('click', () => tabs.forEach((x) => { x.setAttribute('aria-selected', String(x === t)); $('#' + x.getAttribute('aria-controls')).hidden = x !== t; })));
  $$('input[name="vmode"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) setMode(r.value); }));
  // always opens in Simple mode; a link can ask for another mode with ?mode=planner or ?mode=explain
  const askedMode = new URLSearchParams(location.search).get('mode');
  setMode(['planner', 'explain'].includes(askedMode) ? askedMode : 'simple', { quiet: true });
  // advanced mission phases (launch, transfer, lunar orbit) are opt-in so the lunar decision stays the focus
  const adv = $('#adv-toggle');
  adv.checked = store.get('advanced', false);
  const syncAdv = () => {
    document.body.classList.toggle('adv-mode', adv.checked); store.set('advanced', adv.checked);
    if (!adv.checked && $('#t-mission').getAttribute('aria-selected') === 'true') $('#t-sites').click();
    if (adv.checked) renderPhases();
  };
  adv.addEventListener('change', syncAdv); syncAdv();
  $('#lineage-btn').addEventListener('click', () => openAbout());
  $$('.about-tabs .tab').forEach((t) => t.addEventListener('click', () => aboutTab(t.getAttribute('aria-controls'))));
  $('#game-btn').addEventListener('click', openGame);
  $('#tour-btn').addEventListener('click', () => { closeDrawer(); if (mode() === 'simple') setMode('planner'); startTour($('#tour'), { onStep: (s) => { if (s.action === 'play' && !state.playing) togglePlay(); if (s.action !== 'play' && state.playing) togglePlay(); } }); });
  $('#game-close').addEventListener('click', () => { stopGame?.(); $('#game-dlg').close(); });
  $('#game-dlg').addEventListener('close', () => stopGame?.());
  $('#chip-eph').addEventListener('click', () => $('#card-verify').scrollIntoView({ behavior: 'smooth' }));
  $('#chip-tests').addEventListener('click', () => $('#card-verify').scrollIntoView({ behavior: 'smooth' }));
  $('#chip-pgda').addEventListener('click', () => $('#card-conf').scrollIntoView({ behavior: 'smooth' }));
  // mobile drawer
  $('#drawer-btn').addEventListener('click', () => (document.body.classList.contains('drawer-open') ? closeDrawer() : openDrawer()));
  $('#backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer(); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redraw, 120); });
  window.addEventListener('storage', (e) => { if (e.key === 'clearway:launch-result') renderPhases(); });
  window.addEventListener('focus', () => renderPhases());
}
/** View mode: 'simple' (questions → one answer), 'planner' (full board) or 'explain' (board + notes). */
const mode = () => (document.body.classList.contains('simple-mode') ? 'simple' : document.body.classList.contains('explain-mode') ? 'explain' : 'planner');
function setMode(m, { quiet = false } = {}) {
  if (!['simple', 'planner', 'explain'].includes(m)) m = 'planner';
  const was = mode();
  document.body.classList.toggle('simple-mode', m === 'simple');
  document.body.classList.toggle('explain-mode', m === 'explain');
  const r = $(`input[name="vmode"][value="${m}"]`); if (r) r.checked = true;
  store.set('vmode', m);
  if (m === 'simple') closeDrawer();
  if (!quiet && was !== m) { window.scrollTo({ top: 0 }); requestAnimationFrame(redraw); }
}

function openDrawer() { document.body.classList.add('drawer-open'); $('#backdrop').hidden = false; $('#drawer-btn').setAttribute('aria-expanded', 'true'); }
function closeDrawer() { document.body.classList.remove('drawer-open'); $('#backdrop').hidden = true; $('#drawer-btn').setAttribute('aria-expanded', 'false'); }

// ------------------------------------------------------------------ settings
function initControls() {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  $('#d-start').value = d.toISOString().slice(0, 10);
  $('#p-type').innerHTML = Object.entries(PANELS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  const syncPanel = () => { $('#p-az-wrap').hidden = $('#p-type').value !== 'vertical-fixed'; };
  $('#p-type').addEventListener('change', syncPanel); syncPanel();
  // priority presets ↔ slider
  $$('input[name="prio"]').forEach((r) => r.addEventListener('change', () => {
    if (!r.checked) return;
    $('#w-slider').value = String(Math.round(PRIORITIES[r.value].weight * 100));
    $('#tr-prio').value = r.value;
    onWeight(`priority set to ${PRIORITIES[r.value].label}`);
  }));
  $('#w-slider').addEventListener('input', () => { syncPresetRadio(); onWeight(`weight set to ${$('#w-slider').value}% sunlight`); });
  updateWeightLabel();
  $('#m-days').addEventListener('change', () => { $('#tr-days').value = $('#m-days').value; refreshDecisions(`surface stay set to ${stayDays()} days`); scheduleMC(); });
  // anything that changes the physics re-runs the analysis
  for (const id of ['#d-start', '#d-days', '#d-step', '#p-type', '#p-area', '#p-eff', '#p-az', '#b-cap', '#b-usable', '#b-ceff', '#b-deff', '#b-op', '#b-surv', '#k-margin', '#k-dsn', '#k-require', '#r-relay', ...THERMAL_INPUTS]) $(id).addEventListener('change', () => { state.changeReason = `${labelOf(id)} changed`; syncThermal(); rerunSoon(); });
  // the link budget changes no decision: only the readouts are refreshed
  for (const id of ['#r-band', '#r-dish', '#r-power', '#r-gain']) $(id).addEventListener('change', () => { syncRadio(); if (state.selId && state.results.has(state.selId)) { renderTiers(state.results.get(state.selId)); renderVerdict(); } });
  syncThermal(); syncRadio();
  $('#l-tilt').addEventListener('change', () => { renderSafety(); scheduleMC(); });
  $('#mc-run').addEventListener('click', () => scheduleMC(true));
  for (const id of ['#mc-n', '#mc-slip', '#mc-sky', '#mc-seed', '#mc-panel', '#mc-load', '#mc-surv', '#mc-fade', '#mc-rad', '#mc-pos']) $(id).addEventListener('change', () => scheduleMC(true));
  initMap();
  $('#run-btn').addEventListener('click', () => { closeDrawer(); runComparison(); });
  $('#x-apply').addEventListener('click', () => { readLanding(); renderMission(); renderPhases(); toast('Mission updated.'); });
  $$('input[name="hm"]').forEach((r) => r.addEventListener('change', () => { state.heatMetric = r.value; renderHeat(); }));
  $$('input[name="per"]').forEach((r) => r.addEventListener('change', () => { state.perKind = r.value; renderPeriods(); }));
  $$('input[name="tlr"]').forEach((r) => r.addEventListener('change', () => { state.tlRange = r.value; drawSite(); }));
  $('#pano-geo').addEventListener('change', drawSite);
  $('#pano-band').addEventListener('change', drawSite);
  $('#per-csv').addEventListener('click', exportPeriods);
  $('#c-add').addEventListener('click', addCustomSite);
  $('#c-file').addEventListener('change', importHorizonFile);
  $('#time-slider').addEventListener('input', (e) => setCursor(+e.target.value));
  $('#play-btn').addEventListener('click', togglePlay);
  $('#verify-btn').addEventListener('click', verifyWithHorizons);
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));
  for (const id of ['#tr-landing', '#tr-days', '#tr-prio']) $(id).addEventListener('change', () => renderTrade(true));
  $('#heat').addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect();
    const h = state.heatHit?.hit(e.clientX - r.left, e.clientY - r.top);
    if (!h || !state.ranked[h.row]) return;
    selectSite(state.ranked[h.row].id);
    setCursor(Math.min(state.grid.n - 1, Math.round(((h.day + 0.5) * 86400000) / state.grid.step)));
  });
  $('#tline').addEventListener('click', (e) => {
    if (!state.tlHit) return;
    const r = e.target.getBoundingClientRect(), x = e.clientX - r.left;
    if (x < state.tlHit.L) return;
    setCursor(state.tlHit.toIndex(x));
  });
  $('#mglobe').addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect();
    const id = state.globeHit?.hit(e.clientX - r.left, e.clientY - r.top);
    if (id && state.results.has(id)) selectSite(id);
  });
  const cal = $('#cal');
  cal.addEventListener('mousemove', (e) => {
    const r = cal.getBoundingClientRect();
    const d = state.calHit?.hit(e.clientX - r.left, e.clientY - r.top);
    const tip = $('#tip');
    if (!d) { tip.hidden = true; return; }
    tip.innerHTML = calText(d);
    tip.hidden = false;
    tip.style.left = `${Math.min(innerWidth - 290, e.clientX + 14)}px`; tip.style.top = `${e.clientY + 14}px`;
  });
  cal.addEventListener('mouseleave', () => { $('#tip').hidden = true; });
  cal.addEventListener('click', (e) => {
    const r = cal.getBoundingClientRect();
    const d = state.calHit?.hit(e.clientX - r.left, e.clientY - r.top);
    if (d) pickCalendarDay(d);
  });
}

const THERMAL_INPUTS = ['#t-on', '#t-elec', '#t-min', '#t-cap', '#t-rad', '#t-eps', '#t-max', '#t-start', '#t-sink', '#t-sun', '#t-abs'];
const LABELS = { '#d-start': 'Start date', '#d-days': 'Search period', '#d-step': 'Time step', '#p-type': 'Panel mounting', '#p-area': 'Panel area', '#p-eff': 'Panel efficiency', '#p-az': 'Panel direction', '#b-cap': 'Battery capacity', '#b-usable': 'Usable depth', '#b-ceff': 'Charge efficiency', '#b-deff': 'Discharge efficiency', '#b-op': 'Operating load', '#b-surv': 'Survival load', '#k-margin': 'Link clearance', '#k-dsn': 'DSN elevation', '#k-require': 'DSN requirement',
  '#t-on': 'Thermal model', '#t-elec': 'Survival electronics', '#t-min': 'Minimum temperature', '#t-cap': 'Heat capacity', '#t-rad': 'Radiator area', '#t-eps': 'Emissivity', '#t-max': 'Louvre temperature', '#t-start': 'Touchdown temperature', '#t-sink': 'Sink temperature', '#t-sun': 'Sunlit side area', '#t-abs': 'Absorptivity', '#r-relay': 'Relay satellite' };
const labelOf = (id) => LABELS[id] || 'Settings';
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const rerunSoon = debounce(() => runComparison(), 300);

function syncPresetRadio() {
  const w = weight();
  const match = Object.entries(PRIORITIES).find(([, p]) => Math.abs(p.weight - w) < 0.001);
  $$('input[name="prio"]').forEach((r) => { r.checked = !!match && r.value === match[0]; });
  if (match) $('#tr-prio').value = match[0];
}
function updateWeightLabel() { const w = +$('#w-slider').value; $('#w-label').textContent = `Weight: ${w}% sunlight · ${100 - w}% Earth link`; }
function onWeight(reason) {
  updateWeightLabel();
  if (!state.results.size) return;
  refreshDecisions(reason);
  stressSoon();
}
const stressSoon = debounce(() => { scheduleStress(); scheduleMC(); }, 400);

function options() {
  // every number is range-checked: an empty or nonsensical field falls back to the default instead of breaking the run
  return {
    stepMin: [30, 60, 180].includes(+$('#d-step').value) ? +$('#d-step').value : 60,
    panel: { type: $('#p-type').value, areaM2: num('#p-area', 2, 0.01, 1000), efficiency: num('#p-eff', 28, 1, 50) / 100, azimuth: num('#p-az', 0, -360, 360) },
    battery: {
      capacityWh: num('#b-cap', 2000, 1, 1e7), usableFraction: num('#b-usable', 80, 5, 100) / 100,
      chargeEff: num('#b-ceff', 95, 30, 100) / 100, dischargeEff: num('#b-deff', 95, 30, 100) / 100,
      operatingLoadW: num('#b-op', 200, 0, 1e6), survivalLoadW: num('#b-surv', 120, 0, 1e6),
    },
    comms: { minMarginDeg: num('#k-margin', 0.5, -5, 30), dsnMinElDeg: num('#k-dsn', 10, 0, 89), requireDsn: $('#k-require').checked, relay: RELAY_PRESETS[$('#r-relay').value]?.aKm ? RELAY_PRESETS[$('#r-relay').value] : null },
    radio: radioSettings(),
    thermal: thermalSettings(),
  };
}

const num = (id, d, lo = -Infinity, hi = Infinity) => { const v = +$(id).value; return Number.isFinite(v) && $(id).value !== '' ? Math.min(hi, Math.max(lo, v)) : d; };
function radioSettings() {
  return { ...RADIO_DEFAULTS, band: $('#r-band').value, dishM: +$('#r-dish').value, txPowerW: num('#r-power', 10, 0.01, 1e4), txGainDbi: num('#r-gain', 10, -10, 60) };
}
function syncRadio() {
  const r = radioSettings(), lb = linkBudget(384400, r);
  $('#r-out').textContent = `At the mean Earth–Moon distance: C/N0 ${fmt(lb.cn0DbHz, 1)} dB-Hz → up to ${fmtRate(lb.maxRateBps)} direct to a ${r.dishM} m dish (${(lb.freqGHz).toFixed(2)} GHz, EIRP ${fmt(lb.eirpDbw, 1)} dBW, dish gain ${fmt(lb.grDbi, 1)} dBi, path loss ${fmt(lb.fsplDb, 1)} dB).`;
}

function thermalSettings() {
  return resolveThermal({
    enabled: $('#t-on').checked, survivalElecW: num('#t-elec', 45, 0), minC: num('#t-min', -30, -200, 100), capacityKJperK: num('#t-cap', 240, 1),
    radiatorM2: num('#t-rad', 0.9, 0.01), emissivity: num('#t-eps', 0.8, 0.01, 1), maxC: num('#t-max', 30, -100, 200), startC: num('#t-start', 20, -100, 200),
    sinkK: num('#t-sink', 100, 0, 400), sunAreaM2: num('#t-sun', 1.5, 0), absorptivity: num('#t-abs', 0.3, 0, 1),
  });
}

function syncThermal() {
  const t = thermalSettings();
  $('#b-surv').disabled = t.enabled;
  $('#b-surv-wrap').title = t.enabled ? 'Not used while the thermal model is on' : '';
  for (const id of THERMAL_INPUTS.slice(1)) $(id).disabled = !t.enabled;
  const cool = coolDownHours(t);
  $('#t-out').textContent = t.enabled
    ? `In darkness the lander cools from ${fmt(t.startC, 0)} °C to ${fmt(t.minC, 0)} °C in ${Number.isFinite(cool) ? hrs(cool) : 'never (the electronics keep it warm)'}, then needs about ${fmt(steadyHeaterW(t), 0)} W of heater on top of ${fmt(t.survivalElecW, 0)} W of electronics (${fmt(steadyHeaterW(t) + t.survivalElecW, 0)} W in total).`
    : `Fixed survival load of ${$('#b-surv').value} W in every dark hour, however long or short the darkness.`;
}

function leadMs() { const ms = missionSettings(); return (ms.tof + ms.lloDays + 1) * 86400000; }
/** Monte Carlo survival rates for the current analysis run, if the Monte Carlo has finished for it. */
function robustRates() {
  if (!state.mc || state.mcRun !== `${state.runId}|${stayDays()}`) return null;
  return new Map([...state.mc].filter(([, v]) => v).map(([id, v]) => [id, v.rate]));
}
/** Historical analysis: a search that starts before today allows landings on past dates (no launch lead time). */
function isHistorical() {
  const start = Date.parse($('#d-start').value + 'T00:00:00Z');
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return Number.isFinite(start) && start < today.getTime();
}
function decisionOpts() { const o = { durationDays: stayDays(), weight: weight(), notBefore: isHistorical() ? -Infinity : Date.now() + leadMs() }; const r = robustRates(); if (r) o.robust = r; return o; }
/** Why no landing was found for a site: 'past' (every day too soon), 'short' (stay longer than the search) or null. */
function noLandingReason() {
  const g = state.grid; if (!g) return null;
  const end = g.start + g.n * g.step;
  if (stayDays() * 86400000 >= end - g.start) return 'short';
  const nb = decisionOpts().notBefore;
  if (nb + stayDays() * 86400000 >= end) return 'past';
  return null;
}

// ------------------------------------------------------------------ sites
function renderSiteList() {
  const groups = [['South polar region', state.sites.filter(isPolar)], ['Elsewhere on the Moon', state.sites.filter((s) => !isPolar(s))]];
  $('#site-list').innerHTML = groups.filter(([, list]) => list.length).map(([title, list]) => `<div class="grp">${title}</div>` + list.map((s) => {
    const h = state.horizons.get(s.id);
    return `<div class="site-row" data-id="${s.id}" aria-current="${s.id === state.selId}">
      <input type="checkbox" ${s.on ? 'checked' : ''} aria-label="Include ${esc(s.name)}">
      <span class="nm">${esc(s.name)}<small>${fmt(s.lat, 2)}°, ${fmt(s.lon, 2)}° · ${esc(s.kind)}</small></span>
      <span class="tag ${h ? 'lola' : ''}" title="${h ? `Terrain horizon from ${h.resM && h.resM < 20 ? 'the PGDA 5 m/pixel map near the site and LOLA beyond' : 'NASA LOLA elevation maps'}` : 'No terrain data: smooth Moon'}">${terrainLabel(s.id)}</span></div>`;
  }).join('')).join('');
  $$('#site-list .site-row').forEach((row) => {
    const s = siteOf(row.dataset.id);
    row.querySelector('input').addEventListener('change', (e) => { s.on = e.target.checked; state.changeReason = `${s.short || s.name} ${s.on ? 'added to' : 'removed from'} the comparison`; rerunSoon(); });
    row.querySelector('.nm').addEventListener('click', () => { if (state.results.has(s.id)) { selectSite(s.id); closeDrawer(); } else toast('Tick the site to include it in the comparison.'); });
  });
}

async function addCustomSite() {
  const lat = +$('#c-lat').value, lon = +$('#c-lon').value;
  if (!(lat >= -90 && lat <= 90) || !Number.isFinite(lon) || $('#c-lat').value === '') { toast('Enter a latitude between −90° and 90° and a longitude.'); return; }
  const id = `custom-${Date.now().toString(36)}`;
  const name = $('#c-name').value.trim() || `Site ${fmt(lat, 2)}°, ${fmt(lon, 2)}°`;
  const site = { id, name, short: name.slice(0, 14), lat, lon: ((lon + 540) % 360) - 180, kind: 'Custom site', note: 'Added by the team.', source: 'Entered by the team', on: true };
  state.sites.push(site);
  if (lat <= terrainEdge()) {
    try {
      const h = await fetchHorizon(lat, site.lon);
      state.horizons.set(id, { horizon: h.horizon, heightM: h.heightM });
      toast(`Terrain horizon computed from LOLA for ${name}.`);
    } catch { toast(`${name} added with a smooth-Moon horizon (no LOLA map on the server).`); }
  } else toast(`${name} added with a smooth-Moon horizon (the installed LOLA maps cover ${Math.abs(terrainEdge())}°S–90°S). Import a horizon file for real terrain.`, 6000);
  renderSiteList();
  state.changeReason = `${name} added`;
  runComparison(id);
}

async function importHorizonFile(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.sites) { // a horizons.json set
      for (const [id, s] of Object.entries(j.sites)) state.horizons.set(id, { horizon: new Horizon(s.elev, { azStep: j.azStep, source: 'LOLA', meta: j.meta }), heightM: s.heightM });
      toast(`Imported horizons for ${Object.keys(j.sites).length} sites.`);
    } else if (j.elev && j.lat != null) {
      const id = `import-${Date.now().toString(36)}`;
      state.sites.push({ id, name: j.name || f.name, short: (j.name || 'Imported').slice(0, 14), lat: j.lat, lon: j.lon, kind: 'Imported horizon', note: '', source: f.name, on: true });
      state.horizons.set(id, { horizon: new Horizon(j.elev, { azStep: j.azStep || 360 / j.elev.length, source: 'LOLA', meta: j.meta || {} }), heightM: j.heightM || 0 });
      toast(`Imported ${j.name || f.name}.`);
    } else throw new Error('Unrecognised file');
    renderSiteList(); runComparison();
  } catch (err) { toast(`Could not import: ${err.message}`); }
  e.target.value = '';
}

// ------------------------------------------------------------------ analysis
/** Southern edge of the installed LOLA terrain: 60°S when the 60°S map is installed, else 75°S. */
function terrainEdge() { return (state.horizonMeta?.maps || []).some((m) => /60s/i.test(m)) ? -60 : -75; }

function entryFor(s) {
  const h = state.horizons.get(s.id);
  return { id: s.id, name: s.name, site: { ...s, heightM: h?.heightM || 0 }, horizon: h?.horizon || Horizon.smooth(2), terrain: !!h, ring: h?.ring || [], slope: h?.slope || null, pgda: h?.pgda || null, selectedOnMap: h?.selection?.pgdaSun != null };
}
const terrainLabel = (id) => { const h = state.horizons.get(id); return h ? (h.resM && h.resM < 20 ? 'LOLA 5 m' : 'LOLA') : 'smooth'; };

function runComparison(selectId) {
  const active = state.sites.filter((s) => s.on);
  if (!active.length) { toast('Select at least one site.'); return; }
  if (!Number.isFinite(Date.parse($('#d-start').value + 'T00:00:00Z'))) { toast('Choose a valid earliest-landing date first.'); return; }
  $('#run-status').textContent = 'Computing…';
  $('#run-btn').disabled = true;
  setTimeout(() => { try { runNow(selectId, active); } catch (e) { console.error(e); $('#run-btn').disabled = false; $('#run-status').textContent = 'Run failed'; reportError(e.message); } }, 30);
}
function runNow(selectId, active) {
  {
    const t0 = performance.now();
    const start = Date.parse($('#d-start').value + 'T00:00:00Z');
    const days = +$('#d-days').value;
    const o = options();
    state.grid = ephemerisGrid(start, start + days * 86400000, o.stepMin);
    state.results.clear(); state.daily.clear(); state.runId = (state.runId || 0) + 1;
    for (const s of active) {
      const e = entryFor(s);
      const a = analyseSite(e.site, e.horizon, state.grid, o);
      a.horizon = e.horizon; a.terrain = e.terrain ? 'LOLA' : 'smooth'; a.terrainRes = state.horizons.get(s.id)?.resM ?? null;
      state.results.set(s.id, a);
      state.daily.set(s.id, daily(a, state.grid));
    }
    const ms = performance.now() - t0;
    $('#run-status').textContent = `${active.length} sites × ${state.grid.n.toLocaleString()} times in ${fmt(ms / 1000, 2)} s`;
    $('#run-btn').disabled = false;
    $('#rank-sub').textContent = `${days} days from ${$('#d-start').value} · ${o.stepMin} min steps · ${[...state.results.values()].some((a) => a.terrain === 'LOLA') ? 'LOLA terrain where available' : 'smooth Moon (no terrain loaded)'}`;
    if (state.landing && (state.landing < state.grid.start || state.landing >= state.grid.start + state.grid.n * state.grid.step)) state.landing = null;
    refreshDecisions(state.changeReason || null, { select: selectId, reset: true });
    state.changeReason = null;
    renderHeat(); renderSiteList(); renderMap();
    scheduleStress();
    scheduleMC();
    scheduleCrossCheck();
    state.onRun?.();
  }
}

/** Recompute everything that depends on the weight or the stay length (no new physics). */
function refreshDecisions(reason = null, { select = null, reset = false } = {}) {
  if (!state.results.size) return;
  state.ranked = rankSites(state.results, weight());
  state.decisions = siteDecisions(state.results, state.grid, decisionOpts());
  const prev = state.rec?.id;
  state.rec = pickRecommendation();
  state.changeNote = reason && prev && state.rec && prev !== state.rec.id
    ? `Recommendation changed from ${nameOf(prev)} to ${nameOf(state.rec.id)} after ${reason}. ${whyChanged(prev, state.rec.id)}`
    : reason && prev && state.rec ? `Still ${nameOf(state.rec.id)} after ${reason}.` : '';
  const keep = select || (reset && state.rec ? state.rec.id : null) || (state.results.has(state.selId) ? state.selId : state.rec?.id || state.ranked[0].id);
  if (reset || !state.landing || state.landingSite !== keep) {
    const d = state.decisions.get(keep);
    if (d) { state.landing = d.landing; state.landingSite = keep; }
  }
  // trade-off defaults: recommended + runner-up
  state.tradeSel = new Set([...state.tradeSel].filter((id) => state.results.has(id)));
  if (state.tradeSel.size < 2) { state.tradeSel = new Set([...new Set([state.rec?.id, ...state.ranked.map((r) => r.id)].filter(Boolean))].slice(0, 2)); }
  renderVerdict(); renderRank(); renderRobust();
  selectSite(keep, true);
  if (state.rec) {
    const d = state.decisions.get(state.rec.id);
    if (d && (reset || !$('#tr-landing').value)) $('#tr-landing').value = new Date(d.landing).toISOString().slice(0, 16);
  }
  $('#tr-days').value = String(stayDays());
  renderTrade(!!reason);
  if (state.stress) renderConfidence();
}

function whyChanged(fromId, toId) {
  const a = state.decisions.get(fromId), b = state.decisions.get(toId);
  if (a && !a.feasible && b?.feasible) return `${nameOf(fromId)} can no longer survive the stay.`;
  const ma = state.results.get(fromId)?.metrics, mb = state.results.get(toId)?.metrics;
  if (!ma || !mb) return '';
  if (mb.litPct > ma.litPct && mb.commsPct < ma.commsPct) return `${nameOf(toId)} has more sunlight (${fmt(mb.litPct, 0)}% vs ${fmt(ma.litPct, 0)}%) and that now counts for more.`;
  if (mb.commsPct > ma.commsPct && mb.litPct < ma.litPct) return `${nameOf(toId)} has more Earth-link time (${fmt(mb.commsPct, 0)}% vs ${fmt(ma.commsPct, 0)}%) and that now counts for more.`;
  return '';
}

/** Highest-ranked site whose best landing survives the stay; otherwise the top site, flagged. */
function pickRecommendation() {
  const top = state.ranked[0];
  if (!top) return null;
  const r = recommend(state.results, state.grid, weight(), decisionOpts());
  const rates = robustRates();
  const above = state.ranked.slice(0, Math.max(0, state.ranked.findIndex((x) => x.id === r.id)));
  const skipped = above.filter((x) => !state.decisions.get(x.id)?.feasible).map((x) => x.id);
  const fragile = above.filter((x) => state.decisions.get(x.id)?.feasible).map((x) => x.id);
  return { id: r.id, decision: state.decisions.get(r.id), topId: top.id, feasible: r.feasible, skipped, fragile, rates, robustApplied: r.robustApplied };
}

/** Main reason a site fails its Monte Carlo scenarios, in words. */
function mcCause(id) {
  const x = state.mc?.get(id); if (!x) return '';
  const f = x.fail, top = Object.entries(f).sort((a, b) => b[1] - a[1])[0];
  if (!top || !top[1]) return '';
  return { slope: 'the ground is too steep for the lander', battery: 'the battery runs flat', touchdown: 'a late or early touchdown puts the Sun or Earth behind the terrain' }[top[0]];
}

/** Recommended site at every weight (memoised per analysis run and stay settings). */
function recSweep() {
  const key = `${state.runId}|${stayDays()}|${robustRates() ? 'mc' + state.mcKey?.length : 'nomc'}`;
  if (state.sweepKey !== key) { state.sweep = recommendationSweep(state.results, state.grid, decisionOpts(), 10); state.sweepKey = key; }
  return state.sweep;
}

const statusOfSite = (id) => { const d = state.decisions.get(id); return d?.feasible ? 'go' : d ? 'caution' : 'nogo'; };

// ------------------------------------------------------------------ verdict & ranking
function renderVerdict() {
  const v = $('#verdict');
  const rec = state.rec;
  if (!rec) return;
  const a = state.results.get(rec.id), m = a.metrics, d = rec.decision, s = siteOf(rec.id);
  const days = stayDays();
  const col = rec.feasible ? '--go' : d ? '--caution' : '--nogo';
  v.style.setProperty('--status', `var(${col})`);
  v.classList.toggle('st-caution', col === '--caution'); v.classList.toggle('st-nogo', col === '--nogo');
  const sweep = recSweep();
  const wins = sweep.wins.get(rec.id) || [];
  const allW = wins.length === sweep.table.length;
  const pills = [];
  pills.push(rec.feasible ? `<span class="pill s-GO">Survives ${days}-day stay</span>` : d ? `<span class="pill s-NO-GO">Battery runs flat</span>` : `<span class="pill s-NO-GO">No safe touchdown</span>`);
  if (d) pills.push(`<span class="pill" style="color:var(--${d.limiting.severity === 'go' ? 'go' : d.limiting.severity === 'nogo' ? 'nogo' : 'caution'})"><span class="k">Limiting</span>${esc(d.limiting.text)}</span>`);
  pills.push(`<span class="pill" style="color:var(${allW ? '--go' : '--caution'})"><span class="k">Priority</span>${allW ? 'wins at every weight' : wins.length ? (Math.min(...wins) === Math.max(...wins) ? `recommended only at ${Math.round(wins[0] * 100)}% sunlight` : `recommended at ${Math.round(Math.min(...wins) * 100)}–${Math.round(Math.max(...wins) * 100)}% sunlight`) : 'not recommended at other weights'}</span>`);
  if (state.stress) pills.push(`<span class="pill" style="color:var(${state.stress.held === state.stress.total ? '--go' : '--caution'})"><span class="k">Stress tests</span>held ${state.stress.held}/${state.stress.total}</span>`);
  const mc = state.mc?.get(rec.id);
  if (mc) pills.push(`<span class="pill ${mc.rate >= 0.9 ? 'go' : mc.rate >= 0.6 ? 'caution' : 'nogo'}"><span class="k">Monte Carlo</span>survives ${fmt(100 * mc.rate, 0)}% of ${mc.n} scenarios</span>`);
  if (d) { const sd = stayData(a, state.grid, d.k0, d.k0 + Math.round((days * 86400000) / state.grid.step), options().radio); if (sd.hours) pills.push(`<span class="pill" style="color:var(--fg)"><span class="k">Data</span>up to ${fmtRate(sd.maxRateBps)} \u00b7 ${fmtBits(sd.bits)} over the stay</span>`); }
  if (isHistorical()) pills.unshift('<span class="pill" style="color:var(--fg)"><span class="k">Historical analysis</span>past dates allowed, no launch lead time</span>');
  pills.push(`<span class="pill" style="color:var(${a.terrain === 'LOLA' ? '--go' : '--caution'})"><span class="k">Terrain</span>${a.terrain === 'LOLA' ? terrainLabel(rec.id) : 'smooth Moon'}</span>`);
  let title, small, why = '';
  if (d) {
    title = `${esc(s.name)} · land ${utc(d.landing)}`;
    small = `${days}-day stay: Sun up ${fmt(d.litPct, 0)}% · Earth link ${fmt(d.commsPct, 0)}% · longest dark ${hrs(d.longestDarkH)} · battery lowest ${fmt(d.minSocPct, 0)}% (needs ${kwh(d.batteryNeededWh)}, margin ${d.batteryMarginWh >= 0 ? kwh(d.batteryMarginWh) : '−' + kwh(-d.batteryMarginWh)})`;
  } else {
    title = `${esc(s.name)} · no landing found`;
    const why = noLandingReason();
    small = why === 'past' ? 'Every day in the search period is already past or too soon to reach the Moon. Choose a later start date, or a past date for a historical analysis.'
      : why === 'short' ? `The search period is shorter than a ${days}-day stay. Lengthen the search period or shorten the stay.`
      : 'No time in the search period has both the Sun and Earth above the skyline at touchdown. Try other dates.';
  }
  const parts = [];
  if (rec.skipped.length) parts.push(`${rec.skipped.map(nameOf).join(', ')} ${rec.skipped.length > 1 ? 'score' : 'scores'} higher on sunlight and Earth link, but ${rec.skipped.length > 1 ? 'they run' : 'it runs'} the battery flat (or ${rec.skipped.length > 1 ? 'have' : 'has'} no safe touchdown) in every ${days}-day stay with this battery.`);
  if (rec.fragile?.length && rec.rates) parts.push(rec.fragile.map((id) => `${nameOf(id)} survives its best stay on paper but only ${fmt(100 * (rec.rates.get(id) ?? 0), 0)}% of the Monte Carlo scenarios (mostly because ${mcCause(id) || 'of the sampled uncertainties'})`).join('; ') + '.');
  if (parts.length) {
    why = `${parts.join(' ')} So ${esc(s.short || s.name)} is the best site that survives${rec.robustApplied ? ` — in ${fmt(100 * (rec.rates?.get(rec.id) ?? 0), 0)}% of the scenarios` : ''}.`;
    if (rec.robustApplied && rec.rates && (rec.rates.get(rec.id) ?? 0) < ROBUST_MIN_RATE) why += ` No site survives ${Math.round(ROBUST_MIN_RATE * 100)}% of the Monte Carlo scenarios; this is the most robust of those that survive on paper.`;
  } else if (!rec.feasible && d) why = `No site survives a ${days}-day stay with a ${kwh(options().battery.capacityWh)} battery. ${esc(s.short || s.name)} comes closest: it needs ${kwh(d.batteryNeededWh)}. Increase the battery, lower the survival load or shorten the stay.`;
  else {
    why = `${esc(s.short || s.name)} has the best combination of sunlight (${fmt(m.litPct, 0)}%) and Earth-link time (${fmt(m.commsPct, 0)}%) over the ${+$('#d-days').value} days searched${d ? `, and landing on ${day(d.landing)} never lets the battery fall below ${fmt(d.minSocPct, 0)}% during the ${days}-day stay` : ''}.`;
    if (m.batteryNeededWh > options().battery.capacityWh) why += ` Its longest night lasts ${hrs(m.longestDarkH)} — riding that out would take ${kwh(m.batteryNeededWh)} — so the landing date matters as much as the site.`;
    if (a.terrain !== 'LOLA') why += ' Terrain is not loaded, so these figures assume a smooth Moon; real ridges and crater rims change them a lot.';
  }
  v.innerHTML = `<span class="eyebrow">Which landing site gives our lander the best chance of surviving its surface mission while keeping contact with Earth?</span>
    <div class="t0">${title}<small>${small}</small></div>
    <div class="pills">${pills.join('')}</div>
    <p class="why">${why}</p>
    <div class="change" id="change-note">${esc(state.changeNote)}</div>
    <div class="actions"><button class="btn small primary" type="button" id="v-show">Show this landing</button><button class="btn small" type="button" id="v-why">Why this site?</button><button class="btn small" type="button" id="v-trade">Compare with the runner-up</button></div>`;
  $('#v-show').addEventListener('click', () => { selectSite(rec.id); if (d) { setLanding(d.landing, rec.id); setCursor(d.k0); } $('#card-site').scrollIntoView({ behavior: 'smooth' }); });
  $('#v-why').addEventListener('click', () => { selectSite(rec.id); $('#card-why').scrollIntoView({ behavior: 'smooth' }); });
  $('#v-trade').addEventListener('click', () => { $('#card-trade').scrollIntoView({ behavior: 'smooth' }); });
}

function renderRank() {
  const bar = (v, col) => `<span class="bar-cell"><i style="width:${Math.max(0, Math.min(100, v))}%;background:var(${col})"></i></span>`;
  $('#rank-body').innerHTML = state.ranked.map((r, i) => {
    const a = state.results.get(r.id), m = a.metrics, s = siteOf(r.id), d = state.decisions.get(r.id);
    const best = d ? `<span class="feas ${d.feasible ? 'go' : 'nogo'}">${d.feasible ? 'survives' : 'runs flat'}</span>${day(d.landing)} · min ${fmt(d.minSocPct, 0)}%` : '<span class="feas none">no touchdown</span>';
    return `<tr data-id="${r.id}" aria-current="${r.id === state.selId}">
      <td>${i + 1}</td><td>${swatch(r.id)}${esc(s.name)}${a.terrain === 'LOLA' ? '' : ' <span class="hint" title="No terrain data: smooth Moon">*</span>'}${state.rec?.id === r.id ? ' <span class="feas go" title="Recommended">rec.</span>' : ''}</td>
      <td class="num">${bar(m.litPct, '--sun')}${fmt(m.litPct, 0)}%</td><td class="num">${hrs(m.longestDarkH)}</td>
      <td class="num">${bar(m.commsPct, '--earth')}${fmt(m.commsPct, 0)}%</td><td class="num">${hrs(m.longestOutageH)}</td>
      <td title="Best landing in the search period for a ${stayDays()}-day stay">${best}</td>
      <td class="num"><b>${fmt(r.score, 1)}</b></td></tr>`;
  }).join('');
  $$('#rank-body tr').forEach((tr) => tr.addEventListener('click', () => selectSite(tr.dataset.id)));
}

function renderRobust() {
  const sw = recSweep();
  const segs = [];
  for (const row of sw.table) {
    const last = segs[segs.length - 1];
    if (last && last.id === row.winner) last.n++; else segs.push({ id: row.winner, n: 1, from: row.weight });
  }
  const total = sw.table.length;
  $('#robust').innerHTML = segs.map((s) => `<div style="flex:${s.n};background:${colorOf(s.id)};background-image:${patternOf(s.id)}" title="${esc(siteOf(s.id).name)} is recommended from ${Math.round(s.from * 100)}% sunlight weight">${s.n / total > 0.12 ? `<span>${esc(nameOf(s.id))}</span>` : ''}</div>`).join('')
    + `<span class="cur" style="left:calc(${weight() * 100}% - 1px)" title="Current weight"></span>`;
}

function renderHeat() {
  if (!state.ranked.length) return;
  const rows = state.ranked.map((r) => ({ id: r.id, label: nameOf(r.id), values: state.daily.get(r.id)[state.heatMetric] }));
  const d0 = state.daily.get(state.ranked[0].id);
  const dayCursor = Math.floor((state.k * state.grid.step) / 86400000);
  $('#heat').style.height = `${Math.max(160, 26 * rows.length + 30)}px`;
  state.heatHit = drawHeatmap($('#heat'), { rows, start: d0.start, days: d0.days, metric: state.heatMetric, selected: state.selId, dayCursor });
}

// ------------------------------------------------------------------ why
function renderWhy() {
  const id = state.selId; if (!id) return;
  const rival = id === state.rec?.id ? state.ranked.find((r) => r.id !== id)?.id : state.rec?.id;
  const x = explainSite(id, state.results, rival);
  const a = state.results.get(id), m = a.metrics;
  const d = state.decisions.get(id);
  $('#why-sub').textContent = `${siteOf(id).name}${id === state.rec?.id ? ' (recommended)' : ''} against the ${state.results.size - 1} other site${state.results.size > 2 ? 's' : ''}`;
  const li = (arr, empty) => (arr.length ? arr.map((t) => `<li>${esc(t.text || t)}</li>`).join('') : `<li class="hint" style="list-style:none">${empty}</li>`);
  const lim = d ? d.limiting : x.limiting;
  const col = lim.severity === 'go' ? '--go' : lim.severity === 'nogo' ? '--nogo' : '--caution';
  $('#why-body').innerHTML = `
    <div><h3>Strengths</h3><ul class="plus">${li(x.strengths, 'Nothing stands out against the other sites.')}</ul></div>
    <div><h3>Trade-offs</h3><ul class="minus">${li(x.weaknesses, 'No significant weaknesses against the other sites.')}</ul></div>
    <div class="lim ${lim.severity}" style="--status:var(${col})"><h3>Limiting constraint</h3><p>${esc(lim.text)}${d ? ` (best ${stayDays()}-day stay, landing ${day(d.landing)})` : ''}.</p>
      ${x.vs ? `<p class="hint">Against ${esc(nameOf(x.vs.rivalId))}: ${x.vs.wins.length ? `better on ${esc(x.vs.wins.join('; '))}` : 'no clear advantage'}${x.vs.losses.length ? `; worse on ${esc(x.vs.losses.join('; '))}` : ''}.</p>` : ''}
      <button class="linkish" type="button" data-jump="dark">Show the longest dark period (${hrs(m.longestDarkH)}${m.longestDarkStart ? `, from ${day(m.longestDarkStart)}` : ''})</button>
      <button class="linkish" type="button" data-jump="outage">Show the longest Earth-link outage (${hrs(m.longestOutageH)}${m.longestOutageStart ? `, from ${day(m.longestOutageStart)}` : ''})</button>
      ${d ? '<button class="linkish" type="button" data-jump="stay">Show the best surface stay</button>' : ''}
    </div>`;
  $$('#why-body [data-jump]').forEach((b) => b.addEventListener('click', () => jumpTo(b.dataset.jump)));
}

function jumpTo(kind) {
  const a = state.results.get(state.selId), g = state.grid, m = a.metrics;
  if (kind === 'stay') {
    const d = state.decisions.get(state.selId);
    if (d) { setLanding(d.landing, state.selId); state.tlRange = 'stay'; $('input[name="tlr"][value="stay"]').checked = true; state.highlight = null; setCursor(d.k0); }
  } else {
    const t0 = kind === 'dark' ? m.longestDarkStart : m.longestOutageStart;
    const hours = kind === 'dark' ? m.longestDarkH : m.longestOutageH;
    if (t0 == null) { toast(kind === 'dark' ? 'This site is never dark in the search period.' : 'Earth is always in view in the search period.'); return; }
    const k0 = Math.round((t0 - g.start) / g.step), k1 = k0 + Math.round((hours * 3600000) / g.step);
    state.highlight = { k0, k1 };
    state.tlRange = 'all'; $('input[name="tlr"][value="all"]').checked = true;
    setCursor(Math.min(g.n - 1, k0 + Math.round((k1 - k0) / 2)));
  }
  $('#card-site').scrollIntoView({ behavior: 'smooth' });
}

// ------------------------------------------------------------------ selected site
function selectSite(id, resetCursor = false) {
  if (!state.results.has(id)) return;
  const changed = state.selId !== id;
  state.selId = id;
  if (changed) state.highlight = null;
  const a = state.results.get(id);
  const o = a.opts;
  const s = siteOf(id);
  state.calendar = landingCalendar(a, state.grid, decisionOpts());
  state.windows = bestWindows(a, state.grid, { ...decisionOpts(), top: 8 });
  const dec = state.decisions.get(id);
  if (changed || resetCursor) {
    if (state.landingSite !== id && dec) { state.landing = dec.landing; state.landingSite = id; }
    const k0 = state.landing != null && state.landingSite === id ? Math.round((state.landing - state.grid.start) / state.grid.step) : null;
    state.calDay = k0 != null ? Math.floor((k0 * state.grid.step) / 86400000) : null;
    if (k0 != null && k0 >= 0) state.k = k0; else if (resetCursor) state.k = 0;
  }
  $('#time-slider').max = String(state.grid.n - 1);
  $('#site-title').textContent = s.name;
  $('#site-sub').textContent = `${fmt(s.lat, 4)}°, ${fmt(s.lon, 4)}°E · ${s.kind} · coordinates: ${s.source}`;
  const tb = $('#site-terrain');
  tb.className = `badge ${a.terrain === 'LOLA' ? 'lola' : 'smooth'}`;
  tb.textContent = a.terrain === 'LOLA' ? `Terrain: ${terrainLabel(id)} · ${fmt(state.horizons.get(id)?.heightM ?? 0, 0)} m` : 'Terrain: smooth Moon';
  tb.title = a.terrain === 'LOLA' ? 'Horizon ray-marched from NASA LRO LOLA elevation maps' : isPolar(s) ? 'No elevation data for this site: python server.py --build-terrain' : `The installed LOLA maps cover ${Math.abs(terrainEdge())}°S–90°S; import a horizon file for this site`;
  $('#site-explain').textContent = explainMetrics(s.name, a.metrics) + (s.note ? ` ${s.note}` : '');
  renderTiers(a);
  renderSafety();
  // calendar & windows
  $('#cal-sub').textContent = `${stayDays()}-day stay at ${s.short || s.name} · ${PRIORITIES[presetKey()]?.label || `${Math.round(weight() * 100)}% sunlight`} · earliest landing ${day(Date.now() + leadMs())}`;
  renderCalendar();
  $('#win-sub').textContent = `battery ${kwh(o.battery.capacityWh)} nominal, ${Math.round(o.battery.usableFraction * 100)}% usable · loads ${o.battery.operatingLoadW} W lit / ${o.thermal.enabled ? `${o.thermal.survivalElecW} W + heaters (thermal model)` : `${o.battery.survivalLoadW} W`} dark`;
  $('#win-body').innerHTML = state.windows.length ? state.windows.map((w, i) => `<tr data-w="${i}"><td class="num" style="text-align:left">${utc(w.landing)}</td><td class="num">${fmt(w.litPct, 0)}%</td><td class="num">${fmt(w.commsPct, 0)}%</td><td class="num">${hrs(w.longestDarkH)}</td>
      <td class="num" style="color:var(${w.feasible ? '--fg' : '--nogo'})">${w.feasible ? `${fmt(w.minSocPct, 0)}%` : `flat ${hrs(w.hoursWithoutPower)}`}</td><td class="num">${w.batteryMarginWh >= 0 ? '+' : '−'}${kwh(Math.abs(w.batteryMarginWh))}</td>
      <td style="white-space:normal;min-width:180px">${esc(w.limiting.text)}</td><td class="num">${fmt(w.score, 1)}</td><td><button class="btn small" type="button" data-w="${i}">Land here</button></td></tr>`).join('')
    : `<tr><td colspan="9" class="hint">No reachable time in this period has both the Sun and Earth above the skyline at touchdown. Try later dates or a higher site.</td></tr>`;
  $$('#win-body button[data-w]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const w = state.windows[+b.dataset.w]; setLanding(w.landing, id); setCursor(w.k0); toast(`Landing set to ${utc(w.landing)} at ${s.name}.`); }));
  $('#verify-out').textContent = 'Compares this site\'s Sun and Earth positions with NASA JPL\'s ephemeris service.';
  renderPeriods();
  renderWhy();
  $$('#rank-body tr').forEach((tr) => tr.setAttribute('aria-current', String(tr.dataset.id === id)));
  $$('#site-list .site-row').forEach((tr) => tr.setAttribute('aria-current', String(tr.dataset.id === id)));
  renderHeat();
  updateTrace();
  setCursor(state.k);
  renderMission(); renderPhases(); renderMap();
}

const presetKey = () => Object.entries(PRIORITIES).find(([, p]) => Math.abs(p.weight - weight()) < 0.001)?.[0];

function renderTiers(a) {
  const m = a.metrics, o = a.opts;
  const row = (k, v, note = '') => `<tr><td>${k}</td><td class="num">${v}</td><td class="hint" style="white-space:normal">${note}</td></tr>`;
  $('#tiers').innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>Sunlight</th><th class="num">Time</th><th>Meaning</th></tr></thead><tbody>
      ${row('Above a smooth horizon', `${fmt(m.sunGeoPct, 1)}%`, 'Geometry only, no terrain')}
      ${row('Above the real skyline', `${fmt(m.litPct, 1)}%`, `≥ ${Math.round(o.litThreshold * 100)}% of the disc clear of terrain${m.litPct > m.sunGeoPct + 0.5 ? ' — more than geometric: an elevated site sees past the smooth horizon' : ''}`)}
      ${row('Mean disc visible', `${fmt(m.sunPct, 1)}%`, 'Partial Sun counts partly')}
      ${row('Mean array output', `${fmt(m.meanPowerW, 0)} W`, `${fmt(m.energyKWh, 0)} kWh over the period`)}
    </tbody></table></div>
    <div class="table-wrap"><table><thead><tr><th>Direct-to-Earth</th><th class="num">Time</th><th>Meaning</th></tr></thead><tbody>
      ${row('Earth geometrically visible', `${fmt(m.earthGeoPct, 1)}%`, 'Above a smooth-Moon horizon')}
      ${row('Terrain-clear line of sight', `${fmt(m.earthPct, 1)}%`, `Earth's centre ≥ ${o.comms.minMarginDeg}° above the skyline${m.earthPct > m.earthGeoPct + 0.5 ? ' — more than geometric: the site stands high enough to see past the smooth-Moon horizon' : ''}`)}
      ${row('… and a DSN station in view', `${fmt(m.dsnPct, 1)}%`, `Goldstone, Madrid or Canberra sees the Moon ≥ ${o.comms.dsnMinElDeg}°`)}
      ${o.comms.relay ? row('Through the relay only', `${fmt(m.relayOnlyPct, 1)}%`, 'Earth hidden, but the relay is above the skyline and sees Earth') : ''}
      ${row('Link in use (counted)', `${fmt(m.commsPct, 1)}%`, o.comms.relay ? 'Direct or through the relay' : 'Direct line of sight' + (o.comms.requireDsn ? ' with a DSN station' : ''))}
      ${(() => { const d = stayData(a, state.grid, 0, state.grid.n, o.radio); return row('Direct data rate', d.hours ? `${fmtRate(d.minRateBps)}–${fmtRate(d.maxRateBps)}` : '—', `Link equation, ${o.radio.band}-band, ${o.radio.txPowerW} W, ${o.radio.txGainDbi} dBi to a ${o.radio.dishM} m dish; ${fmtBits(d.bits)} could be returned over the period`); })()}
      <tr><td>Operational availability</td><td class="num na">not modelled</td><td class="hint" style="white-space:normal">Antenna pointing, DSN scheduling and weather are mission-specific</td></tr>
    </tbody></table></div>`;
}

function stayRange() {
  const g = state.grid;
  if (state.tlRange !== 'stay' || state.landing == null || state.landingSite !== state.selId) return { from: 0, to: g.n - 1 };
  const k0 = Math.max(0, Math.round((state.landing - g.start) / g.step));
  const k1 = Math.min(g.n - 1, k0 + Math.round((stayDays() * 86400000) / g.step));
  return k1 > k0 ? { from: k0, to: k1 } : { from: 0, to: g.n - 1 };
}

function setCursor(k) {
  state.k = Math.max(0, Math.min(state.grid.n - 1, k));
  $('#time-slider').value = String(state.k);
  drawSite();
}

function drawSite() {
  const a = state.results.get(state.selId); if (!a) return;
  const k = state.k, g = state.grid;
  const t = g.start + k * g.step;
  drawPanorama($('#pano'), { horizon: a.horizon, a, k, trackStep: Math.max(1, Math.round(180 / (g.step / 60000))), geometric: $('#pano-geo').checked, band: $('#pano-band').checked ? 0.5 : 0 });
  const r = stayRange();
  const tr = state.trace && state.tlRange === 'stay' && r.from === state.trace.k0 ? state.trace : null;
  state.tlHit = drawTimeline($('#tline'), { a, grid: g, k, highlight: state.highlight, from: r.from, to: r.to, trace: tr });
  const sunDir = [g.sun[3 * k], g.sun[3 * k + 1], g.sun[3 * k + 2]], earthDir = [g.earth[3 * k], g.earth[3 * k + 1], g.earth[3 * k + 2]];
  if (!drawSite._g || performance.now() - drawSite._g > 80 || !state.playing) {
    drawSite._g = performance.now();
    state.globeHit = drawMoonGlobe($('#mglobe'), { sunDir, earthDir, sites: state.sites.filter((s) => state.results.has(s.id)), selected: state.selId, statusOf: statusOfSite });
    const polar = state.globeHit?.polar;
    $('#globe-title').textContent = polar ? 'South pole from below' : 'The hemisphere around this site';
    $('#globe-hint').textContent = polar ? 'Viewed from outside, looking up at the south pole: 0° longitude (towards Earth) at the top, 90°E on the right. Shading is a smooth sphere: it shows where the Sun is, not terrain shadows. Dot colour: green survives the stay, amber battery runs flat, red no safe touchdown.'
      : 'Viewed from outside, north up and east on the right. Shading is a smooth sphere: it shows day and night, not terrain shadows.';
  }
  $('#time-text').textContent = utc(t);
  const st = statusAt(a, g, k);
  const usable = a.opts.battery.capacityWh * a.opts.battery.usableFraction;
  const inStay = state.trace && k >= state.trace.k0 && k < state.trace.k1;
  const src = inStay ? state.trace : a; // battery and heater state of the planned stay, when the cursor is inside it
  const soc = usable ? (100 * src.soc[k]) / usable : 0;
  const load = src.load[k], temp = src.temp[k];
  $('#status-row').innerHTML = `<span class="sbadge ${st.sunState}">${st.sun} <small>${fmt(100 * a.sunFrac[k], 0)}% of disc</small></span>
    <span class="sbadge ${st.earthState}">${st.earth} <small>Earth ${signed(a.earthEl[k] - a.earthHz[k])}° vs skyline</small></span>
    <span class="sbadge ${a.power[k] >= load ? 'go' : soc > 20 ? 'caution' : 'nogo'}">${a.power[k] >= load ? 'CHARGING' : soc <= 0 ? 'BATTERY FLAT' : 'ON BATTERY'} <small>${fmt(a.power[k], 0)} W in · ${fmt(load, 0)} W load${src.heater[k] > 0.5 ? ` (heaters ${fmt(src.heater[k], 0)} W)` : ''} · ${fmt(soc, 0)}% usable${inStay ? '' : ' (whole-period run)'}</small></span>
    ${Number.isFinite(temp) ? `<span class="sbadge ${temp <= a.opts.thermal.minC + 0.01 ? 'caution' : 'go'}">${temp <= a.opts.thermal.minC + 0.01 ? 'HEATERS HOLDING' : 'THERMAL OK'} <small>${fmt(temp, 0)} °C</small></span>` : ''}`;
  $('#now-readout').innerHTML = `<span>Sun <b>az ${fmt(a.sunAz[k], 1)}° el ${signed(a.sunEl[k], 2)}°</b> · skyline ${signed(a.sunHz[k], 2)}°</span>
    <span>Earth <b>az ${fmt(a.earthAz[k], 1)}° el ${signed(a.earthEl[k], 2)}°</b> · skyline ${signed(a.earthHz[k], 2)}° · smooth horizon ${signed(a.dip, 2)}°</span>
    <span>DSN: highest Moon elevation ${g.dsnMaxEl[k]}°</span>`;
}

function togglePlay() {
  state.playing = !state.playing;
  $('#play-btn').textContent = state.playing ? 'Pause' : 'Play';
  const r = stayRange();
  const perFrame = Math.max(1, Math.round((r.to - r.from) / 600));
  const step = () => {
    if (!state.playing) return;
    const rr = stayRange();
    if (state.k >= rr.to) { state.playing = false; $('#play-btn').textContent = 'Play'; return; }
    setCursor(state.k + perFrame);
    requestAnimationFrame(step);
  };
  if (state.playing) { if (state.k >= r.to || state.k < r.from) state.k = r.from; requestAnimationFrame(step); }
}

function redraw() {
  if (mode() === 'simple') { drawSimpleMap(); return; }
  if (state.ranked.length) { renderHeat(); renderCalendar(); drawSite(); renderMap(); }
}

/** Battery / thermal trace of the planned stay at the selected site (fresh battery, warm lander). */
function updateTrace() {
  const a = state.results.get(state.selId);
  state.trace = null;
  if (!a || state.landing == null || state.landingSite !== state.selId) return;
  const k0 = Math.round((state.landing - state.grid.start) / state.grid.step);
  if (k0 < 0 || k0 >= state.grid.n) return;
  state.trace = stayTrace(a, state.grid, k0, stayDays());
}

// ------------------------------------------------------------------ calendar & periods
function renderCalendar() {
  const c = $('#cal');
  if (!state.calendar.length) return;
  const months = new Set(state.calendar.map((d) => new Date(d.dayStart).toISOString().slice(0, 7))).size;
  c.style.height = `${Math.min(22, 26) * months + 22}px`;
  const best = state.decisions.get(state.selId);
  state.calHit = drawCalendar(c, { days: state.calendar, selectedDay: state.calDay, bestDay: best?.day ?? null });
  renderCalDetail();
}

function calText(d) {
  const date = day(d.dayStart);
  if (d.status === 'past') return `<b>${date}</b> · too soon: earliest landing is ${day(Date.now() + leadMs())} (transfer + lunar orbit)`;
  if (d.status === 'beyond') return `<b>${date}</b> · the ${stayDays()}-day stay would run past the search period`;
  if (d.status === 'no-touchdown') return `<b>${date}</b> · no safe touchdown: the Sun or Earth is behind the terrain all day`;
  return `<b>${date}</b> · land ${utc(d.landing).slice(11)} · ${d.feasible ? `survives (battery lowest ${fmt(d.minSocPct, 0)}%)` : `battery flat for ${hrs(d.hoursWithoutPower)}`}<br>Sun ${fmt(d.litPct, 0)}% · link ${fmt(d.commsPct, 0)}% · longest dark ${hrs(d.longestDarkH)} · score ${fmt(d.score, 1)}<br>Limiting: ${esc(d.limiting.text)}`;
}

function renderCalDetail() {
  const el = $('#cal-detail');
  const d = state.calendar.find((x) => x.day === state.calDay);
  if (!d) { el.innerHTML = ''; return; }
  el.style.setProperty('--status', `var(${d.status === 'ok' ? '--go' : d.status === 'infeasible' ? '--nogo' : '--line'})`);
  el.innerHTML = `<span>${calText(d)}</span>`;
}

function pickCalendarDay(d) {
  state.calDay = d.day;
  if (d.status === 'ok' || d.status === 'infeasible') {
    setLanding(d.landing, state.selId);
    state.highlight = null; state.tlRange = 'stay'; $('input[name="tlr"][value="stay"]').checked = true;
    setCursor(d.k0);
    $('#tr-landing').value = new Date(d.landing).toISOString().slice(0, 16);
    renderTrade(true);
  }
  renderCalendar();
}

function renderPeriods() {
  const a = state.results.get(state.selId); if (!a) return;
  const list = periods(a, state.grid, state.perKind);
  const word = { sun: 'sunlit periods', dark: 'dark periods', comms: 'Earth-link windows', outage: 'link outages' }[state.perKind];
  const sorted = [...list].sort((x, y) => y.hours - x.hours);
  const med = list.length ? [...list].map((p) => p.hours).sort((x, y) => x - y)[Math.floor(list.length / 2)] : 0;
  $('#per-sub').textContent = list.length ? `${list.length} ${word} at ${siteOf(state.selId).name} in the search period · longest ${hrs(sorted[0].hours)} · median ${hrs(med)}. Longest first; "…" = runs past the edge of the period.` : `No ${word} in the search period.`;
  $('#per-body').innerHTML = sorted.slice(0, 40).map((p, i) => `<tr><td class="num" style="text-align:left">${p.k0 === 0 ? '… ' : ''}${utc(p.start)}</td><td class="num" style="text-align:left">${utc(p.end)}${p.k1 === state.grid.n ? ' …' : ''}</td><td class="num">${hrs(p.hours)}</td><td><button class="btn small" type="button" data-p="${i}">Show</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="hint">None.</td></tr>';
  $$('#per-body [data-p]').forEach((b) => b.addEventListener('click', () => {
    const p = sorted[+b.dataset.p];
    state.highlight = { k0: p.k0, k1: p.k1 }; state.tlRange = 'all'; $('input[name="tlr"][value="all"]').checked = true;
    setCursor(p.k0 + Math.floor((p.k1 - p.k0) / 2));
    $('#card-site').scrollIntoView({ behavior: 'smooth' });
  }));
}

function exportPeriods() {
  const a = state.results.get(state.selId); if (!a) return;
  const rows = ['site,type,start_utc,end_utc,hours,truncated'];
  for (const kind of ['sun', 'dark', 'comms', 'outage']) for (const p of periods(a, state.grid, kind)) rows.push([state.selId, kind, new Date(p.start).toISOString(), new Date(p.end).toISOString(), p.hours.toFixed(2), p.truncated].join(','));
  download(`clearway-${state.selId}-periods.csv`, rows.join('\n'), 'text/csv');
}

// ------------------------------------------------------------------ trade-off explorer
function renderTrade(withChange = false) {
  if (!state.results.size) return;
  $('#tr-sites').innerHTML = state.ranked.map((r) => `<label><input type="checkbox" value="${r.id}" ${state.tradeSel.has(r.id) ? 'checked' : ''}>${swatch(r.id, ';margin:0')}${esc(nameOf(r.id))}</label>`).join('');
  $$('#tr-sites input').forEach((i) => i.addEventListener('change', () => { if (i.checked) state.tradeSel.add(i.value); else state.tradeSel.delete(i.value); renderTrade(true); }));
  const ids = state.ranked.map((r) => r.id).filter((id) => state.tradeSel.has(id));
  if (ids.length < 2) { $('#tr-table').innerHTML = ''; $('#tr-out').innerHTML = '<span class="hint">Select at least two sites.</span>'; return; }
  const landing = Date.parse(($('#tr-landing').value || new Date(state.grid.start).toISOString().slice(0, 16)) + ':00Z');
  const days = Math.max(1, +$('#tr-days').value || stayDays());
  const prio = $('#tr-prio').value;
  const res = tradeoff(ids.map((id) => ({ id, a: state.results.get(id) })), state.grid, landing, days, PRIORITIES[prio].weight);
  state.trade = { ...res, landing, days, prio };
  $('#tr-table').innerHTML = `<thead><tr><th>${days}-day stay from ${utc(landing)}</th>${res.cols.map((c) => `<th class="num ${c.id === res.recommended ? 'rec' : ''}">${esc(nameOf(c.id))}${c.id === res.recommended ? ' ★' : ''}</th>`).join('')}</tr></thead>
    <tbody>${res.rows.map((r) => `<tr><td>${r.label}</td>${r.cells.map((c) => `<td class="num ${c.best ? 'best' : ''}">${c.text}</td>`).join('')}</tr>`).join('')}
    <tr><td>Survives the stay</td>${res.cols.map((c) => `<td class="num" style="color:var(${c.feasible ? '--go' : '--nogo'})">${c.feasible ? 'yes' : 'no — battery flat'}</td>`).join('')}</tr>
    <tr><td>Limiting constraint</td>${res.cols.map((c) => `<td style="white-space:normal;min-width:150px;font-size:12px">${esc(c.limiting.text)}</td>`).join('')}</tr></tbody>`;
  const change = withChange ? describeChange(state.tradePrev, res, nameOf) : null;
  const incomplete = res.cols.some((c) => !c.complete);
  $('#tr-out').innerHTML = `<div class="rec">Recommended: ${esc(siteOf(res.recommended).name)} (${PRIORITIES[prio].label.toLowerCase()})</div>
    <div>${esc(res.reason)}</div>
    ${change ? `<div class="diff ${change.changed ? 'flip' : ''}">${change.changed ? 'What changed: ' : ''}${esc(change.text)}</div>` : ''}
    ${incomplete ? '<div class="hint">Part of this stay falls outside the search period, so it is only partly evaluated. Extend the search period.</div>' : ''}
    <div class="actions"><button class="btn small" type="button" id="tr-show">Show ${esc(nameOf(res.recommended))} at this landing</button></div>`;
  $('#tr-show').addEventListener('click', () => { selectSite(res.recommended); setLanding(landing, res.recommended); setCursor(res.k0); $('#card-site').scrollIntoView({ behavior: 'smooth' }); });
  state.tradePrev = res;
}

// ------------------------------------------------------------------ confidence & stress tests
function scheduleStress() {
  const token = ++state.stressToken;
  $('#stress-body').innerHTML = '<tr><td colspan="5" class="hint">Running stress tests…</td></tr>';
  setTimeout(() => {
    if (token !== state.stressToken) return;
    const entries = state.sites.filter((s) => state.results.has(s.id)).map(entryFor);
    state.stress = stressTests(entries, state.grid, options(), weight(), state.results, decisionOpts());
    state.stress.weight = weight();
    renderConfidence(); renderVerdict();
  }, 60);
}

function renderConfidence() {
  const st = state.stress;
  const rec = state.rec; if (!rec) return;
  const a = state.results.get(rec.id), o = a.opts;
  const terrain = a.terrain === 'LOLA';
  const v = state.validation;
  const testsOk = v ? v.ok : null;
  const allHeld = st && st.held === st.total;
  const mcRec = state.mc?.get(rec.id);
  const mcOk = !mcRec || mcRec.rate >= 0.9;
  const level = !terrain ? 'LOW' : allHeld && testsOk !== false && mcOk ? 'HIGH' : mcRec && mcRec.rate < 0.5 ? 'LOW' : 'MEDIUM';
  const cb = $('#conf-badge');
  cb.className = `badge ${level === 'HIGH' ? 'go' : level === 'MEDIUM' ? 'caution' : 'nogo'}`;
  cb.textContent = `Confidence: ${level}${terrain ? '' : ' · smooth Moon'}`;
  const terrainMeta = state.horizonMeta;
  $('#conf-grid').innerHTML = `
    <div class="m"><h3>Modelled</h3><ul>
      <li>Sun and Earth positions every ${o.stepMin} min (validated against JPL Horizons)</li>
      <li>Lunar libration and the Moon's orientation (IAU 2009)</li>
      <li>Local skyline per 0.5° of azimuth, Sun as a disc</li>
      <li>Panel power from flux, incidence and visible disc</li>
      <li>Battery state of charge with efficiencies and two load modes</li>
      ${o.thermal.enabled ? '<li>Lander temperature and survival-heater power (lumped thermal model)</li>' : ''}
      <li>DSN visibility from Goldstone, Madrid, Canberra</li>
      ${state.horizonMeta?.tiles?.length ? '<li>Lander-scale slopes from NASA PGDA 5 m maps</li>' : ''}
      ${state.mc ? `<li>Survival under uncertainty: ${state.mcCfg?.iterations || 200} Monte Carlo scenarios per site</li>` : ''}</ul></div>
    <div class="a"><h3>Assumed (your inputs)</h3><ul>
      <li>${o.panel.areaM2} m² ${esc(PANELS[o.panel.type].label.toLowerCase())}, ${Math.round(o.panel.efficiency * 100)}% efficient</li>
      <li>Battery ${kwh(o.battery.capacityWh)} nominal, ${Math.round(o.battery.usableFraction * 100)}% usable, ${Math.round(o.battery.chargeEff * 100)}/${Math.round(o.battery.dischargeEff * 100)}% charge/discharge</li>
      <li>Loads ${o.battery.operatingLoadW} W in sunlight; ${o.thermal.enabled ? `${o.thermal.survivalElecW} W electronics + heaters holding ≥ ${o.thermal.minC} °C in the dark (heat capacity ${o.thermal.capacityKJperK} kJ/K, radiator ${o.thermal.radiatorM2} m², ε ${o.thermal.emissivity})` : `${o.battery.survivalLoadW} W in the dark (fixed)`}</li>
      <li>Panel and antenna ${o.observerHeightM} m above the ground</li>
      <li>Link needs Earth ≥ ${o.comms.minMarginDeg}° above the skyline${o.comms.requireDsn ? ` and a DSN station ≥ ${o.comms.dsnMinElDeg}°` : ''}</li>
      <li>${stayDays()}-day stay, battery full at touchdown</li></ul></div>
    <div class="n"><h3>Not modelled</h3><ul>
      <li>Boulders and slopes smaller than the map pixels (${state.horizonMeta?.tiles?.length ? '5 m near PGDA sites, ' : ''}${terrainMeta?.maps?.some((m) => m.includes('40m')) ? '40 m near the pole, ' : ''}240 m elsewhere)</li>
      <li>Shadows cast by the lander itself; dust on panels</li>
      <li>Battery temperature effects (ageing is sampled in the Monte Carlo)</li>
      <li>A detailed thermal design (the thermal model is one lumped mass)</li>
      <li>Antenna pointing, link budget, DSN scheduling</li>
      <li>Lunar eclipses (Earth blocking the Sun)</li>
      <li>Ground-truth site safety (hazard cameras, boulder counts)</li></ul></div>
    <div class="c"><h3>Confidence</h3><ul>
      <li>Terrain: ${terrain ? `LOLA horizon (${esc((terrainMeta?.maps || []).join(', ') || 'imported')})` : '<b>smooth-Moon fallback</b> — build LOLA terrain for real skylines'}</li>
      <li>Ephemeris: worst ${state.check ? fmt(Math.max(state.check.sun, state.check.earth) * 3600, 0) : '—'}″ vs JPL Horizons over ${state.check?.n ?? 16} points</li>
      <li>Automated tests: ${v ? `${v.javascript.pass + v.python.pass}/${v.javascript.tests + v.python.tests - v.python.skipped} passed (${day(Date.parse(v.generated))})` : 'report not generated'}</li>
      <li>Stress tests: ${st ? `${st.held} of ${st.total} keep ${esc(nameOf(st.base))} as the recommendation` : 'running…'}</li>
      <li>Monte Carlo: ${mcRec ? `${esc(nameOf(rec.id))} survives ${fmt(100 * mcRec.rate, 0)}% of ${mcRec.n} scenarios (95%: ${fmt(100 * mcRec.ci[0], 0)}–${fmt(100 * mcRec.ci[1], 0)}%)` : 'running…'}</li>
      <li>NASA illumination cross-check: ${state.xc?.summary?.sun ? `median ${fmt(state.xc.summary.sun.medianAbsPts, 1)} pts (sunlight), ${state.xc.summary.earth ? `${fmt(state.xc.summary.earth.medianAbsPts, 1)} pts (Earth)` : ''} over ${state.xc.summary.sun.n} sites` : state.horizonMeta?.illumination && Object.keys(state.horizonMeta.illumination).length ? 'running…' : 'maps not installed'}</li>
      <li>${allHeld ? '<span class="ok-word">Robust to the tested changes</span>' : st ? '<span class="flip-word">Sensitive: see the tests below</span>' : ''}</li></ul></div>`;
  if (!st) return;
  $('#stress-body').innerHTML = st.tests.map((t) => `<tr><td>${esc(t.label)}</td><td style="white-space:normal">${esc(t.detail)}</td><td>${swatch(t.winner)}${esc(nameOf(t.winner))}</td><td class="num">${fmt(t.margin, 1)}</td><td>${t.changed ? '<span class="flip-word">Winner changes</span>' : '<span class="ok-word">Same winner</span>'}</td></tr>`).join('');
  const te = $('#terrain-effect');
  if (st.smooth) {
    te.innerHTML = `<span class="section-title">What terrain changes (LOLA skyline vs smooth Moon)</span>
      <div class="table-wrap"><table><thead><tr><th>Site</th><th class="num">Sun up: smooth → terrain</th><th class="num">Earth link: smooth → terrain</th></tr></thead><tbody>
      ${state.ranked.filter((r) => state.results.get(r.id).terrain === 'LOLA').map((r) => { const t = state.results.get(r.id).metrics, sm = st.smooth.get(r.id)?.metrics; return sm ? `<tr><td>${esc(siteOf(r.id).name)}</td><td class="num">${fmt(sm.litPct, 0)}% → ${fmt(t.litPct, 0)}% (${signed(t.litPct - sm.litPct, 0)})</td><td class="num">${fmt(sm.commsPct, 0)}% → ${fmt(t.commsPct, 0)}% (${signed(t.commsPct - sm.commsPct, 0)})</td></tr>` : ''; }).join('')}
      </tbody></table></div>`;
  } else te.innerHTML = '<p class="hint">Terrain is not loaded, so every site uses a smooth Moon and the terrain comparison is unavailable. Run <code>python server.py --build-terrain</code> to download NASA LOLA maps and see how ridges and crater rims change the answer.</p>';
}

// ------------------------------------------------------------------ verification
async function loadValidation() {
  try {
    const r = await fetch('data/validation.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error();
    state.validation = await r.json();
  } catch { state.validation = null; }
  const v = state.validation;
  if (v) {
    const pass = v.javascript.pass + v.python.pass, total = v.javascript.tests + v.python.tests - v.python.skipped;
    setChip('#chip-tests', `Tests ${pass}/${total} passed`, v.ok ? 'ok' : 'err', `JavaScript ${v.javascript.pass}/${v.javascript.tests}, Python ${v.python.pass}/${v.python.tests - v.python.skipped} (${v.python.skipped} skipped) · ${v.generated}`);
  } else setChip('#chip-tests', 'Tests: not run', 'warn', 'Run python tools/validation_report.py');
  renderValidation();
}

function renderValidation() {
  const v = state.validation, c = state.check;
  const box = (k, val, d, ok) => `<div class="vstat" style="--status:var(${ok === true ? '--go' : ok === false ? '--nogo' : '--caution'})"><span class="k">${k}</span><span class="v">${val}</span><span class="d">${d}</span></div>`;
  const parts = [];
  if (c) parts.push(box('Ephemeris vs JPL Horizons', `±${Math.ceil(Math.max(c.sun, c.earth) * 3600)}″`, `Worst of ${c.n} reference positions, re-checked in your browser just now (Sun ${fmt(c.sun * 3600, 0)}″, Earth ${fmt(c.earth * 3600, 0)}″). 1″ = 1/3600°.`, Math.max(c.sun, c.earth) * 3600 < 60));
  if (v) {
    parts.push(box('JavaScript tests', v.javascript.ok === null ? 'not run' : `${v.javascript.pass}/${v.javascript.tests}`, v.javascript.note || 'Ephemeris, horizons, power, battery, windows, ranking, trade-offs, launch phase', v.javascript.ok));
    parts.push(box('Python tests', `${v.python.pass}/${v.python.tests - v.python.skipped}`, `Terrain ray-march on synthetic maps, map orientation, server${v.python.skipped ? `; ${v.python.skipped} skipped (need real data)` : ''}`, v.python.ok));
    const t = v.terrain;
    parts.push(box('LOLA terrain pipeline', t.built ? `${t.sites} sites` : 'not built', t.built ? `${(t.maps || []).join(', ')} · landmarks ${(t.orientationChecks || []).map((o) => `${o.landmarksMatched}/${o.landmarksTested}`).join(', ') || 'n/a'} · built ${String(t.generated).slice(0, 10)}` : 'Synthetic-map tests pass; build real terrain with python server.py --build-terrain', t.built ? true : null));
  } else parts.push(box('Automated tests', 'not run', 'Run python tools/validation_report.py to record the test results here', null));
  const xs = state.xc?.summary?.sun;
  if (xs) parts.push(box('Sunlight vs NASA maps', `${fmt(xs.medianAbsPts, 1)} pts`, `Median difference from Mazarico et al. (2011) 18.6-year average illumination over ${xs.n} sites (worst ${signed(xs.worstPts, 1)} at ${esc(nameOf(xs.worstId))}); measured in your browser just now.`, xs.medianAbsPts <= 5 ? true : xs.medianAbsPts <= 10 ? null : false));
  const tl = state.horizonMeta?.tiles || [];
  if (tl.length) parts.push(box('PGDA 5 m tiles', `${tl.filter((t) => t.calibration?.ok).length}/${tl.length} agree`, `Each tile checked against the LOLA grid: ${tl.map((t) => `${t.site} r=${fmt(t.calibration?.corr, 3)}, RMS ${fmt(t.calibration?.rmsM, 0)} m`).join('; ')}`, tl.every((t) => t.calibration?.ok)));
  $('#val-body').innerHTML = parts.join('') + (v ? `<p class="hint" style="grid-column:1/-1;margin:0">Test report generated ${esc(v.generated)} by tools/validation_report.py (re-run by CI on every change).</p>` : '');
}

async function verifyWithHorizons() {
  const s = siteOf(state.selId); if (!s) return;
  const out = $('#verify-out');
  out.textContent = 'Asking JPL Horizons…';
  const t0 = state.grid.start + state.k * state.grid.step;
  const start = new Date(t0).toISOString().slice(0, 16), stop = new Date(t0 + 2 * 86400000).toISOString().slice(0, 16);
  try {
    const worst = { sun: 0, earth: 0 };
    let n = 0;
    for (const [target, key] of [['10', 'sun'], ['399', 'earth']]) {
      const q = new URLSearchParams({ lat: s.lat, lon: s.lon, target, start, stop, step: '6h' });
      const r = await fetch(`api/horizons?${q}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      for (const row of j.rows) {
        const mine = skyAt({ lat: s.lat, lon: s.lon }, row.t)[key];
        const dAz = Math.abs(((mine.az - row.az + 540) % 360) - 180) * Math.cos((row.el * Math.PI) / 180);
        worst[key] = Math.max(worst[key], Math.hypot(mine.el - row.el, dAz)); n++;
      }
    }
    out.innerHTML = `<b style="color:var(--go)">Agrees with JPL Horizons:</b> worst difference Sun ${fmt(worst.sun * 3600, 0)}″, Earth ${fmt(worst.earth * 3600, 0)}″ over ${n} positions at ${esc(s.name)}.`;
  } catch (e) { out.textContent = `Live check unavailable (${e.message}). It needs the Clearway server and an internet connection; the built-in reference check above still applies.`; }
}

// ------------------------------------------------------------------ mission & phases (advanced)
function setLanding(t, siteId = state.selId) {
  state.landing = t; state.landingSite = siteId;
  updateTrace();
  state.calDay = Math.floor((Math.round((t - state.grid.start) / state.grid.step) * state.grid.step) / 86400000);
  $('#m-landing').value = new Date(t).toISOString().slice(0, 16);
  renderMission(); renderPhases();
  if (siteId === state.selId) renderCalendar();
}
function readLanding() { const v = $('#m-landing').value; if (v) { state.landing = Date.parse(v + ':00Z'); state.landingSite = state.selId; } }

function missionSettings() {
  return {
    park: +$('#x-park').value, tof: +$('#x-tof').value, llo: +$('#x-llo').value, lloDays: +$('#x-llo-days').value,
    budget: { tli: +$('#v-tli').value, loi: +$('#v-loi').value, desc: +$('#v-desc').value },
  };
}

function renderMission() {
  const ms = missionSettings();
  const moonDist = state.landing ? Math.hypot(...moonCentredBodies(state.landing - ms.lloDays * 86400000).earth) : 384400;
  state.transfer = lunarTransfer({ parkAltKm: ms.park, tofDays: ms.tof, lloAltKm: ms.llo, moonDistKm: moonDist });
  const tr = state.transfer;
  state.timeline = state.landing ? missionTimeline(state.landing, { parkHours: 1.5, tofDays: tr.tofDays, lloDays: ms.lloDays }) : null;
  const tl = state.timeline;
  if (state.landing) $('#m-landing').value = new Date(state.landing).toISOString().slice(0, 16);
  $('#x-out').innerHTML = [
    ['TLI Δv', `${fmt(tr.dv.tli, 3)} km/s`], ['LOI Δv', `${fmt(tr.dv.loi, 3)} km/s`], ['Descent Δv (est.)', `${fmt(tr.dv.descent, 2)} km/s`], ['Total', `${fmt(tr.dv.total, 2)} km/s`],
    ['Coast', `${fmt(tr.tofDays, 2)} d${tr.clamped ? ' (limited)' : ''}`], ['Moon distance', `${Math.round(moonDist).toLocaleString()} km`],
    ['Launch', tl ? utc(tl.launch) : '—'], ['Landing', tl ? utc(tl.landing) : '—'],
  ].map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  if (tl) {
    const q = new URLSearchParams({ launch: new Date(tl.launch).toISOString(), park: String(ms.park), name: $('#m-name').value, operator: $('#m-op').value, country: $('#m-country').value });
    $('#launch-link').href = `launch.html?${q}`;
  }
}

function phaseStatusDv(dv, budget) { return dv > budget ? 'nogo' : dv > budget * 0.97 ? 'caution' : 'go'; }

function renderPhases() {
  if (!state.grid) return;
  if (!state.transfer) renderMission();
  const tr = state.transfer, tl = state.timeline, ms = missionSettings();
  const siteId = state.landingSite || state.selId;
  const a = state.results.get(siteId);
  const site = siteOf(siteId);
  const launch = store.get('launch-result', null);
  const P = [];
  if (tl && tl.launch < Date.now()) {
    P.push({ id: 'launch', label: 'Launch', status: 'nogo', short: 'Launch time has passed', detail: `This landing needs a launch around ${utc(tl.launch)}, which is in the past. Pick a later landing window.` });
  } else if (launch && tl && Math.abs(launch.t0 - tl.launch) < 2 * 86400000) {
    const st = launch.overall === 'GO' ? 'go' : launch.overall === 'CAUTION' ? 'caution' : 'nogo';
    P.push({ id: 'launch', label: 'Launch', status: st, short: `${launch.overall} · ${utc(launch.t0).slice(5)}`, detail: `Launch planner: ${launch.overall} at ${utc(launch.t0)} (collision ${launch.collision}, weather ${launch.weather}).` });
  } else P.push({ id: 'launch', label: 'Launch', status: 'none', short: 'Not screened', detail: tl ? `Required launch about ${utc(tl.launch)}. Open the launch phase to screen it for debris, weather and airspace.` : 'Set a landing time first.' });
  P.push({ id: 'tli', label: 'Trans-lunar injection', status: phaseStatusDv(tr.dv.tli, ms.budget.tli), short: `${fmt(tr.dv.tli, 2)} / ${ms.budget.tli} km/s`, detail: `TLI needs ${fmt(tr.dv.tli, 3)} km/s from a ${ms.park} km parking orbit for a ${fmt(tr.tofDays, 2)}-day coast; budget ${ms.budget.tli} km/s.` });
  let coast = { status: 'none', short: 'Forecast not yet available', detail: 'NOAA forecasts geomagnetic activity 3 days ahead; this phase will be assessed closer to the date.' };
  if (tl && state.sw && state.sw.kpMax != null && tl.tli - Date.now() < 3 * 86400000 && tl.loi > Date.now()) {
    const k = state.sw.kpMax;
    coast = { status: k >= 7 ? 'nogo' : k >= 5 ? 'caution' : 'go', short: `Kp max ${fmt(k, 1)}`, detail: `Forecast geomagnetic activity during the coast: Kp up to ${fmt(k, 1)} (${state.sw.gMax}).` };
  }
  P.push({ id: 'coast', label: 'Coast', ...coast });
  P.push({ id: 'loi', label: 'Lunar orbit insertion', status: phaseStatusDv(tr.dv.loi, ms.budget.loi), short: `${fmt(tr.dv.loi, 2)} / ${ms.budget.loi} km/s`, detail: `Capture into a ${ms.llo} km orbit needs ${fmt(tr.dv.loi, 3)} km/s (arrival excess speed ${fmt(tr.vInf, 2)} km/s); budget ${ms.budget.loi} km/s.` });
  if (a && tl) {
    const k0 = Math.round((tl.landing - state.grid.start) / state.grid.step);
    if (k0 >= 0 && k0 < state.grid.n) {
      const sunM = a.sunEl[k0] - a.sunHz[k0], earthM = a.earthEl[k0] - a.earthHz[k0];
      const dvSt = phaseStatusDv(tr.dv.descent, ms.budget.desc);
      const lightSt = sunM >= 0.5 && earthM >= 0 ? 'go' : sunM >= 0 ? 'caution' : 'nogo';
      const st = [dvSt, lightSt].includes('nogo') ? 'nogo' : [dvSt, lightSt].includes('caution') ? 'caution' : 'go';
      P.push({ id: 'descent', label: 'Descent & landing', status: st, short: `Sun ${signed(sunM)}° · Earth ${signed(earthM)}°`, detail: `At touchdown (${utc(tl.landing)}) at ${site.name} the Sun is ${fmt(sunM, 2)}° and Earth ${fmt(earthM, 2)}° above the skyline. Descent Δv ${fmt(tr.dv.descent, 2)} km/s vs budget ${ms.budget.desc}.` });
      const w = windowAt(a, state.grid, k0, stayDays());
      const sst = !w.feasible ? 'nogo' : w.commsPct < 50 || !w.complete ? 'caution' : 'go';
      P.push({ id: 'surface', label: 'Surface operations', status: sst, short: `${fmt(w.litPct, 0)}% Sun · ${fmt(w.commsPct, 0)}% link`, detail: `${stayDays()}-day stay: Sun up ${fmt(w.litPct, 0)}%, Earth link ${fmt(w.commsPct, 0)}%, longest dark ${hrs(w.longestDarkH)}, battery ${w.feasible ? `survives (lowest ${fmt(w.minSocPct, 0)}% usable, margin ${kwh(Math.max(0, w.batteryMarginWh))})` : `runs flat for ${hrs(w.hoursWithoutPower)} (needs ${kwh(w.batteryNeededWh)})`}${w.complete ? '' : '; the stay runs past the analysed dates'}.` });
    } else {
      P.push({ id: 'descent', label: 'Descent & landing', status: 'none', short: 'Outside analysed dates', detail: 'The landing time is outside the analysed period. Change the dates in the Plan tab.' });
      P.push({ id: 'surface', label: 'Surface operations', status: 'none', short: 'Outside analysed dates', detail: 'The landing time is outside the analysed period.' });
    }
  } else {
    P.push({ id: 'descent', label: 'Descent & landing', status: 'none', short: 'Pick a landing', detail: 'Choose a landing window for the selected site.' });
    P.push({ id: 'surface', label: 'Surface operations', status: 'none', short: 'Pick a landing', detail: 'Choose a landing window for the selected site.' });
  }
  state.phases = P;
  const col = { go: '--go', caution: '--caution', nogo: '--nogo', none: '--nodata' };
  $('#phasebar').innerHTML = P.map((p) => `<button class="phase" type="button" data-p="${p.id}" style="--status:var(${col[p.status]})" title="${esc(p.detail)}"><b>${esc(p.label)}</b><span>${esc(p.short)}</span></button>`).join('');
  $$('#phasebar .phase').forEach((b) => b.addEventListener('click', () => openPhase(P.find((p) => p.id === b.dataset.p))));
}

function openPhase(p) {
  const word = { go: 'GO', caution: 'CAUTION', nogo: 'NO-GO', none: 'NOT ASSESSED' }[p.status];
  $('#phase-title').textContent = p.label;
  $('#phase-body').innerHTML = `<div class="pills"><span class="pill s-${word.replace(' ', '')}">${word}</span></div><p>${esc(p.detail)}</p>
    ${p.id === 'launch' ? `<div class="actions"><a class="btn primary" href="${$('#launch-link').href}">Open the launch phase</a></div><p class="hint">The launch planner screens the launch time against tracked space objects, site weather and airspace, then reports back here.</p>` : ''}
    ${['tli', 'loi'].includes(p.id) ? '<p class="hint">Planning-grade patched-conic estimate: coplanar transfer, no lunar gravity during the coast, no plane changes.</p>' : ''}`;
  $('#phase-dlg').showModal();
}

// ------------------------------------------------------------------ lineage, game, exports
/** Open About Clearway at a tab ('ab-founder', 'ab-data' or 'ab-how'). */
function openAbout(tab = 'ab-founder') {
  renderLineage();
  $('#ab-data').innerHTML = renderDataSources({ meta: state.horizonMeta, check: state.check, validation: state.validation, sw: state.sw });
  loadFounder();
  aboutTab(tab);
  if (tab === 'ab-ch3') renderCh3();
  if (!$('#lineage-dlg').open) $('#lineage-dlg').showModal();
}
function aboutTab(id) {
  if (id === 'ab-ch3') setTimeout(renderCh3, 0);
  $$('.about-tabs .tab').forEach((t) => { const on = t.getAttribute('aria-controls') === id; t.setAttribute('aria-selected', String(on)); $('#' + t.getAttribute('aria-controls')).hidden = !on; });
  $('.about-body').scrollTop = 0;
}
/** Founder page from web/about/about.md (edit in any text editor) and an optional web/about/photo.jpg. */
async function loadFounder() {
  const el = $('#ab-founder');
  if (state.founderHtml) { el.innerHTML = state.founderHtml; return; }
  el.innerHTML = '<p class="hint">Loading…</p>';
  let md = null;
  try { const r = await fetch('about/about.md', { cache: 'no-cache' }); if (r.ok) md = await r.text(); } catch { /* offline or file missing */ }
  const photo = await new Promise((res) => { const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = 'about/photo.jpg?' + Date.now(); });
  const a = md ? parseAboutMd(md) : null;
  const html = `<div class="founder">
      <div class="founder-head">
        ${photo ? `<img class="founder-photo" src="about/photo.jpg?${Date.now()}" alt="${esc(a?.name || 'Founder')}">` : '<img class="founder-photo logo" src="brand/logo-256.png" alt="Clearway logo">'}
        <div><span class="eyebrow">Founder</span><h3>${esc(a?.name || 'Clearway')}</h3>${a?.tagline ? `<p class="tagline">${a.tagline}</p>` : ''}</div>
      </div>
      ${a ? a.sections.map((x) => `<section>${x.title ? `<h4>${esc(x.title)}</h4>` : ''}${x.html}</section>`).join('') : '<p class="hint">Add a file named <code>about.md</code> to the <code>web/about</code> folder to show the founder page here.</p>'}
      <img class="founder-badge" src="brand/badge.jpg" alt="Clearway badge" loading="lazy">
    </div>`;
  if (md) state.founderHtml = html;
  el.innerHTML = html;
}

function renderLineage() {
  $('#lineage-body').innerHTML = `<p class="lead">Clearway answers one question: which landing site gives a lander the best chance of surviving its surface mission while keeping contact with Earth? Every site goes through the same chain, once per time step (hourly by default) over the whole search period.</p>
    <div style="display:grid;gap:8px"><span class="section-title">How a site is evaluated</span>
    <div class="flow">
      <div class="step"><b>Ephemeris</b>Sun and Moon positions, Moon orientation (once per time step)</div><span class="arrow">→</span>
      <div class="step"><b>Topocentric</b>Sun and Earth azimuth and elevation at the site</div><span class="arrow">→</span>
      <div class="step"><b>Horizon</b>Compare with the LOLA skyline at that azimuth; Sun as a disc</div><span class="arrow">→</span>
      <div class="step"><b>Power</b>Panel area × efficiency × solar flux × visible fraction × angle</div><span class="arrow">→</span>
      <div class="step"><b>Thermal</b>Lander temperature sets the survival-heater power</div><span class="arrow">→</span>
      <div class="step"><b>Battery</b>State of charge with efficiencies, operating and survival loads</div><span class="arrow">→</span>
      <div class="step"><b>Decide</b>Ranking, landing calendar, trade-offs, stress tests, Monte Carlo, brief</div>
    </div></div>
    <div class="how-modes">
      <div><b>Simple</b><p>Four questions about your lander and mission; one answer with a survival percentage and three reasons. It runs exactly the same engine as Planner.</p></div>
      <div><b>Planner</b><p>The full board: ranking, NASA south-pole map, horizon view, landing calendar, trade-offs, Monte Carlo, trust and verification, PDF brief.</p></div>
      <div><b>Explain</b><p>The Planner board with plain-language notes on every chart, for classrooms and the public.</p></div>
    </div>
    <p class="hint">Not modelled: boulders smaller than the map pixels, dust, radio link budgets and antenna pointing, and the exact descent trajectory. The survival percentage measures how fragile a plan is under the varied inputs — it is not a certified probability of mission success.</p>`;
}

let stopGame = null;
function openGame() {
  const siteId = state.landingSite || state.selId;
  const a = state.results.get(siteId), s = siteOf(siteId);
  renderMission();
  const tl = state.timeline;
  const ev = [];
  ev.push({ at: -540, title: 'Lunar orbit check', text: `Orbit determination confirms a ${missionSettings().llo} km lunar orbit. Navigation, propulsion and power report nominal.`, correct: ['GO'], why: 'All systems nominal: proceed toward powered descent.' });
  if (a && tl) {
    const k0 = Math.max(0, Math.min(state.grid.n - 1, Math.round((tl.landing - state.grid.start) / state.grid.step)));
    const sunM = a.sunEl[k0] - a.sunHz[k0], earthM = a.earthEl[k0] - a.earthHz[k0];
    ev.push({ at: -420, title: 'Landing site lighting', text: `At touchdown the Sun will be ${fmt(sunM, 1)}° above the skyline at ${s.name}${sunM < 0.5 ? ', so the site will be in shadow or partial shadow' : ''}.`, correct: sunM >= 0.5 ? ['GO'] : ['HOLD'], why: sunM >= 0.5 ? 'The landing area is lit: cameras and hazard avoidance can work and the panels charge immediately.' : 'Landing in shadow blinds the cameras and leaves the batteries draining: wait in orbit for better lighting.' });
    ev.push({ at: -300, title: 'Direct-to-Earth link', text: `Earth will be ${fmt(Math.abs(earthM), 1)}° ${earthM >= 0 ? 'above' : 'below'} the skyline at touchdown.`, correct: earthM >= 0 ? ['GO'] : ['HOLD', 'SCRUB'], why: earthM >= 0 ? 'Mission control can follow the descent live.' : 'Without line of sight to Earth the descent cannot be monitored and there is no confirmation of landing: hold for a pass with Earth in view.' });
    const w = windowAt(a, state.grid, k0, stayDays());
    ev.push({ at: -180, title: 'Power forecast', text: `Forecast for the ${stayDays()}-day stay: ${fmt(w.litPct, 0)}% sunlight, longest dark ${hrs(w.longestDarkH)}, battery ${w.feasible ? `bottoms out at ${fmt(w.minSocPct, 0)}% of usable capacity` : 'runs flat'}.`, correct: w.feasible ? ['GO'] : ['SCRUB'], why: w.feasible ? 'The battery carries the lander through every dark period.' : 'A flat battery means the lander freezes during the dark period: choose another date or site.' });
  }
  ev.push({ at: -60, title: 'Space weather', text: Math.random() < 0.4 ? 'NOAA reports an S2 solar radiation storm in progress; flight computers show two single-event upsets, both corrected.' : 'Quiet space weather; no solar particle events in progress.', correct: ['GO', 'HOLD'], why: 'Radiation storms can upset electronics. Corrected upsets are survivable; a short hold to confirm health is also reasonable.' });
  ev.push({ at: -10, title: 'Final descent poll', text: 'Flight director: all positions report GO for powered descent.', correct: ['GO'], why: 'Final poll is GO across the board.' });
  $('#game-dlg').showModal();
  stopGame?.();
  stopGame = startGame($('#game-body'), { mission: $('#m-name').value, subtitle: s ? `landing at ${s.name}${tl ? ` on ${day(tl.landing)}` : ''}` : 'practice landing', events: ev, successLabel: 'Touchdown' }, { onClose: () => { stopGame?.(); $('#game-dlg').close(); } });
}

function doExport(kind) {
  const a = state.results.get(state.selId), s = siteOf(state.selId);
  if (!a) { toast('Run a comparison first.'); return; }
  const g = state.grid, base = `clearway-${s.id}`;
  if (kind === 'csv') {
    const head = 'utc,sun_az_deg,sun_el_deg,skyline_at_sun_deg,sun_disc_visible,sun_above_smooth_horizon,earth_az_deg,earth_el_deg,skyline_at_earth_deg,earth_above_smooth_horizon,earth_terrain_clear,earth_link,dsn_max_el_deg,power_w,load_w,heater_w,lander_temp_c,battery_usable_wh';
    const rows = [head];
    for (let k = 0; k < g.n; k++) rows.push([new Date(g.start + k * g.step).toISOString(), a.sunAz[k].toFixed(3), a.sunEl[k].toFixed(4), a.sunHz[k].toFixed(3), a.sunFrac[k].toFixed(3), a.sunGeo[k], a.earthAz[k].toFixed(3), a.earthEl[k].toFixed(4), a.earthHz[k].toFixed(3), a.earthGeo[k], a.dte[k], a.comms[k], g.dsnMaxEl[k], a.power[k].toFixed(1), a.load[k].toFixed(1), a.heater[k].toFixed(1), Number.isFinite(a.temp[k]) ? a.temp[k].toFixed(1) : '', a.soc[k].toFixed(1)].join(','));
    download(`${base}-timeseries.csv`, rows.join('\n'), 'text/csv');
  } else if (kind === 'json') {
    download('clearway-site-comparison.json', JSON.stringify({
      generated: new Date().toISOString(), tool: 'Clearway Lunar Mission Browser', question: 'Which candidate landing site gives our lander the best chance of surviving its surface mission while maintaining contact with Earth?',
      start: new Date(g.start).toISOString(), days: (g.n * g.step) / 86400000, stepMin: g.step / 60000, stayDays: stayDays(), settings: options(), weight: weight(),
      recommendation: state.rec ? { site: state.rec.id, feasible: state.rec.feasible, landing: state.rec.decision ? new Date(state.rec.decision.landing).toISOString() : null, stay: state.rec.decision } : null,
      stressTests: state.stress ? { held: state.stress.held, total: state.stress.total, tests: state.stress.tests } : null,
      monteCarlo: state.mc ? { config: state.mcCfg, sites: Object.fromEntries([...state.mc].filter(([, v]) => v)) } : null,
      nasaCrossCheck: state.xc ? { reference: 'Mazarico et al. (2011), Icarus 211, 1066-1081 (NASA PGDA product 69)', summary: state.xc.summary, rows: state.xc.rows } : null,
      ephemerisCheck: state.check, validation: state.validation ? { generated: state.validation.generated, ok: state.validation.ok } : null, terrain: state.horizonMeta,
      sites: state.ranked.map((r, i) => { const x = state.results.get(r.id), st = siteOf(r.id), d = state.decisions.get(r.id), hz = state.horizons.get(r.id); return { rank: i + 1, id: r.id, name: st.name, lat: st.lat, lon: st.lon, source: st.source, terrain: terrainLabel(r.id), slope: hz?.slope || null, nasaReference: hz?.pgda || null, score: r.score, metrics: x.metrics, bestLanding: d ? { landing: new Date(d.landing).toISOString(), feasible: d.feasible, minSocPct: d.minSocPct, batteryNeededWh: d.batteryNeededWh, limiting: d.limiting.text } : null }; }),
    }, null, 2), 'application/json');
  } else if (kind === 'horizon') {
    download(`${base}-horizon.json`, JSON.stringify({ name: s.name, lat: s.lat, lon: s.lon, heightM: state.horizons.get(s.id)?.heightM ?? 0, ...a.horizon.toJSON() }), 'application/json');
  } else if (kind === 'brief') {
    readLanding(); renderMission(); renderPhases();
    const o = options();
    const rival = state.selId === state.rec?.id ? state.ranked.find((r) => r.id !== state.selId)?.id : state.rec?.id;
    const bytes = buildLunarBrief({
      mission: { name: $('#m-name').value, operator: $('#m-op').value, country: $('#m-country').value },
      ranked: state.ranked.map((r) => ({ site: siteOf(r.id), a: state.results.get(r.id), terrain: state.results.get(r.id).terrain, score: r.score, decision: state.decisions.get(r.id) })),
      sel: { site: s, a, horizon: a.horizon, terrain: a.terrain }, phases: advanced() ? state.phases : null, transfer: state.transfer, timeline: state.timeline,
      windows: state.windows, horizonMeta: state.horizonMeta, generatedAt: Date.now(), k: state.k, dailyData: state.daily.get(s.id), selfCheck: state.check,
      rec: state.rec ? { ...state.rec, site: siteOf(state.rec.id) } : null, why: whyForBrief(rival), rivalName: rival ? siteOf(rival).name : null,
      stress: state.stress, names: nameOf, validation: state.validation, trade: state.trade,
      mc: state.mc, mcCfg: state.mcCfg, xc: state.xc, safety: { slope: state.horizons.get(s.id)?.slope || null, pgda: state.horizons.get(s.id)?.pgda || null, tilt: num('#l-tilt', 10, 1, 45) }, thermal: o.thermal,
      settings: { days: +$('#d-days').value, stayDays: stayDays(), startText: $('#d-start').value, weight: weight(), budget: missionSettings().budget, battery: o.battery, comms: o.comms, panelText: `${o.panel.areaM2} sq m ${PANELS[o.panel.type].label.toLowerCase()} at ${Math.round(o.panel.efficiency * 100)}%` },
    });
    download(`${base}-site-mission-brief.pdf`, bytes, 'application/pdf');
  }
}

function whyForBrief(rival) {
  const x = explainSite(state.selId, state.results, rival);
  const d = state.decisions.get(state.selId);
  if (d) x.limiting = { ...d.limiting, text: `${d.limiting.text} (best ${stayDays()}-day stay, landing ${day(d.landing)}). Over the whole period: ${x.limiting.text.toLowerCase()}` };
  return x;
}


// ------------------------------------------------------------------ landing safety & resources (NASA PGDA)
function renderSafety() {
  const el = $('#safety'); const id = state.selId; if (!el || !id) return;
  const h = state.horizons.get(id), sl = h?.slope, pg = h?.pgda, s = siteOf(id);
  const tilt = num('#l-tilt', 10, 1, 45);
  const parts = [];
  if (sl) {
    const L = sl.lander;
    const pSafe = L ? slopeSafeProbability(L, tilt) : null;
    const st = L ? (pSafe >= 0.9 ? 'go' : pSafe >= 0.6 ? 'caution' : 'nogo') : sl.regionalDeg == null ? 'none' : sl.regionalDeg <= tilt ? 'caution' : 'nogo';
    parts.push(`<div class="sfx" style="--status:var(--${st === 'none' ? 'nodata' : st})"><h3>Slope &amp; tilt</h3>
      ${L ? `<p><b>${fmt(L.slopeDeg, 1)}°</b> at the site over ${L.baselineM} m (NASA PGDA 5 m map${L.pgdaSlopeDeg != null ? `; PGDA slope product ${fmt(L.pgdaSlopeDeg, 1)}°` : ''}${L.slopeErrDeg != null ? `, ±${fmt(L.slopeErrDeg, 1)}°` : ''}).</p>
      <p>Within ${L.radiusM} m: median ${fmt(L.p50, 1)}°, 90th percentile ${fmt(L.p90, 1)}°, steepest ${fmt(L.max, 1)}°. <b>${fmt(100 * pSafe, 0)}%</b> of the landing circle is below the ${fmt(tilt, 0)}° tilt limit.</p>
      ${L.heightErrM != null ? `<p class="hint">Map height uncertainty at the site ±${fmt(L.heightErrM, 1)} m (PGDA total error).</p>` : ''}`
      : `<p>Regional slope <b>${fmt(sl.regionalDeg, 1)}°</b> over ${fmt(sl.regionalBaselineM, 0)} m (LOLA grid). Lander-scale slopes need a 5 m map: ${state.horizonMeta?.tiles?.length ? 'this site is outside the downloaded PGDA 5 m tiles.' : 'run <code>python server.py --build-terrain --hires</code>.'}</p>`}
    </div>`);
  }
  if (pg?.psr) {
    const P = pg.psr;
    const ice = P.inside ? 'nogo' : P.nearestKm == null ? 'nodata' : P.nearestKm <= 5 ? 'go' : P.nearestKm <= 20 ? 'caution' : 'nodata';
    parts.push(`<div class="sfx" style="--status:var(--${ice})"><h3>Water-ice access</h3>
      <p>${P.inside ? '<b>The site is inside a permanently shadowed region</b> — no sunlight ever, so no solar power.' : P.nearestKm == null ? `No permanently shadowed region within ${P.searchKm} km.` : `Nearest permanently shadowed region (cold trap) <b>${fmt(P.nearestKm, 1)} km</b> away.`}</p>
      <p>Permanent shadow within 5 km: <b>${fmt(P.areaKm2Within5km, 1)} km²</b> · within 20 km: <b>${fmt(P.areaKm2Within20km, 0)} km²</b>.</p>
      <p class="hint">From Mazarico et al. (2011) permanent-shadow map (${esc(P.map || 'LPSR')}, ${fmt(P.pixelM, 0)} m/pixel).</p></div>`);
  }
  if (pg?.sun || pg?.earth) {
    const row = (k, lab) => pg[k] ? `<p>${lab}: <b>${fmt(100 * pg[k].value, 1)}%</b> <span class="hint">(${fmt(100 * pg[k].min, 1)}–${fmt(100 * pg[k].max, 1)}% within ±1 pixel)</span></p>` : '';
    const xr = state.xc?.rows.find((r) => r.id === id);
    parts.push(`<div class="sfx" style="--status:var(--fg)"><h3>NASA reference (18.6 years)</h3>
      ${row('sun', 'Average sunlight')}${row('earth', 'Earth visible')}
      ${xr ? `<p>Clearway, same definition and span: sunlight <b>${fmt(100 * xr.clearway.sun, 1)}%</b>${xr.sunDiff != null ? ` (${signed(100 * xr.sunDiff, 1)} pts)` : ''}, Earth <b>${fmt(100 * xr.clearway.earth, 1)}%</b>${xr.earthDiff != null ? ` (${signed(100 * xr.earthDiff, 1)} pts)` : ''}.</p>` : '<p class="hint">Clearway\'s 18.6-year comparison runs in the background (see "How much to trust this").</p>'}
      <p class="hint">Mazarico et al. 2011, LOLA polar illumination maps (NASA PGDA).</p></div>`);
  }
  el.innerHTML = parts.length ? `<span class="section-title">Landing safety &amp; resources at ${esc(s.short || s.name)} — NASA PGDA data</span><div class="safety-grid">${parts.join('')}</div>`
    : `<p class="hint">No slope or illumination maps for this site${isPolar(s) ? '. Run <code>python server.py --build-terrain</code> to add NASA\'s illumination and permanent-shadow maps' : ` (NASA polar maps cover ${Math.abs(terrainEdge())}°S–90°S)`}.</p>`;
}

// ------------------------------------------------------------------ south-pole map
function initMap() {
  const c = $('#pmap');
  $$('input[name="mapl"]').forEach((r) => r.addEventListener('change', () => { state.mapLayer = r.value; renderMap(); }));
  $('#map-psr').addEventListener('change', renderMap);
  const zoom = (f) => { if (!state.mapView) return; state.mapView.half = Math.max(1500, Math.min(state.polar?.rhoMaxM || 3e5, state.mapView.half * f)); renderMap(); };
  $('#map-zin').addEventListener('click', () => zoom(0.5));
  $('#map-zout').addEventListener('click', () => zoom(2));
  $('#map-all').addEventListener('click', () => { if (state.polar) { state.mapView = { cx: 0, cy: 0, half: state.polar.rhoMaxM }; renderMap(); } });
  $('#map-site').addEventListener('click', () => centreMapOn(state.selId, 25000));
  let drag = null;
  c.addEventListener('pointerdown', (e) => { if (!state.mapView) return; drag = { x: e.clientX, y: e.clientY, cx: state.mapView.cx, cy: state.mapView.cy, moved: false }; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    if (drag) {
      const s = Math.min(r.width, r.height) / (2 * state.mapView.half);
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { state.mapView.cx = drag.cx - dx / s; state.mapView.cy = drag.cy - dy / s; renderMap(); }
    }
    if (!state.mapHit) return;
    const [lat, lon] = state.mapHit.latlon(e.clientX - r.left, e.clientY - r.top);
    const sun = state.mapHit.sample('sun', lat, lon), psr = state.mapHit.sample('psr', lat, lon);
    $('#map-read').textContent = `${fmt(Math.abs(lat), 3)}°S, ${fmt(Math.abs(lon), 2)}°${lon < 0 ? 'W' : 'E'}${sun != null && sun > 0 ? ` · avg sunlight ≈ ${fmt(100 * sun ** (1 / 0.75), 0)}%` : ''}${psr != null && psr > 0.5 ? ' · permanently shadowed' : ''}`;
  });
  c.addEventListener('pointerup', (e) => {
    const was = drag; drag = null;
    if (!state.mapHit || (was && was.moved)) return;
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const id = state.mapHit.hit(x, y);
    if (id) { if (state.results.has(id)) selectSite(id); else toast('Tick the site in the list to include it.'); return; }
    const [lat, lon] = state.mapHit.latlon(x, y);
    if (lat > -75) return;
    state.mapCursor = { lat, lon }; renderMap();
    $('#c-lat').value = lat.toFixed(4); $('#c-lon').value = lon.toFixed(4); $('#c-name').value = '';
    const det = $('#c-add').closest('details'); if (det) det.open = true;
    toast(`Point ${fmt(Math.abs(lat), 3)}°S, ${fmt(Math.abs(lon), 2)}°${lon < 0 ? 'W' : 'E'} copied to "Add a site" — press Add site to compute its horizon.`, 6000);
    if (matchMedia('(max-width: 960px)').matches) openDrawer();
  });
  c.addEventListener('wheel', (e) => { if (!state.mapView || !e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom(e.deltaY > 0 ? 1.25 : 0.8); }, { passive: false });
}

function centreMapOn(id, half) {
  const s = siteOf(id); if (!s || !state.polar || s.lat > -79.5) return;
  const [X, Y] = toXY(s.lat, s.lon);
  state.mapView = { cx: X, cy: Y, half: half || state.mapView?.half || 25000 };
  renderMap();
}

function renderMap() {
  const card = $('#card-map'); if (!card) return;
  if (!state.polar) {
    card.querySelector('.map-wrap').hidden = true; card.querySelector('.map-tools').hidden = true;
    $('#map-hint').innerHTML = 'The NASA south-pole map is built with the terrain: run <code>python server.py --build-terrain</code> (LOLA terrain plus the Mazarico et al. illumination and permanent-shadow maps).';
    return;
  }
  card.querySelector('.map-wrap').hidden = false; card.querySelector('.map-tools').hidden = false;
  if (!state.mapView) state.mapView = { cx: 0, cy: 0, half: Math.min(state.polar.rhoMaxM, 190000) };
  $('input[name="mapl"][value="sun"]').disabled = !state.polar.layers.sun;
  $('#map-psr').disabled = !state.polar.layers.psr;
  state.mapHit = drawPolarMap($('#pmap'), state.polar, {
    layer: state.mapLayer, psr: $('#map-psr').checked && !!state.polar.layers.psr, view: state.mapView,
    sites: state.sites.filter((x) => x.on || state.results.has(x.id)), selected: state.selId, statusOf: statusOfSite, cursor: state.mapCursor,
  });
  const L = state.polar.layers;
  $('#map-hint').textContent = `${L[state.mapLayer]?.label || L.terrain.label}${$('#map-psr').checked && L.psr ? ' · hatched: permanent shadow' : ''} · ${fmt(state.polar.pixelM, 0)} m/pixel image. Site markers: ● survives the stay, ▲ battery runs flat, ■ no safe touchdown. Drag to pan; click empty ground to add a site there.`;
}

// ------------------------------------------------------------------ Monte Carlo
function mcConfig() {
  return {
    iterations: +$('#mc-n').value, seed: Math.max(1, Math.round(num('#mc-seed', 1, 1))), slipHours: num('#mc-slip', 12, 0, 240),
    skylineSigmaDeg: num('#mc-sky', 0.25, 0, 5), panelSigma: num('#mc-panel', 5, 0, 50) / 100, loadSigma: num('#mc-load', 10, 0, 50) / 100,
    survivalSigma: num('#mc-surv', 15, 0, 50) / 100, batteryFade: num('#mc-fade', 15, 0, 60) / 100, radiatorSigma: num('#mc-rad', 10, 0, 50) / 100,
    positionM: $('#mc-pos').checked ? 100 : 0, tiltLimitDeg: num('#l-tilt', 10, 1, 45),
  };
}

function scheduleMC(force = false) {
  if (!state.results.size) return;
  const token = ++state.mcToken;
  const cfg = mcConfig();
  const landings = new Map();
  for (const [id] of state.results) { const d = state.decisions.get(id); if (d) landings.set(id, d.k0); }
  const key = JSON.stringify([state.runId, stayDays(), cfg, [...landings]]);
  if (!force && key === state.mcKey && state.mc) return;
  $('#mc-status').textContent = 'Running…'; $('#mc-run').disabled = true;
  const entries = state.ranked.map((r) => entryFor(siteOf(r.id)));
  const t0 = performance.now();
  const partial = new Map();
  setTimeout(async () => {
    if (token !== state.mcToken) return;
    const res = await monteCarlo(entries, state.grid, options(), landings, stayDays(), cfg, {
      cancelled: () => token !== state.mcToken,
      onSite: (r, i, n) => { partial.set(r.id, r); $('#mc-status').textContent = `Running… ${i + 1}/${n} sites`; state.onMCProgress?.(i + 1, n); },
    });
    if (!res || token !== state.mcToken) return;
    state.mc = res; state.mcKey = key; state.mcCfg = cfg; state.mcRun = `${state.runId}|${stayDays()}`;
    $('#mc-run').disabled = false;
    $('#mc-status').textContent = `${cfg.iterations} scenarios × ${entries.length} sites in ${fmt((performance.now() - t0) / 1000, 1)} s · seed ${cfg.seed}`;
    const before = state.rec?.id;
    refreshDecisions(null); // the recommendation now also requires surviving the Monte Carlo
    if (before && state.rec && before !== state.rec.id) {
      state.changeNote = `Monte Carlo: ${nameOf(before)} survives only ${fmt(100 * (state.mc.get(before)?.rate ?? 0), 0)}% of the scenarios (${mcCause(before) || 'sampled uncertainties'}), so the recommendation moves to ${nameOf(state.rec.id)} (${fmt(100 * (state.mc.get(state.rec.id)?.rate ?? 0), 0)}%).`;
      renderVerdict();
    }
    renderMC(); renderConfidence();
    scheduleStress();
    const done = state.onMC; state.onMC = null; done?.();
  }, 80);
}

function renderMC() {
  const mc = state.mc; if (!mc) return;
  const cfg = state.mcCfg || mcConfig();
  const rows = state.ranked.map((r) => {
    const x = mc.get(r.id), d = state.decisions.get(r.id), s = siteOf(r.id);
    if (!x || !d) return `<tr><td>${swatch(r.id)}${esc(s.name)}</td><td colspan="5" class="hint">No touchdown with the Sun and Earth up in the search period.</td></tr>`;
    const st = x.rate >= 0.9 ? 'go' : x.rate >= 0.6 ? 'caution' : 'nogo';
    const bar = `<span class="mcbar"><i style="width:${(100 * x.rate).toFixed(1)}%;background:var(--${st})"></i><b style="left:${(100 * x.ci[0]).toFixed(1)}%;width:${(100 * (x.ci[1] - x.ci[0])).toFixed(1)}%"></b></span>`;
    return `<tr data-id="${r.id}"${r.id === state.rec?.id ? ' class="rec-row"' : ''}><td>${swatch(r.id)}${esc(s.name)}${r.id === state.rec?.id ? ' <span class="feas go">rec.</span>' : ''}</td><td class="num" style="text-align:left">${utc(d.landing)}</td>
      <td class="num"><b style="color:var(--${st})">${fmt(100 * x.rate, 0)}%</b> <span class="hint">${x.ok}/${x.n}</span></td><td>${bar} <span class="hint mono">${fmt(100 * x.ci[0], 0)}–${fmt(100 * x.ci[1], 0)}%</span></td>
      <td class="num" style="text-align:left">${x.fail.touchdown} · ${x.slopeP == null ? '<span class="hint" title="No 5 m slope map at this site">n/a</span>' : x.fail.slope} · ${x.fail.battery}</td><td class="num">${x.minSocP10 == null ? '—' : `${fmt(x.minSocP10, 0)}%`}</td></tr>`;
  });
  $('#mc-body').innerHTML = rows.join('');
  $$('#mc-body tr[data-id]').forEach((tr) => tr.addEventListener('click', () => selectSite(tr.dataset.id)));
  const rec = state.rec && mc.get(state.rec.id);
  $('#mc-badge').className = `badge ${rec ? (rec.rate >= 0.9 ? 'go' : rec.rate >= 0.6 ? 'caution' : 'nogo') : ''}`;
  $('#mc-badge').textContent = rec ? `Recommended site: ${fmt(100 * rec.rate, 0)}%` : 'Monte Carlo';
  const anyRing = [...mc.values()].some((x) => x && x.positions > 1);
  $('#mc-note').innerHTML = `Each site's best landing for a ${stayDays()}-day stay is replayed ${cfg.iterations} times. Varied: touchdown time ±${fmt(cfg.slipHours, 0)} h; ${anyRing && cfg.positionM ? 'touchdown point (site or one of 6 points 100 m away, each with its own LOLA horizon); ' : ''}skyline ±${cfg.skylineSigmaDeg}° (1σ); panel efficiency ±${fmt(100 * cfg.panelSigma, 0)}%; loads ±${fmt(100 * cfg.loadSigma, 0)}%; survival electronics ±${fmt(100 * cfg.survivalSigma, 0)}%; battery capacity up to −${fmt(100 * cfg.batteryFade, 0)}%${options().thermal.enabled ? `; radiator area ±${fmt(100 * cfg.radiatorSigma, 0)}%` : ''}; touchdown slope against the ${fmt(cfg.tiltLimitDeg, 0)}° tilt limit where a 5 m slope map exists.
    A scenario succeeds when the Sun and Earth are above the skyline at touchdown, the ground is within the tilt limit and the battery never runs flat. The percentage is the share of sampled scenarios that succeed (95% Wilson interval) — a measure of how fragile the plan is, <b>not</b> a calibrated probability of mission success.`;
}

// ------------------------------------------------------------------ cross-check with NASA illumination maps
function scheduleCrossCheck() {
  const entries = state.sites.filter((s) => state.horizons.get(s.id)?.pgda).map((s) => entryFor(s));
  const key = entries.map((e) => e.id).join(',');
  if (!entries.length) { renderCrossCheck(); return; }
  if (key === state.xcKey) return;
  const token = ++state.xcToken;
  state.xcKey = key;
  const run = async () => {
    if (token !== state.xcToken) return;
    $('#xcheck').innerHTML = '<p class="hint">Cross-checking with NASA\'s published illumination maps: computing 18.6 years of Sun and Earth positions…</p>';
    const t0 = performance.now();
    const res = await crossCheck(entries, { stepH: 1, onProgress: (i, n) => { if (token === state.xcToken) $('#xcheck').innerHTML = `<p class="hint">Cross-checking with NASA's published illumination maps… ${i}/${n} sites</p>`; } });
    if (token !== state.xcToken) return;
    state.xc = res; if (res) res.seconds = (performance.now() - t0) / 1000;
    renderCrossCheck(); renderSafety(); renderConfidence(); renderValidation();
  };
  (window.requestIdleCallback || ((f) => setTimeout(f, 400)))(() => run(), { timeout: 3000 });
}

function renderCrossCheck() {
  const el = $('#xcheck'); if (!el) return;
  const x = state.xc;
  if (!x) {
    if (!state.horizonMeta?.illumination || !Object.keys(state.horizonMeta.illumination).length) el.innerHTML = '<span class="section-title">Cross-check with NASA\'s illumination maps</span><p class="hint">Not available: the Mazarico et al. (2011) illumination maps are not installed. Run <code>python server.py --build-terrain</code> to download them; Clearway then recomputes the same 18.6-year averages and reports the difference.</p>';
    return;
  }
  const sm = x.summary;
  const cell = (v, ok) => (v == null ? '<td class="num">—</td>' : `<td class="num">${signed(100 * v, 1)}${ok ? ' <span class="hint" title="Within the published value\'s range across ±1 map pixel">✓</span>' : ''}</td>`);
  const pct = (v) => (v == null ? '—' : `${fmt(100 * v, 1)}%`);
  const verdict = (k) => { const q = sm[k]; if (!q) return ''; return `${k === 'sun' ? 'Average sunlight' : 'Earth visibility'}: median difference <b>${fmt(q.medianAbsPts, 1)}</b> percentage points over ${q.n} sites (mean bias ${signed(q.meanBiasPts, 1)}, worst ${signed(q.worstPts, 1)} at ${esc(nameOf(q.worstId))}); ${q.within5}/${q.n} within 5 points.`; };
  el.innerHTML = `<span class="section-title">Cross-check with NASA's published illumination maps (Mazarico et al. 2011)</span>
    <p class="hint">NASA's maps give, for every 120 m pixel, the average fraction of the Sun's disc that is visible and the fraction of time any part of Earth is visible, over an 18.6-year cycle. Clearway recomputed both with its own ephemeris and horizons over the same length of time (${x.steps.toLocaleString()} hourly steps from ${day(x.start)}, ${fmt(x.seconds, 1)} s in your browser). Differences are measured, not assumed.</p>
    <div class="table-wrap"><table class="xc"><thead><tr><th>Site</th><th class="num">Sunlight: NASA</th><th class="num">Clearway</th><th class="num">Diff. (pts)</th><th class="num">Earth: NASA</th><th class="num">Clearway</th><th class="num">Diff. (pts)</th></tr></thead><tbody>
    ${x.rows.map((r) => `<tr><td>${esc(nameOf(r.id))}${r.selectedOnMap ? ' <span class="hint" title="This point was chosen as the sunniest flat spot on NASA\'s map, so it is left out of the summary">†</span>' : ''}</td><td class="num">${pct(r.ref.sun?.value)}</td><td class="num" title="Fraction of the time any part of the Sun is visible: ${pct(r.clearway.sunAny)}">${pct(r.clearway.sun)}</td>${cell(r.sunDiff, r.sunWithinSpread)}<td class="num">${pct(r.ref.earth?.value)}</td><td class="num">${pct(r.clearway.earth)}</td>${cell(r.earthDiff, r.earthWithinSpread)}</tr>`).join('')}
    </tbody></table></div>
    <p>${verdict('sun')}<br>${verdict('earth')}</p>
    ${x.rows.some((r) => r.selectedOnMap) ? '<p class="hint">† Point chosen using NASA\'s sunlight map (sunniest flat spot in a 5 m tile): shown, but left out of the summary, because picking the brightest pixel biases the published value upwards.</p>' : ''}
    <p class="hint">Why they can differ: NASA's horizons come from finer LOLA grids and reach farther; Clearway's panel sits 2 m above the ground (seeing slightly further); the published value is for a whole pixel and can change across neighbouring pixels (✓ marks Clearway values inside that range); the 18.6-year spans need not start on the same date.</p>`;
}


// ------------------------------------------------------------------ Chandrayaan-3 analysis (About tab)
async function renderCh3() {
  const el = $('#ab-ch3'); if (!el) return;
  const hz = state.horizons.get('ch3');
  const horizon = hz?.horizon || Horizon.smooth(2);
  if (!state.ch3 || state.ch3.terrain !== horizon.terrain) {
    el.innerHTML = '<p class="hint">Computing the Sun and Earth over the Vikram site…</p>';
    await new Promise((r) => setTimeout(r, 30));
    state.ch3 = analyseLanding(horizon);
  }
  const r = state.ch3;
  let md = null;
  try { const q = await fetch('about/chandrayaan.md', { cache: 'no-cache' }); if (q.ok) md = await q.text(); } catch { /* optional */ }
  const mine = md ? parseAboutMd(md) : null;
  const dt = (t) => (t ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
  const dd = (h) => (h == null ? '—' : `${fmt(h / 24, 1)} days`);
  const ev = Object.fromEntries(CH3.events.map((e) => [e.key, e]));
  const td = r.touchdown, p = hz?.pgda;
  const sign = (h) => (h >= 0 ? `${fmt(h, 1)} h later` : `${fmt(-h, 1)} h earlier`);
  el.innerHTML = `<div class="ch3">
    <p class="lead">Chandrayaan-3's Vikram lander touched down on <b>23 August 2023</b> at ${Math.abs(CH3.site.lat).toFixed(2)}°S, ${CH3.site.lon.toFixed(2)}°E, about 600 km from the south pole. It was designed for one lunar day. Clearway recomputes the Sun and Earth over that exact spot ${r.terrain ? 'with NASA LOLA terrain' : '<b>on a smooth Moon</b> (the LOLA 60°S map is not installed: rebuild to add real terrain)'} and compares its predictions with ISRO's published timeline.</p>
    <div class="table-wrap"><table><thead><tr><th>Event</th><th>ISRO</th><th>Clearway (computed)</th></tr></thead><tbody>
      <tr><td>Touchdown</td><td>${ev.landing.detail}</td><td>Sun ${fmt(td.sunAboveSkylineDeg, 1)}° above the skyline (${fmt(100 * td.sunVisible, 0)}% of the disc); Earth ${fmt(td.earthAboveSkylineDeg, 1)}° above it — ${td.earthLink ? 'direct link available' : 'no direct link'}</td></tr>
      <tr><td>Local sunrise</td><td>Landing planned just after sunrise to use the whole lunar day</td><td>${dt(r.sunrise)} — ${dd(r.sunrise ? (CH3.landing - r.sunrise) / 3600000 : null)} before touchdown</td></tr>
      <tr><td>Design life</td><td>${CH3.designLife}</td><td>Daylight left after touchdown: <b>${dd(r.daylightAfterLandingH)}</b> (whole lunar day ${dd(r.daylightTotalH)}); highest Sun ${fmt(r.maxSunElDeg, 1)}°</td></tr>
      <tr><td>Lander asleep</td><td>${ev.lander.detail}</td><td>Local sunset ${dt(r.sunset)} — ${r.landerSleepBeforeSunsetH == null ? '—' : sign(r.landerSleepBeforeSunsetH)}</td></tr>
      <tr><td>Night</td><td>Not designed to survive it</td><td>Night lasts <b>${dd(r.nightH)}</b>. With Clearway's default thermal model (not Vikram's real design) surviving it would take about <b>${fmt(r.nightEnergyKWh, 0)} kWh</b> of stored energy</td></tr>
      <tr><td>Wake-up attempts</td><td>${ev.wake.detail}</td><td>Next local sunrise ${dt(r.nextSunrise)}${r.wakeAfterSunriseH == null ? '' : ` — attempts began ${sign(r.wakeAfterSunriseH).replace('later', 'after it').replace('earlier', 'before it')}`}</td></tr>
      <tr><td>Earth contact</td><td>Direct link and via Chandrayaan-2 orbiter</td><td>Earth in direct view ${fmt(r.earthLinkPctDaylight, 0)}% of the remaining daylight</td></tr>
      ${p?.sun ? `<tr><td>NASA long-term average</td><td>—</td><td>Mazarico et al. maps at this site: sunlight ${fmt(100 * p.sun.value, 0)}%, Earth visible ${p.earth ? fmt(100 * p.earth.value, 0) : '—'}% (18.6-year averages)</td></tr>` : ''}
    </tbody></table></div>
    <p class="hint">${horizon.terrain
      ? `Skyline: NASA LOLA terrain around the site (${esc((state.horizonMeta?.maps || []).filter((m) => /60s/i.test(m)).join(', ') || 'LOLA')}).`
      : 'Skyline: smooth Moon — the 60°S LOLA map is not installed, so hills around the site are ignored and sunrise and sunset may be off by some hours. Rebuild the terrain (delete web/data/horizons.json and run run.bat) to add it.'}</p>
    <span class="section-title">Sun and Earth over the Vikram site, with ISRO's timeline</span>
    <canvas id="ch3-strip" class="ch3-strip" aria-label="Sun visible and Earth link at the Vikram site, 20 August to 26 September 2023"></canvas>
    <div class="actions"><button class="btn small primary" type="button" id="ch3-open">Open this landing in Planner</button></div>
    ${mine ? mine.sections.map((x) => `<section class="ch3-mine">${x.title ? `<h4>${esc(x.title)}</h4>` : ''}${x.html}</section>`).join('') : ''}
    <p class="hint">Sources: site ${esc(CH3.siteSource)}; timeline from ISRO announcements (${CH3.events.map((e) => esc(e.source)).filter((v, i, a) => a.indexOf(v) === i).join('; ')}). Clearway's numbers are computed, not taken from ISRO. Your own analysis is read from <code>web/about/chandrayaan.md</code>.</p>
  </div>`;
  requestAnimationFrame(() => drawLandingStrip($('#ch3-strip'), r));
  $('#ch3-open').addEventListener('click', openCh3InPlanner);
}

function openCh3InPlanner() {
  const s = siteOf('ch3'); if (!s) { toast('The Chandrayaan-3 site is not in this build.'); return; }
  s.on = true;
  $('#d-start').value = '2023-08-20'; $('#m-days').value = '12'; $('#d-days').value = '90';
  $('#lineage-dlg').close();
  setMode('planner');
  state.onRun = () => {
    state.onRun = null;
    selectSite('ch3');
    const k = Math.round((CH3.landing - state.grid.start) / state.grid.step);
    setLanding(CH3.landing, 'ch3'); setCursor(k);
    $('#card-site').scrollIntoView({ behavior: 'smooth' });
    toast('Chandrayaan-3: historical analysis from 20 Aug 2023, landing set to 23 Aug 2023 12:33 UTC.', 6000);
  };
  renderSiteList();
  runComparison('ch3');
}

// ------------------------------------------------------------------ Simple mode
const ICONS = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/></g></svg>',
  earth: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  battery: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="7" width="17" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="20" y="10" width="2.5" height="4" rx="1" fill="currentColor"/><rect x="4.5" y="9.5" width="9" height="5" fill="currentColor"/></svg>',
};
const SIMPLE_STEPS = [
  ['eph', 'Sun and Earth positions, hour by hour'],
  ['terrain', 'Skylines from NASA LOLA terrain'],
  ['power', 'Power, heaters and battery through every dark spell'],
  ['mc', 'What-if landings with things going wrong (Monte Carlo)'],
];

function initSimple() {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  $('#s-start').value = d.toISOString().slice(0, 10);
  const saved = store.get('simple', null);
  if (saved) {
    const r = $(`input[name="s-preset"][value="${saved.preset}"]`); if (r) r.checked = true;
    const q = $(`input[name="s-prio"][value="${saved.priority}"]`); if (q) q.checked = true;
    if (saved.stayDays) $('#s-days').value = String(saved.stayDays);
    for (const [id, k] of [['#s-area', 'panelM2'], ['#s-eff', 'efficiencyPct'], ['#s-bat', 'batteryWh'], ['#s-load', 'loadW'], ['#s-elec', 'survivalElecW']]) if (saved.custom?.[k] != null) $(id).value = saved.custom[k];
  }
  const syncPreset = () => {
    const v = $('input[name="s-preset"]:checked').value;
    $('#s-custom').hidden = v !== 'custom';
    // show the example's numbers in the custom fields so "My own numbers" starts from something sensible
    if (v !== 'custom') { const p = LANDER_PRESETS[v]; $('#s-area').value = p.panelM2; $('#s-eff').value = p.efficiencyPct; $('#s-bat').value = p.batteryWh; $('#s-load').value = p.loadW; $('#s-elec').value = p.survivalElecW; }
  };
  $$('input[name="s-preset"]').forEach((r) => r.addEventListener('change', syncPreset));
  if (!saved || saved.preset !== 'custom') syncPreset(); else $('#s-custom').hidden = false;
  const syncDays = () => { const n = +$('#s-days').value; $('#s-days-out').textContent = `${n} day${n === 1 ? '' : 's'}`; };
  $('#s-days').addEventListener('input', syncDays); syncDays();
  $('#s-form').addEventListener('submit', (e) => { e.preventDefault(); runSimple(); });
}

function simpleAnswers() {
  return {
    preset: $('input[name="s-preset"]:checked').value,
    custom: { panelM2: +$('#s-area').value, efficiencyPct: +$('#s-eff').value, batteryWh: +$('#s-bat').value, loadW: +$('#s-load').value, survivalElecW: +$('#s-elec').value },
    start: $('#s-start').value || new Date().toISOString().slice(0, 10),
    stayDays: +$('#s-days').value,
    priority: $('input[name="s-prio"]:checked').value,
  };
}

function runSimple() {
  const ans = simpleAnswers();
  if (!state.sites.some((x) => x.on)) { toast('No candidate sites are ticked. Tick some in Planner → Plan.'); return; }
  store.set('simple', ans);
  const v = simpleToPlanner(ans);
  for (const [id, val] of Object.entries(v)) {
    if (!id.startsWith('#')) continue;
    const el = $(id); if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val; else el.value = String(val);
  }
  $('#p-az-wrap').hidden = $('#p-type').value !== 'vertical-fixed';
  const pr = $(`input[name="prio"][value="${v.prio}"]`); if (pr) pr.checked = true;
  $('#tr-prio').value = v.prio;
  updateWeightLabel(); syncThermal();
  $('#tr-days').value = String(stayDays());
  // progress
  $('#s-idle').hidden = true; $('#s-answer').hidden = true; $('#s-progress').hidden = false;
  $('#s-go').disabled = true;
  const active = state.sites.filter((s) => s.on).length;
  $('#s-steps').innerHTML = SIMPLE_STEPS.map(([k, t]) => `<li data-k="${k}" data-st="wait"><span class="dot"></span><span>${t}${k === 'terrain' ? ` · ${active} sites` : ''}</span><em></em></li>`).join('');
  const mark = (k, st, note = '') => { const li = $(`#s-steps li[data-k="${k}"]`); if (li) { li.dataset.st = st; li.querySelector('em').textContent = note; } };
  mark('eph', 'run');
  if (matchMedia('(max-width: 960px)').matches) $('#s-progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const t0 = performance.now();
  state.changeReason = null;
  state.onRun = () => {
    state.onRun = null;
    const dt = performance.now() - t0;
    mark('eph', 'done', `${state.grid.n.toLocaleString()} steps`);
    setTimeout(() => mark('terrain', 'done', `${[...state.results.values()].filter((a) => a.terrain === 'LOLA').length ? 'LOLA' : 'smooth Moon'}`), 250);
    setTimeout(() => { mark('power', 'done', `${fmt(dt / 1000, 1)} s`); mark('mc', 'run', ''); }, 500);
  };
  state.onMCProgress = (i, n) => mark('mc', 'run', `${i}/${n} sites`);
  state.onMC = () => {
    state.onMCProgress = null;
    mark('mc', 'done', `${state.mcCfg?.iterations ?? 200} per site`);
    setTimeout(() => { $('#s-go').disabled = false; renderSimpleAnswer(); }, 450);
  };
  runComparison();
}

function renderSimpleAnswer() {
  const rec = state.rec; const el = $('#s-answer');
  $('#s-progress').hidden = true; el.hidden = false;
  if (!rec) { el.innerHTML = '<p>No sites to compare. Tick at least one site in Planner.</p>'; return; }
  const s = siteOf(rec.id), d = rec.decision, a = state.results.get(rec.id), mc = state.mc?.get(rec.id);
  const band = survivalBand(mc?.rate), days = stayDays(), o = options();
  const link = d ? { ...stayData(a, state.grid, d.k0, d.k0 + Math.round((days * 86400000) / state.grid.step), o.radio), dishM: o.radio.dishM } : null;
  const reasons = simpleReasons(d, { stayDays: days, batteryWh: o.battery.capacityWh, link });
  const advice = simpleAdvice(d, { stayDays: days, reason: d ? null : noLandingReason(), searchDays: +$('#d-days').value });
  const when = d ? new Date(d.landing) : null;
  const dateText = when ? when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'No landing found';
  const ll = `${fmt(Math.abs(s.lat), 2)}°${s.lat < 0 ? 'S' : 'N'}, ${fmt(Math.abs(((s.lon + 540) % 360) - 180), 2)}°${((s.lon + 540) % 360) - 180 < 0 ? 'W' : 'E'}`;
  const runner = state.ranked.map((r) => r.id).filter((id) => id !== rec.id && state.decisions.get(id)?.feasible)
    .map((id) => ({ id, rate: state.mc?.get(id)?.rate ?? 0 })).sort((x, y) => y.rate - x.rate)[0];
  const pct = mc ? Math.round(100 * mc.rate) : null;
  const cause = mc && mc.rate < 0.95 ? simpleCause(rec.id) : '';
  const fragileAll = !!state.mc && [...state.mc.values()].every((x) => !x || x.rate < 0.6);
  const showMap = !!state.polar && s.lat <= -79.5;
  el.dataset.st = d?.feasible ? band.st : 'nogo';
  el.innerHTML = `
    <div class="s-ans-head">
      <div class="s-ans-title">
        <span class="eyebrow">${isHistorical() ? 'Historical analysis · ' : ''}${d?.feasible ? 'Your best landing site' : 'Closest option'}</span>
        <h2>${esc(s.name)}</h2>
        <p class="s-when">${when ? `Land on <b>${dateText}</b> at ${when.toISOString().slice(11, 16)} UTC` : dateText}</p>
        <p class="s-meta">${days}-day stay · ${ll}${a.terrain === 'LOLA' ? ` · ${terrainLabel(rec.id)} terrain` : ''}</p>
      </div>
      <div class="s-gauge" data-st="${d?.feasible ? band.st : 'nogo'}" style="--p:${pct ?? 0}" role="img" aria-label="${pct == null ? 'Not tested' : `Survives ${pct}% of what-if landings`}">
        <div><b>${pct == null ? '—' : pct + '%'}</b><small>survival</small></div>
      </div>
    </div>
    <p class="s-verdict">${mc ? `Survived <b>${mc.ok} of ${mc.n}</b> what-if landings — <b class="st">${d?.feasible ? band.word : 'Not survivable'}</b>.` : ''} ${esc(advice)}</p>
    ${cause ? `<p class="s-cause"><b>${mc.rate < 0.6 ? 'Main risk' : 'When it fails'}:</b> ${esc(cause)}.${mc.rate < 0.6 && fragileAll ? ' Every candidate site is fragile with these settings, so this is the most robust of them.' : ''}</p>` : ''}
    <ul class="s-reasons">${reasons.map((r) => `<li data-icon="${r.icon}"${r.warn ? ' data-warn="1"' : ''}><span class="ico">${ICONS[r.icon]}</span><div><b>${esc(r.title)}</b><p>${esc(r.text)}</p></div></li>`).join('')}</ul>
    ${showMap ? `<figure class="s-map"><canvas id="s-map" aria-label="NASA south-pole map around ${esc(s.name)}"></canvas><figcaption>${state.polar.layers.sun ? 'NASA average-sunlight map' : 'NASA LOLA terrain'} around the site · 60 km across · hatched: permanent shadow</figcaption></figure>` : ''}
    ${runner ? `<p class="s-runner">Next best: <b>${esc(nameOf(runner.id))}</b>${state.mc ? ` — survives ${Math.round(100 * runner.rate)}% of what-if landings` : ''}.</p>` : ''}
    ${a.terrain !== 'LOLA' ? '<p class="s-warn">NASA terrain is not installed on this computer, so this answer assumes a smooth Moon. Run run.bat (Windows) or run.sh to download it.</p>' : ''}
    <div class="actions s-actions">
      <button class="btn primary" type="button" id="s-full">See the full analysis</button>
      <button class="btn" type="button" id="s-pdf">Download the brief (PDF)</button>
      <button class="btn ghost" type="button" id="s-again">Change my lander</button>
    </div>
    <p class="hint">Planning aid built on public NASA data. The survival percentage shows how fragile the plan is when the landing time, spot, terrain, panels, loads and battery vary — not a certified probability. <a href="#" id="s-sources">Where the data comes from</a></p>`;
  $('#s-full').addEventListener('click', () => {
    setMode('planner'); selectSite(rec.id);
    if (d) { setLanding(d.landing, rec.id); setCursor(d.k0); }
    requestAnimationFrame(() => { redraw(); $('#verdict').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  });
  $('#s-pdf').addEventListener('click', () => { selectSite(rec.id); doExport('brief'); });
  $('#s-again').addEventListener('click', () => $('#s-form').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('#s-sources').addEventListener('click', (e) => { e.preventDefault(); openAbout('ab-data'); });
  requestAnimationFrame(drawSimpleMap);
  if (matchMedia('(max-width: 960px)').matches) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** The most common reason a site's what-if landings fail, in plain words. */
function simpleCause(id) {
  const x = state.mc?.get(id); if (!x) return '';
  const top = Object.entries(x.fail).sort((a, b) => b[1] - a[1])[0];
  if (!top || !top[1]) return '';
  const share = `${top[1]} of ${x.n} replays`;
  return {
    touchdown: `landing a few hours early or late, or a little off target, puts the Sun or Earth behind the terrain at touchdown (${share})`,
    slope: `the ground near the target is steeper than the lander's tilt limit (${share})`,
    battery: `the battery runs flat during a dark spell when panels, loads or battery are worse than planned (${share})`,
  }[top[0]] || '';
}

function drawSimpleMap() {
  const c = $('#s-map'); if (!c || !state.polar || !state.rec || $('#s-answer').hidden) return;
  const s = siteOf(state.rec.id); if (!s) return;
  const [X, Y] = toXY(s.lat, s.lon);
  drawPolarMap(c, state.polar, {
    layer: state.polar.layers.sun ? 'sun' : 'terrain', psr: !!state.polar.layers.psr, view: { cx: X, cy: Y, half: 30000 },
    sites: state.sites.filter((x) => state.results.has(x.id)), selected: s.id, statusOf: statusOfSite,
  });
}

function renderSimpleDataLine() {
  const m = state.horizonMeta;
  const il = m?.illumination && Object.keys(m.illumination).length;
  $('#s-data-line').innerHTML = m
    ? `Installed NASA data: LOLA terrain (${esc((m.maps || []).join(', '))})${m.tiles?.length ? `, ${m.tiles.length} high-resolution 5 m site maps` : ''}${il ? ', the Mazarico et al. sunlight and permanent-shadow maps' : ''}. <a href="#" data-about="ab-data">All data sources</a>`
    : 'NASA terrain is not installed yet, so Clearway will assume a smooth Moon. Run run.bat (Windows) or run.sh to download it. <a href="#" data-about="ab-data">Data sources</a>';
  $$('#s-data-line a[data-about]').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); openAbout(x.dataset.about); }));
}

async function loadPdfLogo() {
  try {
    const r = await fetch('brand/logo-pdf.jpg'); if (!r.ok) return;
    const b = new Uint8Array(await r.arrayBuffer());
    let str = ''; for (let i = 0; i < b.length; i += 8192) str += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    // read the JPEG size from its SOF marker
    let w = 0, h = 0;
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (mk >= 0xc0 && mk <= 0xc2) { h = (b[i + 5] << 8) | b[i + 6]; w = (b[i + 7] << 8) | b[i + 8]; break; }
      i += 2 + len;
    }
    if (w && h) setPdfLogo({ data: str, w, h });
  } catch { /* the brief is still produced, without the logo */ }
}

// ------------------------------------------------------------------ boot
async function boot() {
  initChrome();
  initControls();
  initSimple();
  loadPdfLogo();
  const c = selfCheck();
  state.check = c;
  const worst = Math.max(c.sun, c.earth) * 3600;
  setChip('#chip-eph', `Verified vs JPL ±${Math.ceil(worst)}″`, worst < 60 ? 'ok' : 'warn', `Sun and Earth positions match NASA JPL Horizons to ${Math.ceil(worst)} arc-seconds over ${c.n} reference positions (Sun ${fmt(c.sun * 3600, 0)}″, Earth ${fmt(c.earth * 3600, 0)}″)`);
  const [set, polar] = await Promise.all([loadHorizonSet(), loadPolarMap(), loadValidation()]);
  const moved = [];
  if (set) {
    for (const [id, v] of set.sites) {
      // a horizon built for different coordinates (an older build) would be wrong: leave that site on a smooth Moon
      const preset = siteOf(id);
      if (preset && v.builtAt && (Math.abs(preset.lat - v.builtAt.lat) > 0.005 || Math.abs((((preset.lon - v.builtAt.lon) + 540) % 360) - 180) > 0.05)) { moved.push(preset.short || preset.name); continue; }
      state.horizons.set(id, v);
      // sites added by the terrain build (centres of NASA PGDA 5 m tiles)
      if (v.info && !siteOf(id)) state.sites.push({ ...v.info, on: true });
    }
    state.horizonMeta = set.meta;
    const tiles = set.meta.tiles?.length || 0;
    setChip('#chip-terrain', `Terrain LOLA${tiles ? ' + 5 m' : ''} · ${set.sites.size} sites`, 'ok', `Horizons from ${(set.meta.maps || []).join(', ')}`);
    const il = set.meta.illumination || {};
    const nIl = Object.keys(il).length;
    const nSfs = (set.meta.tiles || []).filter((t) => /104/.test(t.product || '')).length;
    setChip('#chip-pgda', `NASA maps: ${[nIl ? 'illumination' : '', tiles - nSfs ? `${tiles - nSfs} × 5 m` : '', nSfs ? `${nSfs} × SfS` : ''].filter(Boolean).join(' + ') || 'none'}`, nIl ? 'ok' : 'warn',
      nIl ? `Mazarico et al. (2011) ${Object.values(il).map((x) => x.file).join(', ')}${tiles ? ` · 5 m maps ${set.meta.tiles.map((t) => `${t.site} (${t.product || 'PGDA 78'})`).join(', ')}` : ''}` : 'Run python server.py --build-terrain to add NASA PGDA illumination maps');
  } else {
    setChip('#chip-terrain', 'Terrain: smooth Moon', 'warn', 'No LOLA horizons installed. Run: python server.py --build-terrain');
    setChip('#chip-pgda', 'NASA maps: none', 'warn', 'Run python server.py --build-terrain');
  }
  state.polar = polar;
  if (set && moved.length) toast(`Terrain was built for older coordinates of ${moved.join(', ')}; ${moved.length > 1 ? 'they use' : 'it uses'} a smooth Moon until you rebuild (delete web\\data\\horizons.json and run run.bat).`, 12000);
  renderSiteList();
  renderValidation();
  renderSimpleDataLine();
  fetchSpaceWeather().then((sw) => { state.sw = sw; setChip('#chip-sw', `Kp ${fmt(sw.kp, 1)} · F10.7 ${fmt(sw.f107, 0)}`, sw.kpMax >= 5 ? 'warn' : 'ok'); renderPhases(); })
    .catch(() => setChip('#chip-sw', 'Space weather unavailable', 'err'));
  runComparison();
}

// any error that escapes a handler is shown, not silently swallowed (the console has the details)
let lastErr = 0;
const reportError = (msg) => { if (Date.now() - lastErr < 4000) return; lastErr = Date.now(); toast(`Something went wrong: ${msg}. The results on screen may be out of date; try Run again or reload the page.`, 10000); };
window.addEventListener('error', (e) => { if (e.error) reportError(e.message || 'unexpected error'); });
window.addEventListener('unhandledrejection', (e) => reportError(e.reason?.message || String(e.reason)));
boot().catch((e) => { console.error(e); toast(`Something went wrong: ${e.message}`, 10000); });
