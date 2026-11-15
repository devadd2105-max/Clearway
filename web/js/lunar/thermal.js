// Clearway Lunar — lumped thermal model for survival-heater power.
//
// The lander is one thermal mass C (J/K) at temperature T. Each time step:
//   C dT/dt = Q_sun + Q_elec + Q_heater − ε σ A_rad (T⁴ − T_sink⁴)
//   Q_sun    = α · A_sun · S · f · cos(el)   sunlight absorbed by the vertical sides (f = visible disc)
//   Q_elec   = the electrical load, all of which ends up as heat inside the lander
//   Q_heater = whatever extra power holds T at T_min when the lander would otherwise get colder
// Above T_max, louvres/radiators reject the excess at no electrical cost (T is capped).
//
// So a short shadow costs almost nothing (the lander rides it out on stored heat), while a long night
// first drains the stored heat and then needs the full steady-state heater power. That makes the energy
// needed to survive grow with the length of the darkness, rather than a fixed survival wattage.
// This is a planning-grade parametric model: every coefficient is an input, not a measured property.

export const SIGMA = 5.670374419e-8;

export const THERMAL_DEFAULTS = {
  enabled: false,          // the analysis library defaults to a fixed survival load; the app turns this on
  capacityKJperK: 240,     // heat capacity (≈ 300 kg of aluminium-like structure × 0.8 kJ/kg/K)
  radiatorM2: 0.9,         // effective radiating area
  emissivity: 0.8,
  sinkK: 100,              // effective sink temperature: cold sky plus polar regolith
  minC: -30,               // survival limit held by the heaters
  maxC: 30,                // louvres open above this
  survivalElecW: 45,       // avionics and receivers that stay on in the dark (excluding heaters)
  sunAreaM2: 1.5,          // side area facing the low Sun
  absorptivity: 0.3,       // white paint / MLI
  startC: 20,              // temperature at touchdown
};

export function resolveThermal(t = {}) { return { ...THERMAL_DEFAULTS, ...t }; }

/** Steady-state heater power (W) once the stored heat is gone, in darkness. */
export function steadyHeaterW(t) {
  const T = t.minC + 273.15;
  return Math.max(0, t.emissivity * SIGMA * t.radiatorM2 * (T ** 4 - t.sinkK ** 4) - t.survivalElecW);
}

/** Time (h) for a lander starting at startC to cool to minC in total darkness with only survivalElecW inside. */
export function coolDownHours(t, dtS = 600) {
  let T = t.startC + 273.15;
  const Tmin = t.minC + 273.15, C = t.capacityKJperK * 1000;
  const loss = (x) => t.emissivity * SIGMA * t.radiatorM2 * (x ** 4 - t.sinkK ** 4);
  if (loss(Tmin) <= t.survivalElecW) return Infinity; // the electronics alone keep it warmer than T_min
  let s = 0;
  while (T > Tmin && s < 90 * 86400) { T += ((t.survivalElecW - loss(T)) * dtS) / C; s += dtS; }
  return s / 3600;
}

/**
 * Advance the thermal state by dtS seconds. Returns {T, heaterW} (average heater power over the step).
 * qSunW: absorbed sunlight; elecW: electrical load dissipated inside (excluding the heater itself).
 */
export function thermalStep(T, dtS, qSunW, elecW, t) {
  const C = t.capacityKJperK * 1000;
  const Tmin = t.minC + 273.15, Tmax = t.maxC + 273.15;
  const n = Math.max(1, Math.ceil(dtS / 1800));
  const dt = dtS / n;
  let heat = 0;
  for (let i = 0; i < n; i++) {
    const net = qSunW + elecW - t.emissivity * SIGMA * t.radiatorM2 * (T ** 4 - t.sinkK ** 4);
    let Tn = T + (net * dt) / C;
    if (Tn < Tmin) { // heaters supply exactly what keeps the lander at T_min
      heat += Math.max(0, ((Tmin - T) * C) / dt - net);
      Tn = Tmin;
    }
    if (Tn > Tmax) Tn = Tmax;
    T = Tn;
  }
  return { T, heaterW: heat / n };
}
