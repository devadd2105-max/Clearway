# Contributing

1. `npm test` (Node + Python suites) must pass.
2. Keep computational modules free of DOM access so they stay testable under Node.
3. New data sources go through `server.py` (validation, caching, stale fallback) and get a row in the Data & lineage panel and the README table, with their terms.
4. Physics changes need a test with a hand-checkable expected value or an independent reference in `tests/test_reference.py`.
5. Never present Clearway output as an official clearance, filing or certified Pc.
6. Ephemeris changes must keep `tests/lunar.test.mjs` within 0.01° of the JPL Horizons reference positions.
