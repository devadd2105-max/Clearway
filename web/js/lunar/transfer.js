// Clearway Lunar — planning-grade Earth–Moon transfer (patched conics).
//
// Translunar injection (TLI) from a circular parking orbit onto a coplanar ellipse that reaches the
// Moon's distance after the chosen time of flight; arrival excess speed relative to the Moon; lunar
// orbit insertion (LOI) into a circular low lunar orbit; and an estimate for powered descent.
// The Moon's gravity during the coast, plane changes and free-return design are not modelled.

export const MU_E = 398600.4418, MU_M = 4902.8001, R_E = 6378.137, R_M = 1737.4;

function tofToRadius(rp, e, r) {
  const a = rp / (1 - e);
  const cosE = (1 - r / a) / e;
  if (cosE < -1 || cosE > 1) return Infinity;
  const E = Math.acos(cosE);
  return (E - e * Math.sin(E)) * Math.sqrt((a * a * a) / MU_E);
}

/**
 * @param p {parkAltKm, tofDays, lloAltKm, moonDistKm}
 */
export function lunarTransfer({ parkAltKm = 185, tofDays = 4, lloAltKm = 100, moonDistKm = 384400, descentLoss = 0.1, landingMarginKms = 0.1 } = {}) {
  const rp = R_E + parkAltKm, rM = moonDistKm;
  const eMin = (rM - rp) / (rM + rp);
  const tofHohmann = tofToRadius(rp, eMin, rM);
  const tofMin = tofToRadius(rp, 0.99, rM);
  let tof = Math.min(Math.max(tofDays * 86400, tofMin), tofHohmann);
  let lo = eMin, hi = 0.99;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (tofToRadius(rp, mid, rM) > tof) lo = mid; else hi = mid; }
  const e = (lo + hi) / 2, a = rp / (1 - e);
  const vPark = Math.sqrt(MU_E / rp);
  const vTli = Math.sqrt(MU_E * (2 / rp - 1 / a));
  const v = Math.sqrt(MU_E * (2 / rM - 1 / a));
  const h = Math.sqrt(MU_E * a * (1 - e * e));
  const vt = h / rM, vr = Math.sqrt(Math.max(0, v * v - vt * vt));
  const vMoon = Math.sqrt((MU_E + MU_M) / rM);
  const vInf = Math.hypot(vt - vMoon, vr);
  const rLlo = R_M + lloAltKm;
  const vLlo = Math.sqrt(MU_M / rLlo);
  const loi = Math.sqrt(vInf * vInf + (2 * MU_M) / rLlo) - vLlo;
  const descent = vLlo * (1 + descentLoss) + landingMarginKms;
  return {
    tofDays: tof / 86400, tofHohmannDays: tofHohmann / 86400, tofMinDays: tofMin / 86400,
    eccentricity: e, apogeeKm: a * (1 + e) - R_E,
    dv: { tli: vTli - vPark, loi, descent, total: vTli - vPark + loi + descent },
    vInf, vLlo, clamped: Math.abs(tof - tofDays * 86400) > 1,
  };
}

/** Mission timeline working back from a landing time (ms). */
export function missionTimeline(landingMs, { parkHours = 1.5, tofDays = 4, lloDays = 1 } = {}) {
  const loi = landingMs - lloDays * 86400000;
  const tli = loi - tofDays * 86400000;
  const launch = tli - parkHours * 3600000;
  return { launch, tli, loi, landing: landingMs };
}
