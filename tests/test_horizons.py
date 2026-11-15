"""Tests for tools/horizons.py with synthetic polar-stereographic maps of known shape."""
from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import horizons as H  # noqa: E402

R = H.R_MOON_M


def write_map(folder: Path, name: str, n: int, scale: float, height_fn, mirror_x: bool = False) -> Path:
    """Write a south-polar int16 map (DN = height / 0.5) with a PDS3-style detached label."""
    off = n / 2 - 0.5
    rows = []
    for j in range(n):
        row = []
        for i in range(n):
            ii = (n - 1 - i) if mirror_x else i
            x, y = (ii - off) * scale, (j - off) * scale
            rho = math.hypot(x, y)
            lat = -(90 - math.degrees(2 * math.atan(rho / (2 * R))))
            lon = math.degrees(math.atan2(x, -y)) if rho else 0.0  # inverse of X = ρ sin lon, Y = −ρ cos lon (DSMAP, south)
            row.append(max(-32768, min(32767, int(round(height_fn(lat, lon) / 0.5)))))
        rows.append(row)
    import array
    a = array.array("h", [v for r in rows for v in r])
    if sys.byteorder != "little":
        a.byteswap()
    img = folder / f"{name}.img"
    with open(img, "wb") as fh:
        a.tofile(fh)
    (folder / f"{name}.lbl").write_text(f"""PDS_VERSION_ID = PDS3
OBJECT = IMAGE
  NAME = HEIGHT
  LINES = {n}
  LINE_SAMPLES = {n}
  SAMPLE_TYPE = LSB_INTEGER
  SAMPLE_BITS = 16
  UNIT = METER
  SCALING_FACTOR = 0.5
  OFFSET = 1737400.
END_OBJECT = IMAGE
OBJECT = IMAGE_MAP_PROJECTION
  MAP_PROJECTION_TYPE = "POLAR STEREOGRAPHIC"
  CENTER_LATITUDE = -90.0 <DEG>
  CENTER_LONGITUDE = 0.0 <DEG>
  MAP_SCALE = {scale} <M/PIXEL>
  LINE_PROJECTION_OFFSET = {off} <PIXEL>
  SAMPLE_PROJECTION_OFFSET = {off} <PIXEL>
END_OBJECT = IMAGE_MAP_PROJECTION
END
""")
    return img


def dest(lat, lon, az_deg, dist_m):
    e, n, u = H.enu(lat, lon)
    a = math.radians(az_deg)
    t = [math.cos(a) * n[i] + math.sin(a) * e[i] for i in range(3)]
    dl = dist_m / R
    return H.latlon([math.cos(dl) * u[i] + math.sin(dl) * t[i] for i in range(3)])


def gc_dist(lat1, lon1, lat2, lon2):
    a, b = H.unit(lat1, lon1), H.unit(lat2, lon2)
    return R * math.acos(max(-1, min(1, sum(x * y for x, y in zip(a, b)))))


def expected_el(dist_m, height_m, obs_m=2.0):
    dl = dist_m / R
    r_t, r_o = R + height_m, R + obs_m
    dx, dz = r_t * math.sin(dl), r_t * math.cos(dl) - r_o
    return math.degrees(math.atan2(dz, dx))


