@echo off
rem Puts SiteSnag on the internet from THIS computer using a free Cloudflare Quick Tunnel.
rem The public address only works while this window stays open and the PC is on.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed. Install it once with:
  echo     winget install --id Cloudflare.cloudflared
  echo then close this window and run this file again.
  pause
  exit /b 1
)
echo Starting SiteSnag in the background...
start "SiteSnag server" /min node server.js
timeout /t 2 >nul
echo.
echo Look below for a line like  https://something-random.trycloudflare.com
echo That is your public address. Share it with anyone. Close this window to take it offline.
echo.
cloudflared tunnel --url http://localhost:3000
