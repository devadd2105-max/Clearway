#!/usr/bin/env python3
"""Clearway Lunar — terrain horizon masks from LOLA polar elevation maps (and PGDA 5 m site maps).

Reads NASA LRO LOLA polar-stereographic gridded elevation products (PDS3 .IMG with a detached
.LBL label, e.g. ldem_75s_240m, ldem_85s_40m, ldem_875s_20m from the PDS Geosciences Node) and
computes, for each site, the terrain elevation angle of the local horizon at every azimuth.
Pure Python standard library; numpy is used automatically if installed (much faster).

Usage:
  python tools/horizons.py --download ldem_75s_240m           # fetch a map into data/lola/
  python tools/horizons.py --dem data/lola/ldem_75s_240m.img   # build web/data/horizons.json for all preset sites
  python tools/horizons.py --dem A.img --dem B.img --site -84.79,29.20
Multiple maps can be given: each sample uses the finest map that covers it.
"""
from __future__ import annotations

import argparse
import array
import json
import math
import re
import sys
import time
from pathlib import Path

R_MOON_M = 1737400.0
ROOT = Path(__file__).resolve().parents[1]
PDS_BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/"
MIT_BASE = "https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG/"

try:  # optional acceleration
    import numpy as np  # type: ignore
except ImportError:  # pragma: no cover - exercised when numpy is absent
    np = None

# Landmarks used to confirm the map orientation: (lat, lon, radius_km, kind)
LANDMARKS = [
    ("Shackleton", -89.67, 129.78, 10.5, "crater"),
    ("Haworth", -86.9, -4.0, 25.7, "crater"),
    ("de Gerlache", -88.5, -87.1, 16.2, "crater"),
    ("Slater", -88.08, 111.29, 12.6, "crater"),
    ("Nobile", -85.28, 53.27, 36.0, "crater"),
    ("Cabeus", -84.9, -35.5, 50.0, "crater"),
    ("Mons Mouton", -84.6, 31.0, 20.0, "mountain"),
    ("Malapert Massif", -86.0, 0.0, 20.0, "mountain"),
]


# ---------------------------------------------------------------------------- PDS3 label
def parse_label(text: str) -> dict:
    """Flat dict of KEY -> value (numbers parsed, units stripped). Later duplicate keys win,
    so IMAGE and IMAGE_MAP_PROJECTION values (which come last) take precedence."""
    out: dict = {}
    for raw in text.splitlines():
        m = re.match(r"\s*([A-Z0-9_^]+)\s*=\s*(.+?)\s*$", raw)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        val = re.sub(r"<[^>]*>", "", val).strip().strip('"')
        num = re.match(r"^[-+]?\d+(\.\d*)?([eE][-+]?\d+)?$", val)
        out[key] = float(val) if num else val
    return out


