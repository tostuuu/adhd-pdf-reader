# Focus PDF Reader

An ADHD-friendly PDF reader. Variable-speed yellow highlight band that moves
word-by-word across the page, auto-scroll, resizable band (1–15 words), persistent
bookmarks keyed by file content hash, click-to-jump, and full Chrome-extension
compatibility.

Runs as an installable Chrome PWA with offline support via a service worker.

## Quick start — one click

```bash
cd ~/Desktop/PDF_reader
./build_app.sh
```

That produces **`Focus PDF Reader.app`** (and a `Stop Focus PDF.app` helper).
Drag `Focus PDF Reader.app` to `/Applications` or the Dock.

Double-click it and Chrome opens straight to the reader. No Terminal window, no
"Install as app" step. Everything is self-contained inside the bundle.

- Behind the scenes the app boots a tiny local server on port `8765` and opens Chrome at it.
- All your Chrome extensions run on the page as usual.
- Double-click **`Stop Focus PDF.app`** when you want to free the port (or just
  let it be — it uses negligible resources until you restart).

## Manual start (alternative)

```bash
cd ~/Desktop/PDF_reader
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome.

## Features

- **Moving highlight band**, 1–15 words wide, pacing based on your WPM slider (80–900 WPM).
- **Auto-scroll** keeps the highlighted line in view.
- **Click-to-jump** — click any word on any page to move the band there.
- **Auto-resume** — every PDF remembers where you left off, keyed by SHA-256 of its contents.
  Works across tab close, Chrome close, and reboots.
- **Pinned bookmark** (press `B`) — gold ribbon in the margin. Press `G` to jump there.
- **File System Access API** — the app remembers your last PDF and offers a one-click
  "Resume" button.
- **Graceful shutdown** — closing the tab/window/switching tabs all save state and stop playback.
- **Zoom in/out/fit-to-width**, keyboard-driven.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause highlight |
| ← / → | Previous / next page |
| `+` / `-` | Speed ±25 WPM |
| `[` / `]` | Zoom out / in |
| `F` | Fit to width |
| `,` / `.` | Band size smaller / larger |
| `B` | Pin bookmark at current word |
| `G` | Go to pinned bookmark |
| `R` | Restart highlight at top of current page |
| `Esc` | Stop highlight |
| Click | Jump highlight to the nearest word |

## Limitations

- Text PDFs only (v1). Scanned PDFs have no text layer — OCR would be a future addition.
- Rotated or heavily multi-column layouts may produce uneven line grouping.

## File layout

- `index.html` — shell + PWA manifest link + SW registration
- `styles.css` — styling
- `app.js` — all logic
- `manifest.webmanifest` — PWA manifest
- `sw.js` — service worker (offline caching)
- `icon.svg` — app icon
- `build_app.sh` — builds the macOS `.app` bundle
- `launch.command` — fallback double-click launcher (no `.app` build required)

No build step, no dependencies installed locally. PDF.js is loaded from jsDelivr and
then cached by the service worker for offline use.

## Privacy

Everything is local. Bookmarks live in `localStorage`. The "Resume last PDF" handle
is in IndexedDB. The only outbound request is the first-time fetch of PDF.js from
jsDelivr, after which the service worker serves it from cache.
