// Clearway — ground-test telemetry console.
// Reads the micro:bit flight logger (see firmware/) over USB using the Web Serial API,
// or runs a built-in simulator. Intended for sub-orbital tests: model rockets, sounding
// rocket payload mock-ups and high-altitude balloons. Orbital launch vehicles need
// flight-qualified telemetry and licensed spectrum, which this does not replace.
//
// Line format (one packet per line):  CW,<seq>,<ms>,<ax_mg>,<ay_mg>,<az_mg>,<temp_c>,<press_pa>[,<rssi>]

export function parseLine(line) {
  const p = line.trim().split(',');
  if (p[0] !== 'CW' || p.length < 8) return null;
  const n = p.slice(1).map(Number);
  if (n.slice(0, 7).some((v) => !Number.isFinite(v))) return null;
  return { seq: n[0], ms: n[1], ax: n[2] / 1000, ay: n[3] / 1000, az: n[4] / 1000, temp: n[5], press: n[6], rssi: Number.isFinite(n[7]) ? n[7] : null };
}

export const pressureAltitude = (p, p0) => 44330 * (1 - Math.pow(p / p0, 1 / 5.255));

/** ISA air density (kg/m^3) in the troposphere, altitude above sea level in metres. */
export const airDensity = (hM) => 1.225 * Math.pow(Math.max(0, 1 - 2.25577e-5 * Math.max(0, hM)), 4.2559);

/** Dynamic pressure q = 1/2 rho v^2 (Pa). */
export const dynamicPressure = (hM, vMs) => 0.5 * airDensity(hM) * vMs * vMs;

export class Telemetry {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.events = [];
    this.p0 = null; this._p0acc = [];
    this.lastSeq = null; this.lost = 0; this.received = 0;
    this.state = 'PAD';
    this.maxAlt = 0; this.maxG = 0; this._vs = 0; this.maxQ = 0; this.maxQAt = null; this.siteAltM = 0;
    this.t0 = null;
  }

  get status() { return this.port ? 'serial' : this.es ? 'relay' : this.simTimer ? 'sim' : 'idle'; }

  ingest(pkt) {
    if (this.lastSeq != null && pkt.seq > this.lastSeq + 1) this.lost += pkt.seq - this.lastSeq - 1;
    this.lastSeq = pkt.seq; this.received++;
    if (this.t0 == null) this.t0 = pkt.ms;
    const t = (pkt.ms - this.t0) / 1000;
    if (pkt.press > 0 && this.p0 == null) {
      this._p0acc.push(pkt.press);
      if (this._p0acc.length >= 20) this.p0 = this._p0acc.reduce((a, b) => a + b) / this._p0acc.length;
    }
    const alt = pkt.press > 0 && this.p0 ? pressureAltitude(pkt.press, this.p0) : null;
    const g = Math.hypot(pkt.ax, pkt.ay, pkt.az);
    const prev = this.samples.at(-1);
    if (prev && alt != null && prev.alt != null && t > prev.t) {
      const raw = (alt - prev.alt) / (t - prev.t);
      this._vs += (raw - this._vs) * 0.25;
    }
    const v = Math.abs(this._vs);
    const q = alt != null ? dynamicPressure(this.siteAltM + alt, v) : null;
    const s = { t, alt, g, vs: this._vs, v, q, temp: pkt.temp, press: pkt.press, rssi: pkt.rssi };
    if (q != null && q > this.maxQ && this._vs > 0) { this.maxQ = q; this.maxQAt = { t, alt }; }
    this.samples.push(s);
    if (this.samples.length > 20000) this.samples.shift();
    if (alt != null) this.maxAlt = Math.max(this.maxAlt, alt);
    this.maxG = Math.max(this.maxG, g);
    this.detect(s);
    this.onUpdate?.(this);
  }

  detect(s) {
    const mark = (name) => { this.events.push({ name, t: s.t, alt: s.alt }); this.state = name.toUpperCase(); };
    const recent = this.samples.slice(-4);
    if (this.state === 'PAD' && recent.length === 4 && recent.every((x) => x.g > 2.5)) mark('Liftoff');
    else if (this.state === 'LIFTOFF' && s.g < 1.3) { if (this.maxQAt) this.events.push({ name: `Max-Q ${this.maxQ.toFixed(0)} Pa`, t: this.maxQAt.t, alt: this.maxQAt.alt }); mark('Burnout'); }
    else if ((this.state === 'BURNOUT' || this.state === 'LIFTOFF') && s.alt != null && s.vs < -1 && this.maxAlt - s.alt > 2) mark('Apogee');
    else if (this.state === 'APOGEE' && s.alt != null && s.alt < 8 && Math.abs(s.vs) < 1.5) mark('Landed');
  }

  zero() { if (this.samples.length) { this._p0acc = []; this.p0 = null; } }

  async connectSerial() {
    if (!('serial' in navigator)) throw new Error('This browser has no Web Serial support. Use Chrome or Edge on desktop.');
    this.stop();
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.reset();
    const decoder = new TextDecoderStream();
    this._pipe = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += value;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const pkt = parseLine(buf.slice(0, nl)); buf = buf.slice(nl + 1);
            if (pkt) this.ingest(pkt);
          }
        }
      } catch { /* port closed */ }
    })();
    this.onUpdate?.(this);
  }

  /** Network relay: server.py --serial PORT pushes packets as server-sent events (any browser, any device). */
  connectRelay(url = 'api/telemetry/stream') {
    this.stop();
    this.reset();
    this.es = new EventSource(url);
    this.es.onmessage = (e) => { const pkt = parseLine(e.data); if (pkt) this.ingest(pkt); };
    this.es.onerror = () => { this.relayError = true; this.onUpdate?.(this); };
    this.es.onopen = () => { this.relayError = false; this.onUpdate?.(this); };
    this.onUpdate?.(this);
  }

  async stop() {
    clearInterval(this.simTimer); this.simTimer = null;
    if (this.es) { this.es.close(); this.es = null; }
    if (this.reader) { try { await this.reader.cancel(); } catch {} this.reader = null; }
    if (this.port) { try { await this._pipe; await this.port.close(); } catch {} this.port = null; }
    this.onUpdate?.(this);
  }

  startSim() {
    this.stop();
    this.reset();
    const p0 = 101325, hz = 20;
    let seq = 0, t = -3, h = 0, v = 0;
    this.simTimer = setInterval(() => {
      const dt = 1 / hz; t += dt;
      let a = 0; // vertical acceleration (m/s^2) excluding gravity reaction
      if (t > 0 && t < 1.6) a = 58 - 9.81;          // motor burn
      else if (t >= 1.6) a = -9.81 - 0.0025 * v * Math.abs(v); // coast with drag
      if (h > 0 || a > 0) { v += a * dt; h = Math.max(0, h + v * dt); }
      if (t > 1.6 && v < 0 && h > 0) v = Math.max(v, -5.5);   // parachute
      if (h === 0 && t > 2) v = 0;
      const gLoad = h > 0 || t < 1.6 && t > 0 ? (a + 9.81) / 9.81 : 1;
      const noise = () => (Math.random() - 0.5) * 0.04;
      const press = p0 * Math.pow(1 - h / 44330, 5.255) + (Math.random() - 0.5) * 6;
      const pkt = { seq: seq++, ms: Math.round((t + 3) * 1000), ax: noise(), ay: noise(), az: Math.max(0, gLoad) + noise(), temp: 21 - h * 0.0065, press, rssi: -40 - Math.round(h / 20) };
      this.ingest(pkt);
      if (t > 90) this.stop();
    }, 1000 / hz);
    this.onUpdate?.(this);
  }

  toCsv() {
    const head = 't_s,alt_m,vs_ms,accel_g,q_pa,temp_c,press_pa,rssi';
    return [head, ...this.samples.map((s) => [s.t.toFixed(3), s.alt?.toFixed(2) ?? '', s.vs.toFixed(2), s.g.toFixed(3), s.q?.toFixed(1) ?? '', s.temp, s.press?.toFixed(1), s.rssi ?? ''].join(','))].join('\n');
  }
}