class Dem:
    """One polar-stereographic LOLA map."""

    def __init__(self, img_path: str | Path, orientation: tuple[int, int, bool] = (1, 1, False)):
        self.path = Path(img_path)
        lbl = self.path.with_suffix(".lbl")
        if not lbl.exists():
            lbl = self.path.with_suffix(".LBL")
        if not lbl.exists():
            raise FileNotFoundError(f"label not found next to {self.path} (expected .lbl)")
        L = parse_label(lbl.read_text(errors="replace"))
        self.label = L
        if "POLAR STEREOGRAPHIC" not in str(L.get("MAP_PROJECTION_TYPE", "")).upper():
            raise ValueError("only POLAR STEREOGRAPHIC maps are supported")
        self.lines, self.samples = int(L["LINES"]), int(L["LINE_SAMPLES"])
        self.scale = float(L["MAP_SCALE"]) * (1000.0 if float(L["MAP_SCALE"]) < 5 else 1.0)  # km/pix → m/pix
        self.loff, self.soff = float(L["LINE_PROJECTION_OFFSET"]), float(L["SAMPLE_PROJECTION_OFFSET"])
        self.factor = float(L.get("SCALING_FACTOR", 1.0))
        self.south = float(L.get("CENTER_LATITUDE", -90)) < 0
        self.clon = math.radians(float(L.get("CENTER_LONGITUDE", 0.0)))
        bits = int(L.get("SAMPLE_BITS", 16))
        stype = str(L.get("SAMPLE_TYPE", "LSB_INTEGER")).upper()
        unsigned = "UNSIGNED" in stype
        code = {16: "H" if unsigned else "h", 32: "f" if "REAL" in stype else ("I" if unsigned else "i")}[bits]
        n = self.lines * self.samples
        if np is not None:
            dt = np.dtype(("<" if "LSB" in stype or "PC" in stype else ">") + {"h": "i2", "H": "u2", "i": "i4", "I": "u4", "f": "f4"}[code])
            self.data = np.fromfile(self.path, dtype=dt, count=n).astype(np.float32) * self.factor
        else:
            a = array.array(code)
            with open(self.path, "rb") as fh:
                a.fromfile(fh, n)
            if ("MSB" in stype) == (sys.byteorder == "little"):
                a.byteswap()
            self.data = a
        self.orientation = orientation
        self.max_r = (min(self.lines, self.samples) / 2 - 2) * self.scale

    # documented projection (PDS DSMAP, polar stereographic): r = 2*Rm*tan((90-|lat|)/2);
    # sample = SAMPLE_OFFSET + x/scale, line = LINE_OFFSET - y/scale, with x = r sin(lon) and
    # y = r cos(lon) at the south pole (y = -r cos(lon) at the north pole). Seen from below the south
    # pole this puts 0° longitude at the top and 90°E on the right — confirmed on the real
    # ldem_75s_240m map by the landmark check. Returned here as (x, -y) so that col = soff + X/scale
    # and row = loff + Y/scale.
    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        r = 2 * R_MOON_M * math.tan(math.radians(90 - abs(lat)) / 2)
        dl = math.radians(lon) - self.clon
        return (r * math.sin(dl), -r * math.cos(dl)) if self.south else (r * math.sin(dl), r * math.cos(dl))

    def covers(self, x: float, y: float) -> bool:
        return math.hypot(x, y) < self.max_r

    def _raw(self, i: int, j: int) -> float:
        # numpy data is already scaled to metres; the pure-Python array holds raw DN
        v = float(self.data[j * self.samples + i])
        return v if np is not None else v * self.factor

    def height_xy(self, x: float, y: float) -> float | None:
        """Bilinear height (m above the 1737.4 km sphere) at projected x, y (m)."""
        sx, sy, tr = self.orientation
        u, v = (y, x) if tr else (x, y)
        col = sx * u / self.scale + self.soff
        row = sy * v / self.scale + self.loff
        i, j = int(math.floor(col)), int(math.floor(row))
        if i < 0 or j < 0 or i + 1 >= self.samples or j + 1 >= self.lines:
            return None
        fx, fy = col - i, row - j
        a, b = self._raw(i, j), self._raw(i + 1, j)
        c, d = self._raw(i, j + 1), self._raw(i + 1, j + 1)
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

    def height(self, lat: float, lon: float) -> float | None:
        x, y = self.xy(lat, lon)
        return self.height_xy(x, y) if self.covers(x, y) else None


# ---------------------------------------------------------------------------- geometry
def unit(lat: float, lon: float) -> tuple[float, float, float]:
    la, lo = math.radians(lat), math.radians(lon)
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


def latlon(v) -> tuple[float, float]:
    x, y, z = v
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def enu(lat: float, lon: float):
    la, lo = math.radians(lat), math.radians(lon)
    e = (-math.sin(lo), math.cos(lo), 0.0)
    n = (-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la))
    u = (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))
    return e, n, u


class Terrain:
    """A stack of maps (LOLA polar grids and PGDA 5 m tiles); samples use the finest map covering the point."""

    def __init__(self, dems: list):
        self.dems = sorted(dems, key=lambda d: d.scale)

    def height(self, lat: float, lon: float):
        for d in self.dems:
            h = d.height(lat, lon)
            if h is not None:
                return h, d.scale
        return None, None


