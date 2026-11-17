@echo off
rem Runs SiteSnag on this computer. Double-click this file, then open http://localhost:3000
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting SiteSnag... open http://localhost:3000 in your browser. Close this window to stop it.
start "" http://localhost:3000
node server.js
pause
