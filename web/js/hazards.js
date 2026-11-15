// Clearway — launch hazard areas for airspace and maritime notices.
// Produces the ascent ground track, a corridor around it, and an approximate first-stage
// impact area, as GeoJSON the team can hand to the aviation authority (NOTAM) and the
// maritime authority (NAVAREA / local navigational warnings).

import { groundTrack, bearing, destination, surfaceDistanceKm } from './orbit.js';

export function computeHazards(traj, site, opts) {
  const { corridorHalfWidthKm = 25, stage1Km = 600, impactAlongKm = 75, impactCrossKm = 25 } = opts;
  const track = groundTrack(traj, 0, traj.tInsSec, 5).map(([lon, lat, alt]) => [lon, lat, alt]);
  const cum = [0];
  for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + surfaceDistanceKm(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0]));

  // corridor from the pad to just beyond the stage-1 impact point
  const corridorEnd = Math.min(cum.at(-1), stage1Km + impactAlongKm);
  const left = [], right = [];
  for (let i = 0; i < track.length && cum[i] <= corridorEnd; i++) {
    const j = Math.min(i + 1, track.length - 1), k = j === i ? i - 1 : i;
    const brg = j === i ? bearing(track[k][1], track[k][0], track[i][1], track[i][0]) : bearing(track[i][1], track[i][0], track[j][1], track[j][0]);
    left.push(destination(track[i][1], track[i][0], brg - 90, corridorHalfWidthKm));
    right.push(destination(track[i][1], track[i][0], brg + 90, corridorHalfWidthKm));
  }
  const corridor = left.length > 1 ? [...left, ...right.reverse(), left[0]] : null;

  // stage-1 impact ellipse centred on the track at the given downrange distance
  let impact = null, impactCenter = null;
  const idx = cum.findIndex((d) => d >= stage1Km);
  if (idx > 0) {
    const t = (stage1Km - cum[idx - 1]) / (cum[idx] - cum[idx - 1]);
    const lon = track[idx - 1][0] + t * (((track[idx][0] - track[idx - 1][0] + 540) % 360) - 180);
    const lat = track[idx - 1][1] + t * (track[idx][1] - track[idx - 1][1]);
    const brg = bearing(track[idx - 1][1], track[idx - 1][0], track[idx][1], track[idx][0]);
    impactCenter = [lon, lat];
    impact = [];
    for (let a = 0; a <= 360; a += 10) {
      const along = impactAlongKm * Math.cos(a * Math.PI / 180), cross = impactCrossKm * Math.sin(a * Math.PI / 180);
      const p = destination(lat, lon, brg, along);
      impact.push(destination(p[1], p[0], brg + 90, cross));
    }
  }
  return { track, trackLengthKm: cum.at(-1), corridor, impact, impactCenter, opts: { corridorHalfWidthKm, stage1Km, impactAlongKm, impactCrossKm } };
}

export function hazardsGeoJson(hz, meta) {
  const features = [
    { type: 'Feature', properties: { name: 'Ascent ground track', kind: 'track', ...meta }, geometry: { type: 'LineString', coordinates: hz.track.map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)]) } },
  ];
  if (hz.corridor) features.push({ type: 'Feature', properties: { name: 'Launch hazard corridor', kind: 'corridor', halfWidthKm: hz.opts.corridorHalfWidthKm, ...meta }, geometry: { type: 'Polygon', coordinates: [hz.corridor.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)])] } });
  if (hz.impact) features.push({ type: 'Feature', properties: { name: 'Stage 1 impact area (approximate)', kind: 'impact', downrangeKm: hz.opts.stage1Km, ...meta }, geometry: { type: 'Polygon', coordinates: [hz.impact.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)])] } });
  return { type: 'FeatureCollection', features };
}

/** Degrees-minutes text for notice drafting, e.g. 28°36.5'N 080°36.2'W */
export function dm(lat, lon) {
  const f = (v, pos, neg, w) => {
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return `${String(d).padStart(w, '0')}°${m.toFixed(1).padStart(4, '0')}'${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 'N', 'S', 2)} ${f(lon, 'E', 'W', 3)}`;
}