def horizon(terrain: Terrain, lat: float, lon: float, *, az_step: float = 0.5, max_km: float = 300.0, observer_m: float = 2.0,
            min_km: float = 0.0, with_dist: bool = False):
    """Horizon elevation angle (deg) for each azimuth. Returns (elev_list, site_height_m), or with
    with_dist=True (elev_list, site_height_m, dist_of_max_list). Only terrain between min_km and max_km
    is considered (used to split near and far fields)."""
    h0, res = terrain.height(lat, lon)
    if h0 is None:
        raise ValueError(f"site {lat:.4f},{lon:.4f} is outside every elevation map")
    e, n, u = enu(lat, lon)
    r_obs = R_MOON_M + h0 + observer_m
    P = (u[0] * r_obs, u[1] * r_obs, u[2] * r_obs)
    # distance samples: fine near the site, then growing by 0.4 % per step
    dists, d = [], res
    while d <= max_km * 1000:
        if d >= min_km * 1000:
            dists.append(d)
        d += max(res, 0.004 * d)
    out, where = [], []
    naz = int(round(360 / az_step))
    for k in range(naz):
        a = math.radians(k * az_step)
        t = (math.cos(a) * n[0] + math.sin(a) * e[0], math.cos(a) * n[1] + math.sin(a) * e[1], math.cos(a) * n[2] + math.sin(a) * e[2])
        best, bestd = -90.0, None
        for dist in dists:
            dl = dist / R_MOON_M
            c, s = math.cos(dl), math.sin(dl)
            q = (c * u[0] + s * t[0], c * u[1] + s * t[1], c * u[2] + s * t[2])
            qlat, qlon = latlon(q)
            ht, _ = terrain.height(qlat, qlon)
            if ht is None:
                break
            r = R_MOON_M + ht
            dx, dy, dz = q[0] * r - P[0], q[1] * r - P[1], q[2] * r - P[2]
            el = math.degrees(math.asin((dx * u[0] + dy * u[1] + dz * u[2]) / math.sqrt(dx * dx + dy * dy + dz * dz)))
            if el > best:
                best, bestd = el, dist
        out.append(round(best, 3))
        where.append(bestd)
    return (out, h0, where) if with_dist else (out, h0)


# ---------------------------------------------------------------------------- orientation check
def ring_mean(dem: Dem, lat: float, lon: float, radius_km: float, n: int = 24):
    e, nn, u = enu(lat, lon)
    vals = []
    for k in range(n):
        a = 2 * math.pi * k / n
        t = [math.cos(a) * nn[i] + math.sin(a) * e[i] for i in range(3)]
        dl = radius_km * 1000 / R_MOON_M
        q = [math.cos(dl) * u[i] + math.sin(dl) * t[i] for i in range(3)]
        h = dem.height(*latlon(q))
        if h is not None:
            vals.append(h)
    return sum(vals) / len(vals) if len(vals) > n // 2 else None


def orientation_score(dem: Dem) -> tuple[int, int]:
    good = tested = 0
    for name, lat, lon, rad, kind in LANDMARKS:
        c = dem.height(lat, lon)
        ring = ring_mean(dem, lat, lon, rad if kind == "crater" else 20.0)
        if c is None or ring is None:
            continue
        tested += 1
        if (kind == "crater" and c < ring - 300) or (kind == "mountain" and c > ring + 500):
            good += 1
    return good, tested


def check_orientation(dem: Dem, verbose: bool = True) -> tuple[int, int, bool]:
    """Confirm the documented orientation with landmarks; try the other 7 symmetries if it fails."""
    base = orientation_score(dem)
    if base[1] == 0:
        if verbose:
            print("  orientation: no landmarks inside this map; using the documented projection")
        return dem.orientation
    if base[0] == base[1]:
        if verbose:
            print(f"  orientation: documented projection confirmed ({base[0]}/{base[1]} landmarks)")
        return dem.orientation
    base_o = dem.orientation
    best, best_o = base, dem.orientation
    for o in [(sx, sy, tr) for sx in (1, -1) for sy in (1, -1) for tr in (False, True)]:
        dem.orientation = o
        s = orientation_score(dem)
        if s[0] > best[0]:
            best, best_o = s, o
    dem.orientation = best_o
    if verbose:
        if best_o == base_o:
            print(f"  orientation: documented projection kept ({base[0]}/{base[1]} landmarks; no other orientation matches more)")
        else:
            print(f"  orientation: WARNING documented projection matched {base[0]}/{base[1]} landmarks; using {best_o} ({best[0]}/{best[1]})")
    return best_o


# ---------------------------------------------------------------------------- CLI
def preset_sites() -> list[dict]:
    text = (ROOT / "web" / "js" / "lunar" / "sites.js").read_text()
    sites = []
    for m in re.finditer(r"id: '([^']+)'.*?lat: (-?[\d.]+), lon: (-?[\d.]+)", text, re.S):
        sites.append({"id": m.group(1), "lat": float(m.group(2)), "lon": float(m.group(3))})
    return sites


