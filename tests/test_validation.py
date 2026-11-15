"""tools/validation_report.py: the parts that do not need to run the whole suite."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import validation_report as V  # noqa: E402


class ValidationReport(unittest.TestCase):
    def test_terrain_section_reports_build_state(self):
        t = V.terrain()
        self.assertIn("built", t)
        if not t["built"]:
            self.assertIn("--build-terrain", t["note"])
        else:
            self.assertGreater(t["sites"], 0)

    def test_ephemeris_check_runs_in_node(self):
        e = V.ephemeris()
        if e.get("ok") is None:
            self.skipTest("node not available")
        self.assertTrue(e["ok"], e)
        self.assertLess(max(e["sunArcsec"], e["earthArcsec"]), 60)

    def test_committed_report_is_well_formed(self):
        f = V.OUT
        if not f.exists():
            self.skipTest("no report yet")
        j = json.loads(f.read_text())
        for k in ("javascript", "python", "ephemeris", "terrain", "generated", "ok"):
            self.assertIn(k, j)


if __name__ == "__main__":
    unittest.main()
