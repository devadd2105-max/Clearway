#!/usr/bin/env python3
"""Clearway server (Lunar Mission Browser + launch phase).

Serves the web app and a set of small caching proxies, using only the Python standard library
(pyserial is optional, for the USB telemetry relay):

  GET  /api/catalog/<group>       CelesTrak GP element sets (3-line TLE), disk cache 2 h
  GET  /api/weather?<query>       Open-Meteo forecast, memory cache 30 min
  GET  /api/swpc/<path>           NOAA SWPC space weather (Kp, Kp forecast, F10.7), cache 15 min
  GET  /api/opensky?lamin=..      OpenSky Network live aircraft states in a bounding box, cache 10 s
  GET  /api/satnogs/stations      SatNOGS Network online ground stations, cache 12 h
  GET  /api/telemetry/stream      Server-sent events: telemetry lines from the relay
  POST /api/telemetry             Push telemetry lines (text/plain, one packet per line)
  GET  /api/horizons?lat=&lon=&target=10|399&start=&stop=&step=
                                  JPL Horizons Sun/Earth az-el from a lunar site (live verification)
  GET  /api/horizon?lat=&lon=     Terrain horizon for any lunar site from the installed LOLA maps
  GET  /api/health                Status, cache contents and feature flags

Usage:
  python server.py --open                      # http://localhost:8080
  python server.py --serial COM5               # also relay a micro:bit on COM5 (needs pyserial)
  python server.py --fetch-vendor              # download browser libraries for offline use
  python server.py --prefetch                  # warm the catalog cache before a demo
  python server.py --build-terrain             # LOLA ldem_75s_240m + NASA PGDA illumination / permanent-shadow maps
  python server.py --build-terrain --hires     # also LOLA ldem_85s_40m and the PGDA 5 m/pixel site maps
  python server.py --build-terrain --quick     # LOLA 240 m map only (29 MB)
  python server.py --build-terrain --hires --tile-extras   # also PGDA slope and uncertainty maps per 5 m site
  python server.py --build-terrain --hires --sfs           # also PGDA 104 shape-from-shading maps (13 Artemis III regions)
  PORT=10000 python server.py --host 0.0.0.0   # hosted (Render, Docker)

Environment: OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET (optional, raises OpenSky rate limits).
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from email.utils import formatdate
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tools"))
WEB = ROOT / "web"
CACHE = ROOT / "cache"
USER_AGENT = "Clearway/4.0 (NASA Space Apps lunar mission browser)"
GROUP_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
DEFAULT_GROUPS = ["active", "cosmos-1408-debris", "fengyun-1c-debris", "iridium-33-debris", "cosmos-2251-debris", "last-30-days"]
SWPC_PATHS = {
    "/products/noaa-planetary-k-index.json",
    "/products/noaa-planetary-k-index-forecast.json",
    "/json/f107_cm_flux.json",
}
VENDOR = {
    "satellite.min.js": "https://cdn.jsdelivr.net/npm/satellite.js@4.1.4/dist/satellite.min.js",
    "land-110m.json": "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json",
}
TTL = {"catalog": 2 * 3600, "weather": 30 * 60, "swpc": 15 * 60, "opensky": 10, "satnogs": 12 * 3600, "horizons": 24 * 3600}
LOLA_DIR = ROOT / "data" / "lola"
PGDA_DIR = ROOT / "data" / "pgda"
MONTHS = {m: i + 1 for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}

_mem: dict[str, tuple[float, bytes]] = {}
_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


def lock_for(key: str) -> threading.Lock:
    with _guard:
        return _locks.setdefault(key, threading.Lock())


def http_get(url: str, timeout: float = 30, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def cached(key: str, ttl: float, fetch) -> bytes:
    """Memory cache with stale fallback when the upstream fails."""
    with lock_for(key):
        hit = _mem.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        try:
            body = fetch()
        except Exception:
            if hit:
                return hit[1]
            raise
        _mem[key] = (time.time(), body)
        return body


# ---------------------------------------------------------------- catalog
def looks_like_tle(text: str) -> bool:
    return bool(re.search(r"(^|\n)1 \d{5}", text)) and bool(re.search(r"(^|\n)2 \d{5}", text))


def get_catalog(group: str) -> tuple[bytes, str, float]:
    """Return (body, cache_state, fetched_at). Serves stale data if CelesTrak is unreachable."""
    if not GROUP_RE.match(group):
        raise ValueError("invalid group name")
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{group}.tle"
    with lock_for("cat:" + group):
        if path.exists() and time.time() - path.stat().st_mtime < TTL["catalog"]:
            return path.read_bytes(), "hit", path.stat().st_mtime
        url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={urllib.parse.quote(group)}&FORMAT=tle"
        try:
            body = http_get(url)
            text = body.decode("utf-8", "replace")
            if not looks_like_tle(text):
                raise ValueError(text.strip()[:160] or "empty response")
            path.write_bytes(body)
            return body, "miss", time.time()
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as exc:
            if path.exists():
                return path.read_bytes(), "stale", path.stat().st_mtime
            raise RuntimeError(f"CelesTrak request for '{group}' failed: {exc}") from exc


# ---------------------------------------------------------------- weather / space weather
def weather_query(query: str) -> str:
    params = urllib.parse.parse_qs(query, keep_blank_values=False)
    allowed = {"latitude", "longitude", "hourly", "wind_speed_unit", "timezone", "forecast_days"}
    clean = {k: v[0] for k, v in params.items() if k in allowed}
    if "latitude" not in clean or "longitude" not in clean:
        raise ValueError("latitude and longitude are required")
    return urllib.parse.urlencode(sorted(clean.items()))


def get_weather(query: str) -> bytes:
    q = weather_query(query)
    return cached("wx:" + q, TTL["weather"], lambda: http_get(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=20))


def get_swpc(path: str) -> bytes:
    if path not in SWPC_PATHS:
        raise ValueError("unsupported SWPC product")
    return cached("swpc:" + path, TTL["swpc"], lambda: http_get("https://services.swpc.noaa.gov" + path, timeout=20))


# ---------------------------------------------------------------- OpenSky
_token: dict = {"value": None, "exp": 0.0}


def opensky_token() -> str | None:
    cid, secret = os.environ.get("OPENSKY_CLIENT_ID"), os.environ.get("OPENSKY_CLIENT_SECRET")
    if not cid or not secret:
        return None
    if _token["value"] and time.time() < _token["exp"] - 60:
        return _token["value"]
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": cid, "client_secret": secret}).encode()
    req = urllib.request.Request("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
                                 data=data, headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as res:
        tok = json.loads(res.read())
    _token.update(value=tok["access_token"], exp=time.time() + float(tok.get("expires_in", 1800)))
    return _token["value"]


def opensky_query(query: str) -> str:
    p = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
    try:
        box = {k: float(p[k]) for k in ("lamin", "lomin", "lamax", "lomax")}
    except (KeyError, ValueError) as exc:
        raise ValueError("lamin, lomin, lamax and lomax are required") from exc
    if not (-90 <= box["lamin"] < box["lamax"] <= 90 and -180 <= box["lomin"] < box["lomax"] <= 180):
        raise ValueError("invalid bounding box")
    if (box["lamax"] - box["lamin"]) * (box["lomax"] - box["lomin"]) > 900:
        raise ValueError("bounding box too large (max ~30x30 degrees)")
    return urllib.parse.urlencode({k: f"{v:.3f}" for k, v in box.items()})


def get_opensky(query: str) -> bytes:
    q = opensky_query(query)

    def fetch():
        tok = opensky_token()
        return http_get(f"https://opensky-network.org/api/states/all?{q}", timeout=20, headers={"Authorization": f"Bearer {tok}"} if tok else None)

    return cached("osky:" + q, TTL["opensky"], fetch)


# ---------------------------------------------------------------- SatNOGS
def normalise_stations(raw: list) -> list:
    out = []
    for s in raw:
        try:
            out.append({"id": s["id"], "name": s.get("name", f"Station {s['id']}"), "lat": float(s["lat"]), "lng": float(s["lng"]),
                        "altitude": float(s.get("altitude") or 0), "min_horizon": float(s.get("min_horizon") or 0), "status": s.get("status", "")})
        except (KeyError, TypeError, ValueError):
            continue
    return out


def get_satnogs_stations() -> bytes:
    def fetch():
        stations, url, pages = [], "https://network.satnogs.org/api/stations/?format=json&status=Online", 0
        while url and pages < 15:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=20) as res:
                data = json.loads(res.read())
                link = res.headers.get("Link", "")
            if isinstance(data, dict):  # paginated object form
                stations += data.get("results", [])
                url = data.get("next")
            else:
                stations += data
                m = re.search(r'<([^>]+)>;\s*rel="next"', link)
                url = m.group(1) if m else None
            pages += 1
        return json.dumps(normalise_stations(stations)).encode()

    return cached("satnogs", TTL["satnogs"], fetch)


# ---------------------------------------------------------------- lunar: JPL Horizons and terrain
def horizons_params(query: str) -> dict:
    p = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
    try:
        lat, lon = float(p["lat"]), float(p["lon"])
    except (KeyError, ValueError) as exc:
        raise ValueError("lat and lon are required") from exc
    if not (-90 <= lat <= 90 and -360 <= lon <= 360):
        raise ValueError("lat/lon out of range")
    target = p.get("target", "10")
    if target not in ("10", "399"):
        raise ValueError("target must be 10 (Sun) or 399 (Earth)")
    iso = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
    start, stop = p.get("start", ""), p.get("stop", "")
    if not iso.match(start) or not iso.match(stop):
        raise ValueError("start and stop must be YYYY-MM-DD or YYYY-MM-DDTHH:MM")
    step = p.get("step", "6h")
    if not re.match(r"^\d{1,4}[hmd]$", step):
        raise ValueError("step must look like 6h, 30m or 1d")
    return {"lat": lat, "lon": lon % 360, "target": target, "start": start.replace("T", " "), "stop": stop.replace("T", " "), "step": step}


def parse_horizons(text: str) -> list:
    """Rows between $$SOE and $$EOE of a Horizons observer table (CSV or fixed-width)."""
    import calendar
    rows, inside = [], False
    for line in text.splitlines():
        if line.startswith("$$SOE"):
            inside = True
            continue
        if line.startswith("$$EOE"):
            break
        if not inside:
            continue
        m = re.match(r"\s*(\d{4})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2})", line)
        nums = re.findall(r"(?<![\w.])-?\d+\.\d+", line[m.end():] if m else "")
        if not m or len(nums) < 2:
            continue
        t = calendar.timegm((int(m.group(1)), MONTHS[m.group(2)], int(m.group(3)), int(m.group(4)), int(m.group(5)), 0))
        rows.append({"t": t * 1000, "az": float(nums[-2]), "el": float(nums[-1])})
    return rows


def get_horizons(query: str) -> bytes:
    p = horizons_params(query)
    params = {
        "format": "json", "COMMAND": f"'{p['target']}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'", "COORD_TYPE": "'GEODETIC'", "SITE_COORD": f"'{p['lon']:.6f},{p['lat']:.6f},0'",
        "START_TIME": f"'{p['start']}'", "STOP_TIME": f"'{p['stop']}'", "STEP_SIZE": f"'{p['step']}'",
        "QUANTITIES": "'4'", "ANG_FORMAT": "'DEG'", "CSV_FORMAT": "'YES'", "APPARENT": "'AIRLESS'",
    }
    url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(params)

    def fetch():
        data = json.loads(http_get(url, timeout=30))
        rows = parse_horizons(data.get("result", ""))
        if not rows:
            raise ValueError("Horizons returned no ephemeris rows: " + data.get("result", "")[:200])
        return json.dumps({"source": "JPL Horizons (DE441)", "target": p["target"], "rows": rows}).encode()

    return cached("hzn:" + url, TTL["horizons"], fetch)


_terrain = {"obj": None, "maps": None}
_horizon_cache: dict = {}


def lola_maps() -> list:
    return sorted(str(p) for p in LOLA_DIR.glob("*.img")) if LOLA_DIR.exists() else []


def tile_files() -> list:
    out = []
    for d in (PGDA_DIR / "sfs", PGDA_DIR / "5m"):
        out += sorted(str(p) for p in d.glob("*/*_5mpp_surf.tif")) if d.exists() else []
    return out


def get_horizon(query: str) -> bytes:
    import horizons as H  # tools/horizons.py
    p = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
    try:
        lat, lon = float(p["lat"]), float(p["lon"])
    except (KeyError, ValueError) as exc:
        raise ValueError("lat and lon are required") from exc
    if not -90 <= lat <= -60:
        raise ValueError("terrain horizons need a south-polar site (LOLA polar maps)")
    maps = lola_maps()
    if not maps:
        raise FileNotFoundError("No LOLA map installed. Run: python server.py --build-terrain")
    key = (round(lat, 4), round(lon, 4))
    if key in _horizon_cache:
        return _horizon_cache[key]
    import pgda as P  # tools/pgda.py
    with lock_for("terrain"):
        stack = maps + tile_files()
        if _terrain["maps"] != stack:
            _terrain.update(obj=H.load_terrain(maps, PGDA_DIR / "5m" if (PGDA_DIR / "5m").exists() else None,
                                                  sfs_dir=PGDA_DIR / "sfs" if (PGDA_DIR / "sfs").exists() else None), maps=stack)
        T = _terrain["obj"]
        elev, h0 = H.horizon(T, lat, lon)
        _, res = T.height(lat, lon)
        coarse = H.Terrain([d for d in T.dems if isinstance(d, H.Dem)])
        base = coarse.height(lat, lon)[1] or 240.0
        reg = P.slope_at(lambda la, lo: coarse.height(la, lo)[0], lat, lon, base)
        slope = {"regionalDeg": None if reg is None else round(reg, 2), "regionalBaselineM": 2 * base}
        tile = next((d for d in T.dems if isinstance(d, P.TileDem) and d.height(lat, lon) is not None), None)
        if tile:
            slope["lander"] = P.lander_slopes(tile, lat, lon)
    body = json.dumps({"azStep": 0.5, "elev": elev, "heightM": round(h0, 1), "resM": res, "slope": slope,
                       "meta": {"source": "NASA LRO LOLA" + (f" + {tile.product}" if tile else ""), "maps": [Path(m).name for m in stack], "observerHeightM": 2.0}}).encode()
    _horizon_cache[key] = body
    return body


def build_terrain(hires: bool = False, quick: bool = False, tile_extras: bool = False, sfs: bool = False) -> int:
    """Download NASA data and build web/data/horizons.json (+ the polar map images).
    Only the LOLA 240 m map is essential; every other product is optional and skipped on failure."""
    import horizons as H
    import pgda as P
    t0 = time.time()
    print("Step 1/4 · NASA LRO LOLA elevation (PDS Geosciences Node)")
    try:
        paths = [str(H.download("ldem_75s_240m", LOLA_DIR))]
    except Exception as exc:  # noqa: BLE001 - report network problems plainly
        print(f"  download failed: {exc}")
        return 1
    if hires:
        try:
            paths.append(str(H.download("ldem_85s_40m", LOLA_DIR)))
        except Exception as exc:  # noqa: BLE001
            print(f"  ldem_85s_40m skipped ({exc})")
    if not quick:  # 60°S map (120 MB): terrain for sites between 60°S and 75°S, e.g. Chandrayaan-3
        try:
            paths.append(str(H.download("ldem_60s_240m", LOLA_DIR)))
        except Exception as exc:  # noqa: BLE001
            print(f"  ldem_60s_240m skipped ({exc})")
    illum = None
    if not quick:
        print("Step 2/4 · NASA PGDA illumination and permanent-shadow maps (Mazarico et al. 2011)")
        got = P.download_illumination("120", PGDA_DIR / "illumination")
        P.download_illumination("240", PGDA_DIR / "illumination")  # 65°S maps for sites north of 75°S
        illum = PGDA_DIR / "illumination" if got else None
    tiles = None
    if hires:
        print("Step 3/4 · NASA PGDA 5 m/pixel site maps")
        kinds = P.ALL_TILE_KINDS if tile_extras else P.TILE_KINDS
        tiles = PGDA_DIR / "5m" if P.download_tiles(kinds=kinds, dest=PGDA_DIR / "5m") else None
    elif (PGDA_DIR / "5m").exists():
        tiles = PGDA_DIR / "5m"
    if sfs:
        print("Step 3b · NASA PGDA 104 shape-from-shading 5 m maps of the 13 Artemis III regions (Zenodo; large)")
        try:
            P.download_sfs(dest=PGDA_DIR / "sfs")
        except Exception as exc:  # noqa: BLE001
            print(f"  shape-from-shading maps skipped ({exc})")
    sfs_dir = PGDA_DIR / "sfs" if any((PGDA_DIR / "sfs").glob("*/*_5mpp_surf.tif")) else None
    print("Step 4/4 · terrain horizons, slopes, references and the polar map (a few minutes)")
    H.build(paths, H.preset_sites(), WEB / "data" / "horizons.json", tiles_dir=tiles, illum_dir=illum, map_dir=WEB / "data", sfs_dir=sfs_dir)
    print(f"Done in {(time.time() - t0) / 60:.1f} min.")
    return 0


# ---------------------------------------------------------------- telemetry relay (SSE)
class Relay:
    def __init__(self):
        self.clients: list[queue.Queue] = []
        self.lock = threading.Lock()
        self.count = 0

    def publish(self, line: str):
        line = line.strip()
        if not line.startswith("CW,") or len(line) > 200:
            return
        self.count += 1
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait(line)
                except queue.Full:
                    pass

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=2000)
        with self.lock:
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)


RELAY = Relay()


def serial_reader(port: str, baud: int):
    try:
        import serial  # type: ignore
    except ImportError:
        print("  --serial needs pyserial:  pip install pyserial", file=sys.stderr)
        return
    while True:
        try:
            with serial.Serial(port, baud, timeout=1) as ser:
                print(f"  telemetry relay reading {port} @ {baud}")
                buf = b""
                while True:
                    buf += ser.read(256)
                    while b"\n" in buf:
                        raw, buf = buf.split(b"\n", 1)
                        RELAY.publish(raw.decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001 - keep retrying (unplugged board etc.)
            print(f"  serial {port}: {exc}; retrying in 3 s", file=sys.stderr)
            time.sleep(3)


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    server_version = "Clearway/4.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.path.endswith((".js", ".css", ".html", "/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or "") and "/api/telemetry" not in (self.path or ""):
            sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {fmt % args}\n")

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _upstream(self, fn, *args):
        try:
            return self._send(200, fn(*args), "application/json")
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except (urllib.error.URLError, TimeoutError, OSError, KeyError, json.JSONDecodeError) as exc:
            return self._json(502, {"error": f"upstream request failed: {exc}"})

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path != "/api/telemetry":
            return self._json(404, {"error": "not found"})
        n = min(int(self.headers.get("Content-Length") or 0), 1_000_000)
        for line in self.rfile.read(n).decode("utf-8", "replace").splitlines():
            RELAY.publish(line)
        return self._json(200, {"ok": True})

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        if path.startswith("/api/catalog/"):
            try:
                body, state, fetched = get_catalog(path.rsplit("/", 1)[-1].lower())
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            except RuntimeError as exc:
                return self._json(502, {"error": str(exc)})
            return self._send(200, body, "text/plain; charset=utf-8", {"X-Clearway-Cache": state, "X-Clearway-Fetched": formatdate(fetched, usegmt=True)})
        if path == "/api/weather":
            return self._upstream(get_weather, url.query)
        if path.startswith("/api/swpc/"):
            return self._upstream(get_swpc, path[len("/api/swpc"):])
        if path == "/api/opensky":
            return self._upstream(get_opensky, url.query)
        if path == "/api/satnogs/stations":
            return self._upstream(get_satnogs_stations)
        if path == "/api/horizons":
            return self._upstream(get_horizons, url.query)
        if path == "/api/horizon":
            try:
                return self._send(200, get_horizon(url.query), "application/json")
            except FileNotFoundError as exc:
                return self._json(404, {"error": str(exc)})
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
        if path == "/api/telemetry/stream":
            return self._stream()
        if path == "/api/health":
            files = {p.stem: {"bytes": p.stat().st_size, "age_s": int(time.time() - p.stat().st_mtime)} for p in CACHE.glob("*.tle")} if CACHE.exists() else {}
            vendor = sorted(p.name for p in (WEB / "vendor").glob("*")) if (WEB / "vendor").exists() else []
            return self._json(200, {"ok": True, "version": "4.0", "catalog_cache": files, "vendor": vendor,
                                    "lola_maps": [Path(m).name for m in lola_maps()], "pgda_tiles": [Path(t).parent.name for t in tile_files()],
                                    "pgda_illumination": sorted(p.name for p in (PGDA_DIR / "illumination").glob("*.IMG")) if (PGDA_DIR / "illumination").exists() else [],
                                    "horizons_built": (WEB / "data" / "horizons.json").exists(),
                                    "opensky_auth": bool(os.environ.get("OPENSKY_CLIENT_ID")), "telemetry_packets": RELAY.count})
        return super().do_GET()

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = RELAY.subscribe()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    line = q.get(timeout=15)
                    self.wfile.write(f"data: {line}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            RELAY.unsubscribe(q)


def fetch_vendor() -> int:
    out = WEB / "vendor"
    out.mkdir(exist_ok=True)
    ok = 0
    for name, url in VENDOR.items():
        try:
            data = http_get(url)
            (out / name).write_bytes(data)
            print(f"  saved web/vendor/{name} ({len(data):,} bytes)")
            ok += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  could not download {name}: {exc}")
    return 0 if ok == len(VENDOR) else 1


def prefetch() -> int:
    bad = 0
    for g in DEFAULT_GROUPS:
        try:
            body, state, _ = get_catalog(g)
            n = body.decode("utf-8", "replace").count("\n1 ")
            print(f"  {g:22s} {state:5s} ~{n:,} objects")
        except RuntimeError as exc:
            print(f"  {g:22s} FAILED  {exc}")
            bad += 1
    return 1 if bad else 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # never crash on a console that cannot print ° or ×
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    ap.add_argument("--open", action="store_true", help="open the app in the default browser")
    ap.add_argument("--serial", metavar="PORT", help="relay a micro:bit ground station on this serial port (needs pyserial)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--fetch-vendor", action="store_true", help="download third-party browser assets for offline use and exit")
    ap.add_argument("--prefetch", action="store_true", help="download the default catalog groups into the cache and exit")
    ap.add_argument("--build-terrain", action="store_true", help="download NASA LOLA (and PGDA) data and build lunar horizons, then exit")
    ap.add_argument("--hires", action="store_true", help="with --build-terrain: also the 40 m/px LOLA map and the PGDA 5 m/px site maps")
    ap.add_argument("--quick", action="store_true", help="with --build-terrain: LOLA 240 m map only (no PGDA products)")
    ap.add_argument("--sfs", action="store_true", help="with --build-terrain: also NASA PGDA 104 shape-from-shading 5 m maps of the 13 Artemis III regions")
    ap.add_argument("--tile-extras", action="store_true", help="with --hires: also PGDA's slope and uncertainty maps for each 5 m site")
    args = ap.parse_args()

    if args.fetch_vendor:
        return fetch_vendor()
    if args.prefetch:
        return prefetch()
    if args.build_terrain:
        return build_terrain(args.hires, args.quick, args.tile_extras, args.sfs)
    if args.serial:
        threading.Thread(target=serial_reader, args=(args.serial, args.baud), daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/"
    print(f"Clearway running at {url}  (Ctrl+C to stop)")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
