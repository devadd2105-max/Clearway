// Clearway Lunar — Simple mode: a few questions about the lander and the mission, one answer.
//
// Simple mode drives the same engine as Planner: it writes its answers into the Planner inputs, runs
// the full comparison (ephemeris, LOLA horizons, power, thermal, battery) and the Monte Carlo, then
// summarises the recommendation in plain words. Nothing is computed differently.

/**
 * Example landers. These are ILLUSTRATIVE round numbers for a small, a medium and a rover-sized
 * vehicle — not the specifications of any real spacecraft. Teams should enter their own values.
 */
export const LANDER_PRESETS = {
  small: {
    label: 'Small lander', blurb: 'About the size of the first commercial landers',
    panelM2: 2, efficiencyPct: 28, batteryWh: 2000, loadW: 200, survivalElecW: 45, heatCapKJK: 240, radiatorM2: 0.9,
  },
  medium: {
    label: 'Medium lander', blurb: 'Bigger panels and battery, more payload power',
    panelM2: 4, efficiencyPct: 30, batteryWh: 6000, loadW: 400, survivalElecW: 80, heatCapKJK: 500, radiatorM2: 1.6,
  },
  rover: {
    label: 'Small rover', blurb: 'A light rover that drives in sunlight',
    panelM2: 1, efficiencyPct: 28, batteryWh: 1000, loadW: 100, survivalElecW: 25, heatCapKJK: 60, radiatorM2: 0.35,
  },
};

export const SIMPLE_PRIORITIES = {
  power: { label: 'More power', hint: 'Sunlight matters most', weight: 0.8 },
  balanced: { label: 'Balanced', hint: 'Sunlight and contact equally', weight: 0.5 },
  comms: { label: 'More contact', hint: 'Talking to Earth matters most', weight: 0.2 },
};

import { fmtRate, fmtBits } from './radio.js';

const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * Turn the Simple-mode answers into Planner input values (keyed by the Planner input ids).
 * answers: {preset, custom:{panelM2, efficiencyPct, batteryWh, loadW, survivalElecW}, start, stayDays, priority}
 */
export function simpleToPlanner(answers) {
  const base = LANDER_PRESETS[answers.preset] || LANDER_PRESETS.small;
  const c = answers.preset === 'custom' ? answers.custom || {} : {};
  const v = {
    panelM2: clamp(+c.panelM2, 0.1, 100, base.panelM2),
    efficiencyPct: clamp(+c.efficiencyPct, 1, 45, base.efficiencyPct),
    batteryWh: clamp(+c.batteryWh, 50, 1e6, base.batteryWh),
    loadW: clamp(+c.loadW, 0, 1e5, base.loadW),
    survivalElecW: clamp(+c.survivalElecW, 0, 1e4, base.survivalElecW),
  };
  // custom landers scale the thermal mass and radiator with the battery between the example sizes
  const scale = answers.preset === 'custom' ? Math.sqrt(v.batteryWh / LANDER_PRESETS.small.batteryWh) : 1;
  const prio = SIMPLE_PRIORITIES[answers.priority] ? answers.priority : 'balanced';
  return {
    '#p-type': 'vertical-tracking',
    '#p-area': v.panelM2,
    '#p-eff': v.efficiencyPct,
    '#b-cap': v.batteryWh,
    '#b-op': v.loadW,
    '#t-on': true,
    '#t-elec': v.survivalElecW,
    '#t-cap': answers.preset === 'custom' ? Math.round(clamp(base.heatCapKJK * scale, 20, 5000, 240)) : base.heatCapKJK,
    '#t-rad': answers.preset === 'custom' ? +clamp(base.radiatorM2 * scale, 0.1, 10, 0.9).toFixed(2) : base.radiatorM2,
    '#d-start': answers.start,
    '#m-days': Math.round(clamp(+answers.stayDays, 1, 120, 14)),
    '#w-slider': Math.round(SIMPLE_PRIORITIES[prio].weight * 100),
    prio,
  };
}

const f0 = (v) => (Number.isFinite(v) ? Math.round(v).toString() : '—');
const hrs = (h) => (h >= 72 ? `${(h / 24).toFixed(1)} days` : `${Math.round(h)} hours`);
const kwh = (wh) => `${(wh / 1000).toFixed(wh >= 10000 ? 0 : 1)} kWh`;

