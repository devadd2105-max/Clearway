"""Server tests (stdlib unittest; also runs under pytest): input validation, caching with
stale fallback, the telemetry relay and the HTTP endpoints, with all upstreams mocked."""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402

TLE = """ISS (ZARYA)
1 25544U 98067A   26277.51782528  .00016717  00000-0  30210-3 0  9993
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579 34567
"""


class Validation(unittest.TestCase):
    def test_tle_detection(self):
        self.assertTrue(server.looks_like_tle(TLE))
        self.assertFalse(server.looks_like_tle("No GP data found"))

    def test_group_names(self):
        self.assertTrue(server.GROUP_RE.match("cosmos-1408-debris"))
        for bad in ["../etc", "a", "UPPER", "x" * 60, "a b"]:
            self.assertFalse(server.GROUP_RE.match(bad), bad)
        with self.assertRaises(ValueError):
            server.get_catalog("../secret")

    def test_weather_query_is_sanitised(self):
        q = server.weather_query("latitude=28.5&longitude=-80.6&hourly=cape&evil=1&forecast_days=16")
        self.assertNotIn("evil", q)
        self.assertIn("latitude=28.5", q)
        with self.assertRaises(ValueError):
            server.weather_query("hourly=cape")

    def test_opensky_box(self):
        self.assertIn("lamin=33.000", server.opensky_query("lamin=33&lomin=-121&lamax=35&lomax=-119"))
        for bad in ["lamin=33", "lamin=35&lomin=-121&lamax=33&lomax=-119", "lamin=-60&lomin=-170&lamax=60&lomax=170"]:
            with self.assertRaises(ValueError):
                server.opensky_query(bad)

    def test_swpc_whitelist(self):
        with self.assertRaises(ValueError):
            server.get_swpc("/products/anything-else.json")

    def test_station_normalisation(self):
        out = server.normalise_stations([{"id": 1, "name": "A", "lat": "1.5", "lng": 2, "altitude": None, "min_horizon": 10}, {"id": 2}])
        self.assertEqual(out, [{"id": 1, "name": "A", "lat": 1.5, "lng": 2.0, "altitude": 0.0, "min_horizon": 10.0, "status": ""}])


