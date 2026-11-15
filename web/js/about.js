// Clearway — "About Clearway": the founder page (from an editable Markdown file) and the register of
// every dataset Clearway uses, where it comes from and how Clearway checks it.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Inline Markdown: **bold**, *italic*, [text](https://link). Input is escaped first. */
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
}

/**
 * A deliberately small Markdown reader for web/about/about.md, so the page can be edited in Notepad.
 * Supports: "# Name", "## Section", "### Subheading", paragraphs, "- bullets", **bold**, *italic*,
 * [links](https://…) and <!-- comments -->. Returns {name, tagline, sections:[{title, html}]}.
 */
export function parseAboutMd(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const out = { name: '', tagline: '', sections: [] };
  let cur = null, para = [], list = [];
  const flush = () => {
    if (para.length) { const h = `<p>${inline(para.join(' '))}</p>`; if (cur) cur.html += h; else out.tagline += (out.tagline ? ' ' : '') + para.join(' '); para = []; }
    if (list.length) { const h = `<ul>${list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`; if (!cur) { cur = { title: '', html: '' }; out.sections.push(cur); } cur.html += h; list = []; }
  };
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    let m;
    if ((m = line.match(/^#\s+(.*)$/))) { flush(); out.name = m[1].trim(); continue; }
    if ((m = line.match(/^##\s+(.*)$/))) { flush(); cur = { title: m[1].trim(), html: '' }; out.sections.push(cur); continue; }
    if ((m = line.match(/^###\s+(.*)$/))) { flush(); if (!cur) { cur = { title: '', html: '' }; out.sections.push(cur); } cur.html += `<h4>${inline(m[1].trim())}</h4>`; continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) { if (para.length) { const l = list; list = []; flush(); list = l; } list.push(m[1]); continue; }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  out.tagline = out.tagline ? inline(out.tagline) : '';
  out.sections = out.sections.filter((s) => s.title || s.html);
  return out;
}

// ------------------------------------------------------------------ data register
// level: 'primary' = NASA / USGS archive data or service; 'paper' = peer-reviewed method or reference;
// 'algorithm' = published algorithm Clearway implements and checks; 'live' = live public feed;
// 'input' = values the user enters (examples are illustrative).
export const DATA_SOURCES = [
  {
    group: 'Moon terrain (NASA)', name: 'LOLA polar elevation maps', level: 'primary',
    what: 'Height of the ground around the south pole: 240 m/pixel to 60°S (LDEM_60S_240M, for sites such as Chandrayaan-3) and to 75°S (LDEM_75S_240M), and 40 m/pixel to 85°S (LDEM_85S_40M). Clearway traces the skyline around every site from these maps.',
    source: 'NASA Lunar Reconnaissance Orbiter, Lunar Orbiter Laser Altimeter (LOLA) gridded data records, archived by NASA\'s Planetary Data System Geosciences Node.',
    links: [['PDS LOLA archive', 'https://pds-geosciences.wustl.edu/missions/lro/lola.htm'], ['Polar maps folder', 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/'], ['LOLA team archive (backup)', 'https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG/']],
    check: 'Downloaded as the original files (PDS first, the LOLA team archive at MIT as a backup); label (.LBL) projection and scaling are read, not assumed. Unit tests reproduce the polar stereographic projection.',
    status: (c) => (c.meta?.maps?.length ? `Installed: ${c.meta.maps.join(', ')}` : null),
  },
  {
    group: 'Moon terrain (NASA)', name: '5 m/pixel landing-site maps', level: 'primary',
    what: 'Lander-scale height maps of six south-pole regions, used for touchdown slope and the exact point Clearway analyses at those sites.',
    source: 'NASA Goddard Planetary Geology, Geophysics and Geochemistry Lab (PGDA) product 78: "High-Resolution LOLA Topography for Lunar South Pole Sites", M. K. Barker. Method: Barker et al. (2021), Planetary and Space Science 203, 105119.',
    links: [['PGDA product 78', 'https://pgda.gsfc.nasa.gov/products/78']],
    check: 'Every tile is compared with the LOLA grid at its own points before use (correlation reported in the Verification card).',
    status: (c) => (c.meta?.tiles?.length ? `Installed: ${c.meta.tiles.map((t) => `${t.site} ${t.name || ''}${t.calibration?.corr != null ? ` (r = ${Number(t.calibration.corr).toFixed(3)})` : ''}`).join(', ')}` : null),
  },
  {
    group: 'Moon terrain (NASA)', name: 'Shape-from-shading 5 m maps of the Artemis III regions', level: 'primary',
    what: 'Optional (python server.py --build-terrain --hires --sfs): 5 m/pixel terrain of the 13 Artemis III candidate regions, made by combining LOLA laser heights with shading in LRO camera images. Used first where it covers a site, for the near skyline and lander-scale slopes; regions without a PGDA 78 site are added to the site list.',
    source: 'NASA PGDA product 104 (shape-from-shading DEMs of the Artemis III candidate regions). Method: Bertone, S., et al., The Planetary Science Journal, doi:10.3847/PSJ/ae5b70. Files: Zenodo record 17954508, doi:10.5281/zenodo.17954508.',
    links: [['PGDA product 104', 'https://pgda.gsfc.nasa.gov/products/104'], ['Zenodo files', 'https://doi.org/10.5281/zenodo.17954508']],
    check: 'Clearway extracts only the elevation file from each region\'s archive (the list of everything in the archive is saved next to it) and compares it with the LOLA grid before use, exactly like the PGDA 78 tiles.',
    status: (c) => { const t = (c.meta?.tiles || []).filter((x) => /104/.test(x.product || '')); return t.length ? `Installed: ${t.map((x) => `${x.name}${x.calibration?.corr != null ? ` (r = ${Number(x.calibration.corr).toFixed(3)})` : ''}`).join(', ')}` : null; },
  },
  {
    group: 'Sunlight & shadow (NASA)', name: 'Average sunlight, Earth visibility and permanent shadow maps', level: 'primary',
    what: 'For every 120 m pixel (to 75°S, plus the 240 m maps to 65°S for sites further north): the average visible fraction of the Sun and of Earth over 18.6 years, and whether it is permanently shadowed. Shown on the south-pole map and used as an independent cross-check.',
    source: 'Mazarico, E., et al. (2011). Illumination conditions of the lunar polar regions using LOLA topography. Icarus 211, 1066–1081. doi:10.1016/j.icarus.2010.10.030. Listed as NASA PGDA product 69; files (version 201608) from the PDS Geosciences Node LOLA "extras", with the LOLA team archive as a backup.',
    links: [['PGDA product 69', 'https://pgda.gsfc.nasa.gov/products/69'], ['PDS files', 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/']],
    check: 'Clearway recomputes the same 18.6-year averages with its own ephemeris and terrain and shows the difference site by site. Note: PDS lists the "extras" folder as products not formally reviewed by PDS.',
    status: (c) => { const il = c.meta?.illumination; return il && Object.keys(il).length ? `Installed: ${Object.values(il).map((x) => `${x.file}${x.host ? (/^from |^downloaded/i.test(x.host) ? ` (${x.host.replace(/^from /i, '')})` : ` from ${x.host}`) : ''}`).join('; ')}` : null; },
  },
  {
    group: 'Sun, Earth & Moon positions', name: 'Reference ephemeris', level: 'primary',
    what: 'Where the Sun and Earth appear in the lunar sky. Used to check Clearway\'s own calculation.',
    source: 'NASA JPL Horizons system (planetary ephemeris DE441).',
    links: [['JPL Horizons', 'https://ssd.jpl.nasa.gov/horizons/']],
    check: 'Built-in reference positions are compared on every page load; any site can be re-checked live with the "Check this site live against JPL Horizons" button.',
    status: (c) => (c.check ? `Agrees to ${Math.ceil(Math.max(c.check.sun, c.check.earth) * 3600)} arc-seconds over ${c.check.n} reference positions` : null),
  },
  {
    group: 'Sun, Earth & Moon positions', name: 'Sun and Moon position algorithms', level: 'algorithm',
    what: 'The positions Clearway computes for every hour of the search period.',
    source: 'J. Meeus, Astronomical Algorithms, 2nd ed. (1998), ch. 25 (Sun) and ch. 47 (Moon, truncated ELP-2000/82).',
    links: [],
    check: 'Checked against JPL Horizons (above).',
    status: () => null,
  },
  {
    group: 'Sun, Earth & Moon positions', name: 'Moon orientation', level: 'paper',
    what: 'How the Moon is tilted and turned at each moment (libration), so the Sun and Earth are placed in the right part of each site\'s sky.',
    source: 'IAU Working Group on Cartographic Coordinates and Rotational Elements, 2009 report: Archinal et al. (2011), Celestial Mechanics and Dynamical Astronomy 109, 101–135.',
    links: [],
    check: 'Same frame as the LOLA maps; checked with the Horizons comparison.',
    status: () => null,
  },
  {
    group: 'Landing sites', name: 'Named features', level: 'primary',
    what: 'Coordinates of Shackleton, de Gerlache, Haworth, Nobile, Slater, Cabeus B and Mons Mouton.',
    source: 'USGS / IAU Gazetteer of Planetary Nomenclature (feature centre, first listed control network).',
    links: [['planetarynames.wr.usgs.gov', 'https://planetarynames.wr.usgs.gov/']],
    check: 'Each site in the list shows its Gazetteer feature number.',
    status: () => null,
  },
  {
    group: 'Landing sites', name: 'Mission landing points', level: 'primary',
    what: 'Where IM-1 (Odysseus), IM-2 (Athena) and Blue Ghost Mission 1 came to rest, and the Malapert region.',
    source: 'NASA LRO camera (LROC) team images 1408 (IM-2), 1407 (Blue Ghost) and 1294 (Malapert); NASA, "NASA\'s LRO Images Intuitive Machines\' Odysseus Lander" (IM-1).',
    links: [['LROC featured images', 'https://www.lroc.asu.edu/images'], ['NASA LRO', 'https://science.nasa.gov/mission/lro/']],
    check: 'Coordinates are quoted per site in the site list and the exports.',
    status: () => null,
  },
  {
    group: 'Landing sites', name: 'Sites chosen on NASA\'s 5 m maps', level: 'input',
    what: 'For each 5 m map, Clearway picks the sunniest point that is flat enough to land on (slope under 8°).',
    source: 'Clearway\'s own selection on the PGDA 5 m maps and the Mazarico sunlight map (both above).',
    links: [],
    check: 'Marked † in the cross-check and left out of its summary, because choosing the brightest pixel biases the comparison.',
    status: (c) => (c.meta?.tiles?.length ? `${c.meta.tiles.length} sites` : null),
  },
  {
    group: 'Landing sites', name: 'Chandrayaan-3 landing site and timeline', level: 'primary',
    what: 'Where Vikram landed (69.3741°S, 32.32°E) and the published mission timeline, for the historical analysis under About → Chandrayaan-3.',
    source: 'Site: NASA LRO camera (LROC) image 1314, "Chandrayaan-3 Landing Site". Timeline (touchdown 23 Aug 2023; rover and lander put to sleep 2 and 4 Sep; wake-up attempts from 22 Sep): ISRO mission updates. Chandrayaan-3 is an ISRO mission; Clearway is not affiliated with ISRO.',
    links: [['LROC image 1314', 'https://www.lroc.asu.edu/posts/1314'], ['ISRO Chandrayaan-3', 'https://www.isro.gov.in/Chandrayaan3.html']],
    check: 'Clearway\'s predicted local sunset and next sunrise are set beside ISRO\'s sleep and wake dates; nothing about Vikram\'s internal design is assumed.',
    status: () => null,
  },
  {
    group: 'Earth link', name: 'Deep Space Network stations', level: 'primary',
    what: 'Goldstone, Madrid and Canberra, for the optional "a DSN station must see the Moon" rule.',
    source: 'NASA Deep Space Network complex locations (approximate antenna coordinates).',
    links: [['NASA DSN', 'https://www.nasa.gov/communicating-with-missions/dsn/']],
    check: 'Moon elevation above each complex computed with the same ephemeris.',
    status: () => null,
  },
  {
    group: 'Earth link', name: 'Radio link budget and relay satellite', level: 'algorithm',
    what: 'The highest direct-to-Earth data rate at each moment, and an optional relay satellite on an elliptical frozen orbit whose slow far point sits over the south pole.',
    source: 'Standard link equation (free-space path loss, dish gain η(πD/λ)², system noise, Boltzmann constant), with the actual Earth–Moon distance from the ephemeris. Relay: two-body Kepler orbit, propagated in a frame fixed to the Moon\'s spin axis.',
    links: [],
    check: 'Every radio value is an input; the defaults are typical round numbers, not a specific mission, and the relay orbit is illustrative. Unit tests check the link equation against a hand calculation and the relay geometry (far point over the south pole, Earth hidden behind the Moon when it should be).',
    status: () => null,
  },
  {
    group: 'Physics constants', name: 'Solar constant', level: 'paper',
    what: '1361 W/m² at 1 AU, scaled by the actual Sun–Moon distance at each step.',
    source: 'Kopp & Lean (2011), Geophysical Research Letters 38, L01706 (total solar irradiance).',
    links: [],
    check: '—',
    status: () => null,
  },
  {
    group: 'Lander', name: 'Your lander and the example landers', level: 'input',
    what: 'Solar panels, battery, power use, heaters and tilt limit. The Simple-mode examples (small lander, medium lander, rover) are illustrative round numbers, not the specifications of any real spacecraft.',
    source: 'Entered by you (Planner → Lander tab, or Simple mode).',
    links: [],
    check: 'The Monte Carlo varies these values to show how sensitive the answer is to them.',
    status: () => null,
  },
  {
    group: 'Live feeds', name: 'Space weather', level: 'live',
    what: 'Geomagnetic Kp index and the F10.7 solar radio flux, shown in the header.',
    source: 'NOAA Space Weather Prediction Center public JSON services.',
    links: [['swpc.noaa.gov', 'https://www.swpc.noaa.gov/']],
    check: 'Displayed only; it does not change the site recommendation.',
    status: (c) => (c.sw ? `Kp ${c.sw.kp?.toFixed?.(1) ?? '—'}, F10.7 ${Math.round(c.sw.f107) || '—'}` : 'Unavailable right now'),
  },
  {
    group: 'Live feeds', name: 'Launch phase (optional)', level: 'live',
    what: 'Launch windows, debris screening, weather and airspace in the separate launch planner.',
    source: 'US Space Force catalogue via CelesTrak; Open-Meteo; OpenSky Network; SatNOGS.',
    links: [['CelesTrak', 'https://celestrak.org/'], ['Open-Meteo', 'https://open-meteo.com/']],
    check: 'Shown with timestamps; planning aid only, not an official clearance.',
    status: () => null,
  },
  {
    group: 'Verification', name: 'Automated test suite', level: 'algorithm',
    what: 'JavaScript and Python tests of the ephemeris, terrain, power, thermal, Monte Carlo and file readers.',
    source: 'tools/validation_report.py (node --test and Python unittest).',
    links: [],
    check: 'Result shown in the header chip and the Verification card.',
    status: (c) => (c.validation ? `${c.validation.ok ? 'Passing' : 'Failures'} · ${String(c.validation.generated || '').slice(0, 10)}` : null),
  },
];

export const LEVELS = {
  primary: 'NASA / USGS archive',
  paper: 'Peer-reviewed reference',
  algorithm: 'Published method, checked',
  live: 'Live public feed',
  input: 'Your input / Clearway choice',
};

/** HTML for the data register (ctx: {meta, check, validation, sw}). */
export function renderDataSources(ctx = {}) {
  const groups = [...new Set(DATA_SOURCES.map((d) => d.group))];
  const legend = Object.entries(LEVELS).map(([k, v]) => `<span class="lvl lvl-${k}">${esc(v)}</span>`).join('');
  return `<p class="lead">Every number in Clearway comes from one of the sources below. NASA and USGS data are downloaded from the original archives as published; nothing is hand-edited. "In this session" shows what is installed on this computer right now.</p>
    <div class="lvl-legend">${legend}</div>
    ${groups.map((g) => `<section class="ds-group"><h3>${esc(g)}</h3>${DATA_SOURCES.filter((d) => d.group === g).map((d) => {
      let st = null; try { st = d.status(ctx); } catch { st = null; }
      return `<article class="ds">
        <header><b>${esc(d.name)}</b><span class="lvl lvl-${d.level}">${esc(LEVELS[d.level])}</span></header>
        <p>${esc(d.what)}</p>
        <dl><dt>Source</dt><dd>${esc(d.source)}${d.links.length ? `<br>${d.links.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' · ')}` : ''}</dd>
        <dt>How Clearway checks it</dt><dd>${esc(d.check)}</dd>
        ${st ? `<dt>In this session</dt><dd class="mono">${esc(st)}</dd>` : ''}</dl>
      </article>`;
    }).join('')}</section>`).join('')}
    <p class="hint">Clearway is an independent student project for the NASA Space Apps Challenge. It uses publicly released NASA data but is not endorsed by NASA.</p>`;
}
