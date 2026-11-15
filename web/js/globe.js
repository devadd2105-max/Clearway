// Clearway — dependency-free orthographic globe on a 2-D canvas.
// Draws coastlines, the tracked-object population, and mission overlays (orbit path,
// ground track, hazard areas, conjunction markers). All 3-D inputs are ECEF in km.

import { RE, DEG, eciToEcef, gmst } from './orbit.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Globe {
  constructor(canvas, { onHover, onSelect } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lon0 = -80 * DEG; this.lat0 = 25 * DEG; this.zoom = 0.82;
    this.land = [];            // [[Float64Array xyz unit vectors], ...]
    this.objects = [];         // catalog list
    this.ecef = null;          // Float32Array(3N)
    this.visible = { PAYLOAD: true, ROCKET_BODY: true, DEBRIS: true, CREWED: true };
    this.shell = null;         // {lo, hi} km filter
    this.overlays = {};        // { orbitEci:[...], groundTrack:[[lon,lat]], hazards:[[[lon,lat]...]], site:{lat,lon}, events:[{posEci, severity}], vehicleEci, selectedOrbit:[ecef] }
    this.displayTime = Date.now();
    this.selected = null;
    this.onHover = onHover; this.onSelect = onSelect;
    this.dirty = true;
    this.readColors();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = () => { if (this.dirty) { this.dirty = false; this.render(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  readColors() {
    this.c = {
      ocean: css('--globe-ocean'), oceanEdge: css('--globe-ocean-edge'), land: css('--globe-land'), coast: css('--globe-coast'),
      grid: css('--globe-grid'), PAYLOAD: css('--obj-payload'), ROCKET_BODY: css('--obj-rb'), DEBRIS: css('--obj-debris'),
      CREWED: css('--obj-crewed'), path: css('--accent'), track: css('--track'), hazard: css('--hazard'), red: css('--nogo'),
      amber: css('--caution'), text: css('--fg'), muted: css('--muted'), site: css('--fg'),
    };
    this.dirty = true;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.dirty = true;
  }

  setLand(topo) {
    this.land = decodeTopoLand(topo);
    this.dirty = true;
  }

  setObjects(list, ecef) { this.objects = list; this.ecef = ecef; this.dirty = true; }
  setOverlays(o) { this.overlays = { ...this.overlays, ...o }; this.dirty = true; }
  setDisplayTime(t) { this.displayTime = t; this.dirty = true; }
  centerOn(latDeg, lonDeg) { this.lat0 = latDeg * DEG; this.lon0 = lonDeg * DEG; this.dirty = true; }
  zoomBy(f) { this.zoom = Math.max(0.35, Math.min(80, this.zoom * f)); this.dirty = true; }

  // --- projection: returns [sx, sy, visible] for an ECEF point in km ---
  frame() {
    const R = Math.min(this.w, this.h) * 0.5 * this.zoom;
    return { R, cx: this.w / 2, cy: this.h / 2, cl: Math.cos(this.lon0), sl: Math.sin(this.lon0), cp: Math.cos(this.lat0), sp: Math.sin(this.lat0) };
  }
  project(f, x, y, z) {
    const ax = x * f.cl + y * f.sl, ay = -x * f.sl + y * f.cl;
    const X = ay, depth = ax * f.cp + z * f.sp, Y = -ax * f.sp + z * f.cp;
    const vis = depth > 0 || X * X + Y * Y > 1;
    return [f.cx + X * f.R, f.cy - Y * f.R, vis, X, Y, depth];
  }
  projectKm(f, p) { return this.project(f, p[0] / RE, p[1] / RE, p[2] / RE); }
  projectLatLon(f, lonDeg, latDeg, altKm = 0) {
    const la = latDeg * DEG, lo = lonDeg * DEG, r = 1 + altKm / RE;
    return this.project(f, r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la));
  }

  render() {
    const { ctx, dpr } = this;
    const f = this.frame();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    // ocean disk
    const g = ctx.createRadialGradient(f.cx - f.R * 0.3, f.cy - f.R * 0.35, f.R * 0.1, f.cx, f.cy, f.R);
    g.addColorStop(0, this.c.ocean); g.addColorStop(1, this.c.oceanEdge);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(f.cx, f.cy, f.R, 0, Math.PI * 2); ctx.fill();

    // graticule
    ctx.strokeStyle = this.c.grid; ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let lat = -60; lat <= 60; lat += 30) this.polyLatLon(f, Array.from({ length: 73 }, (_, i) => [i * 5 - 180, lat]), false);
    for (let lon = -180; lon < 180; lon += 30) this.polyLatLon(f, Array.from({ length: 37 }, (_, i) => [lon, i * 5 - 90]), false);
    ctx.stroke();

    // land
    if (this.land.length) {
      ctx.fillStyle = this.c.land; ctx.strokeStyle = this.c.coast; ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (const ring of this.land) this.ringClamped(f, ring);
      ctx.fill('evenodd'); ctx.stroke();
    }

    const theta = gmst(this.displayTime);
    const toEcef = (p) => eciToEcef(p, theta);

    // hazard areas & ground track (earth-fixed)
    const ov = this.overlays;
    if (ov.hazards) {
      ctx.fillStyle = this.c.hazard; ctx.strokeStyle = this.c.hazard; ctx.lineWidth = 1;
      for (const poly of ov.hazards) {
        ctx.globalAlpha = 0.28; ctx.beginPath(); this.polyLatLon(f, poly, true); ctx.fill();
        ctx.globalAlpha = 0.9; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (ov.groundTrack) {
      ctx.strokeStyle = this.c.track; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]);
      ctx.beginPath(); this.polyLatLon(f, ov.groundTrack, false); ctx.stroke(); ctx.setLineDash([]);
    }

    // object population
    if (this.ecef) {
      const n = this.objects.length;
      const sz = this.zoom > 2 ? 2.2 : 1.6;
      for (const type of ['DEBRIS', 'ROCKET_BODY', 'PAYLOAD', 'CREWED']) {
        if (!this.visible[type]) continue;
        ctx.fillStyle = this.c[type];
        const s = type === 'CREWED' ? 5 : sz;
        for (let i = 0; i < n; i++) {
          const o = this.objects[i];
          if (o.type !== type) continue;
          if (this.shell && (o.apogee < this.shell.lo || o.perigee > this.shell.hi)) continue;
          const x = this.ecef[3 * i];
          if (x !== x) continue;
          const pr = this.project(f, x / RE, this.ecef[3 * i + 1] / RE, this.ecef[3 * i + 2] / RE);
          if (!pr[2]) continue;
          ctx.fillRect(pr[0] - s / 2, pr[1] - s / 2, s, s);
        }
      }
    }

    // selected object's orbit
    if (ov.selectedOrbit) {
      ctx.strokeStyle = this.c.text; ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
      ctx.beginPath(); this.polyKm(f, ov.selectedOrbit); ctx.stroke(); ctx.globalAlpha = 1;
    }

    // vehicle path (inertial, shown at display time), coloured by screening severity
    if (ov.pathSegments) {
      for (const seg of ov.pathSegments) {
        ctx.strokeStyle = seg.sev === 'red' ? this.c.red : seg.sev === 'amber' ? this.c.amber : this.c.path;
        ctx.lineWidth = seg.future ? 1.4 : 3;
        ctx.globalAlpha = seg.future ? 0.55 : 1;
        ctx.beginPath(); this.polyKm(f, seg.pts.map(toEcef)); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (ov.orbitEci) {
      ctx.strokeStyle = this.c.path; ctx.lineWidth = 2.2;
      ctx.beginPath(); this.polyKm(f, ov.orbitEci.map(toEcef)); ctx.stroke();
    }

    // live aircraft (OpenSky)
    if (ov.aircraft) {
      for (const a of ov.aircraft) {
        const pr = this.projectLatLon(f, a.lon, a.lat, (a.altM || 0) / 1000);
        if (!pr[2] || pr[5] <= 0) continue;
        const h = ((a.track || 0) * Math.PI) / 180;
        ctx.save(); ctx.translate(pr[0], pr[1]); ctx.rotate(h);
        ctx.fillStyle = a.inside ? this.c.hazard : this.c.muted;
        ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(3.5, 4); ctx.lineTo(0, 2); ctx.lineTo(-3.5, 4); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }

    // conjunction markers
    if (ov.events) {
      for (const e of ov.events) {
        const pr = this.projectKm(f, toEcef(e.posEci));
        if (!pr[2]) continue;
        ctx.strokeStyle = e.severity === 'red' ? this.c.red : e.severity === 'amber' ? this.c.amber : this.c.muted;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(pr[0], pr[1], e.highlight ? 9 : 6, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // launch site
    if (ov.site) {
      const pr = this.projectLatLon(f, ov.site.lon, ov.site.lat);
      if (pr[2] && pr[5] > 0) {
        ctx.fillStyle = this.c.path; ctx.strokeStyle = this.c.oceanEdge; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(pr[0], pr[1] - 9); ctx.lineTo(pr[0] + 6, pr[1] + 5); ctx.lineTo(pr[0] - 6, pr[1] + 5); ctx.closePath();
        ctx.stroke(); ctx.fill();
      }
    }

    // vehicle, its screening sphere and the objects currently inside it
    if (ov.vehicleEci) {
      const pr = this.projectKm(f, toEcef(ov.vehicleEci));
      const col = ov.vehicleStatus === 'red' ? this.c.red : ov.vehicleStatus === 'amber' ? this.c.amber : this.c.path;
      if (ov.proximity) {
        ctx.lineWidth = 1.2;
        for (const o of ov.proximity) {
          const po = this.projectKm(f, o.ecef);
          ctx.strokeStyle = o.sev === 'red' ? this.c.red : o.sev === 'amber' ? this.c.amber : this.c.muted;
          ctx.beginPath(); ctx.moveTo(pr[0], pr[1]); ctx.lineTo(po[0], po[1]); ctx.stroke();
          ctx.beginPath(); ctx.arc(po[0], po[1], 3.5, 0, Math.PI * 2); ctx.stroke();
        }
      }
      if (pr[2]) {
        if (ov.sphereKm) {
          const rpx = (ov.sphereKm / RE) * f.R;
          ctx.strokeStyle = col; ctx.globalAlpha = 0.6; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(pr[0], pr[1], Math.max(9, rpx), 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
        ctx.fillStyle = col; ctx.strokeStyle = this.c.text; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(pr[0], pr[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }

    // selection ring
    if (this.selected != null && this.ecef) {
      const i = this.selected;
      const x = this.ecef[3 * i];
      if (x === x) {
        const pr = this.project(f, x / RE, this.ecef[3 * i + 1] / RE, this.ecef[3 * i + 2] / RE);
        if (pr[2]) { ctx.strokeStyle = this.c.text; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(pr[0], pr[1], 8, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
  }

  polyLatLon(f, pts, close) {
    let pen = false;
    for (const [lon, lat] of pts) {
      const pr = this.projectLatLon(f, lon, lat);
      if (pr[5] > 0) { if (pen) this.ctx.lineTo(pr[0], pr[1]); else this.ctx.moveTo(pr[0], pr[1]); pen = true; } else pen = false;
    }
    if (close && pen) this.ctx.closePath();
  }

  polyKm(f, pts) {
    let pen = false;
    for (const p of pts) {
      const pr = this.projectKm(f, p);
      if (pr[2]) { if (pen) this.ctx.lineTo(pr[0], pr[1]); else this.ctx.moveTo(pr[0], pr[1]); pen = true; } else pen = false;
    }
  }

  // Land rings: points behind the limb are pushed onto the limb so polygons fill correctly.
  ringClamped(f, ring) {
    const { ctx } = this;
    const prs = [];
    let any = false;
    for (let i = 0; i < ring.length; i += 3) {
      const pr = this.project(f, ring[i], ring[i + 1], ring[i + 2]);
      if (pr[5] >= 0) any = true;
      prs.push(pr);
    }
    if (!any) return;
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      let x = pr[0], y = pr[1];
      if (pr[5] < 0) {
        const L = Math.hypot(pr[3], pr[4]) || 1;
        x = f.cx + (pr[3] / L) * f.R; y = f.cy - (pr[4] / L) * f.R;
      }
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  pick(sx, sy, maxPx = 8) {
    if (!this.ecef) return null;
    const f = this.frame();
    let best = null, bd = maxPx * maxPx;
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (!this.visible[o.type]) continue;
      if (this.shell && (o.apogee < this.shell.lo || o.perigee > this.shell.hi)) continue;
      const x = this.ecef[3 * i]; if (x !== x) continue;
      const pr = this.project(f, x / RE, this.ecef[3 * i + 1] / RE, this.ecef[3 * i + 2] / RE);
      if (!pr[2]) continue;
      const d = (pr[0] - sx) ** 2 + (pr[1] - sy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  bind() {
    const cv = this.canvas;
    let drag = null, moved = false;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, lon: this.lon0, lat: this.lat0 }; moved = false; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        const k = 1 / (Math.min(this.w, this.h) * 0.5 * this.zoom);
        this.lon0 = drag.lon - dx * k;
        this.lat0 = Math.max(-1.45, Math.min(1.45, drag.lat + dy * k));
        this.dirty = true;
      } else if (this.onHover && !this._hoverPending) {
        this._hoverPending = true;
        requestAnimationFrame(() => {
          this._hoverPending = false;
          const i = this.pick(e.clientX - r.left, e.clientY - r.top);
          this.onHover(i, e.clientX - r.left, e.clientY - r.top);
        });
      }
    });
    cv.addEventListener('pointerup', (e) => {
      if (drag && !moved && this.onSelect) {
        const r = cv.getBoundingClientRect();
        this.onSelect(this.pick(e.clientX - r.left, e.clientY - r.top));
      }
      drag = null;
    });
    cv.addEventListener('pointerleave', () => this.onHover?.(null));
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    cv.addEventListener('keydown', (e) => {
      const step = 5 * DEG / this.zoom;
      if (e.key === 'ArrowLeft') this.lon0 -= step; else if (e.key === 'ArrowRight') this.lon0 += step;
      else if (e.key === 'ArrowUp') this.lat0 = Math.min(1.45, this.lat0 + step); else if (e.key === 'ArrowDown') this.lat0 = Math.max(-1.45, this.lat0 - step);
      else if (e.key === '+' || e.key === '=') this.zoomBy(1.2); else if (e.key === '-') this.zoomBy(1 / 1.2); else return;
      e.preventDefault(); this.dirty = true;
    });
  }
}

/** Decode the `land` object of a world-atlas TopoJSON file into rings of unit vectors. */
export function decodeTopoLand(topo) {
  const obj = topo.objects.land || Object.values(topo.objects)[0];
  const { scale, translate } = topo.transform || { scale: [1, 1], translate: [0, 0] };
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
  });
  const ringCoords = (ring) => {
    const pts = [];
    for (const ai of ring) {
      const a = ai < 0 ? arcs[~ai].slice().reverse() : arcs[ai];
      for (let k = pts.length ? 1 : 0; k < a.length; k++) pts.push(a[k]);
    }
    return pts;
  };
  const rings = [];
  const geoms = obj.type === 'GeometryCollection' ? obj.geometries : [obj];
  for (const gm of geoms) {
    const polys = gm.type === 'Polygon' ? [gm.arcs] : gm.type === 'MultiPolygon' ? gm.arcs : [];
    for (const poly of polys) for (const ring of poly) {
      const pts = ringCoords(ring);
      const v = new Float64Array(pts.length * 3);
      pts.forEach(([lon, lat], i) => {
        const la = lat * DEG, lo = lon * DEG;
        v[3 * i] = Math.cos(la) * Math.cos(lo); v[3 * i + 1] = Math.cos(la) * Math.sin(lo); v[3 * i + 2] = Math.sin(la);
      });
      rings.push(v);
    }
  }
  return rings;
}

/** Decode TopoJSON land into rings of [lon, lat] degrees (used for printed maps). */
export function decodeTopoLonLat(topo) {
  const obj = topo.objects.land || Object.values(topo.objects)[0];
  const { scale, translate } = topo.transform || { scale: [1, 1], translate: [0, 0] };
  const arcs = topo.arcs.map((arc) => { let x = 0, y = 0; return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; }); });
  const rings = [];
  const geoms = obj.type === 'GeometryCollection' ? obj.geometries : [obj];
  for (const gm of geoms) {
    const polys = gm.type === 'Polygon' ? [gm.arcs] : gm.type === 'MultiPolygon' ? gm.arcs : [];
    for (const poly of polys) for (const ring of poly) {
      const pts = [];
      for (const ai of ring) { const a = ai < 0 ? arcs[~ai].slice().reverse() : arcs[ai]; for (let k = pts.length ? 1 : 0; k < a.length; k++) pts.push(a[k]); }
      rings.push(pts);
    }
  }
  return rings;
}
