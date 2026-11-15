"""Version 6 pipeline tests: one-file extraction from a remote zip (byte ranges, zip64), the PGDA 104
shape-from-shading maps, the 65°S illumination companion maps, the LOLA download fallback and the
extra GeoTIFF compressions. Everything runs on synthetic files and a local web server."""
from __future__ import annotations

import http.server
import lzma
import os
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tools"))
sys.path.insert(0, str(HERE))
import geotiff as G  # noqa: E402
import horizons as H  # noqa: E402
import pgda as P  # noqa: E402
from test_horizons import write_map  # noqa: E402
from test_pgda import terrain_fn, write_tile  # noqa: E402


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """A static server that honours single byte ranges (bytes=a-b and bytes=-n), like Zenodo."""
    no_range = False

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = Path(self.translate_path(self.path.split("?")[0]))
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        rng = self.headers.get("Range")
        if not rng or self.no_range:
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        a, b = rng.split("=", 1)[1].split("-")
        if a == "":
            start, end = max(0, len(data) - int(b)), len(data) - 1
        else:
            start, end = int(a), min(len(data) - 1, int(b) if b else len(data) - 1)
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.wfile.write(data[start:end + 1])


def serve(folder: Path, no_range=False):
    handler = type("H", (RangeHandler,), {"no_range": no_range})
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: handler(*a, directory=str(folder), **k))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


class RemoteZipReader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        cls.payload = os.urandom(300_000) + b"x" * 700_000
        with zipfile.ZipFile(cls.dir / "plain.zip", "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("README.txt", "hello")
            z.writestr("Region/Region_hillshade.tif", b"h" * 1000)
            z.writestr("Region/Region_SDEM_5mpp.tif", cls.payload)
        with zipfile.ZipFile(cls.dir / "z64.zip", "w", zipfile.ZIP_STORED) as z:
            with z.open("big/elev_dem.tif", "w", force_zip64=True) as fh:
                fh.write(cls.payload)
        cls.httpd, cls.url = serve(cls.dir)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_lists_members_and_extracts_a_deflated_one(self):
        z = P.RemoteZip(self.url + "plain.zip")
        self.assertEqual(len(z.members), 3)
        m = P.pick_sfs_dem(z.members)
        self.assertEqual(m["name"], "Region/Region_SDEM_5mpp.tif", "the hillshade is not taken for the elevation")
        out = z.extract(m, self.dir / "out" / "a.tif", chunk=65536)
        self.assertEqual(out.read_bytes(), self.payload)

    def test_zip64_stored_member(self):
        z = P.RemoteZip(self.url + "z64.zip")
        m = z.members[0]
        self.assertEqual(m["usize"], len(self.payload))
        self.assertEqual(z.extract(m, self.dir / "out" / "b.tif").read_bytes(), self.payload)

    def test_server_without_byte_ranges_is_reported(self):
        httpd, url = serve(self.dir, no_range=True)
        try:
            with mock.patch("shutil.which", return_value=None), self.assertRaises(P.RangeUnsupported):
                P.RemoteZip(url + "plain.zip")
        finally:
            httpd.shutdown()

    def test_dem_picker_ignores_derived_products(self):
        names = ["A/x_ortho.tif", "A/x_slope.tif", "A/x_dem_unc.tif", "A/x_dem.tif", "A/x_dem_hillshade.tif", "A/notes.pdf"]
        m = P.pick_sfs_dem([{"name": n, "usize": 10} for n in names])
        self.assertEqual(m["name"], "A/x_dem.tif")
        self.assertIsNone(P.pick_sfs_dem([{"name": "A/x_ortho.tif", "usize": 1}]))


class SfsDownloadAndBuild(unittest.TestCase):
    def test_download_sfs_writes_the_tile_and_its_contents_list(self):
        src, dest = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        tif = write_tile(src / "t.tif", -88.45, -87.1, km=4.0, px=40.0)
        with zipfile.ZipFile(src / "A3CLR22_2_Haworth.zip", "w", zipfile.ZIP_DEFLATED) as z:
            z.write(tif, "A3-Haworth/Haworth_sfs_dem.tif")
            z.writestr("A3-Haworth/Haworth_ortho.tif", b"o" * 100)
        httpd, url = serve(src)
        try:
            with mock.patch.object(P, "SFS_URLS", [url + "{name}"]):
                got = P.download_sfs(["Haworth"], dest=dest, verbose=False)
        finally:
            httpd.shutdown()
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0], dest / "A3-Haworth" / "A3-Haworth_sfs_5mpp_surf.tif")
        self.assertEqual(got[0].read_bytes(), tif.read_bytes())
        self.assertIn("Haworth_ortho.tif", (dest / "A3-Haworth" / "contents.txt").read_text())

    def test_build_adds_artemis_regions_and_prefers_sfs_slopes(self):
        d = Path(tempfile.mkdtemp())
        (d / "lola").mkdir()
        img = write_map(d / "lola", "coarse", 300, 400.0, terrain_fn)
        for folder, lat, lon in (("A3-Haworth", -88.45, -87.1), ("A3-Connecting_Ridge", -89.45, -137.3)):
            (d / "sfs" / folder).mkdir(parents=True)
            write_tile(d / "sfs" / folder / f"{folder}_sfs_5mpp_surf.tif", lat, lon, km=8.0, px=40.0)
        (d / "5m" / "Site01").mkdir(parents=True)
        write_tile(d / "5m" / "Site01" / "Site01_final_adj_5mpp_surf.tif", -89.45, -137.3, km=8.0, px=40.0)
        res = H.build([img], [], d / "h.json", az_step=10, max_km=40, verbose=False, tiles_dir=d / "5m", sfs_dir=d / "sfs", ring_n=0)
        ids = set(res["sites"])
        self.assertIn("a3-haworth", ids, "a region without a PGDA 78 site becomes a site")
        self.assertNotIn("a3-connecting-ridge", ids, "a region that overlaps PGDA Site01 refines it instead")
        self.assertIn("pgda-site01", ids)
        self.assertEqual(res["sites"]["pgda-site01"]["slope"]["lander"]["tile"], "A3-Connecting_Ridge", "SfS terrain is used first")
        self.assertIn("Artemis III", res["sites"]["a3-haworth"]["kind"])
        products = {t["site"]: t["product"] for t in res["meta"]["tiles"]}
        self.assertIn("104", products["A3-Haworth"])
        self.assertIn("78", products["Site01"])


