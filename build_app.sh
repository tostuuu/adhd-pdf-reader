#!/bin/bash
# build_app.sh — build a self-contained "Focus PDF Reader.app" for macOS.
# Re-run this whenever you edit the web files.
#
# One-click design:
#   - Double-clicking the app ALWAYS restarts the background server with the
#     latest files, then opens Chrome. No separate "Stop" helper needed.
#   - The server only lives while you want to read; relaunching is clean.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Focus PDF Reader"
APP_DIR="${APP_NAME}.app"
PORT=8765
BUILD_VERSION="$(date +%Y%m%d-%H%M)"

echo "Building ${APP_DIR} (build ${BUILD_VERSION})..."
rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources/www"

# 1. Copy web assets and the Python backend into the bundle.
# NOTE: we deliberately do NOT ship sw.js any more. This is a local app, so the
# service worker added caching complexity with zero benefit and was a frequent
# source of "stale code" bugs. The page actively unregisters any legacy SWs.
cp index.html styles.css app.js manifest.webmanifest icon.svg \
   rsvp-popup.html rsvp-popup.js \
   notes-popup.html notes-popup.js \
   "${APP_DIR}/Contents/Resources/www/"
# Bundled PDF.js — lets the app work offline. Fatal error if missing.
if [ ! -f "vendor/pdfjs/pdf.min.mjs" ] || [ ! -f "vendor/pdfjs/pdf.worker.min.mjs" ]; then
  echo "ERROR: vendor/pdfjs/ is missing. Run:"
  echo "  curl -fsSL -o vendor/pdfjs/pdf.min.mjs https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs"
  echo "  curl -fsSL -o vendor/pdfjs/pdf.worker.min.mjs https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs"
  exit 1
fi
mkdir -p "${APP_DIR}/Contents/Resources/www/vendor/pdfjs"
cp vendor/pdfjs/pdf.min.mjs vendor/pdfjs/pdf.worker.min.mjs \
   "${APP_DIR}/Contents/Resources/www/vendor/pdfjs/"

# Bundled Quill 2.x — rich text editor for the Notes window.
if [ ! -f "vendor/quill/quill.js" ] || [ ! -f "vendor/quill/quill.snow.css" ]; then
  echo "ERROR: vendor/quill/ is missing. Run:"
  echo "  curl -fsSL -o vendor/quill/quill.js https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.js"
  echo "  curl -fsSL -o vendor/quill/quill.snow.css https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css"
  exit 1
fi
mkdir -p "${APP_DIR}/Contents/Resources/www/vendor/quill"
cp vendor/quill/quill.js vendor/quill/quill.snow.css \
   "${APP_DIR}/Contents/Resources/www/vendor/quill/"

cp server.py "${APP_DIR}/Contents/Resources/server.py"

# Stamp the build into the page so it's visible in the top bar.
# We replace the sentinel "__BUILD__" string at build time.
sed -i '' "s/__BUILD__/${BUILD_VERSION}/g" "${APP_DIR}/Contents/Resources/www/index.html"
sed -i '' "s/__BUILD__/${BUILD_VERSION}/g" "${APP_DIR}/Contents/Resources/www/app.js"
sed -i '' "s/__BUILD__/${BUILD_VERSION}/g" "${APP_DIR}/Contents/Resources/www/rsvp-popup.html"
sed -i '' "s/__BUILD__/${BUILD_VERSION}/g" "${APP_DIR}/Contents/Resources/www/rsvp-popup.js"
sed -i '' "s/__BUILD__/${BUILD_VERSION}/g" "${APP_DIR}/Contents/Resources/www/notes-popup.html"
sed -i '' "s/__BUILD__/${BUILD_VERSION}/g" "${APP_DIR}/Contents/Resources/www/notes-popup.js"

# 2. Generate the ICNS icon from icon.svg.
ICONSET_DIR="$(mktemp -d)/AppIcon.iconset"
mkdir -p "${ICONSET_DIR}"
for size in 16 32 128 256 512; do
  sips -s format png icon.svg --out "${ICONSET_DIR}/icon_${size}x${size}.png" \
       -z ${size} ${size} >/dev/null
  x2=$((size*2))
  sips -s format png icon.svg --out "${ICONSET_DIR}/icon_${size}x${size}@2x.png" \
       -z ${x2} ${x2} >/dev/null
done
iconutil -c icns "${ICONSET_DIR}" -o "${APP_DIR}/Contents/Resources/AppIcon.icns"

# 3. Launcher: kill any previous server, start a fresh one, open Chrome.
cat > "${APP_DIR}/Contents/MacOS/launcher" <<SH
#!/bin/bash
set -u
BUNDLE_DIR="\$(cd "\$(dirname "\$0")/.." && pwd)"
WEBROOT="\${BUNDLE_DIR}/Resources/www"
PORT=${PORT}
URL="http://localhost:\${PORT}/"
PID_FILE="/tmp/focuspdf.\${PORT}.pid"
LOG_FILE="/tmp/focuspdf.\${PORT}.log"

# Always stop any previous server so every launch runs the newest code.
if [ -f "\${PID_FILE}" ]; then
  OLD=\$(cat "\${PID_FILE}" 2>/dev/null || true)
  [ -n "\${OLD}" ] && kill "\${OLD}" 2>/dev/null || true
  rm -f "\${PID_FILE}"
fi
# Belt-and-suspenders: also free the port in case something else grabbed it.
OTHER=\$(lsof -tiTCP:\${PORT} -sTCP:LISTEN 2>/dev/null | head -1 || true)
[ -n "\${OTHER}" ] && kill "\${OTHER}" 2>/dev/null || true

export FOCUSPDF_PORT="\${PORT}"
nohup /usr/bin/env python3 "\${BUNDLE_DIR}/Resources/server.py" "\${WEBROOT}" >"\${LOG_FILE}" 2>&1 &
echo \$! > "\${PID_FILE}"
sleep 0.4

# Unique URL per launch so Chrome doesn't focus a stale tab showing old code.
STAMP=\$(date +%s)
FRESH_URL="\${URL}?t=\${STAMP}"

if [ -d "/Applications/Google Chrome.app" ]; then
  # Close any existing Focus PDF tabs first, then open a fresh one.
  # Using AppleScript — safely no-ops if Chrome isn't running yet.
  /usr/bin/osascript <<'APPLESCRIPT' 2>/dev/null || true
tell application "System Events"
  if (name of processes) contains "Google Chrome" then
    tell application "Google Chrome"
      set winList to every window
      repeat with w in winList
        set tabList to every tab of w
        repeat with t in tabList
          if (URL of t contains "localhost:8765") then close t
        end repeat
      end repeat
    end tell
  end if
end tell
APPLESCRIPT
  open -a "Google Chrome" "\${FRESH_URL}"
else
  open "\${FRESH_URL}"
fi
SH
chmod +x "${APP_DIR}/Contents/MacOS/launcher"

# 4. Info.plist
cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Focus PDF Reader</string>
  <key>CFBundleDisplayName</key><string>Focus PDF Reader</string>
  <key>CFBundleIdentifier</key><string>com.joan.focuspdf</string>
  <key>CFBundleVersion</key><string>${BUILD_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${BUILD_VERSION}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSBackgroundOnly</key><false/>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Remove quarantine so macOS doesn't complain.
xattr -dr com.apple.quarantine "${APP_DIR}" 2>/dev/null || true

# Delete the old "Stop Focus PDF.app" helper — no longer needed.
rm -rf "Stop Focus PDF.app"

echo ""
echo "Built: ${APP_DIR} (v${BUILD_VERSION})"
echo "Double-click it — every launch restarts the server with the latest code."
