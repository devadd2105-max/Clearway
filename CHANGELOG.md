# Changelog

## 6.2.0 — Clearway 11: final version
- The app always opens in Simple mode, so every visitor starts with the four-question landing-site finder; it no
  longer reopens the last mode used. Planner or Explain can still be opened from the header, or directly with
  `?mode=planner` or `?mode=explain` in the address

## 6.1.0 — Clearway 10: submission release
- Team DD Engineering and the challenge ("CLPS Lunar Mission Browser") named in the README and the founder page
- "Use of AI" and "Fonts, libraries and other resources" sections in the README, as the 2026 Project Submission
  Guide asks; the founder page states what is the author's own work and where AI assistance was used
- Founder page wording updated

## 6.0.0 — Clearway 9: historical analysis, Chandrayaan-3, NASA shape-from-shading terrain, radio link budget
- Historical analysis: an earliest-landing date in the past analyses a landing that already happened (no "too soon"
  limit); Simple mode says "Historical analysis" and explains why nothing was found (past dates, stay longer than the
  search, or no safe touchdown)
- Chandrayaan-3 (About → Chandrayaan-3): the Vikram site (LROC image 1314) with ISRO's published timeline beside
  Clearway's computed touchdown Sun and Earth, local sunrise, sunset, night length, energy to survive the night and
  next sunrise; strip chart; "Open this landing in Planner"; your own analysis read from `web/about/chandrayaan.md`.
  On a smooth Moon Clearway puts local sunset about 15 h after ISRO put Vikram to sleep, and the next sunrise about
  2 days before ISRO's wake-up attempts
- NASA LOLA `ldem_60s_240m` (terrain to 60°S) and the Mazarico et al. 240 m maps to 65°S; LOLA downloads fall back to
  the LOLA team archive at MIT
- NASA PGDA product 104 shape-from-shading 5 m terrain of the 13 Artemis III regions (`--sfs`): byte-range extraction of
  just the elevation file from each Zenodo archive (zip64), checked against LOLA, used first for skylines and slopes;
  regions without a PGDA 78 site become sites
- Radio link budget (band, power, antenna gain, 34/70 m dish) → data rate and data volume per stay; optional relay
  satellite on an elliptical frozen orbit; tiers show relay-only time, link in use and the direct data rate
- Battery wording: "Battery nearly runs out — lowest X%" instead of "never below 0%"
- Reliability: every Planner number is range-checked (empty or negative fields fall back to defaults), invalid dates
  are caught, a failed run re-enables the Run button, and any unexpected error is shown instead of silently ignored
- GeoTIFF reader: ZSTD (Python 3.14+ or the zstandard package) and LZMA compression
- 9 new JavaScript tests (82) and 9 new Python tests (75)

## 5.0.0 — Final: Simple mode, About Clearway, data-source register, logo
- Simple mode (opens by default): pick an example lander or enter your own panel area, efficiency, battery, power use
  and keep-alive electronics; earliest landing date, days on the surface and priority. One answer card: site, landing
  date, Monte Carlo survival gauge, main risk, three plain reasons, next-best site, NASA mini map, PDF brief, and
  "See the full analysis" into Planner. It drives the same engine as Planner (no separate model)
- About Clearway: Founder tab read from the editable `web/about/about.md` (+ optional `photo.jpg`); Data sources tab
  listing every dataset with its citation, link, reliability class, how Clearway checks it and what is installed;
  How it works tab
- Clearway logo in the header, favicon, home-screen icon and the PDF brief header (JPEG embedding in the PDF writer)
- Example landers are labelled as illustrative, not real spacecraft specifications
- Date inputs styled like the other fields; About tabs no longer clash with the control-panel tabs
- 8 new JavaScript tests (73 in total)
- Checked on the real NASA build: the Earth-visibility map no longer goes through the peak/crater landmark test (Earth
  view depends on slope direction); it shares the sunlight map's layout, and a new real-data test checks it physically
  (IM-1 sees Earth > 90% of the time; deep crater floors never do). Site names from the terrain build are no longer cut
  mid-word; "Battery stays full" wording when there is no darkness; `check.bat` / `check.sh` re-run the checks after an update

## 4.0.0 — Final draft: every NASA south-pole product, thermal model, Monte Carlo, NASA cross-check
- NASA PGDA 5 m/pixel LOLA site maps (product 78): dependency-free GeoTIFF reader; each tile checked against
  the LOLA grid (projection, datum, correlation, RMS) before use; finest-map-first terrain; lander-scale slope at
  the site and across a 100 m landing circle with PGDA's slope and height uncertainty; six PGDA sites added
- NASA PGDA illumination products (product 69, Mazarico et al. 2011): average sunlight, Earth visibility and
  permanent shadow at every site; distance to water-ice cold traps; south-pole map (terrain, sunlight, shadow)
  with click-to-add sites
- Cross-check: Clearway recomputes NASA's 18.6-year averages and reports the measured difference per site
- Thermal model: survival-heater power follows the lander's temperature (lumped thermal balance), so long
  nights cost more than short shadows; heater and temperature in the timeline, status, CSV and brief
