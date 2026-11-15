# Demo video script (3 minutes)

One question carries the whole demo:

> **"Which candidate landing site gives our lander the best chance of surviving its surface mission
> while maintaining contact with Earth?"**

The story is geometry → power and communications → mission feasibility → an informed decision.

**Before recording.** Run `run.bat` / `./run.sh` once while online (it downloads the NASA data and
builds the terrain), then check the header shows **Terrain LOLA + 5 m**, **NASA maps: illumination +
… × 5 m**, **Verified vs JPL ±20″** and **Tests … passed**. If the terrain chip
says *smooth Moon*, stop and build the terrain: the smooth fallback cannot show why crater rims
and ridges matter. Use a 1440×900 window, the default black theme. The app opens in Simple mode.

| Time | Show | Say |
|---|---|---|
| 0:00 | **Simple mode**: pick *Small lander*, 14 days, *Balanced*, press **Find my landing site** | "Anyone can ask the question. Pick a lander, how long it stays, what matters most. Clearway checks every south-pole site against NASA terrain, simulates the whole stay and replays the landing 200 times — and answers: this site, this date, this survival rate, and three reasons why." |
| 0:15 | **See the full analysis** → the verdict card in Planner | "Behind that answer is the full analysis. Same result: this site, this landing date, the battery never drops below this — and here is what limits it." |
| 0:15 | Compare the sites; click **Power first**, then **Comms first** | "Every candidate is scored on sunlight and Earth-link time. Watch the recommendation change when the mission cares more about power or about communications — and the strip shows who wins at every priority." |
| 0:30 | **South-pole map**: switch to *Average sunlight*, point at hatched craters, click empty ridge | "All NASA data: laser-altimeter terrain, NASA's 18.6-year sunlight map, and the permanently shadowed craters where ice survives. Click a ridge and Clearway computes a new candidate on the spot." |
| 0:45 | **Why this site?** → *Show the longest dark period* | "It explains itself: strengths, trade-offs, the runner-up, and the single constraint that limits it." |
| 0:55 | Horizon view: tick **Terrain ±0.5°**, press **Play** | "This is the real skyline from NASA's laser altimeter. The dashed line is what a smooth Moon would give. The Sun skims the ridge; when it drops behind, the badge turns red, power stops, the heaters take over as the lander cools, and the battery drains — all in sync. Below: the slope from NASA's 5-metre maps and the distance to ice." |
| 1:20 | Earth disc and **LINK AVAILABLE / BLOCKED** badge; link tiers table | "Earth barely moves here. Visible on paper is not the same as a link: Clearway separates geometric visibility, terrain line of sight and Deep Space Network coverage, and says plainly what it does not model." |
| 1:40 | **When to land** calendar: hover a red day, then a green one | "Every landing day for a 14-day stay. Green survives; red runs the battery flat even though the score looks good; grey has the Sun or Earth behind the terrain at touchdown." |
| 1:55 | **Trade-off explorer**: two sites, change stay 14 → 30 days | "Same landing, two sites, side by side. Lengthen the stay — the recommendation updates and tells us exactly what changed." |
| 2:05 | **Survival under uncertainty** | "Real landings are late and off target. Each plan is replayed 200 times: a touchdown 100 metres away with its own real horizon, terrain error, weaker panels, an aged battery, a steep spot. This site survives [X]% — that one only [Y]%." (read X and Y off your own screen) |
| 2:20 | **How much to trust this**: cross-check table, then **Verification** | "And we check ourselves against NASA. Clearway recomputes NASA's own 18.6-year sunlight and Earth-visibility maps for every site and shows the difference, site by site. Positions match JPL Horizons to 20 arc-seconds, every 5-metre map is checked against LOLA, and every test passes." |
| 2:30 | **About → Chandrayaan-3** | "Does it work on a real mission? Here is India's Chandrayaan-3. Clearway recomputes the Sun over the Vikram site: it predicts local sunset about fifteen hours after ISRO put the lander to sleep, and the next sunrise just before ISRO tried to wake it — the same story the mission told." (read the numbers off your own screen) |
| 2:40 | Switch to **Explain**, open **Landing Director** | "For classrooms: plain-language notes on every chart, and a game where students make the GO, HOLD and SCRUB calls for this exact landing." |
| 2:50 | Export the **Site & Mission Brief** | "And a brief the team can hand to engineers. Clearway: the clearest way to see the lighting and communication trade-offs at the lunar south pole." |

**Backup plan.** If the live Horizons check is offline during judging, the built-in reference check
(16 JPL positions) still runs at start-up and the Verification card shows it.

**Closing shot (optional):** open **About** → *Data sources* — "Every number comes from a NASA or USGS archive, cited, with how Clearway checks it."
