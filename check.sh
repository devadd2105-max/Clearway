#!/bin/sh
# Clearway: re-run the automated checks (after installing an update), then start the app.
cd "$(dirname "$0")"
python3 tools/validation_report.py
exec python3 server.py --open "$@"