- Monte Carlo: landing slip, touchdown point (ring horizons 100 m out), skyline error, panel, loads, battery
  fade, radiator and slope; survival share with Wilson 95% interval; seeded and reproducible
- Surface-stay timeline now shows a fresh battery and warm lander from touchdown (whole-period run elsewhere)
- Black-and-white interface; colour reserved for status (green / amber / red) and paired with shapes and words
- Brief PDF gains a Monte Carlo, landing-safety and NASA cross-check page; JSON export includes both
- Build: `--build-terrain` (LOLA + illumination maps), `--hires` (+ 40 m map + 5 m tiles), `--quick`; resumable
  downloads with a curl fallback; every optional product skipped gracefully
- Primary sources for every site: USGS/IAU Gazetteer of Planetary Nomenclature for named features (de Gerlache
  and Cabeus B moved to the Gazetteer's control-network centres), NASA and LROC for IM-1, IM-2, Blue Ghost and Malapert
- Illumination maps downloaded from NASA's PDS Geosciences Node first (LOLA team archive as backup); the host is
  recorded and shown in Data & lineage
- The recommendation must also survive the Monte Carlo (at least 60% of scenarios, else the most robust surviving
  site), and the verdict says which higher-scoring sites were too fragile and why
- PGDA 5 m sites sit on the sunniest point of each tile with 90% of the ground within 50 m below 8°; those points
  are flagged and left out of the NASA cross-check summary (they were chosen using NASA's map)
- Illumination map layout is scored against all 8 mirror/rotation alternatives; an old build for moved
  coordinates is detected and ignored until rebuilt
- Tests: 65 JS + 65 Python (GeoTIFF layouts, LZW cross-checked with libtiff, tile calibration, slopes, PSR,
  rings, thermal, Monte Carlo, cross-check); real-data checks run automatically once the products are built

## 3.1.0 — Decision support
- The board now answers one question: which site gives the lander the best chance of surviving its surface
  mission while keeping contact with Earth? The verdict names a site **and** a landing date, says whether the
  battery survives the stay, and names the limiting constraint
- "Why this site?": strengths and trade-offs against the other sites, head-to-head with the runner-up, links that
  jump the timeline to the longest night and the longest outage
- Priority presets (Power first / Balanced / Comms first) and a strip showing which site wins at every weight
- Landing calendar: every landing day coloured survives / battery flat / no safe touchdown / too soon, with the
  limiting constraint on hover; landing windows table with minimum charge, battery margin and limiting factor
- Sunlit-period, dark-period, Earth-link-window and outage tables with CSV export
- Horizon view: smooth-Moon (geometric) horizon line, ±0.5° terrain-uncertainty band, live SUN UP / LINK AVAILABLE /
  LINK BLOCKED BY TERRAIN / ON BATTERY badges, timeline zoomed to the surface stay
- Link tiers kept separate: geometric → terrain line of sight → DSN station in view → operational (not modelled)
- Battery model: usable depth, charge and discharge efficiency, operating vs survival loads, minimum state of
  charge, battery margin; infeasible stays are flagged even when they score well
- Mission trade-off explorer: 2+ sites, one landing time and stay, side by side, with "what changed" explanations
- How much to trust this: modelled / assumed / not modelled / confidence, stress tests (priority ±20, skyline ±0.5°,
  2° link clearance, terrain vs smooth Moon) and a terrain-effect table; "robust" only when every test holds
- Verification card and header chips: ephemeris vs JPL Horizons, test-suite results from
  `tools/validation_report.py` (run by CI), LOLA terrain build status with landmark orientation checks
- Sites anywhere on the Moon; IM-1 (Odysseus) and Blue Ghost Mission 1 added; Moon map uses a general orthographic
  projection (south-polar view now has 90°E on the right, as seen from outside)
- Focused interface: launch/transfer phases behind a "Mission phases" switch; guided tour; mobile drawer and
  scrollable charts at phone widths
- Brief PDF rebuilt around the decision (recommendation, why, stress tests, link tiers, battery model)

## 3.0.0 — Lunar Mission Browser (CLPS challenge)
- New front door: compare south-pole landing sites and dates by sunlight, power, battery and direct-to-Earth link
- Analytic lunar ephemeris (Meeus/ELP-2000 + IAU 2009 orientation) validated against JPL Horizons to ≈20″
- Terrain horizons from NASA LOLA polar maps (`tools/horizons.py`), with landmark orientation check; `--build-terrain`
- Horizon panorama, timeline, site × date heatmap, south-polar Moon map, time scrubber and playback
- Battery sizing, DSN visibility, best landing windows, mission phase bar, patched-conic transfer
- Live JPL Horizons verification, custom sites with server-side terrain, Explain mode, Landing Director game
- Site & Mission Brief PDF; CSV/JSON/horizon exports
- The Earth launch planner (v2) becomes the launch phase and reports back to the phase bar

## 2.0.0
- Covariance-based collision probability, space weather, CesiumJS view, hold optimiser, in-orbit advisory,
  business impact, OpenSky, SatNOGS, PDFs, telemetry relay, scenarios, lineage, game, CI and hosting

## 1.0.0
- Launch windows, SGP4 catalog screening, weather go/no-go, hazard areas, exports, micro:bit console
