"""Tests for the NASA PGDA pipeline: GeoTIFF reader, 5 m tiles, illumination maps, slopes, ring horizons
and the polar map — all on synthetic files written in the same formats as the real products."""
from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tools"))
sys.path.insert(0, str(HERE))
import geotiff as G  # noqa: E402
import horizons as H  # noqa: E402
import pgda as P  # noqa: E402
from test_horizons import write_map  # noqa: E402
from tiffwriter import write_tiff, lzw_encode  # noqa: E402

R = H.R_MOON_M
GEOKEYS = {1024: 1, 3072: 32767, 3075: 15, 3081: -90.0, 3095: 0.0, 3092: 1.0, 3082: 0.0, 3083: 0.0, 2057: 1737400.0}


def terrain_fn(lat, lon):
    """A smooth bump plus a tilted plane near (-89.45°, -137.3°) and craters at the landmarks."""
    h = 0.0
    for la, lo, rk, dep in [(-89.67, 129.78, 10.5, 4000), (-86.9, -4.0, 25.7, 3000), (-88.5, -87.1, 16.2, 2500), (-88.08, 111.29, 12.6, 2200),
                            (-85.28, 53.27, 36.0, 3500), (-84.9, -35.5, 50.0, 3800)]:
        d = gc(lat, lon, la, lo) / (rk * 1000)
        h += -dep * (1 - d * d) if d < 1 else 0
        h += 0.25 * dep * math.exp(-(((d - 1) / 0.25) ** 2))
    for la, lo, rk, hh in [(-84.6, 31.0, 18.0, 5000), (-86.0, 0.0, 16.0, 4800), (-89.45, -137.3, 6.0, 1500)]:
        h += hh * math.exp(-((gc(lat, lon, la, lo) / (rk * 1000)) ** 2))
    return h


def gc(lat1, lon1, lat2, lon2):
    a, b = H.unit(lat1, lon1), H.unit(lat2, lon2)
    return R * math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b)))))


def write_tile(path: Path, clat, clon, km=1.0, px=10.0, sign_y=1, offset=0.0, extra=None, compression=8, predictor=3):
    """A south-polar-stereographic GeoTIFF tile (PROJ convention X = ρ sin λ, Y = ρ cos λ unless sign_y = −1)."""
    rho = 2 * R * math.tan(math.radians(90 - abs(clat)) / 2)
    cx, cy = rho * math.sin(math.radians(clon)), sign_y * rho * math.cos(math.radians(clon))
    n = int(km * 1000 / px)
    x0, y0 = cx - n * px / 2, cy + n * px / 2
    vals = []
    for j in range(n):
        for i in range(n):
            X, Y = x0 + (i + 0.5) * px, y0 - (j + 0.5) * px
            rr = math.hypot(X, Y)
            lat = -(90 - math.degrees(2 * math.atan(rr / (2 * R))))
            lon = math.degrees(math.atan2(X, sign_y * Y))
            vals.append((extra(lat, lon, X, Y) if extra else terrain_fn(lat, lon)) - offset)
    write_tiff(path, n, n, vals, "f4", compression=compression, predictor=predictor, tile=(64, 64), pixel_scale=(px, px),
               tiepoint=(0, 0, 0, x0, y0, 0), geokeys=GEOKEYS, nodata=-3.4028226550889045e38)
    return path