def download(name: str, dest: Path = ROOT / "data" / "lola") -> Path:
    """Fetch a LOLA polar product (.lbl + .img) from the PDS Geosciences Node. Python cannot always
    build the server's certificate chain (missing intermediate, school proxies), so pgda.fetch falls
    back to the system curl, which uses the operating system's verifier and resumes partial files."""
    from pgda import fetch  # noqa: PLC0415 - pgda imports this module
    for ext in (".lbl", ".img"):
        try:
            fetch(PDS_BASE + name + ext, dest / f"{name}{ext}")
        except Exception as exc:  # noqa: BLE001 - same file, LOLA team archive (upper-case names)
            print(f"  {name}{ext}: PDS failed ({exc}); trying the LOLA team archive")
            fetch(MIT_BASE + name.upper() + ext.upper(), dest / f"{name}{ext}")
    return dest / f"{name}.img"


def ring_points(lat: float, lon: float, radius_m: float, n: int):
    """n points radius_m from the site (azimuths 0, 360/n, …) — for position-uncertainty sampling."""
    e, nn, u = enu(lat, lon)
    out = []
    for k in range(n):
        a = math.radians(360 * k / n)
        t = [math.cos(a) * nn[i] + math.sin(a) * e[i] for i in range(3)]
        dl = radius_m / R_MOON_M
        out.append((360 * k / n, *latlon([math.cos(dl) * u[i] + math.sin(dl) * t[i] for i in range(3)])))
    return out


NEAR_KM = 10.0


def ring_horizons(terrain, lat, lon, h0, radius_m=100.0, n=6, max_km=300.0, observer_m=2.0, az_step=1.0):
    """Horizons for n points radius_m from the site. Terrain nearer than NEAR_KM is ray-marched from each
    point; farther terrain is taken from the site's own far-field profile, corrected for the point's
    different height (first order: Δel = −Δh·cos(el)/d). A 100 m move changes the angle to terrain 10 km
    away by at most ~0.6 mrad in azimuth terms, so this is accurate and ~5× faster."""
    far, _, fd = horizon(terrain, lat, lon, az_step=az_step, max_km=max_km, observer_m=observer_m, min_km=NEAR_KM, with_dist=True)
    out = []
    for az, la, lo in ring_points(lat, lon, radius_m, n):
        try:
            near, h2 = horizon(terrain, la, lo, az_step=az_step, max_km=NEAR_KM, observer_m=observer_m)
        except ValueError:
            continue
        dh = h2 - h0
        elev = []
        for i, e in enumerate(near):
            f = far[i]
            if fd[i]:
                f -= math.degrees(dh * math.cos(math.radians(f)) / fd[i])
            elev.append(round(max(e, f), 2))
        out.append({"az": az, "heightM": round(h2, 1), "elev": elev})
    return out


