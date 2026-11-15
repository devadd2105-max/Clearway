#!/usr/bin/env python3
"""Clearway — NASA PGDA lunar south-pole products (standard library only).

Adds three NASA Goddard Planetary Geodynamics Data Archive (PGDA) products to the terrain build:

1. LOLA polar illumination maps (Mazarico et al. 2011, Icarus 211, 1066-1081; PGDA product 69):
   average solar illumination and average Earth visibility over an 18.6-year nutation cycle, and the
   permanent-shadow map. Clearway samples them at every site and stores them as an independent
   reference: the app then recomputes the same 18.6-year averages with its own ephemeris and LOLA
   horizon and reports the measured difference (no agreement is assumed).
2. LOLA 5 m/pixel site maps (Barker et al.; PGDA product 78): surface elevation, slope and
   uncertainty GeoTIFFs around named south-pole sites. They give lander-scale slope and a sharper
   near-field horizon; the 240 m map still supplies distant terrain.
3. A south-polar map image (terrain shading, average sunlight, permanent shadow) for the app.

Every map is checked before use: map orientation against named craters and massifs, and each 5 m
tile against the 240 m LOLA map (projection convention and height datum), so a convention mismatch
is detected and reported instead of silently producing wrong numbers.
"""
from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import horizons as H  # noqa: E402
from geotiff import GeoTiff, TiffError  # noqa: E402

ROOT = HERE.parent
PGDA_DIR = ROOT / "data" / "pgda"
R = H.R_MOON_M

# Hosts for the identical illumination files, in order of preference:
#   1. NASA's PDS Geosciences Node (LOLA "extras" area: hosted by the PDS, lower-case file names)
#   2. the LOLA science team's archive at MIT (linked from NASA PGDA product 69)
ILLUM_HOSTS = [
    ("NASA PDS Geosciences Node", "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/img/{lower}"),
    ("LOLA team archive (MIT)", "http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/{upper}"),
]
ILLUM_TIF = "https://pgda.gsfc.nasa.gov/data/MoonIllumination/{name}.TIF"
ILLUM_PRODUCTS = {  # key → file stem pattern; {r} is the resolution tag
    "sun": "AVGVISIB_{band}_{res}M_201608",
    "earth": "AVGVISIB_{band}_{res}M_201608_EARTH",
    "psr": "LPSR_{band}_{res}M_201608",
}
ILLUM_RES = {"240": ("65S", "240"), "120": ("75S", "120"), "60": ("85S", "060")}

TILE_BASE = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{site}/{site}_final_adj_5mpp_{kind}.tif"
# PGDA 5 m sites (numbering follows Mazarico et al. 2011). Names from the PGDA product page.
TILE_SITES = {
    "Site01": "Connecting ridge", "Site04": "Shackleton rim", "Site06": "Nobile rim 1", "Site07": "Peak near Shackleton",
    "Site11": "de Gerlache rim", "Site20": "Leibnitz beta plateau", "Site23": "Malapert massif", "Site42": "de Gerlache-Kocher massif",
    "DM1": "Amundsen rim", "DM2": "Nobile rim 2", "SL2": "de Gerlache rim (SL2)", "SL3": "Connecting ridge extension",
    "LM1": "Shackleton rim B",
}
DEFAULT_TILES = ["Site01", "Site04", "Site06", "Site07", "Site11", "Site23"]

# NASA PGDA product 104 (Bertone et al., Planetary Science Journal, doi:10.3847/PSJ/ae5b70): 5 m/pixel
# shape-from-shading elevation models of the 13 Artemis III candidate landing regions (2022 list), built on
# the LOLA 5 m maps and sharpened with LRO camera (NAC) images. Archived on Zenodo (doi:10.5281/zenodo.17954508)
# as one zip per region (1.1-4.4 GB each, 26.6 GB in total); Clearway reads only the elevation GeoTIFF
# out of each zip with HTTP range requests, so it downloads tens of MB per region instead of gigabytes.
SFS_RECORD = "17954508"
SFS_URLS = [
    "https://zenodo.org/api/records/{rec}/files/{name}/content",
    "https://zenodo.org/records/{rec}/files/{name}?download=1",
]
# (zip index, region name, folder, existing PGDA 5 m site covering the same region or None)
SFS_REGIONS = [
    (0, "Amundsen_Rim", "A3-Amundsen_Rim", None), (1, "Nobile_Rim_2", "A3-Nobile_Rim_2", None),
    (2, "Haworth", "A3-Haworth", None), (3, "Faustini_Rim_A", "A3-Faustini_Rim_A", None),
    (4, "deGerlache_Rim_2", "A3-deGerlache_Rim_2", None), (5, "Connecting_Ridge_Extension", "A3-Connecting_Ridge_Extension", None),
    (6, "Connecting_Ridge", "A3-Connecting_Ridge", "Site01"), (7, "Nobile_Rim_1", "A3-Nobile_Rim_1", "Site06"),
    (8, "Peak_Near_Shackleton", "A3-Peak_Near_Shackleton", "Site07"), (9, "deGerlache_Rim", "A3-deGerlache_Rim", "Site11"),
    (10, "Leibnitz_Beta_Plateau", "A3-Leibnitz_Beta_Plateau", None), (11, "Malapert_Massif", "A3-Malapert_Massif", "Site23"),
    (12, "deGerlache_Kocher_Massif", "A3-deGerlache_Kocher_Massif", None),
]
SFS_OVERLAP = {folder: site for _, _, folder, site in SFS_REGIONS}
SFS_LABELS = {
    "A3-Amundsen_Rim": "Amundsen Rim", "A3-Nobile_Rim_2": "Nobile Rim 2", "A3-Haworth": "Haworth (region)",
    "A3-Faustini_Rim_A": "Faustini Rim A", "A3-deGerlache_Rim_2": "de Gerlache Rim 2",
    "A3-Connecting_Ridge_Extension": "Connecting Ridge Extension", "A3-Connecting_Ridge": "Connecting Ridge (SfS)",
    "A3-Nobile_Rim_1": "Nobile Rim 1 (SfS)", "A3-Peak_Near_Shackleton": "Peak Near Shackleton (SfS)",
    "A3-deGerlache_Rim": "de Gerlache Rim (SfS)", "A3-Leibnitz_Beta_Plateau": "Leibnitz Beta Plateau",
    "A3-Malapert_Massif": "Malapert Massif (SfS)", "A3-deGerlache_Kocher_Massif": "de Gerlache\u2013Kocher Massif",
}
TILE_KINDS = ["surf"]  # elevation only by default (slopes are computed from it); the rest are optional:
ALL_TILE_KINDS = ["surf", "slp", "toterr", "slperr"]  # + PGDA slope, height uncertainty, slope uncertainty