class Caching(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(__file__).resolve().parent / "_cache_test"
        self.tmp.mkdir(exist_ok=True)
        self.patch = mock.patch.object(server, "CACHE", self.tmp)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        for p in self.tmp.glob("*"):
            p.unlink()
        self.tmp.rmdir()

    def test_fresh_fetch_then_hit(self):
        with mock.patch.object(server, "http_get", return_value=TLE.encode()) as g:
            body, state, _ = server.get_catalog("stations")
            self.assertEqual(state, "miss")
            body2, state2, _ = server.get_catalog("stations")
            self.assertEqual(state2, "hit")
            self.assertEqual(g.call_count, 1)
            self.assertEqual(body, body2)

    def test_stale_copy_served_when_upstream_fails(self):
        path = self.tmp / "stations.tle"
        path.write_text(TLE)
        old = time.time() - 3 * 3600
        os.utime(path, (old, old))
        with mock.patch.object(server, "http_get", side_effect=urllib.error.URLError("offline")):
            body, state, _ = server.get_catalog("stations")
        self.assertEqual(state, "stale")
        self.assertIn(b"25544", body)

    def test_error_page_is_not_cached(self):
        with mock.patch.object(server, "http_get", return_value=b"Invalid query"):
            with self.assertRaises(RuntimeError):
                server.get_catalog("stations")
        self.assertFalse((self.tmp / "stations.tle").exists())

    def test_memory_cache_stale_fallback(self):
        server._mem.pop("t:key", None)
        self.assertEqual(server.cached("t:key", 0, lambda: b"one"), b"one")
        self.assertEqual(server.cached("t:key", 0, lambda: (_ for _ in ()).throw(OSError("down"))), b"one")


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.daemon_threads = True
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as r:
            return r.status, r.headers, r.read()

    def test_static_and_health(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Clearway", body)
        status, _, body = self.get("/api/health")
        self.assertTrue(json.loads(body)["ok"])

    def test_bad_requests(self):
        for path in ["/api/catalog/..%2Fx", "/api/weather?hourly=x", "/api/opensky?lamin=1"]:
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self.get(path)
            self.assertEqual(ctx.exception.code, 400, path)

    def test_weather_proxy(self):
        with mock.patch.object(server, "http_get", return_value=b'{"hourly":{"time":[]}}'):
            status, _, body = self.get("/api/weather?latitude=1&longitude=2&hourly=cape")
        self.assertEqual(status, 200)
        self.assertIn(b"hourly", body)

    def test_telemetry_relay_round_trip(self):
        got = []

        def listen():
            with urllib.request.urlopen(self.base + "/api/telemetry/stream", timeout=5) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if line.startswith("data: "):
                        got.append(line[6:])
                        if len(got) == 2:
                            return

        t = threading.Thread(target=listen, daemon=True)
        t.start()
        time.sleep(0.4)
        payload = "CW,1,50,0,0,1000,21.0,101325\nnot telemetry\nCW,2,100,0,0,1000,21.0,101320,-55\n"
        req = urllib.request.Request(self.base + "/api/telemetry", data=payload.encode(), method="POST")
        urllib.request.urlopen(req, timeout=5).read()
        t.join(5)
        self.assertEqual(got, ["CW,1,50,0,0,1000,21.0,101325", "CW,2,100,0,0,1000,21.0,101320,-55"])


if __name__ == "__main__":
    unittest.main()


class Lunar(unittest.TestCase):
    CSV = """header
$$SOE
 2026-Nov-14 00:00,*, ,  126.627333,   1.258335,
 2026-Nov-14 06:00,*, ,  123.580728,   1.280122,
$$EOE
"""
    FIXED = """$$SOE
 2026-Nov-14 00:00 *   358.773423  -4.148545
 2027-Mar-02 00:00  i  331.729513  -0.433785
$$EOE"""

    def test_parse_horizons_csv_and_fixed_width(self):
        rows = server.parse_horizons(self.CSV)
        self.assertEqual(rows[0], {"t": 1794614400000, "az": 126.627333, "el": 1.258335})
        self.assertEqual(len(rows), 2)
        rows = server.parse_horizons(self.FIXED)
        self.assertEqual(rows[1]["el"], -0.433785)
        self.assertEqual(rows[1]["t"], 1803945600000)

    def test_horizons_params_validation(self):
        p = server.horizons_params("lat=-84.79&lon=-30&target=399&start=2026-11-14T00:00&stop=2026-11-15&step=6h")
        self.assertEqual(p["lon"], 330.0)
        self.assertEqual(p["start"], "2026-11-14 00:00")
        for bad in ["lat=x&lon=1", "lat=1&lon=1&target=301&start=2026-01-01&stop=2026-01-02", "lat=1&lon=1&start=tomorrow&stop=2026-01-02",
                    "lat=1&lon=1&start=2026-01-01&stop=2026-01-02&step=6x"]:
            with self.assertRaises(ValueError, msg=bad):
                server.horizons_params(bad)

    def test_horizons_proxy_builds_the_request_and_parses_rows(self):
        captured = {}

        def fake(url, timeout=30, headers=None):
            captured["url"] = url
            return json.dumps({"result": self.CSV}).encode()

        with mock.patch.object(server, "http_get", side_effect=fake):
            out = json.loads(server.get_horizons("lat=-89.5&lon=0&target=10&start=2026-11-14&stop=2026-11-15&step=6h"))
        self.assertIn("coord%40301", captured["url"])
        self.assertIn("SITE_COORD=%270.000000%2C-89.500000%2C0%27", captured["url"])
        self.assertEqual(len(out["rows"]), 2)

    def test_horizon_endpoint_without_maps(self):
        with mock.patch.object(server, "LOLA_DIR", Path("/nonexistent")):
            with self.assertRaises(FileNotFoundError):
                server.get_horizon("lat=-89&lon=0")

    def test_horizon_endpoint_uses_5m_tiles_and_reports_slopes(self):
        import tempfile
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_pgda import terrain_fn, write_tile
        from test_horizons import write_map
        d = Path(tempfile.mkdtemp())
        (d / "lola").mkdir()
        write_map(d / "lola", "coarse", 300, 400.0, terrain_fn)
        (d / "pgda" / "5m" / "Site01").mkdir(parents=True)
        write_tile(d / "pgda" / "5m" / "Site01" / "Site01_final_adj_5mpp_surf.tif", -89.45, -137.3, km=8.0, px=40.0)
        server._horizon_cache.clear()
        server._terrain.update(obj=None, maps=None)
        with mock.patch.object(server, "LOLA_DIR", d / "lola"), mock.patch.object(server, "PGDA_DIR", d / "pgda"):
            on = json.loads(server.get_horizon("lat=-89.45&lon=-137.3"))
            off = json.loads(server.get_horizon("lat=-88.9&lon=30"))
            with self.assertRaises(ValueError):
                server.get_horizon("lat=10&lon=0")
        self.assertEqual(on["resM"], 40.0)
        self.assertIn("lander", on["slope"])
        self.assertEqual(len(on["elev"]), 720)
        self.assertEqual(off["resM"], 400.0)
        self.assertNotIn("lander", off["slope"])
        self.assertIsNotNone(off["slope"]["regionalDeg"])
        server._horizon_cache.clear()
        server._terrain.update(obj=None, maps=None)
