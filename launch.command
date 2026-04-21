#!/bin/bash
# Focus PDF Reader — double-click launcher for macOS.
# Starts a tiny local server (only if not already running), then opens Chrome
# to the installed PWA. Leave this terminal window open while using the app.

set -u
cd "$(dirname "$0")"

PORT=8000
URL="http://localhost:${PORT}/"

# If the port is already serving our app, don't start a second server.
if ! lsof -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Starting local server on port ${PORT}..."
  python3 -m http.server ${PORT} >/dev/null 2>&1 &
  SERVER_PID=$!
  # Make sure the server dies when this terminal closes
  trap "kill ${SERVER_PID} 2>/dev/null" EXIT INT TERM
  sleep 0.5
else
  echo "Server already running on port ${PORT}."
fi

echo "Opening Focus PDF Reader at ${URL}"
open -a "Google Chrome" "${URL}" || open "${URL}"

echo ""
echo "The app is running. Close this window to stop the server."
echo "Tip: in Chrome, open the ⋮ menu -> 'Install page as app' the first time."

# Keep the script alive so the server keeps running until the user closes this window.
if [ -n "${SERVER_PID:-}" ]; then
  wait ${SERVER_PID}
fi