# ---------------------------------------------------------------------------- downloads
def fetch(url: str, target: Path, quiet: bool = False) -> Path:
    """Download url → target (skips files already present). Falls back to the system curl, which
    uses the operating system's certificate store and can resume interrupted transfers."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return target
    part = target.with_name(target.name + ".part")
    if not quiet:
        print(f"  downloading {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Clearway/4.0"})
        with urllib.request.urlopen(req, timeout=180) as r, open(part, "wb") as fh:
            total = int(r.headers.get("Content-Length") or 0)
            got, last = 0, time.time()
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
                got += len(chunk)
                if not quiet and total > 20e6 and time.time() - last > 5:
                    print(f"    {got / 1e6:.0f} / {total / 1e6:.0f} MB")
                    last = time.time()
        if total and part.stat().st_size != total:
            raise IOError(f"incomplete download ({part.stat().st_size} of {total} bytes)")
    except Exception as exc:  # noqa: BLE001
        curl = shutil.which("curl.exe") or shutil.which("curl")
        if not curl:
            part.unlink(missing_ok=True)
            raise
        if not quiet:
            print(f"  Python download failed ({exc}); retrying with the system curl")
        subprocess.run([curl, "-fL", "--progress-bar", "--retry", "3", "-C", "-", "-o", str(part), url], check=True)
    part.replace(target)
    return target


def download_illumination(res: str = "120", dest: Path = PGDA_DIR / "illumination") -> dict:
    """Download the Mazarico et al. average-sun, average-Earth and permanent-shadow maps.
    Returns {key: path} for the products that could be fetched."""
    band, rtag = ILLUM_RES[res]
    out = {}
    for key, pat in ILLUM_PRODUCTS.items():
        name = pat.format(band=band, res=rtag)
        img, lbl = dest / f"{name}.IMG", dest / f"{name}.LBL"
        side = dest / f"{name}.source.txt"
        if img.exists() and img.stat().st_size > 0 and not side.exists():
            side.write_text("Downloaded by an earlier Clearway build (identical files are hosted by NASA's PDS Geosciences Node and the LOLA team archive)\n")
        for host, pattern in ILLUM_HOSTS:
            try:
                fetch(pattern.format(lower=f"{name.lower()}.lbl", upper=f"{name}.LBL"), lbl)
                fetch(pattern.format(lower=f"{name.lower()}.img", upper=f"{name}.IMG"), img)
                out[key] = img
                if not (dest / f"{name}.source.txt").exists():
                    (dest / f"{name}.source.txt").write_text(f"{host}\n{pattern.format(lower=name.lower() + '.img', upper=name + '.IMG')}\n")
                break
            except Exception as exc:  # noqa: BLE001
                print(f"  {name}: not available from {host} ({exc}); trying the next host")
        if key not in out:
            try:
                out[key] = fetch(ILLUM_TIF.format(name=name), dest / f"{name}.TIF")
                (dest / f"{name}.source.txt").write_text(f"NASA PGDA\n{ILLUM_TIF.format(name=name)}\n")
            except Exception as exc2:  # noqa: BLE001
                print(f"  {name}: not downloaded ({exc2}); the cross-check will skip it")
    return out


def illumination_source(path: Path) -> str:
    """Where an illumination file came from (recorded at download; files already present are identical
    copies of the same Mazarico et al. product, so they are attributed to NASA's PDS by default)."""
    side = Path(path).with_name(Path(path).stem + ".source.txt")
    if side.exists():
        return side.read_text().splitlines()[0]
    return "NASA PDS Geosciences Node / LOLA team archive (identical files)"


def download_tiles(sites=None, kinds=None, dest: Path = PGDA_DIR / "5m") -> list[Path]:
    """Download PGDA 5 m/pixel site maps. Returns the folders that hold at least a surface map."""
    folders = []
    for site in sites or DEFAULT_TILES:
        got = False
        for kind in kinds or TILE_KINDS:
            try:
                fetch(TILE_BASE.format(site=site, kind=kind), dest / site / f"{site}_final_adj_5mpp_{kind}.tif")
                got = got or kind == "surf"
            except Exception as exc:  # noqa: BLE001
                print(f"  {site} {kind}: not downloaded ({exc})")
                if kind == "surf":
                    break
        if got:
            folders.append(dest / site)
    return folders


# ---------------------------------------------------------------------------- PGDA 104: one file out of a remote zip
class RangeUnsupported(IOError):
    """The server answered a byte-range request with the whole file (or not at all)."""


def fetch_range(url: str, start: int | None = None, end: int | None = None, suffix: int | None = None) -> tuple[bytes, int | None]:
    """Bytes start..end (inclusive), or the last `suffix` bytes, of url. Returns (data, total size).
    Uses urllib, then the system curl (operating-system certificates) if urllib fails."""
    rng = f"bytes=-{suffix}" if suffix else f"bytes={start}-{end}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Clearway/6.0", "Range": rng})
        with urllib.request.urlopen(req, timeout=180) as r:
            if r.status != 206:
                raise RangeUnsupported(f"server ignored the byte range (HTTP {r.status})")
            total = r.headers.get("Content-Range", "").rpartition("/")[2]
            return r.read(), int(total) if total.isdigit() else None
    except RangeUnsupported:
        raise
    except Exception:  # noqa: BLE001 - certificate or proxy problems: try curl
        curl = shutil.which("curl.exe") or shutil.which("curl")
        if not curl:
            raise
        res = subprocess.run([curl, "-sSL", "-r", rng.split("=", 1)[1], "-D", "-", "-o", "-", url], capture_output=True, check=True)
        head, _, body = res.stdout.partition(b"\r\n\r\n")
        while head.startswith(b"HTTP/") and b" 30" in head.split(b"\r\n", 1)[0]:  # skip redirect headers
            head, _, body = body.partition(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0]
        if b" 206" not in status:
            raise RangeUnsupported(f"server ignored the byte range ({status.decode(errors='replace')})")
        total = None
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"content-range:"):
                t = line.rpartition(b"/")[2].strip()
                total = int(t) if t.isdigit() else None
        return body, total