class WideIlluminationAndDownloads(unittest.TestCase):
    def test_covering_falls_back_to_the_wide_map(self):
        class M:
            def __init__(self, ok, wide=None):
                self.ok, self.wide = ok, wide

            def raw(self, lat, lon, nearest=False):
                return 0.5 if self.ok(lat) else None
        wide = M(lambda lat: lat <= -65)
        primary = M(lambda lat: lat <= -75, wide)
        self.assertIs(P._covering(primary, -80, 0), primary)
        self.assertIs(P._covering(primary, -69.4, 32), wide)
        self.assertIsNone(P._covering(primary, -60, 0))

    def test_lola_download_falls_back_to_the_mit_archive(self):
        calls = []

        def fake(url, path):
            calls.append(url)
            if "pds-geosciences" in url:
                raise OSError("boom")
            return path
        with mock.patch.object(P, "fetch", fake):
            H.download("ldem_60s_240m", Path(tempfile.mkdtemp()))
        self.assertTrue(any(u.endswith("LDEM_60S_240M.IMG") and "imbrium.mit.edu" in u for u in calls))

    def test_lzma_and_zstd_strips(self):
        self.assertEqual(G.decompress(34925, lzma.compress(b"abc" * 100)), b"abc" * 100)
        try:
            from compression import zstd  # type: ignore
        except ImportError:
            try:
                import zstandard as zs  # type: ignore
            except ImportError:
                self.skipTest("no zstd codec in this Python")
            data = zs.ZstdCompressor().compress(b"z" * 500)
        else:
            data = zstd.compress(b"z" * 500)
        self.assertEqual(G.decompress(50000, data), b"z" * 500)


if __name__ == "__main__":
    unittest.main()
