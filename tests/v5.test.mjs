// Clearway 5 — tests for Simple mode (answers → Planner inputs, plain-language reasons), the founder
// page Markdown reader, the data-source register and JPEG images in the PDF writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANDER_PRESETS, simpleToPlanner, simpleReasons, simpleAdvice, survivalBand } from '../web/js/lunar/simple.js';
import { parseAboutMd, DATA_SOURCES, LEVELS, renderDataSources } from '../web/js/about.js';
import { PdfDoc } from '../web/js/pdf.js';

test('simple: presets map onto the Planner inputs', () => {
  const v = simpleToPlanner({ preset: 'medium', start: '2026-11-01', stayDays: 20, priority: 'power' });
  const p = LANDER_PRESETS.medium;
  assert.equal(v['#p-area'], p.panelM2); assert.equal(v['#b-cap'], p.batteryWh); assert.equal(v['#b-op'], p.loadW);
  assert.equal(v['#t-elec'], p.survivalElecW); assert.equal(v['#t-on'], true); assert.equal(v['#p-type'], 'vertical-tracking');
  assert.equal(v['#d-start'], '2026-11-01'); assert.equal(v['#m-days'], 20); assert.equal(v['#w-slider'], 80); assert.equal(v.prio, 'power');
});

test('simple: custom values are used and clamped; bad input falls back', () => {
  const v = simpleToPlanner({ preset: 'custom', custom: { panelM2: 3, efficiencyPct: 99, batteryWh: 8000, loadW: 300, survivalElecW: NaN }, stayDays: 500, priority: 'nope' });
  assert.equal(v['#p-area'], 3); assert.equal(v['#p-eff'], 45); assert.equal(v['#b-cap'], 8000); assert.equal(v['#t-elec'], LANDER_PRESETS.small.survivalElecW);
  assert.equal(v['#m-days'], 120); assert.equal(v.prio, 'balanced'); assert.equal(v['#w-slider'], 50);
  assert.ok(v['#t-cap'] > LANDER_PRESETS.small.heatCapKJK, 'a bigger custom lander gets more thermal mass');
});

test('simple: three reasons, and honest wording when the battery fails', () => {
  const ok = simpleReasons({ litPct: 82.4, commsPct: 64.6, longestDarkH: 40, minSocPct: 37, batteryMarginWh: 900, batteryNeededWh: 700, feasible: true }, { stayDays: 14, batteryWh: 2000 });
  assert.equal(ok.length, 3);
  assert.deepEqual(ok.map((r) => r.icon), ['sun', 'earth', 'battery']);
  assert.match(ok[0].title, /82%/); assert.match(ok[0].text, /40 hours/); assert.match(ok[2].title, /37%/);
  const bad = simpleReasons({ litPct: 50, commsPct: 100, longestDarkH: 300, minSocPct: 0, batteryNeededWh: 9000, feasible: false }, { stayDays: 30, batteryWh: 2000 });
  assert.match(bad[2].title, /runs flat/); assert.match(bad[1].text, /never drops/); assert.match(bad[0].text, /12.5 days/);
  assert.match(simpleAdvice({ feasible: false }, { stayDays: 30 }), /shorter stay/);
  assert.equal(simpleAdvice({ feasible: true }, {}), '');
  assert.equal(simpleReasons(null).length, 0);
});

test('simple: survival bands', () => {
  assert.equal(survivalBand(0.95).st, 'go'); assert.equal(survivalBand(0.7).st, 'caution'); assert.equal(survivalBand(0.2).st, 'nogo'); assert.equal(survivalBand(null).st, 'nodata');
});

test('about: Markdown reader handles name, tagline, sections, bullets, links and comments', () => {
  const a = parseAboutMd('<!-- hidden -->\r\n# Ada Lovelace\nAnalyst\n\n## Why\nFirst line\nsame para with **bold** and *it*.\n\nSecond <script>x</script>\n## Me\n- one [site](https://example.com)\n- two\nafter list\n## Bad link\n[x](javascript:alert(1))');
  assert.equal(a.name, 'Ada Lovelace'); assert.equal(a.tagline, 'Analyst');
  assert.deepEqual(a.sections.map((s) => s.title), ['Why', 'Me', 'Bad link']);
  assert.match(a.sections[0].html, /<p>First line same para with <b>bold<\/b> and <i>it<\/i>.<\/p><p>Second &lt;script&gt;/);
  assert.match(a.sections[1].html, /<ul><li>one <a href="https:\/\/example.com" target="_blank" rel="noopener">site<\/a><\/li><li>two<\/li><\/ul><p>after list<\/p>/);
  assert.doesNotMatch(a.sections[2].html, /href="javascript/);
  assert.doesNotMatch(JSON.stringify(a), /hidden/);
});

test('about: the shipped about.md parses', () => {
  const a = parseAboutMd(readFileSync(new URL('../web/about/about.md', import.meta.url), 'utf8'));
  assert.ok(a.name.length > 3);
  assert.ok(a.sections.length >= 3);
  assert.ok(a.sections.some((s) => /AI assistance/.test(s.html)), 'AI use is disclosed');
});

test('data register: every entry is complete and renders with or without installed data', () => {
  for (const d of DATA_SOURCES) {
    for (const k of ['group', 'name', 'what', 'source', 'check']) assert.ok(d[k], `${d.name}: ${k}`);
    assert.ok(LEVELS[d.level], d.name);
    for (const [, u] of d.links) assert.match(u, /^https:\/\//, d.name);
  }
  const empty = renderDataSources({});
  assert.match(empty, /LOLA polar elevation maps/); assert.doesNotMatch(empty, /In this session<\/dt><dd class="mono">Installed/);
  const full = renderDataSources({ meta: { maps: ['ldem_75s_240m.img'], tiles: [{ site: 'Site01', name: 'Ridge', calibration: { corr: 0.999 } }], illumination: { sun: { file: 'AVGVISIB_75S_120M_201608.IMG', host: 'PDS' } } }, check: { sun: 0.004, earth: 0.005, n: 16 } });
  assert.match(full, /r = 0.999/); assert.match(full, /AVGVISIB_75S_120M_201608.IMG from PDS/); assert.match(full, /Agrees to 18 arc-seconds/);
});

test('pdf: JPEG images are embedded as DCT XObjects', () => {
  const jpg = readFileSync(new URL('../web/brand/logo-pdf.jpg', import.meta.url));
  const doc = new PdfDoc(); const p = doc.addPage();
  p.image({ data: String.fromCharCode(...jpg), w: 160, h: 160 }, 10, 10, 40, 40);
  doc.addPage().text(10, 10, 'no image');
  const bytes = doc.toBytes(); const s = Buffer.from(bytes).toString('latin1');
  assert.match(s, /\/Subtype \/Image \/Width 160 \/Height 160 .*\/Filter \/DCTDecode \/Length \d+/);
  assert.match(s, /\/XObject << \/Im\d+ \d+ 0 R >>/);
  assert.match(s, /40.00 0 0 40.00 10.00 791.89 cm \/Im\d+ Do Q/);
  assert.ok(s.includes(String.fromCharCode(...jpg.subarray(0, 64))), 'JPEG bytes are copied verbatim');
});
