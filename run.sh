#!/usr/bin/env sh
# Clearway one-command start (macOS / Linux)
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
[ -z "$PY" ] && { echo "Python 3.9+ is required: https://www.python.org/downloads/"; exit 1; }
[ -f web/vendor/satellite.min.js ] || "$PY" server.py --fetch-vendor
if [ ! -f web/data/horizons.json ]; then
  echo "First run: downloading NASA data (LOLA terrain, PGDA illumination and 5 m site maps) and building the terrain."
  echo "This takes a while the first time (build about 5-10 minutes). Later starts are instant."
  if "$PY" server.py --build-terrain --hires || "$PY" server.py --build-terrain --quick; then
    echo "Recording the verification report…"; "$PY" tools/validation_report.py || true
  else
    echo "Terrain build skipped (offline?). The app will use a smooth Moon until you run: $PY server.py --build-terrain"
  fi
fi
exec "$PY" server.py --open "$@"