def build(dem_paths, sites, out_path, az_step=0.5, max_km=300.0, observer_m=2.0, verbose=True,
          tiles_dir=None, illum_dir=None, ring_n=6, ring_m=100.0, map_dir=None, tile_sites=True, sfs_dir=None) -> dict:
    """Build web/data/horizons.json: terrain horizons for every site plus, when the PGDA products are
    present, 5 m tiles (near-field terrain and lander-scale slopes), the Mazarico et al. illumination
    references, horizons for points ring_m around each site (position uncertainty) and a polar map."""
    import pgda as P  # noqa: PLC0415
    t_all = time.time()
    dems, checks = [], []
    for p in dem_paths:
        d = Dem(p)
        if verbose:
            print(f"  map {Path(p).name}: {d.samples}×{d.lines} px at {d.scale:g} m/px")
        check_orientation(d, verbose)
        good, tested = orientation_score(d)
        checks.append({"map": Path(p).name, "landmarksMatched": good, "landmarksTested": tested, "orientation": list(d.orientation)})
        dems.append(d)
    coarse = Terrain(dems)
    sfs = P.load_tiles(sfs_dir, coarse, verbose) if sfs_dir else []
    tiles = sfs + (P.load_tiles(tiles_dir, coarse, verbose) if tiles_dir else [])  # shape-from-shading first
    terrain = Terrain(dems + tiles)
    maps = P.load_illumination(illum_dir, verbose) if illum_dir else {}
    sites = list(sites)
    if tile_sites:
        for t in tiles:
            if t in sfs:
                if P.SFS_OVERLAP.get(t.site):  # same ground as a PGDA 78 site: it refines that site's terrain
                    continue
                spot = P.best_spot(t, maps)
                (lat, lon), how = (spot[:2], spot[2]) if spot else (t.center(), {"rule": "map centre (no flat point found)"})
                slug = t.site.removeprefix("A3-").lower().replace("_", "-")
                sites.append({"id": f"a3-{slug}", "lat": round(lat, 5), "lon": round(lon, 5),
                              "name": f"{t.label} (Artemis III region)", "short": t.label, "kind": "Artemis III region (SfS 5 m)",
                              "note": (f"A point inside NASA's 5 m/pixel shape-from-shading terrain for the Artemis III candidate region {t.label}"
                                       f" (PGDA product 104, Bertone et al.), chosen by Clearway: {how['rule']}. Not an official landing point."),
                              "source": f"PGDA product 104, {t.path.name}; point selected by Clearway ({how['rule']})", "selection": how})
                if verbose:
                    print(f"  {t.site} site point: {how['rule']} -> {lat:.4f}, {lon:.4f}")
                continue
            spot = P.best_spot(t, maps)
            if spot:
                lat, lon, how = spot
                note = (f"Best landing point inside NASA PGDA's 5 m/pixel LOLA map {t.site} ({t.label}), chosen by Clearway: {how['rule']}."
                        f" Site numbering follows Mazarico et al. (2011).")
                source = f"PGDA product 78, tile {t.path.name}; point selected by Clearway ({how['rule']})"
            else:
                (lat, lon), how = t.center(), {"rule": "tile centre (no flat point found)"}
                note = f"Centre of NASA PGDA's 5 m/pixel LOLA map {t.site} ({t.label}); site numbering follows Mazarico et al. (2011)."
                source = f"PGDA product 78, tile {t.path.name} (tile centre)"
            if verbose:
                print(f"  {t.site} site point: {how['rule']} -> {lat:.4f}, {lon:.4f}" + (f" (NASA sunlight {100 * how['pgdaSun']:.0f}%)" if how.get("pgdaSun") is not None else ""))
            sites.append({"id": f"pgda-{t.site.lower()}", "lat": round(lat, 5), "lon": round(lon, 5),
                          "name": f"{t.label} (PGDA {t.site})", "short": t.label, "kind": "PGDA 5 m site",
                          "note": note, "source": source, "selection": how})
    result = {
        "azStep": az_step,
        "meta": {
            "source": "NASA LRO LOLA polar gridded elevation (PDS Geosciences Node)" + (" + PGDA 5 m/pixel site maps" if len(tiles) > len(sfs) else "") + (" + PGDA shape-from-shading 5 m maps" if sfs else ""),
            "maps": [Path(p).name for p in dem_paths] + [t.path.name for t in tiles],
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "observerHeightM": observer_m, "maxDistanceKm": max_km,
            "method": "ray-march per azimuth on a 1737.4 km sphere with bilinear sampling; finest map first",
            "orientationChecks": checks,
            "tiles": [{"site": t.site, "name": t.label, "product": t.product, "file": t.path.name, "px": [t.tif.width, t.tif.height], "scaleM": t.scale,
                       "extra": sorted(t.extra), "calibration": t.calibration} for t in tiles],
            "illumination": {k: {"file": m.path.name, "pixelM": m.scale, "host": P.illumination_source(m.path), **{a: b for a, b in m.info.items() if a in ("divisor", "landmarksMatched", "landmarksTested", "bestAlternative", "inverted", "flaggedFraction")},
                                 **({"wide": m.wide.path.name} if getattr(m, "wide", None) is not None else {})} for k, m in maps.items()},
            "reference": "Mazarico, E., Neumann, G. A., Smith, D. E., Zuber, M. T., Torrence, M. H. (2011), Illumination conditions of the lunar polar regions using LOLA topography, Icarus 211, 1066-1081" if maps else None,
            "ring": {"n": ring_n, "radiusM": ring_m, "azStep": 1.0} if ring_n else None,
        },
        "sites": {},
    }
    for s in sites:
        t0 = time.time()
        try:
            elev, h0 = horizon(terrain, s["lat"], s["lon"], az_step=az_step, max_km=max_km, observer_m=observer_m)
        except ValueError as exc:
            if verbose:
                print(f"  {s['id']:16s} skipped: {exc}")
            continue
        _, res = terrain.height(s["lat"], s["lon"])
        entry = {"lat": s["lat"], "lon": s["lon"], "heightM": round(h0, 1), "resM": res, "elev": elev}
        for k in ("name", "short", "kind", "note", "source", "selection"):
            if k in s:
                entry[k] = s[k]
        # slopes: regional from the LOLA grid, lander-scale from a 5 m tile when one covers the site
        reg = P.slope_at(lambda la, lo: coarse.height(la, lo)[0], s["lat"], s["lon"], coarse.height(s["lat"], s["lon"])[1] or 240.0)
        entry["slope"] = {"regionalDeg": None if reg is None else round(reg, 2), "regionalBaselineM": 2 * (coarse.height(s["lat"], s["lon"])[1] or 240.0)}
        tile = next((t for t in tiles if t.height(s["lat"], s["lon"]) is not None), None)
        if tile:
            entry["slope"]["lander"] = P.lander_slopes(tile, s["lat"], s["lon"])
        if ring_n:
            entry["ring"] = ring_horizons(terrain, s["lat"], s["lon"], h0, ring_m, ring_n, max_km, observer_m)
        if maps:
            entry["pgda"] = P.site_reference(maps, s["lat"], s["lon"])
        result["sites"][s["id"]] = entry
        if verbose:
            extra = []
            if tile:
                extra.append(f"5 m slope {entry['slope']['lander'].get('slopeDeg')}°")
            if entry.get("pgda", {}).get("sun"):
                extra.append(f"PGDA sun {100 * entry['pgda']['sun']['value']:.0f}%")
            print(f"  {s['id']:16s} height {h0:8.0f} m · horizon {min(elev):+6.2f}° … {max(elev):+6.2f}° · {res:g} m map"
                  f"{' · ' + ' · '.join(extra) if extra else ''} · {time.time() - t0:.1f} s")
    if map_dir:
        try:
            result["meta"]["polarMap"] = P.polar_map(coarse, maps, Path(map_dir), verbose=verbose)
        except Exception as exc:  # noqa: BLE001
            print(f"  polar map skipped: {exc}")
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, separators=(",", ":")))
    if verbose:
        print(f"  wrote {out_path} ({len(result['sites'])} sites) in {time.time() - t_all:.0f} s")
    return result


