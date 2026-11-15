@echo off
rem Clearway: re-run the automated checks (after installing an update), then start the app.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (set PY=python)
%PY% tools\validation_report.py
%PY% server.py --open %*