/** Survival band for a Monte Carlo rate. */
export function survivalBand(rate) {
  if (rate == null || !Number.isFinite(rate)) return { st: 'nodata', word: 'Not tested' };
  if (rate >= 0.9) return { st: 'go', word: 'Very robust' };
  if (rate >= 0.6) return { st: 'caution', word: 'Robust enough' };
  return { st: 'nogo', word: 'Fragile' };
}

/**
 * Three plain-language reasons for the recommended landing.
 * d: the stay decision (litPct, commsPct, longestDarkH, minSocPct, batteryNeededWh, batteryMarginWh, feasible)
 */
export function simpleReasons(d, { stayDays, batteryWh, link = null } = {}) {
  if (!d) return [];
  const out = [];
  out.push({
    icon: 'sun', title: `Sunlight ${f0(d.litPct)}% of the stay`,
    text: d.longestDarkH > 0.5
      ? `The Sun is above the surrounding terrain for ${f0(d.litPct)}% of your ${stayDays} days. The longest darkness lasts ${hrs(d.longestDarkH)}.`
      : `The Sun stays above the surrounding terrain for your whole ${stayDays}-day stay.`,
  });
  out.push({
    icon: 'earth', title: `Earth in view ${f0(d.commsPct)}% of the stay`,
    text: d.commsPct >= 99.5
      ? 'Earth never drops behind the terrain, so the lander can talk directly to Earth the whole time.'
      : `Earth is above the terrain — so the lander can radio home directly — for ${f0(d.commsPct)}% of the stay.`,
  });
  if (link && link.hours > 0) out.at(-1).text += ` At up to ${fmtRate(link.maxRateBps)} to a ${link.dishM ?? 34} m DSN dish, about ${fmtBits(link.bits)} of data could come home.`;
  out.push(d.feasible && d.longestDarkH <= 0.5
    ? {
      icon: 'battery', title: 'Battery stays full',
      text: `With no darkness during the stay, the panels cover the lander's power use the whole time${Number.isFinite(d.batteryMarginWh) && d.batteryMarginWh > 0 ? ` and the battery keeps ${kwh(d.batteryMarginWh)} in reserve` : ''}.`,
    }
    : d.feasible && d.minSocPct < 10
    ? {
      icon: 'battery', warn: true, title: `Battery nearly runs out — lowest ${f0(d.minSocPct)}%`,
      text: `The battery just makes it through the darkest spell, dropping to ${f0(d.minSocPct)}% of its usable charge. There is almost no margin: weaker panels, a colder night or an older battery could run it flat. A bigger battery or a shorter stay would add margin.`,
    }
    : d.feasible
    ? {
      icon: 'battery', title: `Battery never below ${f0(d.minSocPct)}%`,
      text: `Through every dark spell the battery keeps at least ${f0(d.minSocPct)}% of its usable charge${Number.isFinite(d.batteryMarginWh) && d.batteryMarginWh > 0 ? `, ${kwh(d.batteryMarginWh)} to spare` : ''}.`,
    }
    : {
      icon: 'battery', title: 'The battery runs flat',
      text: `Riding out the darkness would need about ${kwh(d.batteryNeededWh)} of usable battery${batteryWh ? ` — this lander carries ${kwh(batteryWh)}` : ''}. Try a bigger battery, a shorter stay or later dates.`,
    });
  return out;
}

/** Short hint for what to change when nothing survives. */
export function simpleAdvice(d, { stayDays, reason = null, searchDays = 180 } = {}) {
  if (!d && reason === 'past') return 'Every day searched is already in the past or too soon to reach the Moon. Choose a later earliest-landing date, or a date in the past to run a historical analysis.';
  if (!d && reason === 'short') return `The search period ends before a ${stayDays}-day stay could finish. Shorten the stay or start earlier.`;
  if (!d) return `No landing time in the ${searchDays} days searched has both the Sun and Earth above the terrain at touchdown. Try another start date.`;
  if (!d.feasible) return `No site survives a ${stayDays}-day stay with this lander. A shorter stay, a bigger battery or lower power use would help most.`;
  return '';
}