class SyntheticTerrain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.site = (-89.0, 30.0)  # 30 km from the pole, so everything fits on the 70 km-radius map
        cls.mesa_c = dest(*cls.site, 90.0, 40_000)

        def mesa(lat, lon):  # 3 km-high flat-topped mesa, radius 3 km, 40 km east of the site
            return 3000.0 if gc_dist(lat, lon, *cls.mesa_c) < 3000 else 0.0

        def ring(lat, lon):  # 1.5 km-high wall 30–32 km from the site in every direction
            return 1500.0 if 30_000 <= gc_dist(lat, lon, *cls.site) <= 32_000 else 0.0

        cls.mesa_img = write_map(cls.dir, "mesa", 700, 200.0, mesa)
        cls.ring_img = write_map(cls.dir, "ring", 700, 200.0, ring)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_label_parsing(self):
        d = H.Dem(self.mesa_img)
        self.assertEqual((d.lines, d.samples, d.scale, d.factor), (700, 700, 200.0, 0.5))
        self.assertTrue(d.south)

    def test_projection_round_trip(self):
        d = H.Dem(self.mesa_img)
        self.assertAlmostEqual(d.height(*self.mesa_c), 3000.0, delta=1.0)
        self.assertAlmostEqual(d.height(*self.site), 0.0, delta=1.0)

    def test_heights_are_scaled_with_or_without_numpy(self):
        d = H.Dem(self.mesa_img)
        self.assertAlmostEqual(d.height(*self.mesa_c), 3000.0, delta=1.0)
        saved = H.np
        try:
            H.np = None  # the pure-Python path (Windows installs usually lack numpy)
            d2 = H.Dem(self.mesa_img)
            self.assertAlmostEqual(d2.height(*self.mesa_c), 3000.0, delta=1.0)
        finally:
            H.np = saved

    def test_projection_puts_90e_on_the_right_seen_from_below(self):
        d = H.Dem(self.mesa_img)
        x0, y0 = d.xy(-89.0, 0.0)
        x90, _ = d.xy(-89.0, 90.0)
        self.assertLess(y0, 0)   # 0° longitude: towards smaller line numbers (top of the image)
        self.assertGreater(x90, 0)  # 90°E: larger sample numbers (right)

    def test_flat_sphere_horizon_is_the_geometric_dip(self):
        elev, h0 = H.horizon(H.Terrain([H.Dem(self.mesa_img)]), *self.site, az_step=10, max_km=60)
        dip = -math.degrees(math.acos(R / (R + 2.0)))
        self.assertAlmostEqual(elev[0], dip, delta=0.02)   # north: nothing but the sphere
        self.assertEqual(h0, 0.0)

    def test_mesa_appears_at_its_azimuth_with_the_right_elevation(self):
        elev, _ = H.horizon(H.Terrain([H.Dem(self.mesa_img)]), *self.site, az_step=1, max_km=60)
        want = expected_el(37_000, 3000.0)
        self.assertAlmostEqual(elev[90], want, delta=0.08)
        self.assertLess(max(elev[180:360]), 0.0)           # nothing to the west
        width = sum(1 for v in elev if v > 1.0)             # 6 km wide at ~40 km ≈ 9°
        self.assertTrue(6 <= width <= 11, width)

    def test_ring_wall_is_seen_all_around(self):
        elev, _ = H.horizon(H.Terrain([H.Dem(self.ring_img)]), *self.site, az_step=15, max_km=60)
        want = expected_el(30_000, 1500.0)
        for v in elev:
            self.assertAlmostEqual(v, want, delta=0.08)

    def test_orientation_check_recovers_a_mirrored_map(self):
        def landmarks(lat, lon):
            h = 0.0
            for _, la, lo, rad, kind in H.LANDMARKS:
                d = gc_dist(lat, lon, la, lo) / 1000
                if kind == "crater" and d < rad:
                    h -= 2000 * (1 - (d / rad) ** 2)
                if kind == "mountain" and d < 15:
                    h += 3000 * (1 - d / 15)
            return h
        good = H.Dem(write_map(self.dir, "lm", 520, 650.0, landmarks))
        self.assertEqual(H.check_orientation(good, verbose=False), (1, 1, False))
        flipped = H.Dem(write_map(self.dir, "lmx", 520, 650.0, landmarks, mirror_x=True))
        o = H.check_orientation(flipped, verbose=False)
        self.assertNotEqual(o, (1, 1, False))
        self.assertEqual(H.orientation_score(flipped)[0], H.orientation_score(flipped)[1])

    def test_build_writes_the_web_format(self):
        out = self.dir / "h.json"
        res = H.build([self.mesa_img], [{"id": "t", "lat": self.site[0], "lon": self.site[1]}], out, az_step=30, max_km=50, verbose=False)
        self.assertEqual(len(res["sites"]["t"]["elev"]), 12)
        self.assertIn("LOLA", res["meta"]["source"])
        self.assertTrue(out.exists())

    def test_preset_sites_are_read_from_the_app(self):
        ids = [s["id"] for s in H.preset_sites()]
        self.assertIn("im2", ids)
        self.assertIn("malapert", ids)
        self.assertIn("blueghost", ids)  # mid-latitude sites are read too; build() skips those outside the maps

    def test_sites_outside_the_maps_are_skipped(self):
        out = self.dir / "h2.json"
        res = H.build([self.mesa_img], [{"id": "t", "lat": self.site[0], "lon": self.site[1]}, {"id": "far", "lat": 18.56, "lon": 61.81}], out, az_step=60, max_km=20, verbose=False)
        self.assertIn("t", res["sites"])
        self.assertNotIn("far", res["sites"])
        self.assertEqual(res["meta"]["orientationChecks"][0]["map"], "mesa.img")


