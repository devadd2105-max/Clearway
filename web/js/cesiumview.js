// Clearway — CesiumJS 3-D globe (optional view).
// Same data as the canvas globe, drawn in Cesium's Earth-fixed frame: the catalog as a point
// cloud, the severity-coloured vehicle path, hazard areas, live aircraft, and 3-sigma
// covariance ellipsoids around the vehicle and the object at a selected close approach.
// Loaded on demand from the Cesium CDN (needs internet); no Cesium ion token is used: the
// base map is the Natural Earth II imagery bundled with CesiumJS.

import { gmst, eciToEcef } from './orbit.js';

const VERSION = '1.121';
const SOURCES = [
  `https://cesium.com/downloads/cesiumjs/releases/${VERSION}/Build/Cesium/`,
  `https://cdn.jsdelivr.net/npm/cesium@${VERSION}.0/Build/Cesium/`,
];

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(new Error(src)); }; document.head.appendChild(s); });
}

async function loadCesium() {
  if (window.Cesium) return window.Cesium;
  for (const base of SOURCES) {
    try {
      window.CESIUM_BASE_URL = base;
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'Widgets/widgets.css';
      document.head.appendChild(css);
      await loadScript(base + 'Cesium.js');
      if (window.Cesium) return window.Cesium;
    } catch { /* next source */ }
  }
  throw new Error('CesiumJS could not be loaded (internet connection needed for the 3-D view).');
}

/** Hamilton product a ⊗ b of [x,y,z,w] quaternions. */
export function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
/** Rotate an inertial-frame orientation into the Earth-fixed frame at sidereal angle theta. */
export const qEciToEcef = (q, theta) => qmul([0, 0, Math.sin(-theta / 2), Math.cos(-theta / 2)], q);

export class CesiumView {
  static async create(container, colors) {
    const Cesium = await loadCesium();
    const v = new CesiumView();
    v.C = Cesium; v.colors = colors;
    v.viewer = new Cesium.Viewer(container, {
      baseLayer: Cesium.ImageryLayer.fromProviderAsync(Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'))),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
    });
    const scene = v.viewer.scene;
    scene.globe.enableLighting = false;
    scene.backgroundColor = Cesium.Color.fromCssColorString(colors.oceanEdge || '#08111f');
    v.points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    v.lines = scene.primitives.add(new Cesium.PolylineCollection());
    v.marks = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    v.ds = new Cesium.CustomDataSource('clearway');
    v.viewer.dataSources.add(v.ds);
    v.scratch = new Cesium.Cartesian3();
    v.list = null; v.t = Date.now();
    return v;
  }

  col(name, alpha = 1) { return this.C.Color.fromCssColorString(this.colors[name] || '#ffffff').withAlpha(alpha); }
  km(p) { return new this.C.Cartesian3(p[0] * 1000, p[1] * 1000, p[2] * 1000); }
  render() { this.viewer.scene.requestRender(); }

  setObjects(list, ecef, visible, shell) {
    const C = this.C;
    if (this.list !== list) {
      this.points.removeAll();
      this.objPts = list.map((o) => this.points.add({ position: C.Cartesian3.ZERO, pixelSize: o.type === 'CREWED' ? 7 : 2.5, color: this.col(o.type) }));
      this.list = list;
    }
    for (let i = 0; i < list.length; i++) {
      const p = this.objPts[i], o = list[i], x = ecef?.[3 * i];
      const show = x === x && ecef && visible[o.type] && !(shell && (o.apogee < shell.lo || o.perigee > shell.hi));
      p.show = !!show;
      if (show) { this.scratch.x = x * 1000; this.scratch.y = ecef[3 * i + 1] * 1000; this.scratch.z = ecef[3 * i + 2] * 1000; p.position = this.scratch; }
    }
    this.render();
  }

  setOverlays(ov, displayTime) {
    const C = this.C;
    const th = gmst(displayTime);
    const toEcef = (p) => this.km(eciToEcef(p, th));
    this.lines.removeAll(); this.marks.removeAll(); this.ds.entities.removeAll();
    const sevCol = (s) => (s === 'red' ? this.col('red') : s === 'amber' ? this.col('amber') : this.col('path'));
    for (const seg of ov.pathSegments || []) {
      if (seg.pts.length < 2) continue;
      this.lines.add({ positions: seg.pts.map(toEcef), width: seg.future ? 1.5 : 3.5, material: C.Material.fromType('Color', { color: sevCol(seg.sev).withAlpha(seg.future ? 0.55 : 1) }) });
    }
    if (ov.groundTrack) this.lines.add({ positions: C.Cartesian3.fromDegreesArray(ov.groundTrack.flat()), width: 1.5, material: C.Material.fromType('Color', { color: this.col('track', 0.8) }) });
    for (const poly of ov.hazards || []) {
      this.ds.entities.add({ polygon: { hierarchy: C.Cartesian3.fromDegreesArray(poly.flat()), material: this.col('hazard', 0.3), outline: true, outlineColor: this.col('hazard'), height: 0 } });
    }
    if (ov.site) this.marks.add({ position: C.Cartesian3.fromDegrees(ov.site.lon, ov.site.lat, 0), pixelSize: 9, color: this.col('path'), outlineColor: C.Color.WHITE, outlineWidth: 1.5 });
    for (const a of ov.aircraft || []) this.marks.add({ position: C.Cartesian3.fromDegrees(a.lon, a.lat, a.altM || 0), pixelSize: 5, color: a.inside ? this.col('hazard') : this.col('muted') });
    if (ov.vehicleEci) {
      const vp = toEcef(ov.vehicleEci);
      this.marks.add({ position: vp, pixelSize: 10, color: sevCol(ov.vehicleStatus), outlineColor: C.Color.WHITE, outlineWidth: 2 });
      for (const o of ov.proximity || []) this.lines.add({ positions: [vp, this.km(o.ecef)], width: 1.5, material: C.Material.fromType('Color', { color: sevCol(o.sev) }) });
    }
    for (const e of ov.events || []) this.marks.add({ position: toEcef(e.posEci), pixelSize: e.highlight ? 12 : 7, color: C.Color.TRANSPARENT, outlineColor: sevCol(e.severity), outlineWidth: 2 });
    // covariance ellipsoids (3-sigma) at a selected approach
    for (const el of ov.ellipsoids || []) {
      const q = qEciToEcef(el.qEci, th);
      this.ds.entities.add({
        position: toEcef(el.posEci),
        orientation: new C.Quaternion(q[0], q[1], q[2], q[3]),
        ellipsoid: { radii: new C.Cartesian3(3000 * el.sig.r, 3000 * el.sig.i, 3000 * el.sig.c), material: (el.kind === 'vehicle' ? this.col('path') : this.col('red')).withAlpha(0.3), outline: true, outlineColor: el.kind === 'vehicle' ? this.col('path') : this.col('red'), slicePartitions: 24, stackPartitions: 16 },
      });
    }
    this.render();
  }

  flyTo(eciKm, displayTime, rangeKm = 60) {
    const C = this.C;
    const p = this.km(eciToEcef(eciKm, gmst(displayTime)));
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(p, rangeKm * 1000), { duration: 1.6 });
  }

  centerOn(lat, lon, heightKm = 18000) {
    this.viewer.camera.flyTo({ destination: this.C.Cartesian3.fromDegrees(lon, lat, heightKm * 1000), duration: 1.2 });
  }

  destroy() { try { this.viewer.destroy(); } catch { /* already gone */ } }
}
