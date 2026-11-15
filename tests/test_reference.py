"""Independent Python reference implementations of Clearway's core formulas, cross-checked
against the JavaScript modules (run through Node). Also cross-checks satellite.js SGP4 against
the Python `sgp4` package when both are available (pip install sgp4; python server.py --fetch-vendor)."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MU, RE, J2, OMEGA = 398600.4418, 6378.137, 1.08262668e-3, 7.2921159e-5
NODE = shutil.which("node")

JS = """
import * as O from './web/js/orbit.js';
import { encounterPc } from './web/js/covariance.js';
import { dvBudget } from './web/js/econ.js';
const D = O.DEG;
const out = {
  sso550: O.ssoInclination(550) / D,
  sso800: O.ssoInclination(800) / D,
  az: O.inertialAzimuth(28.5 * D, 51.6 * D, 'asc') / D,
  azDesc: O.inertialAzimuth(34.5 * D, 97.6 * D, 'desc') / D,
  gmst: O.gmst(Date.UTC(2026, 9, 4, 12)) / D,
  period: O.periodSec(O.RE + 400),
  pc: encounterPc([0.5, 0, 0], [0, 0, 10], [1,0,0, 0,1,0, 0,0,1], 0.02).pc,
  pcAniso: encounterPc([0.3, 0.4, 0], [0, 0, 10], [0.25,0,0, 0,4,0, 0,0,1], 0.015).pc,
  dv: dvBudget(12, 1, 220),
};
console.log(JSON.stringify(out));
"""


def js_values():
    r = subprocess.run([NODE, "--input-type=module", "-e", JS], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return json.loads(r.stdout)


def sso_inclination(h):
    a = RE + h
    n = math.sqrt(MU / a**3)
    rate = 2 * math.pi / (365.2421897 * 86400)
    return math.degrees(math.acos(-rate / (1.5 * n * J2 * (RE / a) ** 2)))


def gmst_deg(jd):
    t = (jd - 2451545.0) / 36525
    s = -6.2e-6 * t**3 + 0.093104 * t**2 + (876600 * 3600 + 8640184.812866) * t + 67310.54841
    return (s / 240) % 360


def pc_numeric(mx, my, sxx, syy, hbr, n=600):
    """Brute-force Cartesian integration of a 2-D Gaussian over the hard-body disc."""
    total, h = 0.0, 2 * hbr / n
    norm = 1 / (2 * math.pi * math.sqrt(sxx * syy))
    for i in range(n):
        x = -hbr + (i + 0.5) * h
        for j in range(n):
            y = -hbr + (j + 0.5) * h
            if x * x + y * y <= hbr * hbr:
                total += math.exp(-0.5 * ((x - mx) ** 2 / sxx + (y - my) ** 2 / syy))
    return norm * total * h * h


@unittest.skipUnless(NODE, "Node.js not installed")
class CrossCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = js_values()

    def test_sun_synchronous_inclination(self):
        self.assertAlmostEqual(self.js["sso550"], sso_inclination(550), places=9)
        self.assertAlmostEqual(self.js["sso800"], sso_inclination(800), places=9)

    def test_launch_azimuth(self):
        b = math.degrees(math.asin(math.cos(math.radians(51.6)) / math.cos(math.radians(28.5))))
        self.assertAlmostEqual(self.js["az"], b, places=9)
        b2 = math.degrees(math.asin(math.cos(math.radians(97.6)) / math.cos(math.radians(34.5))))
        self.assertAlmostEqual(self.js["azDesc"], (180 - b2) % 360, places=9)

    def test_gmst(self):
        jd = 2440587.5 + (1791115200000 / 86400000)  # 2026-10-04T12:00Z
        self.assertAlmostEqual(self.js["gmst"], gmst_deg(jd), places=6)

    def test_period(self):
        self.assertAlmostEqual(self.js["period"], 2 * math.pi * math.sqrt((RE + 400) ** 3 / MU), places=6)

    def test_pc_against_brute_force_integration(self):
        self.assertAlmostEqual(self.js["pc"] / pc_numeric(0.5, 0, 1, 1, 0.02), 1, places=3)
        # anisotropic: encounter plane axes x (radial var 0.25) and y (in-track var 4)
        self.assertAlmostEqual(self.js["pcAniso"] / pc_numeric(0.3, 0.4, 0.25, 4, 0.015), 1, places=3)

    def test_rocket_equation(self):
        self.assertAlmostEqual(self.js["dv"], 220 * 9.80665 * math.log(12 / 11), places=9)


VENDOR = ROOT / "web" / "vendor" / "satellite.min.js"


@unittest.skipUnless(NODE and VENDOR.exists(), "needs Node.js and web/vendor/satellite.min.js (python server.py --fetch-vendor)")
class Sgp4CrossCheck(unittest.TestCase):
    def test_satellite_js_matches_python_sgp4(self):
        try:
            from sgp4.api import Satrec, jday
        except ImportError:
            self.skipTest("pip install sgp4 to enable")
        l1 = "1 25544U 98067A   26277.51782528  .00016717  00000-0  30210-3 0  9993"
        l2 = "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579 34567"
        js = f"""
        const fs = await import('node:fs'); const vm = await import('node:vm');
        const ctx = {{ window: {{}}, self: {{}} }}; ctx.globalThis = ctx; vm.createContext(ctx);
        vm.runInContext(fs.readFileSync('{VENDOR.as_posix()}', 'utf8'), ctx);
        const sat = ctx.satellite || ctx.window.satellite || ctx.self.satellite;
        const rec = sat.twoline2satrec('{l1}', '{l2}');
        const out = [0, 90, 1440].map((m) => {{ const p = sat.sgp4(rec, m).position; return [p.x, p.y, p.z]; }});
        console.log(JSON.stringify(out));"""
        r = subprocess.run([NODE, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        js_pos = json.loads(r.stdout)
        sat = Satrec.twoline2rv(l1, l2)
        for minutes, pj in zip([0, 90, 1440], js_pos):
            jd, fr = sat.jdsatepoch, sat.jdsatepochF + minutes / 1440
            e, pp, _ = sat.sgp4(jd, fr)
            self.assertEqual(e, 0)
            self.assertLess(math.dist(pp, pj), 1e-3, f"t+{minutes} min")  # agree to 1 m


if __name__ == "__main__":
    unittest.main()