class GeoTiffReader(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.w, self.h = 37, 23
        self.vals = [math.sin(i / 3.1) * 100 + (i % 37) * 0.5 for i in range(self.w * self.h)]

    def check(self, **kw):
        p = self.dir / "t.tif"
        dtype = kw.pop("dtype", "f4")
        vals = [int(v) for v in self.vals] if dtype == "i2" else self.vals
        write_tiff(p, self.w, self.h, vals, dtype, **kw)
        g = G.GeoTiff(p)
        import array
        ref = array.array("f" if dtype == "f4" else "h", vals)
        for r in range(self.h):
            for c in range(self.w):
                self.assertEqual(g.value(c, r), float(ref[r * self.w + c]), (kw, c, r))
        g.close()

    def test_every_supported_layout(self):
        for comp in (1, 5, 8, 32946, 32773):
            for big in (False, True):
                for bo in "<>":
                    self.check(compression=comp, byteorder=bo, big=big, rows_per_strip=5)
                    self.check(compression=comp, byteorder=bo, big=big, tile=(16, 16))
        for comp in (1, 5, 8):
            self.check(compression=comp, predictor=3, tile=(16, 16))
            self.check(compression=comp, predictor=2, dtype="i2", rows_per_strip=4)

    def test_lzw_round_trip_on_long_input(self):
        data = bytes((i * 7 + (i >> 5)) & 0xFF for i in range(70000))  # forces the 12-bit table and a reset
        self.assertEqual(G.lzw_decode(lzw_encode(data)), data)

    def test_unsupported_compression_names_the_fix(self):
        with self.assertRaises(G.TiffError) as cm:
            G.decompress(34887, b"")
        self.assertIn("gdal_translate", str(cm.exception))

    def test_nodata_and_georeference(self):
        p = self.dir / "g.tif"
        vals = [1.0] * 100
        vals[55] = -9999.0
        write_tiff(p, 10, 10, vals, "f4", pixel_scale=(5.0, 5.0), tiepoint=(0, 0, 0, 1000.0, 2000.0, 0), geokeys=GEOKEYS, nodata=-9999)
        g = G.GeoTiff(p)
        self.assertIsNone(g.value(5, 5))
        self.assertEqual(g.value(4, 5), 1.0)
        self.assertEqual(g.pixel_of(1002.5, 1997.5), (0.0, 0.0))  # centre of the first pixel (PixelIsArea)
        self.assertEqual(g.bounds(), (1000.0, 1950.0, 1050.0, 2000.0))
        pr = g.projection()
        self.assertEqual((pr["lat0"], pr["lon0"], pr["k0"], pr["radius"]), (-90.0, 0.0, 1.0, 1737400.0))
        # PixelIsPoint shifts the corner by half a pixel
        write_tiff(p, 10, 10, vals, "f4", pixel_scale=(5.0, 5.0), tiepoint=(0, 0, 0, 1000.0, 2000.0, 0), geokeys=GEOKEYS, point=True)
        self.assertEqual(G.GeoTiff(p).pixel_of(1000.0, 2000.0), (0.0, 0.0))


class Tiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        lola = cls.dir / "lola"
        lola.mkdir()
        cls.dem = H.Dem(write_map(lola, "coarse", 400, 400.0, terrain_fn))
        cls.coarse = H.Terrain([cls.dem])
        cls.site = (-89.45, -137.3)

    def tile(self, name, **kw):
        d = self.dir / "5m" / name
        d.mkdir(parents=True, exist_ok=True)
        kw.setdefault("km", 8.0); kw.setdefault("px", 40.0)
        return write_tile(d / f"{name}_final_adj_5mpp_surf.tif", *self.site, **kw)

    def test_calibration_keeps_the_proj_convention_and_heights(self):
        t = P.TileDem(self.tile("Site01"))
        c = t.calibrate(self.coarse)
        self.assertEqual(c["orientation"], [1, 1])
        self.assertTrue(c["ok"])
        self.assertEqual(c["offsetM"], 0.0)
        lat, lon = t.center()
        self.assertAlmostEqual(lat, self.site[0], 3)
        self.assertAlmostEqual(((lon - self.site[1] + 180) % 360) - 180, 0, 1)
        self.assertAlmostEqual(t.height(*self.site), terrain_fn(*self.site), delta=5.0)

    def test_calibration_detects_a_mirrored_layout_and_a_datum_offset(self):
        t = P.TileDem(self.tile("Site04", sign_y=-1, offset=-1737400.0 + 1737000.0))  # heights 400 m too high
        c = t.calibrate(self.coarse)
        self.assertEqual(c["orientation"], [1, -1])
        self.assertAlmostEqual(c["offsetM"], -400.0, delta=20)
        self.assertAlmostEqual(t.height(*self.site), terrain_fn(*self.site), delta=20)

    def test_tiles_join_the_terrain_stack_finest_first(self):
        tiles = P.load_tiles(self.dir / "5m", self.coarse, verbose=False)
        self.assertGreaterEqual(len(tiles), 1)
        T = H.Terrain([self.dem] + tiles)
        h, res = T.height(*self.site)
        self.assertEqual(res, 40.0)
        far = H.latlon(P._offset(*self.site, 90, 9000))
        self.assertEqual(T.height(*far)[1], 400.0, "outside the tile the LOLA grid takes over")

    def test_lander_slopes_on_a_known_plane(self):
        k = math.tan(math.radians(12))  # a 12° plane
        def plane(lat, lon, X, Y):
            return 1000 + k * X
        d = self.dir / "plane"
        d.mkdir(exist_ok=True)
        t = P.TileDem(write_tile(d / "Plane_final_adj_5mpp_surf.tif", *self.site, km=0.6, px=5.0, extra=plane))
        s = P.lander_slopes(t, *self.site, radius_m=50)
        self.assertAlmostEqual(s["slopeDeg"], 12.0, delta=0.2)
        self.assertAlmostEqual(s["p90"], 12.0, delta=0.3)
        self.assertEqual(s["fracBelow"]["10"], 0.0)
        self.assertEqual(s["fracBelow"]["15"], 1.0)


class Illumination(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        # brightness that follows height (crater floors dark), stored ×10000 like a scaled integer product
        sun = lambda la, lo: max(0.0, min(0.9, 0.3 + terrain_fn(la, lo) / 12000)) * 10000 * 0.5  # write_map stores value/0.5
        write_map(cls.dir, "AVGVISIB_75S_120M_201608", 260, 2400.0, sun)
        psr = lambda la, lo: (1.0 if terrain_fn(la, lo) < -1500 else 0.0) * 0.5
        write_map(cls.dir, "LPSR_75S_120M_201608", 260, 2400.0, psr)
        for stem in ("AVGVISIB_75S_120M_201608", "LPSR_75S_120M_201608"):
            img = cls.dir / f"{stem}.img"
            img.rename(cls.dir / f"{stem}.IMG")
            lbl = (cls.dir / f"{stem}.lbl").read_text().replace("SCALING_FACTOR = 0.5", "SCALING_FACTOR = 1")
            (cls.dir / f"{stem}.lbl").unlink()
            (cls.dir / f"{stem}.LBL").write_text(lbl)
        cls.maps = P.load_illumination(cls.dir, verbose=False)

    def test_scaling_is_found_and_orientation_confirmed(self):
        m = self.maps["sun"]
        self.assertEqual(m.norm, 10000.0)
        self.assertEqual(m.info["landmarksMatched"], m.info["landmarksTested"])
        self.assertGreater(m.info["landmarksTested"], 4)
        self.assertLess(m.value(-89.67, 129.78), 0.05, "Shackleton floor is dark")

    def test_psr_metrics(self):
        p = self.maps["psr"]
        self.assertTrue(p.is_psr(-89.67, 129.78))
        self.assertFalse(p.info["inverted"])
        inside = p.metrics(-89.67, 129.78, search_km=10)
        self.assertTrue(inside["inside"])
        self.assertEqual(inside["nearestKm"], 0.0)
        ridge = p.metrics(-89.45, -137.3, search_km=30)
        self.assertFalse(ridge["inside"])
        self.assertIsNotNone(ridge["nearestKm"])
        self.assertGreater(ridge["areaKm2Within20km"], 0)

    def test_site_reference_has_value_and_spread(self):
        ref = P.site_reference(self.maps, -86.0, 0.0)
        s = ref["sun"]
        self.assertLessEqual(s["min"], s["value"])
        self.assertGreaterEqual(s["max"], s["value"])
        self.assertIn("psr", ref)


class BuildAndMap(unittest.TestCase):
    def test_build_with_pgda_products_and_rings(self):
        d = Path(tempfile.mkdtemp())
        lola = d / "lola"
        lola.mkdir()
        img = write_map(lola, "coarse", 300, 400.0, terrain_fn)
        tiles = d / "5m" / "Site01"
        tiles.mkdir(parents=True)
        write_tile(tiles / "Site01_final_adj_5mpp_surf.tif", -89.45, -137.3, km=8.0, px=40.0)
        out = d / "h.json"
        res = H.build([img], [{"id": "t", "lat": -88.9, "lon": 30.0}], out, az_step=10, max_km=40, verbose=False,
                      tiles_dir=d / "5m", ring_n=3, ring_m=100.0, map_dir=d / "map")
        self.assertIn("pgda-site01", list(res["sites"]), "the tile adds a site")
        s = res["sites"]["pgda-site01"]
        self.assertEqual(s["resM"], 40.0)
        self.assertIn("lander", s["slope"])
        self.assertEqual(len(res["sites"]["t"]["ring"]), 3)
        self.assertEqual(len(res["sites"]["t"]["ring"][0]["elev"]), 360)
        self.assertTrue(res["meta"]["tiles"][0]["calibration"]["ok"])
        meta = json.loads((d / "map" / "polar-map.json").read_text())
        self.assertIn("terrain", meta["layers"])
        png = (d / "map" / "polar-terrain.png").read_bytes()
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")

    def test_ring_split_matches_a_full_ray_march(self):
        d = Path(tempfile.mkdtemp())
        dem = H.Dem(write_map(d, "m", 300, 1500.0, terrain_fn))
        T = H.Terrain([dem])
        lat, lon = -86.2, 3.0
        h0 = T.height(lat, lon)[0]
        approx = H.ring_horizons(T, lat, lon, h0, 150.0, 2, max_km=150, az_step=5.0)
        for (az, la, lo), r in zip(H.ring_points(lat, lon, 150.0, 2), approx):
            full, _ = H.horizon(T, la, lo, az_step=5.0, max_km=150)
            self.assertLess(max(abs(a - b) for a, b in zip(full, r["elev"])), 0.05)

    def test_png_writer(self):
        p = Path(tempfile.mkdtemp()) / "x.png"
        P.png_gray(p, 3, 2, [bytes([0, 128, 255]), bytes([1, 2, 3])])
        b = p.read_bytes()
        self.assertEqual(b[:8], b"\x89PNG\r\n\x1a\n")
        i = b.index(b"IDAT")
        n = int.from_bytes(b[i - 4:i], "big")
        self.assertEqual(zlib.decompress(b[i + 4:i + 4 + n]), b"\x00\x00\x80\xff\x00\x01\x02\x03")


if __name__ == "__main__":
    unittest.main()


HORIZONS_JSON = HERE.parent / "web" / "data" / "horizons.json"
_real = json.loads(HORIZONS_JSON.read_text()) if HORIZONS_JSON.exists() else {}


@unittest.skipUnless(_real.get("meta", {}).get("illumination"), "NASA PGDA illumination maps not built (python server.py --build-terrain)")
class RealPgdaProducts(unittest.TestCase):
    """Sanity checks on the real Mazarico et al. maps once they are installed."""

    def test_maps_were_read_the_right_way_round(self):
        il = _real["meta"]["illumination"]
        if "sun" in il and "bestAlternative" in il["sun"]:
            # the documented layout must match at least as many landmarks as any mirrored or rotated one.
            # (Not applied to the Earth map: Earth visibility depends on slope direction, not on peak vs
            # crater, so the landmark test does not apply; it shares the sunlight map's layout.)
            self.assertGreaterEqual(il["sun"]["landmarksMatched"], il["sun"]["bestAlternative"], il["sun"])
        if "psr" in il:
            self.assertFalse(il["psr"].get("inverted"), "permanent shadow should be flagged by non-zero values")
            self.assertLess(il["psr"]["flaggedFraction"], 0.2, "permanent shadow covers only a few percent of 80-90°S")

    def test_shackleton_floor_is_dark_and_shadowed(self):
        s = _real["sites"].get("shackleton", {}).get("pgda")
        if not s:
            self.skipTest("Shackleton not built")
        if "sun" in s:
            self.assertLess(s["sun"]["value"], 0.05)
        if "psr" in s:
            self.assertTrue(s["psr"]["inside"])

    def test_earth_map_sees_earth_from_the_near_side(self):
        # IM-1 (80°S, 1°E) sits on ground facing the Earth-side limb: Earth is in view almost all the time;
        # deep polar crater floors (Shackleton, Haworth, de Gerlache) never see Earth.
        sites = _real["sites"]
        e = lambda k: sites.get(k, {}).get("pgda", {}).get("earth", {}).get("value")
        if e("im1") is not None:
            self.assertGreater(e("im1"), 0.9)
        floors = [e(k) for k in ("shackleton", "haworth", "degerlache") if e(k) is not None]
        if floors:
            self.assertLess(max(floors), 0.05)

    def test_sunlit_ridges_beat_crater_floors(self):
        sites = _real["sites"]
        ridge = [sites[k]["pgda"]["sun"]["value"] for k in ("malapert", "mouton", "im2") if "sun" in sites.get(k, {}).get("pgda", {})]
        floor = [sites[k]["pgda"]["sun"]["value"] for k in ("shackleton", "haworth", "degerlache") if "sun" in sites.get(k, {}).get("pgda", {})]
        if ridge and floor:
            self.assertGreater(min(ridge), max(floor))


@unittest.skipUnless(_real.get("meta", {}).get("tiles"), "NASA PGDA 5 m tiles not built (python server.py --build-terrain --hires)")
class RealPgdaTiles(unittest.TestCase):
    def test_every_tile_agrees_with_lola(self):
        for t in _real["meta"]["tiles"]:
            self.assertTrue(t["calibration"]["ok"], t)
            self.assertLess(t["calibration"]["rmsM"], 80, t)

    def test_tile_sites_have_lander_slopes(self):
        for k, s in _real["sites"].items():
            if k.startswith("pgda-"):
                self.assertIn("lander", s["slope"], k)
                self.assertLess(s["slope"]["lander"]["slopeDeg"], 45, k)


class BestSpot(unittest.TestCase):
    def test_best_spot_is_flat_and_on_the_brightest_ground(self):
        d = Path(tempfile.mkdtemp())
        site = (-89.45, -137.3)
        k = math.tan(math.radians(20))
        def terrain(lat, lon, X, Y):  # steep everywhere except a flat shelf east of the centre
            return 1000.0 if X - X0 > 600 else 1000.0 + k * abs(Y - Y0)
        rho = 2 * R * math.tan(math.radians(90 - abs(site[0])) / 2)
        X0, Y0 = rho * math.sin(math.radians(site[1])), rho * math.cos(math.radians(site[1]))
        t = P.TileDem(write_tile(d / "S_final_adj_5mpp_surf.tif", *site, km=3.0, px=10.0, extra=terrain))

        class Sun:  # brighter further east
            def value(self, lat, lon):
                X, Y = t.proj_xy(lat, lon)
                return min(1.0, max(0.0, 0.5 + (X - X0) / 4000))
        lat, lon, how = P.best_spot(t, {"sun": Sun()}, max_slope=8, step_m=100, margin_m=300)
        X, Y = t.proj_xy(lat, lon)
        self.assertGreater(X - X0, 600, "on the flat shelf")
        self.assertLessEqual(how["p90SlopeDeg"], 8)
        self.assertIn("sunlight", how["rule"])