/** Minimal strip chart. series: [{values:[[t,v]], color}] */
export function drawStrip(canvas, series, { span = 30, label = '', unit = '' } = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const st = getComputedStyle(document.documentElement);
  const grid = st.getPropertyValue('--line').trim(), muted = st.getPropertyValue('--muted').trim();
  ctx.clearRect(0, 0, w, h);
  const all = series.flatMap((s) => s.values);
  if (!all.length) { ctx.fillStyle = muted; ctx.font = '12px var(--font-body)'; ctx.fillText('Waiting for data', 10, h / 2); return; }
  const tMax = Math.max(...all.map((p) => p[0])), tMin = tMax - span;
  const vis = all.filter((p) => p[0] >= tMin);
  let lo = Math.min(...vis.map((p) => p[1])), hi = Math.max(...vis.map((p) => p[1]));
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const X = (t) => 36 + ((t - tMin) / span) * (w - 44), Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 24);
  ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = muted; ctx.font = '10px ui-monospace, monospace';
  for (let k = 0; k <= 2; k++) {
    const v = lo + ((hi - lo) * k) / 2, y = Y(v);
    ctx.beginPath(); ctx.moveTo(36, y); ctx.lineTo(w - 8, y); ctx.stroke();
    ctx.fillText(v.toFixed(Math.abs(hi - lo) < 10 ? 1 : 0), 2, y + 3);
  }
  ctx.fillText(`${label} ${unit}`.trim(), 40, h - 4);
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.beginPath();
    let first = true;
    for (const [t, v] of s.values) { if (t < tMin) continue; if (first) { ctx.moveTo(X(t), Y(v)); first = false; } else ctx.lineTo(X(t), Y(v)); }
    ctx.stroke();
    const last = s.values.at(-1);
    if (last) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(last[0]), Y(last[1]), 2.5, 0, Math.PI * 2); ctx.fill(); }
  }
}
