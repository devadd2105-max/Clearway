// Clearway — propellant and lifetime trade-offs.
// Converts a Δv cost (a plane error after a late launch, or a collision-avoidance burn) into
// propellant, months of operational life and, optionally, revenue.

export const G0 = 9.80665;

/** Total Δv (m/s) a satellite's propellant provides (Tsiolkovsky). */
export const dvBudget = (wetKg, propKg, ispS) => (propKg > 0 && wetKg > propKg ? ispS * G0 * Math.log(wetKg / (wetKg - propKg)) : 0);

/** Propellant (kg) to deliver dv (m/s) from a given mass. */
export const propellantFor = (massKg, dv, ispS) => massKg * (1 - Math.exp(-dv / (ispS * G0)));

/**
 * @param p {wetKg, propKg, ispS, annualDv (m/s/yr), reserveDv (m/s, end-of-life disposal), extraDv (m/s), revenuePerMonth}
 */
export function lifetimeImpact(p) {
  const budget = dvBudget(p.wetKg, p.propKg, p.ispS);
  const usable = Math.max(0, budget - p.reserveDv);
  const life = p.annualDv > 0 ? usable / p.annualDv : Infinity;
  const lifeAfter = p.annualDv > 0 ? Math.max(0, usable - p.extraDv) / p.annualDv : Infinity;
  const monthsLost = Number.isFinite(life) ? (life - lifeAfter) * 12 : 0;
  return {
    budget, usable, lifeYears: life, lifeYearsAfter: lifeAfter, monthsLost,
    propUsedKg: propellantFor(p.wetKg, p.extraDv, p.ispS),
    revenueLost: p.revenuePerMonth ? monthsLost * p.revenuePerMonth : null,
    exceedsBudget: p.extraDv > usable,
  };
}