if __name__ == "__main__":
    unittest.main()


HORIZONS_JSON = Path(__file__).resolve().parents[1] / "web" / "data" / "horizons.json"


@unittest.skipUnless(HORIZONS_JSON.exists(), "real LOLA horizons not built (python server.py --build-terrain)")
class RealLolaHorizons(unittest.TestCase):
    """Sanity checks on horizons built from the real LOLA map: crater floors are walled in, summits see far."""

    @classmethod
    def setUpClass(cls):
        import json
        cls.data = json.loads(HORIZONS_JSON.read_text())
        cls.sites = cls.data["sites"]

    def test_shackleton_floor_is_surrounded_by_its_rim(self):
        elev = self.sites["shackleton"]["elev"]
        self.assertGreater(min(elev), 5.0, "a 4 km-deep, 21 km-wide crater walls in its floor")
        self.assertLess(self.sites["shackleton"]["heightM"], -2000)

    def test_mons_mouton_is_high_and_im2_sees_past_the_smooth_horizon(self):
        # Mons Mouton is a ~5 km-high massif; IM-2 landed on it. (The catalogued feature point is not
        # the exact summit, so its own skyline is not required to fall below 0° everywhere.)
        self.assertGreater(self.sites["mouton"]["heightM"], 4000)
        self.assertGreater(self.sites["im2"]["heightM"], 4000)
        dip = -math.degrees(math.acos(R / (R + 2.0)))
        self.assertLess(min(self.sites["im2"]["elev"]), dip, "from the massif some directions look down past the smooth horizon")

    def test_heights_match_known_relief(self):
        s = self.sites
        self.assertLess(s["shackleton"]["heightM"], s["pole"]["heightM"] - 3000, "Shackleton floor ~4 km below its rim (the pole)")
        self.assertGreater(min(s["shackleton"]["elev"]), 15.0, "21 km crater, ~4 km deep: walls rise ~20° from the floor")
        self.assertLess(max(s["shackleton"]["elev"]), 30.0)
        self.assertGreater(s["malapert"]["heightM"], 4000)

    def test_every_preset_site_was_built(self):
        ids = {s["id"] for s in H.preset_sites() if s["lat"] <= -76}  # LOLA polar maps cover the south polar cap
        self.assertTrue(ids <= set(self.sites), ids - set(self.sites))

    def test_orientation_was_confirmed_by_landmarks(self):
        for c in self.data["meta"].get("orientationChecks", []):
            if c["landmarksTested"]:
                self.assertEqual(c["orientation"], [1, 1, False], "the documented projection should need no correction")
                self.assertGreaterEqual(c["landmarksMatched"], c["landmarksTested"] - 1, c)
