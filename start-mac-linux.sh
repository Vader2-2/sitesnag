#!/bin/sh
# Runs SiteSnag on this computer, then open http://localhost:3000
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  exit 1
fi
echo "Starting SiteSnag... open http://localhost:3000 in your browser. Press Ctrl+C to stop."
(sleep 1; open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) &
exec node server.js
