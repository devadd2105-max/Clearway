@echo off
rem Clearway one-command start (Windows)
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (set PY=python)
if not exist web\vendor\satellite.min.js %PY% server.py --fetch-vendor
if not exist web\data\horizons.json (
  echo First run: downloading NASA data ^(LOLA terrain, PGDA illumination and 5 m site maps^) and building the terrain.
  echo This takes a while the first time ^(download size depends on NASA's servers; build about 5-10 minutes^). Later starts are instant.
  %PY% server.py --build-terrain --hires || %PY% server.py --build-terrain --quick
  %PY% tools\validation_report.py
)
%PY% server.py --open %*
