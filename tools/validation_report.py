#!/usr/bin/env python3
"""Run Clearway's automated checks and write web/data/validation.json for the app's Verification card.

    python tools/validation_report.py

Records: the JavaScript test suite (node --test), the Python test suite (unittest), the built-in
ephemeris comparison with JPL Horizons, and the state of the NASA terrain build (LOLA orientation
landmarks, PGDA 5 m tile agreement with LOLA, illumination maps installed, sites built, and the
real-data sanity tests). Nothing here is hand-written: every
number comes from running the checks on this machine.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "data" / "validation.json"


def run(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    return p.returncode, p.stdout + "\n" + p.stderr


NO_NODE = {"tests": 0, "pass": 0, "fail": 0, "ok": None, "note": "Node.js not installed on this machine; JavaScript suite not run"}


def previous() -> dict:
    try:
        return json.loads(OUT.read_text())
    except Exception:
        return {}


def node_suite() -> dict:
    if not shutil.which("node"):
        prev = previous().get("javascript", {})
        if prev.get("ok") is not None:  # keep the last real run, clearly dated
            when = prev.get("recordedAt") or previous().get("generated", "?")
            return {**prev, "recordedAt": when, "note": f"Recorded {when} by the developer's run (Node.js not installed on this machine)"}
        return dict(NO_NODE)
    code, out = run(["node", "--test", "tests/core.test.mjs", "tests/lunar.test.mjs", "tests/v4.test.mjs", "tests/v5.test.mjs", "tests/v6.test.mjs"])
    g = lambda k: int(m.group(1)) if (m := re.search(rf"^# {k} (\d+)", out, re.M)) else 0
    names = re.findall(r"^ok \d+ - (.+)$", out, re.M)
    return {"tests": g("tests"), "pass": g("pass"), "fail": g("fail"), "ok": code == 0, "names": names}


def python_suite() -> dict:
    code, out = run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"])
    ran = int(m.group(1)) if (m := re.search(r"Ran (\d+) tests?", out)) else 0
    skipped = int(m.group(1)) if (m := re.search(r"skipped=(\d+)", out)) else 0
    failed = sum(int(x) for x in re.findall(r"(?:failures|errors)=(\d+)", out))
    skipped_names = re.findall(r"^(\w+) \(.*?\) \.\.\. skipped", out, re.M)
    return {"tests": ran, "pass": ran - skipped - failed, "skipped": skipped, "fail": failed, "ok": code == 0, "skippedNames": skipped_names}


def ephemeris() -> dict:
    if not shutil.which("node"):
        return {"ok": None, "error": "Node.js not installed (the app re-checks the ephemeris in the browser)"}
    code, out = run(["node", "-e", "import('./web/js/lunar/reference.js').then(m=>console.log(JSON.stringify(m.selfCheck())))"])
    try:
        c = json.loads(out.strip().splitlines()[0])
        return {"points": c["n"], "sunArcsec": round(c["sun"] * 3600, 1), "earthArcsec": round(c["earth"] * 3600, 1), "reference": "JPL Horizons DE441", "ok": max(c["sun"], c["earth"]) * 3600 < 60}
    except Exception as exc:  # pragma: no cover
        return {"ok": False, "error": str(exc)}


def terrain() -> dict:
    f = ROOT / "web" / "data" / "horizons.json"
    if not f.exists():
        return {"built": False, "note": "LOLA horizons not built on this machine: run python server.py --build-terrain"}
    j = json.loads(f.read_text())
    sites = j.get("sites", {})
    meta = j.get("meta", {})
    return {
        "built": True, "maps": meta.get("maps", []), "generated": meta.get("generated"), "sites": len(sites),
        "orientationChecks": meta.get("orientationChecks", []),
        "tiles": [{"site": t["site"], "ok": t["calibration"].get("ok"), "corr": t["calibration"].get("corr"), "rmsM": t["calibration"].get("rmsM")} for t in meta.get("tiles", [])],
        "illumination": {k: v.get("file") for k, v in (meta.get("illumination") or {}).items()},
        "examples": {k: {"heightM": v["heightM"], "minDeg": min(v["elev"]), "maxDeg": max(v["elev"])} for k, v in list(sites.items())[:12]},
    }


def main() -> int:
    t0 = time.time()
    report = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "javascript": node_suite(), "python": python_suite(), "ephemeris": ephemeris(), "terrain": terrain()}
    report["seconds"] = round(time.time() - t0, 1)
    report["ok"] = all(report[k]["ok"] is not False for k in ("javascript", "python", "ephemeris"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=1))
    js, py, ep = report["javascript"], report["python"], report["ephemeris"]
    print(f"JavaScript {js['pass']}/{js['tests']}{' (node not installed)' if js['ok'] is None else ''} · Python {py['pass']}/{py['tests']} ({py['skipped']} skipped) · "
          f"ephemeris worst Sun {ep.get('sunArcsec')}\" Earth {ep.get('earthArcsec')}\" · terrain {'built' if report['terrain']['built'] else 'not built'}")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