class RemoteZip:
    """Read the directory of a zip on a web server and extract single members with byte-range requests
    (zip and zip64; stored or deflated members)."""

    def __init__(self, url: str):
        self.url = url
        tail, self.size = fetch_range(url, suffix=65536 + 22)
        i = tail.rfind(b"PK\x05\x06")
        if i < 0:
            raise IOError("not a zip file (end of central directory not found)")
        _, _, _, _, n_total, cd_size, cd_off, _ = struct.unpack("<4sHHHHIIH", tail[i:i + 22])
        if cd_off == 0xFFFFFFFF or cd_size == 0xFFFFFFFF or n_total == 0xFFFF:
            j = tail.rfind(b"PK\x06\x07", 0, i)
            if j < 0:
                raise IOError("zip64 locator not found")
            _, _, z64_off, _ = struct.unpack("<4sIQI", tail[j:j + 20])
            z64, _ = fetch_range(url, z64_off, z64_off + 55)
            (_, _, _, _, _, _, _, n_total, cd_size, cd_off) = struct.unpack("<4sQHHIIQQQQ", z64[:56])
        cd, _ = fetch_range(url, cd_off, cd_off + cd_size - 1)
        self.members = []
        p = 0
        while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
            (_, _, _, flags, method, _, _, _, csize, usize, nlen, xlen, clen, _, _, _, lho) = struct.unpack("<4sHHHHHHIIIHHHHHII", cd[p:p + 46])
            name = cd[p + 46:p + 46 + nlen].decode("utf-8" if flags & 0x800 else "cp437")
            extra = cd[p + 46 + nlen:p + 46 + nlen + xlen]
            q = 0
            while q + 4 <= len(extra):  # zip64 extended information
                hid, hlen = struct.unpack("<HH", extra[q:q + 4])
                if hid == 0x0001:
                    vals = list(struct.unpack(f"<{hlen // 8}Q", extra[q + 4:q + 4 + (hlen // 8) * 8]))
                    if usize == 0xFFFFFFFF and vals: usize = vals.pop(0)
                    if csize == 0xFFFFFFFF and vals: csize = vals.pop(0)
                    if lho == 0xFFFFFFFF and vals: lho = vals.pop(0)
                q += 4 + hlen
            self.members.append({"name": name, "method": method, "csize": csize, "usize": usize, "offset": lho})
            p += 46 + nlen + xlen + clen

    def extract(self, member: dict, target: Path, chunk: int = 32 << 20) -> Path:
        """Download and decompress one member into target (resumes nothing; writes .part then renames)."""
        if member["method"] not in (0, 8):
            raise IOError(f"{member['name']}: compression method {member['method']} is not supported")
        head, _ = fetch_range(self.url, member["offset"], member["offset"] + 29)
        if head[:4] != b"PK\x03\x04":
            raise IOError("bad local header")
        nlen, xlen = struct.unpack("<HH", head[26:30])
        start = member["offset"] + 30 + nlen + xlen
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".part")
        z = zlib.decompressobj(-15) if member["method"] == 8 else None
        with open(part, "wb") as fh:
            pos, end = start, start + member["csize"] - 1
            while pos <= end:
                data, _ = fetch_range(self.url, pos, min(end, pos + chunk - 1))
                fh.write(z.decompress(data) if z else data)
                pos += len(data)
            if z:
                fh.write(z.flush())
        if part.stat().st_size != member["usize"]:
            part.unlink(missing_ok=True)
            raise IOError(f"{member['name']}: size mismatch after extraction")
        part.replace(target)
        return target


_NOT_DEM = ("hillshade", "shade", "ortho", "mosaic", "coverage", "cover", "bin", "resolution", "res_", "diff", "minus",
            "slope", "slp", "vrm", "rough", "mask", "count", "err", "unc", "std", "sigma", "illum", "image", "nac", "ldem")


def pick_sfs_dem(members: list[dict]) -> dict | None:
    """The shape-from-shading elevation raster among a region's files: a GeoTIFF whose name says
    SDEM / DEM / elevation and none of the derived products; the largest such file if several."""
    tifs = [m for m in members if m["name"].lower().endswith((".tif", ".tiff")) and not m["name"].endswith("/")]
    def ok(m):
        n = m["name"].lower().rsplit("/", 1)[-1]
        return any(k in n for k in ("sdem", "dem", "elev", "height", "surf")) and not any(k in n for k in _NOT_DEM)
    cands = [m for m in tifs if ok(m)]
    return max(cands, key=lambda m: m["usize"]) if cands else None


def download_sfs(regions=None, dest: Path = PGDA_DIR / "sfs", max_mb: float = 1500.0, verbose: bool = True) -> list[Path]:
    """Extract the elevation GeoTIFF of each Artemis III region from NASA PGDA product 104 (Zenodo).
    Writes dest/<folder>/<folder>_sfs_5mpp_surf.tif and a contents.txt listing everything in the zip."""
    out = []
    for idx, region, folder, _ in SFS_REGIONS:
        if regions and region not in regions and folder not in regions:
            continue
        target = dest / folder / f"{folder}_sfs_5mpp_surf.tif"
        if target.exists() and target.stat().st_size > 0:
            out.append(target)
            continue
        name = f"A3CLR22_{idx}_{region}.zip"
        last = None
        for pattern in SFS_URLS:
            url = pattern.format(rec=SFS_RECORD, name=name)
            try:
                z = RemoteZip(url)
                (dest / folder).mkdir(parents=True, exist_ok=True)
                (dest / folder / "contents.txt").write_text("\n".join(f"{m['usize']:>14,}  {m['name']}" for m in z.members) + "\n")
                m = pick_sfs_dem(z.members)
                if not m:
                    raise IOError(f"no elevation GeoTIFF recognised among {len(z.members)} files (see {folder}/contents.txt)")
                if m["usize"] > max_mb * 1e6:
                    raise IOError(f"{m['name']} is {m['usize'] / 1e6:.0f} MB, above the {max_mb:.0f} MB limit")
                if verbose:
                    print(f"  {region}: {m['name']} ({m['csize'] / 1e6:.0f} MB of a {z.size / 1e9 if z.size else 0:.1f} GB zip)")
                z.extract(m, target)
                (dest / folder / "source.txt").write_text(f"NASA PGDA product 104 via Zenodo {SFS_RECORD}\n{url}\n{m['name']}\n")
                out.append(target)
                last = None
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
        if last is not None and verbose:
            print(f"  {region}: not downloaded ({last})")
    return out


# ---------------------------------------------------------------------------- 5 m tiles
class TileDem:
    """A PGDA 5 m/pixel GeoTIFF elevation tile with the Dem interface used by horizons.Terrain.

    Projection: south polar stereographic on a 1737.4 km sphere, true scale at the pole, X/Y in metres
    (PGDA product 78). The X/Y sign convention and the height datum are confirmed against the 240 m
    LOLA map by calibrate(); orientation (sx, sy) multiplies (ρ sin λ, ρ cos λ)."""

    def __init__(self, path: Path, name: str | None = None):
        self.path = Path(path)
        self.tif = GeoTiff(self.path)
        if not self.tif.georeferenced:
            raise TiffError(f"{self.path.name} has no georeferencing")
        self.proj = self.tif.projection()
        self.scale = abs(self.tif.sx)
        self.orientation = (1, 1)
        self.offset = 0.0  # metres added to reach heights above the 1737.4 km sphere
        self.unit = 1.0
        self.site = name or self.path.parent.name
        self.label = TILE_SITES.get(self.site) or SFS_LABELS.get(self.site, self.site)
        self.product = "PGDA 104 (shape-from-shading)" if self.site in SFS_LABELS else "PGDA 78 (LOLA 5 m)"
        x0, y0, x1, y1 = self.tif.bounds()
        self.box = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        self.calibration: dict = {}
        self.extra: dict[str, GeoTiff] = {}
        for kind in ("slp", "toterr", "slperr"):
            p = self.path.with_name(self.path.name.replace("_surf.tif", f"_{kind}.tif"))
            if p.exists() and p != self.path:
                try:
                    self.extra[kind] = GeoTiff(p)
                except (TiffError, OSError) as exc:
                    print(f"  {p.name}: unreadable ({exc})")

    def proj_xy(self, lat: float, lon: float) -> tuple[float, float]:
        p = self.proj
        rho = 2 * p["radius"] * p["k0"] * math.tan(math.radians(90 - abs(lat)) / 2)
        dl = math.radians(lon - p["lon0"])
        sx, sy = self.orientation
        return p["fe"] + sx * rho * math.sin(dl), p["fn"] + sy * rho * math.cos(dl)

    def latlon(self, x: float, y: float) -> tuple[float, float]:
        p = self.proj
        sx, sy = self.orientation
        u, v = (x - p["fe"]) * sx, (y - p["fn"]) * sy
        rho = math.hypot(u, v)
        lat = -(90 - math.degrees(2 * math.atan(rho / (2 * p["radius"] * p["k0"]))))
        lon = p["lon0"] + math.degrees(math.atan2(u, v))
        return lat, ((lon + 180) % 360) - 180

    def _inside(self, x, y) -> bool:
        b = self.box
        return b[0] <= x <= b[2] and b[1] <= y <= b[3]

    def height(self, lat: float, lon: float):
        x, y = self.proj_xy(lat, lon)
        if not self._inside(x, y):
            return None
        v = self.tif.bilinear(*self.tif.pixel_of(x, y))
        return None if v is None else v * self.unit + self.offset

    def sample(self, kind: str, lat: float, lon: float):
        g = self.extra.get(kind)
        if g is None:
            return None
        x, y = self.proj_xy(lat, lon)
        return g.bilinear(*g.pixel_of(x, y))

    def center(self) -> tuple[float, float]:
        return self.latlon(*self.tif.center_xy())

    def calibrate(self, coarse: "H.Terrain", n: int = 15) -> dict:
        """Choose the X/Y sign convention and height datum that make this tile agree with the
        coarser LOLA map, and record how well it agrees."""
        x0, y0, x1, y1 = self.box
        pts = [(x0 + (x1 - x0) * (i + 0.5) / n, y0 + (y1 - y0) * (j + 0.5) / n) for i in range(n) for j in range(n)]
        raw = []
        for x, y in pts:
            v = self.tif.bilinear(*self.tif.pixel_of(x, y))
            if v is not None:
                raw.append((x, y, v))
        if len(raw) < 10:
            raise ValueError(f"{self.path.name}: too few valid pixels to calibrate")
        best, cands = None, {}
        for o in [(1, 1), (1, -1), (-1, 1), (-1, -1)]:
            self.orientation = o
            diffs = []
            for x, y, v in raw:
                lat, lon = self.latlon(x, y)
                c, _ = coarse.height(lat, lon)
                if c is not None:
                    diffs.append((v, c))
            if len(diffs) < 10:
                continue
            # a tile stored in km, or as radius instead of height, is converted here
            vs = sorted(d[0] for d in diffs)
            unit = 1000.0 if max(abs(vs[0]), abs(vs[-1])) < 30 and max(abs(d[1]) for d in diffs) > 300 else 1.0
            off = median([d[1] - d[0] * unit for d in diffs])
            if abs(off) < 150:
                off = 0.0  # same datum: keep the published heights untouched
            rms = math.sqrt(sum((d[0] * unit + off - d[1]) ** 2 for d in diffs) / len(diffs))
            # correlation of the detrended heights distinguishes mirrored layouts robustly
            corr = correlation([d[0] for d in diffs], [d[1] for d in diffs])
            cand = {"orientation": list(o), "offsetM": round(off, 1), "unit": unit, "rmsM": round(rms, 1), "corr": round(corr, 3), "points": len(diffs)}
            cands[o] = cand
            if best is None or (corr, -rms) > (best["corr"], -best["rmsM"]):
                best = cand
        if best is None:
            raise ValueError(f"{self.path.name}: lies outside the coarse LOLA maps")
        # keep the documented PROJ convention unless another layout is clearly better: a tile only a few
        # coarse pixels wide cannot discriminate by correlation alone
        default = cands.get((1, 1))
        if default and best is not default and (best["corr"] - default["corr"] < 0.15 or default["corr"] > 0.9):
            best = default
        self.orientation = tuple(best["orientation"])
        self.offset, self.unit = best["offsetM"], best["unit"]
        best["ok"] = best["corr"] > 0.8
        self.calibration = best
        return best


def median(xs):
    s = sorted(xs)
    return 0.0 if not s else (s[len(s) // 2] if len(s) % 2 else (s[len(s) // 2 - 1] + s[len(s) // 2]) / 2)


def correlation(a, b) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def load_tiles(folder: Path = PGDA_DIR / "5m", coarse: "H.Terrain | None" = None, verbose: bool = True) -> list[TileDem]:
    tiles = []
    for surf in sorted(Path(folder).glob("*/*_5mpp_surf.tif")) if folder and Path(folder).exists() else []:
        try:
            t = TileDem(surf)
        except (TiffError, OSError, KeyError) as exc:
            if verbose:
                print(f"  {surf.name}: skipped ({exc})")
            continue
        if coarse is not None:
            try:
                c = t.calibrate(coarse)
            except ValueError as exc:
                if verbose:
                    print(f"  {surf.name}: skipped ({exc})")
                continue
            if verbose:
                datum = f", datum offset {c['offsetM']:+.0f} m" if c["offsetM"] else ""
                verdict = "" if c["ok"] else " — POOR AGREEMENT: tile not used"
                print(f"  5 m {'SfS map' if t.site in SFS_LABELS else 'tile'} {t.site} ({t.label}): {t.tif.width}×{t.tif.height} px · vs LOLA map: "
                      f"correlation {c['corr']:.3f}, RMS {c['rmsM']:.0f} m{datum}{verdict}")
            if not c["ok"]:
                continue
        tiles.append(t)
    return tiles


# ---------------------------------------------------------------------------- slopes
def slope_at(height, lat: float, lon: float, base_m: float) -> float | None:
    """Slope (deg) from central differences with a baseline of 2 × base_m, using a height(lat, lon) callable."""
    pts = {}
    for name, az in (("n", 0), ("s", 180), ("e", 90), ("w", 270)):
        q = H.latlon(_offset(lat, lon, az, base_m))
        pts[name] = height(*q)
    if any(v is None for v in pts.values()):
        return None
    gx = (pts["e"] - pts["w"]) / (2 * base_m)
    gy = (pts["n"] - pts["s"]) / (2 * base_m)
    return math.degrees(math.atan(math.hypot(gx, gy)))


def _offset(lat, lon, az_deg, dist_m):
    e, n, u = H.enu(lat, lon)
    a = math.radians(az_deg)
    t = [math.cos(a) * n[i] + math.sin(a) * e[i] for i in range(3)]
    dl = dist_m / R
    return [math.cos(dl) * u[i] + math.sin(dl) * t[i] for i in range(3)]


def lander_slopes(tile: TileDem, lat: float, lon: float, radius_m: float = 100.0, step_m: float = 5.0) -> dict:
    """Lander-scale slopes from a 5 m tile: at the site and across a landing circle of radius_m."""
    h = tile.height
    at = slope_at(h, lat, lon, step_m)
    vals = []
    k = int(radius_m // step_m)
    e, n, u = H.enu(lat, lon)
    for i in range(-k, k + 1):
        for j in range(-k, k + 1):
            if i * i + j * j > k * k:
                continue
            d = math.hypot(i, j) * step_m
            az = math.degrees(math.atan2(i, j)) if d else 0.0
            q = H.latlon(_offset(lat, lon, az, d)) if d else (lat, lon)
            s = slope_at(h, q[0], q[1], step_m)
            if s is not None:
                vals.append(s)
    vals.sort()
    if not vals:
        return {}
    pct = lambda p: vals[min(len(vals) - 1, int(p * len(vals)))]
    out = {
        "slopeDeg": None if at is None else round(at, 2), "baselineM": 2 * step_m, "radiusM": radius_m, "samples": len(vals),
        "p50": round(pct(0.5), 2), "p90": round(pct(0.9), 2), "max": round(vals[-1], 2),
        "fracBelow": {str(lim): round(sum(v < lim for v in vals) / len(vals), 4) for lim in (5, 8, 10, 12, 15, 20)},
        "tile": tile.site, "tileName": tile.label, "source": f"NASA {tile.product} {tile.scale:g} m/pixel ({tile.path.name})",
    }
    for kind, key in (("slp", "pgdaSlopeDeg"), ("slperr", "slopeErrDeg"), ("toterr", "heightErrM")):
        v = tile.sample(kind, lat, lon)
        if v is not None:
            out[key] = round(v, 2)
    return out


def best_spot(tile: TileDem, maps: dict, max_slope: float = 8.0, step_m: float = 100.0, margin_m: float = 400.0, shortlist: int = 40):
    """The best landing point inside a 5 m tile: the highest NASA average sunlight among points whose
    ground within 50 m stays below max_slope (90th percentile, 5 m map). Without the sunlight map the
    flattest high point is used. Returns (lat, lon, info) or None."""
    x0, y0, x1, y1 = tile.box
    cands = []
    sun = maps.get("sun")
    nx, ny = int((x1 - x0 - 2 * margin_m) // step_m), int((y1 - y0 - 2 * margin_m) // step_m)
    for i in range(nx + 1):
        for j in range(ny + 1):
            x, y = x0 + margin_m + i * step_m, y0 + margin_m + j * step_m
            lat, lon = tile.latlon(x, y)
            s = slope_at(tile.height, lat, lon, 5.0)
            if s is None or s > max_slope:
                continue
            v = sun.value(lat, lon) if sun else None
            h = tile.height(lat, lon)
            cands.append(((v if v is not None else -1.0), h or 0.0, -s, lat, lon))
    if not cands:
        return None
    cands.sort(reverse=True)
    for v, h, ns, lat, lon in cands[:shortlist]:
        ls = lander_slopes(tile, lat, lon, radius_m=50.0)
        if ls and ls["p90"] <= max_slope:
            return lat, lon, {"rule": f"highest NASA average sunlight with 90% of the ground within 50 m below {max_slope:g}°" if sun else f"highest point with 90% of the ground within 50 m below {max_slope:g}°",
                              "pgdaSun": None if v < 0 else round(v, 4), "p90SlopeDeg": ls["p90"], "candidates": len(cands)}
    return None


# ---------------------------------------------------------------------------- illumination maps
class ValueMap:
    """A Mazarico et al. illumination product (PDS IMG with label, or GeoTIFF) sampled by lat/lon.
    Values are normalised to fractions 0–1 (the scaling is reported, not assumed)."""

    def __init__(self, path: Path, kind: str):
        self.path, self.kind = Path(path), kind
        if self.path.suffix.lower() == ".img":
            self.dem = H.Dem(self.path)
            self.tile = None
            self.scale = self.dem.scale
        else:
            self.dem = None
            self.tile = TileDem(self.path)
            self.scale = self.tile.scale
        self.norm = 1.0
        self.notes = []

    def raw(self, lat: float, lon: float, nearest: bool = False):
        if self.dem is not None:
            x, y = self.dem.xy(lat, lon)
            if not self.dem.covers(x, y):
                return None
            if nearest:
                sx, sy, tr = self.dem.orientation
                u, v = (y, x) if tr else (x, y)
                i = int(round(sx * u / self.dem.scale + self.dem.soff))
                j = int(round(sy * v / self.dem.scale + self.dem.loff))
                if i < 0 or j < 0 or i >= self.dem.samples or j >= self.dem.lines:
                    return None
                return self.dem._raw(i, j)
            return self.dem.height_xy(x, y)
        x, y = self.tile.proj_xy(lat, lon)
        c, r = self.tile.tif.pixel_of(x, y)
        return self.tile.tif.value(int(round(c)), int(round(r))) if nearest else self.tile.tif.bilinear(c, r)

    def value(self, lat: float, lon: float, nearest: bool = False):
        v = self.raw(lat, lon, nearest)
        if v is None or v < 0:
            return None
        return v / self.norm

    def calibrate(self) -> dict:
        """Find the value scaling (fraction / percent / scaled integer) and confirm orientation."""
        vals = []
        for lat in [-75.5 - 0.25 * i for i in range(58)]:
            for lon in range(0, 360, 6):
                v = self.raw(lat, lon, nearest=True)
                if v is not None and v >= 0:
                    vals.append(v)
        mx = max(vals) if vals else 1.0
        if self.kind != "psr":
            for d in (1.0, 100.0, 1000.0, 10000.0, 32767.0, 65535.0):
                if mx <= d * 1.0005:
                    self.norm = d
                    break
            self.notes.append(f"maximum {mx:g} -> values divided by {self.norm:g}")
        # orientation: polar crater floors are darker than their surroundings, massifs brighter. The
        # documented layout is kept unless another of the 8 layouts matches clearly more landmarks.
        good = tested = 0
        alt_best, alt_o = 0, None
        if self.kind == "earth":
            # Earth visibility depends on which way a slope faces, not on whether it is a peak or a crater,
            # so the peak/crater landmark test does not apply. The Earth map is the same NASA product,
            # grid and projection as the sunlight map, so it keeps the documented layout like that map.
            self.notes.append("layout: same NASA product, grid and projection as the sunlight map")
        elif self.dem is not None and self.kind != "psr":
            good, tested, failed = self._landmark_score()
            documented = self.dem.orientation
            for o in [(sx, sy, tr) for sx in (1, -1) for sy in (1, -1) for tr in (False, True)]:
                if o == documented:
                    continue
                self.dem.orientation = o
                g, _, _ = self._landmark_score()
                if g > alt_best:
                    alt_best, alt_o = g, o
            self.dem.orientation = documented
            if alt_best >= good + 2:
                self.dem.orientation = alt_o
                self.notes.append(f"WARNING: layout {alt_o} matches {alt_best} landmarks vs {good} for the documented one; using it")
                good, tested, failed = self._landmark_score()
            if failed:
                self.notes.append("landmarks not matched: " + ", ".join(failed))
        return {"max": mx, "divisor": self.norm, "landmarksMatched": good, "landmarksTested": tested, "bestAlternative": alt_best}

    def _landmark_score(self):
        good = tested = 0
        failed = []
        for name, lat, lon, rad, kind in H.LANDMARKS:
            c = self.value(lat, lon)
            ring = self._ring(lat, lon, rad if kind == "crater" else 20.0)
            if c is None or ring is None:
                continue
            tested += 1
            if (kind == "crater" and c < ring - 0.03) or (kind == "mountain" and c > ring + 0.03):
                good += 1
            else:
                failed.append(name)
        return good, tested, failed

    def _ring(self, lat, lon, radius_km, n=24):
        vals = []
        for k in range(n):
            q = H.latlon(_offset(lat, lon, 360 * k / n, radius_km * 1000))
            v = self.value(*q)
            if v is not None:
                vals.append(v)
        return sum(vals) / len(vals) if len(vals) > n // 2 else None

    def neighbourhood(self, lat: float, lon: float, radius_m: float) -> tuple[float, float] | None:
        """Min and max within radius_m (spatial sensitivity of the reference value)."""
        vals = []
        steps = 4
        for i in range(-steps, steps + 1):
            for j in range(-steps, steps + 1):
                d = math.hypot(i, j) * radius_m / steps
                if d > radius_m + 1e-6:
                    continue
                q = H.latlon(_offset(lat, lon, math.degrees(math.atan2(i, j)), d)) if d else (lat, lon)
                v = self.value(*q)
                if v is not None:
                    vals.append(v)
        return (min(vals), max(vals)) if vals else None


class PsrMap(ValueMap):
    def __init__(self, path: Path):
        super().__init__(path, "psr")
        self.invert = False

    def calibrate(self) -> dict:
        info = super().calibrate()
        # Shackleton's floor is the best-known permanently shadowed region: it must read as shadow
        v = self.raw(-89.67, 129.78, nearest=True)
        frac = self._fraction_flagged()
        self.invert = (v is not None and v <= 0) and frac > 0.5
        info.update(shackletonValue=v, flaggedFraction=round(frac, 4), inverted=self.invert)
        return info

    def _fraction_flagged(self):
        n = f = 0
        for lat in [-80 - 0.2 * i for i in range(50)]:
            for lon in range(0, 360, 5):
                v = self.raw(lat, lon, nearest=True)
                if v is None:
                    continue
                n += 1
                f += v > 0
        return f / n if n else 0.0

    def is_psr(self, lat: float, lon: float) -> bool | None:
        v = self.raw(lat, lon, nearest=True)
        if v is None:
            return None
        return (v <= 0) if self.invert else (v > 0)

    def metrics(self, lat: float, lon: float, search_km: float = 30.0) -> dict:
        """Inside a PSR? Distance to the nearest PSR pixel and PSR area within 5 and 20 km."""
        px = self.scale
        inside = self.is_psr(lat, lon)
        nearest = None
        area5 = area20 = 0
        kmax = int(search_km * 1000 / px)
        e, n, u = H.enu(lat, lon)
        # walk a local grid in the tangent plane (pixel spacing); fine for ≤ 30 km
        for i in range(-kmax, kmax + 1):
            for j in range(-kmax, kmax + 1):
                d = math.hypot(i, j) * px
                if d > search_km * 1000:
                    continue
                if d:
                    q = H.latlon(_offset(lat, lon, math.degrees(math.atan2(i, j)), d))
                else:
                    q = (lat, lon)
                if self.is_psr(*q):
                    if nearest is None or d < nearest:
                        nearest = d
                    if d <= 5000:
                        area5 += 1
                    if d <= 20000:
                        area20 += 1
        a = (px / 1000) ** 2
        return {"inside": bool(inside), "nearestKm": None if nearest is None else round(nearest / 1000, 2),
                "areaKm2Within5km": round(area5 * a, 2), "areaKm2Within20km": round(area20 * a, 1), "searchKm": search_km, "pixelM": px}


def load_illumination(folder: Path = PGDA_DIR / "illumination", verbose: bool = True) -> dict:
    """Find and calibrate the illumination products in folder: {'sun': ValueMap, 'earth': ..., 'psr': PsrMap}."""
    out = {}
    if not Path(folder).exists():
        return out
    for key, pat in ILLUM_PRODUCTS.items():
        files = []
        for res in ("060", "120", "240"):
            for band in ("85S", "75S", "65S"):
                stem = pat.format(band=band, res=res)
                files += [p for p in (Path(folder) / f"{stem}.IMG", Path(folder) / f"{stem}.TIF") if p.exists()]
        # coverage first (75S covers every south-polar site), then resolution
        files.sort(key=lambda p: ("75S" not in p.name and "65S" not in p.name, int(p.stem.split("_")[2][:-1])))
        for f in files:
            if key in out and "65S" not in f.name:
                continue  # after the primary map, only a wider 65S map is still useful (sites north of 75°S)
            try:
                m = PsrMap(f) if key == "psr" else ValueMap(f, key)
                info = m.calibrate()
            except Exception as exc:  # noqa: BLE001
                if verbose:
                    print(f"  {f.name}: unreadable ({exc})")
                continue
            m.info = info
            m.wide = None
            if verbose:
                lm = f" · landmarks {info['landmarksMatched']}/{info['landmarksTested']}" if info.get("landmarksTested") else ""
                ex = f" · Shackleton floor shadowed: {'yes' if m.is_psr(-89.67, 129.78) else 'NO'}" if key == "psr" else ""
                print(f"  {f.name}: {m.scale:g} m/px · {'; '.join(m.notes) or 'binary mask'}{lm}{ex}")
            if key not in out:
                out[key] = m
                if "65S" in f.name:
                    break  # the primary already covers 65°S
            else:
                out[key].wide = m  # wider coverage for sites north of the primary map
                break
    return out


def _covering(m, lat: float, lon: float):
    """The map (primary or its wider 65°S companion) that has a value at lat, lon."""
    if m.raw(lat, lon, nearest=True) is not None:
        return m
    w = getattr(m, "wide", None)
    return w if w is not None and w.raw(lat, lon, nearest=True) is not None else None


def site_reference(maps: dict, lat: float, lon: float) -> dict:
    """Published (Mazarico et al.) values at a site, with their spread within ±1 pixel."""
    out = {}
    for key in ("sun", "earth"):
        m = maps.get(key)
        m = _covering(m, lat, lon) if m else None
        if not m:
            continue
        v = m.value(lat, lon)
        if v is None:
            continue
        nb = m.neighbourhood(lat, lon, m.scale)
        out[key] = {"value": round(v, 4), "min": round(nb[0], 4) if nb else None, "max": round(nb[1], 4) if nb else None,
                    "map": m.path.name, "pixelM": m.scale}
    psr = _covering(maps["psr"], lat, lon) if maps.get("psr") else None
    if psr:
        try:
            out["psr"] = psr.metrics(lat, lon) | {"map": psr.path.name}
        except Exception as exc:  # noqa: BLE001
            out["psr"] = {"error": str(exc)}
    return out


# ---------------------------------------------------------------------------- map image
def png_gray(path: Path, width: int, height: int, rows: list[bytes]):
    """Write an 8-bit greyscale PNG (no dependencies)."""
    raw = b"".join(b"\x00" + r for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(data)


def polar_map(terrain: "H.Terrain", maps: dict, out_dir: Path, size: int = 900, edge_lat: float = -79.5, verbose: bool = True) -> dict:
    """South-polar images in the app's orientation (0° longitude up, 90°E right, seen from below):
    terrain shading, average sunlight and permanent shadow. Returns the layer metadata."""
    out_dir.mkdir(parents=True, exist_ok=True)
    rmax = 2 * R * math.tan(math.radians(90 - abs(edge_lat)) / 2)
    px = 2 * rmax / size
    t0 = time.time()
    # heights on the image grid (one sample per pixel), then hillshade from neighbouring pixels
    hgt = [[None] * size for _ in range(size)]
    for j in range(size):
        Y = -rmax + (j + 0.5) * px  # image row j → our Y (down)
        for i in range(size):
            X = -rmax + (i + 0.5) * px
            rho = math.hypot(X, Y)
            if rho > rmax:
                continue
            lat = -(90 - math.degrees(2 * math.atan(rho / (2 * R))))
            lon = math.degrees(math.atan2(X, -Y))
            hgt[j][i] = terrain.height(lat, lon)[0]
    layers = {}
    az, alt = math.radians(315), math.radians(35)  # light from the upper left, the cartographic convention
    rows = []
    for j in range(size):
        row = bytearray(size)
        for i in range(size):
            h = hgt[j][i]
            if h is None:
                continue
            l = hgt[j][i - 1] if i > 0 and hgt[j][i - 1] is not None else h
            r_ = hgt[j][i + 1] if i + 1 < size and hgt[j][i + 1] is not None else h
            u = hgt[j - 1][i] if j > 0 and hgt[j - 1][i] is not None else h
            d = hgt[j + 1][i] if j + 1 < size and hgt[j + 1][i] is not None else h
            dzdx, dzdy = (r_ - l) / (2 * px), (u - d) / (2 * px)
            slope = math.atan(math.hypot(dzdx, dzdy) * 2.0)  # ×2 vertical exaggeration for legibility
            aspect = math.atan2(dzdy, -dzdx)
            shade = math.sin(alt) * math.cos(slope) + math.cos(alt) * math.sin(slope) * math.cos(az - aspect)
            row[i] = max(18, min(255, int(30 + 215 * max(0.0, shade))))
        rows.append(bytes(row))
    png_gray(out_dir / "polar-terrain.png", size, size, rows)
    layers["terrain"] = {"file": "polar-terrain.png", "label": "Terrain (LOLA elevation, shaded)"}
    for key, label in (("sun", "Average sunlight (Mazarico et al. 2011)"), ("psr", "Permanent shadow (Mazarico et al. 2011)")):
        m = maps.get(key)
        if not m:
            continue
        rows = []
        for j in range(size):
            row = bytearray(size)
            Y = -rmax + (j + 0.5) * px
            for i in range(size):
                X = -rmax + (i + 0.5) * px
                rho = math.hypot(X, Y)
                if rho > rmax:
                    continue
                lat = -(90 - math.degrees(2 * math.atan(rho / (2 * R))))
                lon = math.degrees(math.atan2(X, -Y))
                if key == "psr":
                    row[i] = 255 if m.is_psr(lat, lon) else 0
                else:
                    v = m.value(lat, lon, nearest=True)
                    row[i] = 0 if v is None else max(0, min(255, int(round(255 * v ** 0.75))))
            rows.append(bytes(row))
        png_gray(out_dir / f"polar-{key}.png", size, size, rows)
        layers[key] = {"file": f"polar-{key}.png", "label": label, "source": m.path.name}
    meta = {"size": size, "edgeLat": edge_lat, "rhoMaxM": rmax, "pixelM": px, "radiusM": R,
            "projection": "south polar stereographic, 0° longitude up, 90°E right (seen from below)", "layers": layers,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (out_dir / "polar-map.json").write_text(json.dumps(meta, indent=1))
    if verbose:
        print(f"  polar map: {', '.join(layers)} ({size}×{size} px, {px:.0f} m/px) in {time.time() - t0:.0f} s")
    return meta
