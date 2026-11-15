// Clearway — minimal dependency-free PDF writer (PDF 1.4, standard Type 1 fonts, vector drawing).
// Enough for formal two-page briefs: text with wrapping, rules, boxes, tables and maps.

const W_HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const FONTS = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Courier' };
export const A4 = { w: 595.28, h: 841.89 };

// Characters outside WinAnsi are mapped to ASCII equivalents.
const MAP = { 'Δ': 'd', 'σ': 's', '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '≈': '~', '−': '-', '₀': '0', '₁': '1', '₂': '2', '²': '²', '³': '³', '″': '"', '′': "'", '★': '*', '✓': 'ok', '×': 'x' };
const WIN = { '—': 0x97, '–': 0x96, '•': 0x95, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '…': 0x85, '€': 0x80 };

export function winAnsi(str) {
  let out = '';
  for (const ch of String(str ?? '')) {
    const m = MAP[ch] ?? ch;
    for (const c of m) {
      const code = c.codePointAt(0);
      if (WIN[c]) out += String.fromCharCode(WIN[c]);
      else if (code < 256) out += c;
      else out += '?';
    }
  }
  return out;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r?\n/g, ' ');

export function textWidth(str, size, font = 'F1') {
  const s = winAnsi(str);
  if (font === 'F3') return s.length * 0.6 * size;
  let w = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); w += c >= 32 && c <= 126 ? W_HELV[c - 32] : 556; }
  return (w / 1000) * size * (font === 'F2' ? 1.05 : 1);
}

export function wrap(str, width, size, font = 'F1') {
  const lines = [];
  for (const para of String(str ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${word}` : word;
      if (textWidth(t, size, font) <= width || !line) line = t; else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

const rgb = (hex) => { const h = hex.replace('#', ''); return [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' '); };

let IMG_SEQ = 0;

class Page {
  constructor() { this.ops = []; }
  // y measured from the TOP of the page for convenience
  text(x, y, str, { size = 10, font = 'F1', color = '#132033', align = 'left' } = {}) {
    const s = winAnsi(str);
    let dx = x;
    if (align !== 'left') { const w = textWidth(str, size, font); dx = align === 'right' ? x - w : x - w / 2; }
    this.ops.push(`BT /${font} ${size} Tf ${rgb(color)} rg ${dx.toFixed(2)} ${(A4.h - y).toFixed(2)} Td (${esc(s)}) Tj ET`);
    return this;
  }
  /** Wrapped paragraph; returns the y below it. */
  para(x, y, str, width, { size = 10, font = 'F1', color = '#132033', leading = 1.35 } = {}) {
    for (const line of wrap(str, width, size, font)) { this.text(x, y, line, { size, font, color }); y += size * leading; }
    return y;
  }
  line(x1, y1, x2, y2, { width = 0.6, color = '#132033', dash = null } = {}) {
    this.ops.push(`${width} w ${rgb(color)} RG ${dash ? `[${dash.join(' ')}] 0 d` : '[] 0 d'} ${x1.toFixed(2)} ${(A4.h - y1).toFixed(2)} m ${x2.toFixed(2)} ${(A4.h - y2).toFixed(2)} l S`);
    return this;
  }
  rect(x, y, w, h, { fill = null, stroke = null, width = 0.6 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.ops.push(`${width} w ${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' : ''}[] 0 d ${x.toFixed(2)} ${(A4.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${op}`);
    return this;
  }
  poly(points, { fill = null, stroke = '#132033', width = 0.6, close = false, dash = null, alpha = null } = {}) {
    if (points.length < 2) return this;
    const path = points.map(([x, y], i) => `${x.toFixed(2)} ${(A4.h - y).toFixed(2)} ${i ? 'l' : 'm'}`).join(' ');
    const op = fill && stroke ? (close ? 'b' : 'B') : fill ? 'f' : close ? 's' : 'S';
    this.ops.push(`q ${alpha != null ? `/GS${Math.round(alpha * 100)} gs ` : ''}${width} w ${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' : ''}${dash ? `[${dash.join(' ')}] 0 d` : '[] 0 d'} ${path} ${op} Q`);
    if (alpha != null) (this.alphas ??= new Set()).add(Math.round(alpha * 100));
    return this;
  }
  /** Draw a JPEG image ({data: binary string, w, h}) with its top-left corner at (x, y). */
  image(img, x, y, w, h) {
    if (!img?.data) return this;
    (this.images ??= new Set()).add(img);
    img.name ??= `Im${++IMG_SEQ}`;
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(A4.h - y - h).toFixed(2)} cm /${img.name} Do Q`);
    return this;
  }
  clip(x, y, w, h, fn) {
    this.ops.push(`q ${x.toFixed(2)} ${(A4.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re W n`);
    fn(this);
    this.ops.push('Q');
    return this;
  }
}

export class PdfDoc {
  constructor({ title = 'Clearway', author = 'Clearway' } = {}) { this.pages = []; this.title = title; this.author = author; }
  addPage() { const p = new Page(); this.pages.push(p); return p; }

  toBytes() {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const fontIds = Object.entries(FONTS).map(([k, name]) => [k, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`)]);
    const alphas = new Set(); this.pages.forEach((p) => p.alphas?.forEach((a) => alphas.add(a)));
    const gsIds = [...alphas].map((a) => [a, add(`<< /Type /ExtGState /ca ${(a / 100).toFixed(2)} /CA ${(a / 100).toFixed(2)} >>`)]);
    const images = new Set(); this.pages.forEach((p) => p.images?.forEach((im) => images.add(im)));
    const imgIds = [...images].map((im) => [im.name, add(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n${im.data}\nendstream`)]);
    const res = `<< /Font << ${fontIds.map(([k, id]) => `/${k} ${id} 0 R`).join(' ')} >>${gsIds.length ? ` /ExtGState << ${gsIds.map(([a, id]) => `/GS${a} ${id} 0 R`).join(' ')} >>` : ''}${imgIds.length ? ` /XObject << ${imgIds.map(([n, id]) => `/${n} ${id} 0 R`).join(' ')} >>` : ''} >>`;
    const pageIds = this.pages.map((p) => {
      const content = p.ops.join('\n');
      const cid = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources ${res} /Contents ${cid} 0 R >>`);
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    const now = new Date();
    const d = `D:${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}00Z`;
    const info = add(`<< /Title (${esc(winAnsi(this.title))}) /Author (${esc(winAnsi(this.author))}) /Producer (Clearway) /CreationDate (${d}) >>`);
    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