def load_terrain(lola_paths, tiles_dir=None, verbose=False, sfs_dir=None) -> Terrain:
    """The same terrain stack the build uses (for the server's on-demand horizons)."""
    import pgda as P  # noqa: PLC0415
    dems = []
    for p in lola_paths:
        d = Dem(p)
        check_orientation(d, verbose)
        dems.append(d)
    coarse = Terrain(dems)
    tiles = (P.load_tiles(sfs_dir, coarse, verbose) if sfs_dir else []) + (P.load_tiles(tiles_dir, coarse, verbose) if tiles_dir else [])
    return Terrain(dems + tiles)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", action="append", default=[], help="LOLA polar .img (label .lbl alongside); repeatable")
    ap.add_argument("--download", action="append", default=[], help="download a LOLA product by name, e.g. ldem_75s_240m")
    ap.add_argument("--site", action="append", default=[], help="extra site as LAT,LON (deg, east longitude)")
    ap.add_argument("--out", default=str(ROOT / "web" / "data" / "horizons.json"))
    ap.add_argument("--az-step", type=float, default=0.5)
    ap.add_argument("--max-km", type=float, default=300.0)
    ap.add_argument("--observer-m", type=float, default=2.0, help="height of the solar panel / antenna above the ground")
    ap.add_argument("--tiles", default=None, help="folder of PGDA 5 m site maps (SiteXX/*_5mpp_surf.tif)")
    ap.add_argument("--illum", default=None, help="folder of PGDA/Mazarico illumination maps")
    ap.add_argument("--sfs", default=None, help="folder of PGDA 104 shape-from-shading maps (A3-*/*_sfs_5mpp_surf.tif)")
    ap.add_argument("--ring", type=int, default=6, help="horizons for N points around each site (0 = off)")
    ap.add_argument("--map-dir", default=None, help="write the polar map images here")
    a = ap.parse_args(argv)
    paths = list(a.dem) + [str(download(n)) for n in a.download]
    if not paths:
        ap.error("give --dem FILE or --download NAME")
    sites = preset_sites()
    for i, s in enumerate(a.site):
        lat, lon = (float(x) for x in s.split(","))
        sites.append({"id": f"custom{i + 1}", "lat": lat, "lon": lon})
    build(paths, sites, a.out, a.az_step, a.max_km, a.observer_m, tiles_dir=a.tiles, illum_dir=a.illum, ring_n=a.ring, map_dir=a.map_dir, sfs_dir=a.sfs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
