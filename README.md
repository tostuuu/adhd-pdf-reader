# Focus PDF Reader

An ADHD-friendly PDF reader with a moving highlight band, variable reading speed,
persistent bookmarks, and full Chrome-extension compatibility (because it runs as a
web page in your normal Chrome).

## Features

- Simple UI. Dark chrome, warm off-white paper.
- Variable-speed highlight band (1/2/3 lines wide) that moves across the page at your chosen WPM.
- Auto-scroll follows the highlight.
- Persistent per-file bookmarks: page, line, WPM, band size, zoom — saved by file hash,
  so the same file resumes where you left off even after closing the app or rebooting.
- "Resume" button for the last PDF you opened (via the File System Access API).
- Zoom in/out/fit-to-width.
- Keyboard-driven. Works great without the mouse.
- Drag-and-drop a PDF to open it.

## Run it

This is a pure static web app. Because it uses ES modules and PDF.js, you need to
serve it over `http://` rather than opening the HTML file directly with `file://`.

### Option A — Python (already on macOS)

```bash
cd ~/Desktop/PDF_reader
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome.

### Option B — Node

```bash
cd ~/Desktop/PDF_reader
npx serve .
```

Then open the URL it prints (usually http://localhost:3000).

### Tip: make it one click

- On macOS, save `http://localhost:8000` as a Chrome app:
  Chrome → ⋮ menu → *Cast, save, and share* → *Install page as app*.
  You get a dock icon that opens this reader in its own window.

## Usage

1. Click **Open PDF** (or drag a PDF onto the window).
2. Press **Space** to start the moving highlight.
3. Adjust speed with the slider or `+` / `-` keys.
4. Change the band width with the **Band** selector or keys `1` / `2` / `3`.
5. Your position is saved automatically as the highlight moves. Close the tab, reopen later,
   click **Resume**, and pick up where you left off.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause highlight |
| ← / → | Previous / next page |
| `+` / `-` | Speed up / slow down (±25 WPM) |
| `[` / `]` | Zoom out / in |
| `F` | Fit to width |
| `1` / `2` / `3` | Band width (lines) |
| `B` | Save bookmark (also auto-saves) |
| `R` | Restart highlight at top of current page |
| `Esc` | Stop highlight |

## Chrome extensions

Your existing extensions (highlighters, dictionary lookups, translators, etc.) run on this
page like any other webpage. If an extension is restricted to specific sites, allow it on
`http://localhost:8000`.

## Limitations (v1)

- **Text PDFs only.** Scanned PDFs have no text layer, so the highlight has nothing to
  track. OCR via Tesseract.js is a future addition.
- **Rotated text / multi-column layouts** may produce uneven line grouping.
- The highlight-to-next-line timing is based on word count divided by WPM.

## File layout

- `index.html` — shell
- `styles.css` — styling
- `app.js` — all logic
- No build step, no dependencies installed locally. PDF.js is loaded from jsDelivr.

## Privacy

Everything is local. Bookmarks are in `localStorage`; the file handle for "Resume" is
stored in IndexedDB. No network calls except fetching PDF.js from jsDelivr on first load.
