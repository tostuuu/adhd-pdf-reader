#!/bin/bash
# build_app.sh — build a self-contained "Focus PDF Reader.app" for macOS.
# Re-run this whenever you edit the web files.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Focus PDF Reader"
APP_DIR="${APP_NAME}.app"
PORT=8765

echo "Building ${APP_DIR}..."
rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources/www"

# 1. Copy web assets and the Python backend into the bundle
cp index.html styles.css app.js sw.js manifest.webmanifest icon.svg \
   "${APP_DIR}/Contents/Resources/www/"
cp server.py "${APP_DIR}/Contents/Resources/server.py"

# 2. Generate the ICNS icon from icon.svg
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

# 3. Launcher executable: starts the server (if not running), opens Chrome, exits.
cat > "${APP_DIR}/Contents/MacOS/launcher" <<SH
#!/bin/bash
set -u
BUNDLE_DIR="\$(cd "\$(dirname "\$0")/.." && pwd)"
WEBROOT="\${BUNDLE_DIR}/Resources/www"
PORT=${PORT}
URL="http://localhost:\${PORT}/"
PID_FILE="/tmp/focuspdf.\${PORT}.pid"
LOG_FILE="/tmp/focuspdf.\${PORT}.log"

# Start server if not already running
if [ -f "\${PID_FILE}" ] && kill -0 "\$(cat "\${PID_FILE}")" 2>/dev/null; then
  :
else
  export FOCUSPDF_PORT="\${PORT}"
  nohup /usr/bin/env python3 "\${BUNDLE_DIR}/Resources/server.py" "\${WEBROOT}" >"\${LOG_FILE}" 2>&1 &
  echo \$! > "\${PID_FILE}"
  sleep 0.4
fi

# Open in Chrome if installed, else default browser
if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "\${URL}"
else
  open "\${URL}"
fi
SH
chmod +x "${APP_DIR}/Contents/MacOS/launcher"

# 4. Info.plist — marks it as a proper macOS app with our icon.
cat > "${APP_DIR}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Focus PDF Reader</string>
  <key>CFBundleDisplayName</key><string>Focus PDF Reader</string>
  <key>CFBundleIdentifier</key><string>com.joan.focuspdf</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSBackgroundOnly</key><false/>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# 5. Also bundle a small "Stop Focus PDF.app" helper that shuts the server down.
STOP_APP="Stop Focus PDF.app"
rm -rf "${STOP_APP}"
mkdir -p "${STOP_APP}/Contents/MacOS"
mkdir -p "${STOP_APP}/Contents/Resources"
cp "${APP_DIR}/Contents/Resources/AppIcon.icns" "${STOP_APP}/Contents/Resources/AppIcon.icns"
cat > "${STOP_APP}/Contents/MacOS/launcher" <<SH
#!/bin/bash
PID_FILE="/tmp/focuspdf.${PORT}.pid"
if [ -f "\${PID_FILE}" ]; then
  kill "\$(cat "\${PID_FILE}")" 2>/dev/null || true
  rm -f "\${PID_FILE}"
fi
SH
chmod +x "${STOP_APP}/Contents/MacOS/launcher"
cat > "${STOP_APP}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Stop Focus PDF</string>
  <key>CFBundleDisplayName</key><string>Stop Focus PDF</string>
  <key>CFBundleIdentifier</key><string>com.joan.focuspdf.stop</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Remove quarantine flags so macOS doesn't complain on first open.
xattr -dr com.apple.quarantine "${APP_DIR}" 2>/dev/null || true
xattr -dr com.apple.quarantine "${STOP_APP}" 2>/dev/null || true

echo ""
echo "Built: ${APP_DIR}"
echo "Built: ${STOP_APP}"
echo ""
echo "Drag \"${APP_DIR}\" into /Applications (or the Dock) to use it from anywhere."
