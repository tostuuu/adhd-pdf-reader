// Focus PDF Reader — ADHD-friendly PDF reader with a moving highlight band.
// Runs as a local web app. Open in Chrome so your existing extensions keep working.

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

// ---------- State ----------
const state = {
  pdfDoc: null,
  fileHash: null,
  fileName: null,
  numPages: 0,
  pages: [],         // per-page: { page, pageDiv, viewport, rendered, rendering, lines: [...] }
  allLines: [],      // flat list: { top, left, width, height, pageIndex, firstWordIdx, lastWordIdx }
  allWords: [],      // flat list: { str, left, top, width, height, pageIndex, lineIdx (global) }
  currentWordIdx: 0,
  pinnedWordIdx: null, // explicit bookmark the user pinned with B
  playing: false,
  wpm: 250,
  bandSize: 5,       // number of words highlighted simultaneously
  zoom: 1.25,
  autoScroll: true,
  advanceTimer: null,
  highlightEl: null,
  markerEl: null,
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const viewer = $("viewer");
const viewerWrap = $("viewer-wrap");
const fileInput = $("fileInput");
const openBtn = $("openBtn");
const resumeBtn = $("resumeBtn");
const fileNameEl = $("fileName");
const pageInfoEl = $("pageInfo");
const playBtn = $("playBtn");
const wpmSlider = $("wpm");
const wpmVal = $("wpmVal");
const bandSlider = $("band");
const bandVal = $("bandVal");
const autoscrollChk = $("autoscroll");
const bookmarkBtn = $("bookmarkBtn");
const gotoBookmarkBtn = $("gotoBookmarkBtn");
const bookmarkInfo = $("bookmarkInfo");
const prevPageBtn = $("prevPage");
const nextPageBtn = $("nextPage");
const zoomInBtn = $("zoomIn");
const zoomOutBtn = $("zoomOut");
const zoomFitBtn = $("zoomFit");

// ---------- Central store (server-backed JSON file + localStorage fallback) ----------
// The Python backend (server.py) exposes /api/store which reads/writes
// ~/Library/Application Support/FocusPDFReader/bookmarks.json
// If the backend isn't reachable (e.g. user opened the plain static server),
// we fall back to localStorage so the app still works.

const LS_FALLBACK_KEY = "focuspdf:store:v2";
const LS_LEGACY_BOOKMARKS_KEY = "focuspdf:bookmarks:v1";

const DEFAULT_SETTINGS = {
  defaultWpm: 250,
  defaultBandSize: 5,
  defaultAutoScroll: true,
  defaultZoom: 1.25,
};

const store = {
  version: 1,
  settings: { ...DEFAULT_SETTINGS },
  bookmarks: {},
  _backend: "localStorage", // or "server"
  _storagePath: null,
};

async function apiAvailable() {
  try {
    const res = await fetch("/api/store/meta", { cache: "no-store" });
    return res.ok;
  } catch { return false; }
}

async function loadStore() {
  const hasApi = await apiAvailable();
  if (hasApi) {
    try {
      const res = await fetch("/api/store", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        Object.assign(store, { version: data.version || 1, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) }, bookmarks: data.bookmarks || {} });
        store._backend = "server";
        try {
          const meta = await (await fetch("/api/store/meta")).json();
          store._storagePath = meta.path;
        } catch {}
        // One-time migration from localStorage legacy bookmarks if server store is empty
        if (Object.keys(store.bookmarks).length === 0) {
          migrateLegacyLocalStorageIntoStore();
          if (Object.keys(store.bookmarks).length > 0) await saveStoreNow();
        }
        return;
      }
    } catch (e) { console.warn("store API failed; using localStorage:", e); }
  }
  // Fallback: localStorage
  try {
    const raw = localStorage.getItem(LS_FALLBACK_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      Object.assign(store, { version: data.version || 1, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) }, bookmarks: data.bookmarks || {} });
    } else {
      migrateLegacyLocalStorageIntoStore();
    }
  } catch (e) { console.warn("localStorage store failed:", e); }
  store._backend = "localStorage";
  store._storagePath = "browser localStorage (fallback)";
}

function migrateLegacyLocalStorageIntoStore() {
  try {
    const legacy = JSON.parse(localStorage.getItem(LS_LEGACY_BOOKMARKS_KEY) || "{}");
    for (const [hash, bm] of Object.entries(legacy)) {
      if (!store.bookmarks[hash]) store.bookmarks[hash] = bm;
    }
  } catch {}
}

let saveTimer = null;
function scheduleStoreSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveStoreNow().catch(() => {}); saveTimer = null; }, 350);
}

async function saveStoreNow() {
  const payload = {
    version: store.version,
    settings: store.settings,
    bookmarks: store.bookmarks,
  };
  // Always mirror to localStorage as offline safety net
  try { localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(payload)); } catch {}
  if (store._backend === "server") {
    try {
      await fetch("/api/store", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) { console.warn("store save failed (kept local copy):", e); }
  }
}

function getBookmark(hash) { return store.bookmarks[hash]; }
function setBookmark(hash, data) {
  store.bookmarks[hash] = { ...(store.bookmarks[hash] || {}), ...data, updatedAt: Date.now() };
  scheduleStoreSave();
}
function deleteBookmark(hash) {
  delete store.bookmarks[hash];
  scheduleStoreSave();
}

// ---------- IndexedDB: per-bookmark FileSystemHandles ----------
const DB_NAME = "focuspdf";
const DB_STORE = "handles";
const DB_VERSION = 2;

function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(key, value) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const g = tx.objectStore(DB_STORE).get(key);
    g.onsuccess = () => res(g.result ?? null);
    g.onerror = () => rej(g.error);
  });
}
async function idbDel(key) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function saveHandleForHash(hash, handle, name) {
  await idbPut(`bm:${hash}`, { handle, name, savedAt: Date.now() });
}
async function getHandleForHash(hash) {
  return idbGet(`bm:${hash}`);
}
async function saveLastHandle(handle, name) {
  await idbPut("last", { handle, name });
}
async function getLastHandle() {
  return idbGet("last");
}

// ---------- Hash helper ----------
async function hashBuffer(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- File loading ----------
async function loadFromFile(file, opts = {}) {
  const buf = await file.arrayBuffer();
  state.fileHash = await hashBuffer(buf);
  state.fileName = file.name;
  fileNameEl.textContent = file.name;
  document.title = `${file.name} · Focus PDF Reader`;
  // Remember basic identity info for the bookmarks list
  const bm = store.bookmarks[state.fileHash] || {};
  setBookmark(state.fileHash, {
    fileName: file.name,
    fileSize: file.size,
    lastOpenedAt: Date.now(),
    missing: false,
  });
  await loadPdfFromBuffer(buf);
}

async function loadPdfFromBuffer(buf) {
  stopPlaying();

  viewer.querySelectorAll(".page").forEach((el) => el.remove());
  state.pages = [];
  state.allLines = [];
  state.allWords = [];
  state.currentWordIdx = 0;

  state.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  state.numPages = state.pdfDoc.numPages;
  document.body.classList.add("has-doc");

  const bm = getBookmark(state.fileHash);
  // Start from store defaults, then override with this file's saved preferences if any.
  state.zoom = store.settings.defaultZoom ?? 1.25;
  state.wpm = store.settings.defaultWpm ?? 250;
  state.bandSize = store.settings.defaultBandSize ?? 5;
  if (bm) {
    if (typeof bm.zoom === "number") state.zoom = bm.zoom;
    if (typeof bm.wpm === "number") state.wpm = bm.wpm;
    if (typeof bm.bandSize === "number") state.bandSize = bm.bandSize;
  }
  wpmSlider.value = state.wpm;
  bandSlider.value = state.bandSize;
  updateWpmDisplay();
  updateBandDisplay();

  const pagePromises = [];
  for (let i = 1; i <= state.numPages; i++) pagePromises.push(state.pdfDoc.getPage(i));
  const pdfPages = await Promise.all(pagePromises);

  for (let i = 0; i < pdfPages.length; i++) {
    const page = pdfPages[i];
    const vp = page.getViewport({ scale: state.zoom });
    const pageDiv = document.createElement("div");
    pageDiv.className = "page";
    pageDiv.style.width = vp.width + "px";
    pageDiv.style.height = vp.height + "px";
    pageDiv.dataset.pageIndex = i;
    viewer.appendChild(pageDiv);
    state.pages.push({ page, pageDiv, viewport: vp, rendered: false, rendering: false, lines: [] });
  }

  ensureHighlightEl();
  updatePageInfo();

  await extractAllText();

  setupLazyRender();

  // Restore reading position (auto-resume) and pinned bookmark
  state.pinnedWordIdx = null;
  if (bm) {
    if (typeof bm.pinnedWordIdx === "number" && bm.pinnedWordIdx < state.allWords.length) {
      state.pinnedWordIdx = bm.pinnedWordIdx;
    }
    if (typeof bm.wordIdx === "number" && bm.wordIdx < state.allWords.length) {
      state.currentWordIdx = bm.wordIdx;
    } else if (typeof bm.page === "number") {
      const firstWordIdx = state.allWords.findIndex((w) => w.pageIndex === bm.page - 1);
      if (firstWordIdx !== -1) state.currentWordIdx = firstWordIdx;
    }
  }
  updateHighlight();
  updateBookmarkMarker();
  updateBookmarkUI();
  scrollToCurrent(true);
}

// ---------- Text extraction: items -> lines -> words ----------
async function extractAllText() {
  state.allLines = [];
  state.allWords = [];
  for (let pi = 0; pi < state.pages.length; pi++) {
    const p = state.pages[pi];
    const content = await p.page.getTextContent();
    const lines = groupItemsIntoLines(content.items, p.viewport);
    p.lines = [];
    for (const line of lines) {
      const firstWordIdx = state.allWords.length;
      const globalLineIdx = state.allLines.length;
      for (const w of line.words) {
        state.allWords.push({
          str: w.str,
          left: w.left,
          top: line.top,
          width: w.width,
          height: line.height,
          pageIndex: pi,
          lineIdx: globalLineIdx,
        });
      }
      const lastWordIdx = state.allWords.length - 1;
      const lineEntry = {
        top: line.top,
        left: line.left,
        width: line.width,
        height: line.height,
        pageIndex: pi,
        firstWordIdx,
        lastWordIdx,
      };
      p.lines.push(lineEntry);
      state.allLines.push(lineEntry);
    }
  }
}

function groupItemsIntoLines(items, viewport) {
  // 1) Transform each text item into CSS pixel coords.
  const placed = items
    .filter((it) => it.str && it.str.trim().length > 0)
    .map((it) => {
      const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]);
      const left = tx[4];
      const top = tx[5] - fontHeight;              // tx[5] = baseline; top of glyph is above it
      const width = it.width * viewport.scale;
      return { str: it.str, left, top, width, height: fontHeight };
    });

  placed.sort((a, b) => a.top - b.top || a.left - b.left);

  // 2) Group items into lines by proximity in y.
  const raw = [];
  for (const item of placed) {
    const last = raw[raw.length - 1];
    const sameLine =
      last && Math.abs(last.top - item.top) <= Math.max(3, last.height * 0.5);
    if (sameLine) {
      last.items.push(item);
      last.top = Math.min(last.top, item.top);
      last.height = Math.max(last.height, item.height);
      last.left = Math.min(last.left, item.left);
      last.right = Math.max(last.right, item.left + item.width);
    } else {
      raw.push({
        top: item.top,
        height: item.height,
        left: item.left,
        right: item.left + item.width,
        items: [item],
      });
    }
  }

  // 3) Within each line, split each item into individual words with proportional x.
  const out = [];
  for (const line of raw) {
    line.items.sort((a, b) => a.left - b.left);
    const words = [];
    for (const item of line.items) {
      const text = item.str;
      const chars = Math.max(text.length, 1);
      const pxPerChar = item.width / chars;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const wStart = m.index;
        const wEnd = wStart + m[0].length;
        const wLeft = item.left + wStart * pxPerChar;
        const wWidth = Math.max(4, (wEnd - wStart) * pxPerChar);
        words.push({ str: m[0], left: wLeft, width: wWidth });
      }
    }
    out.push({
      top: line.top,
      left: line.left,
      width: line.right - line.left,
      height: line.height,
      words,
    });
  }
  return out;
}

// ---------- Lazy rendering ----------
let pageObserver = null;
function setupLazyRender() {
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const idx = Number(e.target.dataset.pageIndex);
          renderPage(idx);
        }
      }
    },
    { root: viewerWrap, rootMargin: "800px 0px" }
  );
  for (const p of state.pages) pageObserver.observe(p.pageDiv);
}

async function renderPage(idx) {
  const p = state.pages[idx];
  if (!p || p.rendered || p.rendering) return;
  p.rendering = true;
  try {
    const vp = p.page.getViewport({ scale: state.zoom });
    p.viewport = vp;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    p.pageDiv.style.width = vp.width + "px";
    p.pageDiv.style.height = vp.height + "px";
    ctx.scale(dpr, dpr);
    p.pageDiv.innerHTML = "";
    p.pageDiv.appendChild(canvas);
    await p.page.render({ canvasContext: ctx, viewport: vp }).promise;
    p.rendered = true;
  } finally {
    p.rendering = false;
  }
}

async function ensurePageRendered(idx) {
  const p = state.pages[idx];
  if (!p) return;
  if (!p.rendered) await renderPage(idx);
}

// ---------- Zoom ----------
async function setZoom(z) {
  if (!state.pdfDoc) return;
  state.zoom = Math.max(0.4, Math.min(4, z));
  for (const p of state.pages) {
    p.rendered = false;
    p.rendering = false;
    const vp = p.page.getViewport({ scale: state.zoom });
    p.viewport = vp;
    p.pageDiv.style.width = vp.width + "px";
    p.pageDiv.style.height = vp.height + "px";
    p.pageDiv.innerHTML = "";
  }
  await extractAllText();
  setupLazyRender();
  updateHighlight();
  updateBookmarkMarker();
  saveCurrentBookmark();
}

async function fitWidth() {
  if (!state.pdfDoc) return;
  const containerWidth = viewerWrap.clientWidth - 40;
  const pg = await state.pdfDoc.getPage(1);
  const vp = pg.getViewport({ scale: 1 });
  setZoom(containerWidth / vp.width);
}

// ---------- Highlight band ----------
function ensureHighlightEl() {
  if (!state.highlightEl || state.highlightEl.parentElement !== viewer) {
    const el = document.createElement("div");
    el.className = "highlight-band";
    el.hidden = true;
    viewer.appendChild(el);
    state.highlightEl = el;
  }
  if (!state.markerEl || state.markerEl.parentElement !== viewer) {
    const el = document.createElement("div");
    el.className = "bookmark-marker";
    el.hidden = true;
    el.title = "Pinned bookmark — click to jump here";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      gotoBookmark();
    });
    viewer.appendChild(el);
    state.markerEl = el;
  }
}

function updateBookmarkMarker() {
  const el = state.markerEl;
  if (!el) return;
  if (state.pinnedWordIdx == null || !state.allWords.length) {
    el.hidden = true;
    return;
  }
  const w = state.allWords[clampWord(state.pinnedWordIdx)];
  if (!w) { el.hidden = true; return; }
  const line = state.allLines[w.lineIdx];
  const pageDiv = state.pages[w.pageIndex].pageDiv;
  const vRect = viewer.getBoundingClientRect();
  const pRect = pageDiv.getBoundingClientRect();
  const pageOffsetTop = pRect.top - vRect.top;
  const pageOffsetLeft = pRect.left - vRect.left;
  // Place in the left margin of the bookmarked line
  const markerLeft = pageOffsetLeft + Math.max(4, line.left - 22);
  const markerTop = pageOffsetTop + line.top - 2;
  el.style.left = markerLeft + "px";
  el.style.top = markerTop + "px";
  el.hidden = false;
}

function updateBookmarkUI() {
  const pinned = state.pinnedWordIdx;
  if (pinned == null || !state.allWords.length) {
    gotoBookmarkBtn.disabled = true;
    bookmarkInfo.hidden = true;
    return;
  }
  const w = state.allWords[clampWord(pinned)];
  gotoBookmarkBtn.disabled = false;
  bookmarkInfo.hidden = false;
  bookmarkInfo.textContent = `Bookmark: page ${w.pageIndex + 1} · "${w.str.slice(0, 24)}${w.str.length > 24 ? "…" : ""}"`;
}

function pinBookmarkHere() {
  if (!state.allWords.length) return;
  state.pinnedWordIdx = state.currentWordIdx;
  saveCurrentBookmark();
  updateBookmarkMarker();
  updateBookmarkUI();
  const old = bookmarkBtn.textContent;
  bookmarkBtn.textContent = "★ Pinned";
  setTimeout(() => (bookmarkBtn.textContent = old), 1200);
}

function gotoBookmark() {
  if (state.pinnedWordIdx == null || !state.allWords.length) return;
  state.currentWordIdx = clampWord(state.pinnedWordIdx);
  updateHighlight();
  scrollToCurrent(true);
  saveCurrentBookmark();
}

function clampWord(i) {
  return Math.max(0, Math.min(state.allWords.length - 1, i));
}

function updateHighlight() {
  const h = state.highlightEl;
  if (!h) return;
  if (!state.allWords.length) { h.hidden = true; return; }

  const start = clampWord(state.currentWordIdx);
  const startWord = state.allWords[start];
  // Expand the band by up to (bandSize - 1) more words, but stop at the end of the line.
  let end = start;
  let count = 1;
  while (count < state.bandSize && end + 1 < state.allWords.length) {
    const next = state.allWords[end + 1];
    if (next.lineIdx !== startWord.lineIdx) break;
    end++;
    count++;
  }

  const first = startWord;
  const last = state.allWords[end];
  const pageDiv = state.pages[first.pageIndex].pageDiv;

  const vRect = viewer.getBoundingClientRect();
  const pRect = pageDiv.getBoundingClientRect();
  const pageOffsetTop = pRect.top - vRect.top;
  const pageOffsetLeft = pRect.left - vRect.left;

  // Vertical padding so the band covers ascenders AND descenders evenly.
  const padV = Math.max(4, first.height * 0.30);
  const padH = 4;

  const leftCss = first.left;
  const rightCss = last.left + last.width;

  h.hidden = false;
  h.style.top = (pageOffsetTop + first.top - padV) + "px";
  h.style.left = (pageOffsetLeft + leftCss - padH) + "px";
  h.style.width = (rightCss - leftCss + padH * 2) + "px";
  h.style.height = (first.height + padV * 2) + "px";

  pageInfoEl.textContent = `${first.pageIndex + 1} / ${state.numPages}`;
}

function scrollToCurrent(instant = false) {
  if (!state.allWords.length) return;
  if (!state.autoScroll && !instant) return;
  const word = state.allWords[clampWord(state.currentWordIdx)];
  const line = state.allLines[word.lineIdx];
  const pageDiv = state.pages[word.pageIndex].pageDiv;
  ensurePageRendered(word.pageIndex);
  const vRect = viewer.getBoundingClientRect();
  const pRect = pageDiv.getBoundingClientRect();
  const targetTopInViewer = (pRect.top - vRect.top) + line.top;
  const viewH = viewerWrap.clientHeight;
  const desired = targetTopInViewer - viewH * 0.35;
  viewerWrap.scrollTo({ top: desired, behavior: instant ? "auto" : "smooth" });
}

// ---------- Play / advance ----------
function startPlaying() {
  if (!state.allWords.length) return;
  state.playing = true;
  playBtn.textContent = "⏸ Pause";
  scheduleNext();
}
function stopPlaying() {
  state.playing = false;
  playBtn.textContent = "▶ Play";
  if (state.advanceTimer) {
    clearTimeout(state.advanceTimer);
    state.advanceTimer = null;
  }
}
function togglePlay() {
  state.playing ? stopPlaying() : startPlaying();
}

function scheduleNext() {
  if (!state.playing) return;
  const ms = 60000 / Math.max(1, state.wpm);
  state.advanceTimer = setTimeout(() => {
    if (!state.playing) return;
    if (state.currentWordIdx >= state.allWords.length - 1) {
      stopPlaying();
      return;
    }
    state.currentWordIdx++;
    updateHighlight();
    scrollToCurrent();
    saveCurrentBookmark();
    scheduleNext();
  }, ms);
}

function saveCurrentBookmark() {
  if (!state.fileHash) return;
  const word = state.allWords[clampWord(state.currentWordIdx)];
  setBookmark(state.fileHash, {
    fileName: state.fileName,
    page: word ? word.pageIndex + 1 : 1,
    wordIdx: state.currentWordIdx,
    pinnedWordIdx: state.pinnedWordIdx,
    wpm: state.wpm,
    bandSize: state.bandSize,
    zoom: state.zoom,
  });
}

// ---------- Navigation ----------
function goToPage(pageNum) {
  if (!state.pdfDoc) return;
  const idx = Math.max(1, Math.min(state.numPages, pageNum));
  const firstWordIdx = state.allWords.findIndex((w) => w.pageIndex === idx - 1);
  if (firstWordIdx !== -1) {
    state.currentWordIdx = firstWordIdx;
  }
  updateHighlight();
  scrollToCurrent(true);
  saveCurrentBookmark();
}
function nextPage() {
  if (!state.pdfDoc) return;
  const cur = state.allWords[state.currentWordIdx]?.pageIndex ?? 0;
  goToPage(cur + 2);
}
function prevPage() {
  if (!state.pdfDoc) return;
  const cur = state.allWords[state.currentWordIdx]?.pageIndex ?? 0;
  goToPage(cur);
}

function updatePageInfo() {
  pageInfoEl.textContent = state.numPages ? `1 / ${state.numPages}` : "– / –";
}
function updateWpmDisplay() { wpmVal.textContent = state.wpm + " wpm"; }
function updateBandDisplay() {
  bandVal.textContent = state.bandSize + (state.bandSize === 1 ? " word" : " words");
}

// ---------- File open flow ----------
async function pickAndOpen() {
  const picked = await pickPdfFile();
  if (!picked) return;
  const { file, handle } = picked;
  if (handle) await saveLastHandle(handle, handle.name);
  await loadFromFile(file);
  if (handle) {
    await saveHandleForHash(state.fileHash, handle, handle.name);
  }
  resumeBtn.hidden = true;
}

async function tryResumeLast() {
  const entry = await getLastHandle();
  if (!entry || !entry.handle) return;
  try {
    let perm = await entry.handle.queryPermission({ mode: "read" });
    if (perm !== "granted") {
      perm = await entry.handle.requestPermission({ mode: "read" });
    }
    if (perm !== "granted") return;
    const file = await entry.handle.getFile();
    await loadFromFile(file);
    resumeBtn.hidden = true;
  } catch (e) {
    console.warn("Could not resume last file:", e);
  }
}

// ---------- Events ----------
openBtn.addEventListener("click", pickAndOpen);
resumeBtn.addEventListener("click", tryResumeLast);

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await loadFromFile(file);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  viewerWrap.addEventListener(ev, (e) => {
    e.preventDefault();
    viewerWrap.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  viewerWrap.addEventListener(ev, (e) => {
    e.preventDefault();
    viewerWrap.classList.remove("dragover");
  })
);
viewerWrap.addEventListener("drop", async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    await loadFromFile(file);
  }
});

playBtn.addEventListener("click", togglePlay);
wpmSlider.addEventListener("input", () => {
  state.wpm = Number(wpmSlider.value);
  updateWpmDisplay();
  saveCurrentBookmark();
});
bandSlider.addEventListener("input", () => {
  state.bandSize = Math.max(1, Number(bandSlider.value));
  updateBandDisplay();
  updateHighlight();
  saveCurrentBookmark();
});
autoscrollChk.addEventListener("change", () => {
  state.autoScroll = autoscrollChk.checked;
});
bookmarkBtn.addEventListener("click", pinBookmarkHere);
gotoBookmarkBtn.addEventListener("click", gotoBookmark);
prevPageBtn.addEventListener("click", prevPage);
nextPageBtn.addEventListener("click", nextPage);
zoomInBtn.addEventListener("click", () => setZoom(state.zoom * 1.15));
zoomOutBtn.addEventListener("click", () => setZoom(state.zoom / 1.15));
zoomFitBtn.addEventListener("click", fitWidth);

let resizeRaf = null;
window.addEventListener("resize", () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    updateHighlight();
    updateBookmarkMarker();
  });
});
viewerWrap.addEventListener("scroll", () => {
  // marker is positioned within #viewer so it scrolls naturally; nothing to do
});

// ---------- Graceful shutdown ----------
// Save progress + stop playback before the tab is closed, hidden, or navigated away.
// localStorage writes are synchronous so the state is persisted before the tab dies.
function gracefulShutdown() {
  try {
    stopPlaying();
    saveCurrentBookmark();
  } catch (_) { /* never block shutdown */ }
}

// Tab hidden (minimize, switch tab, lock screen): pause & save so you come back paused.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") gracefulShutdown();
});

// Tab/window closing (the most reliable cleanup event on modern browsers).
window.addEventListener("pagehide", gracefulShutdown);

// Extra safety net; we do NOT return a string, so no confirmation dialog is shown.
window.addEventListener("beforeunload", gracefulShutdown);

// Click anywhere on a page to move the highlight to the nearest word.
viewer.addEventListener("click", (e) => {
  if (!state.pdfDoc || !state.allWords.length) return;
  const pageEl = e.target.closest && e.target.closest(".page");
  if (!pageEl) return;
  const pageIndex = Number(pageEl.dataset.pageIndex);
  if (Number.isNaN(pageIndex)) return;

  const pRect = pageEl.getBoundingClientRect();
  const clickY = e.clientY - pRect.top;
  const clickX = e.clientX - pRect.left;

  const pLines = state.pages[pageIndex].lines;
  if (!pLines.length) return;

  let bestIdx = -1;
  let bestScore = Infinity;
  for (const line of pLines) {
    const lineTop = line.top;
    const lineBottom = line.top + line.height;
    let vDist;
    if (clickY >= lineTop && clickY <= lineBottom) vDist = 0;
    else if (clickY < lineTop) vDist = lineTop - clickY;
    else vDist = clickY - lineBottom;

    for (let wi = line.firstWordIdx; wi <= line.lastWordIdx; wi++) {
      const w = state.allWords[wi];
      const wMid = w.left + w.width / 2;
      // Horizontal distance: 0 if click is inside the word, else distance to nearest edge
      let hDist;
      if (clickX >= w.left && clickX <= w.left + w.width) hDist = 0;
      else hDist = Math.min(Math.abs(clickX - w.left), Math.abs(clickX - (w.left + w.width)));
      const score = vDist * 4 + hDist;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = wi;
      }
    }
  }
  if (bestIdx === -1) return;

  state.currentWordIdx = bestIdx;
  updateHighlight();
  scrollToCurrent();
  saveCurrentBookmark();

  if (state.playing) {
    if (state.advanceTimer) { clearTimeout(state.advanceTimer); state.advanceTimer = null; }
    scheduleNext();
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;

  switch (e.key) {
    case " ":
      e.preventDefault();
      togglePlay();
      break;
    case "ArrowLeft":
      e.preventDefault();
      prevPage();
      break;
    case "ArrowRight":
      e.preventDefault();
      nextPage();
      break;
    case "+":
    case "=":
      state.wpm = Math.min(900, state.wpm + 25);
      wpmSlider.value = state.wpm;
      updateWpmDisplay();
      saveCurrentBookmark();
      break;
    case "-":
    case "_":
      state.wpm = Math.max(80, state.wpm - 25);
      wpmSlider.value = state.wpm;
      updateWpmDisplay();
      saveCurrentBookmark();
      break;
    case "[":
      setZoom(state.zoom / 1.15);
      break;
    case "]":
      setZoom(state.zoom * 1.15);
      break;
    case "f":
    case "F":
      fitWidth();
      break;
    case ",":
    case "<":
      state.bandSize = Math.max(1, state.bandSize - 1);
      bandSlider.value = state.bandSize;
      updateBandDisplay();
      updateHighlight();
      saveCurrentBookmark();
      break;
    case ".":
    case ">":
      state.bandSize = Math.min(Number(bandSlider.max), state.bandSize + 1);
      bandSlider.value = state.bandSize;
      updateBandDisplay();
      updateHighlight();
      saveCurrentBookmark();
      break;
    case "b":
    case "B":
      pinBookmarkHere();
      break;
    case "g":
    case "G":
      gotoBookmark();
      break;
    case "r":
    case "R": {
      const pageIdx = state.allWords[state.currentWordIdx]?.pageIndex ?? 0;
      const first = state.allWords.findIndex((w) => w.pageIndex === pageIdx);
      if (first !== -1) {
        state.currentWordIdx = first;
        updateHighlight();
        scrollToCurrent(true);
      }
      break;
    }
    case "Escape":
      if (!settingsOverlay.hidden) { closeSettings(); break; }
      stopPlaying();
      break;
  }
});

// ---------- Settings modal ----------
const settingsBtn = $("settingsBtn");
const settingsOverlay = $("settingsOverlay");
const settingsClose = $("settingsClose");
const storagePathEl = $("storagePath");
const storageStatusEl = $("storageStatus");
const defaultWpmEl = $("defaultWpm");
const defaultWpmValEl = $("defaultWpmVal");
const defaultBandEl = $("defaultBand");
const defaultBandValEl = $("defaultBandVal");
const defaultAutoscrollEl = $("defaultAutoscroll");
const bookmarksListEl = $("bookmarksList");
const bookmarksCountEl = $("bookmarksCount");
const bookmarksExportBtn = $("bookmarksExport");

function openSettings() {
  settingsOverlay.hidden = false;
  refreshSettingsUI();
  renderBookmarksList();
}
function closeSettings() { settingsOverlay.hidden = true; }

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// Tab switching
document.querySelectorAll(".modal .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".modal .tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".modal .tab-pane").forEach((p) =>
      p.classList.toggle("active", p.dataset.tab === target)
    );
    if (target === "bookmarks") renderBookmarksList();
  });
});

function refreshSettingsUI() {
  storagePathEl.textContent = store._storagePath || "(unknown)";
  storageStatusEl.textContent = store._backend === "server"
    ? "Saved to a JSON file on disk. Survives app reinstalls and Chrome resets."
    : "Fallback mode: saved in browser localStorage only. Start the app via Focus PDF Reader.app for file-based storage.";
  defaultWpmEl.value = store.settings.defaultWpm;
  defaultWpmValEl.textContent = `${store.settings.defaultWpm} wpm`;
  defaultBandEl.value = store.settings.defaultBandSize;
  defaultBandValEl.textContent = `${store.settings.defaultBandSize} words`;
  defaultAutoscrollEl.checked = !!store.settings.defaultAutoScroll;
}

defaultWpmEl.addEventListener("input", () => {
  store.settings.defaultWpm = Number(defaultWpmEl.value);
  defaultWpmValEl.textContent = `${store.settings.defaultWpm} wpm`;
  scheduleStoreSave();
});
defaultBandEl.addEventListener("input", () => {
  store.settings.defaultBandSize = Number(defaultBandEl.value);
  defaultBandValEl.textContent = `${store.settings.defaultBandSize} words`;
  scheduleStoreSave();
});
defaultAutoscrollEl.addEventListener("change", () => {
  store.settings.defaultAutoScroll = defaultAutoscrollEl.checked;
  scheduleStoreSave();
});

bookmarksExportBtn.addEventListener("click", () => {
  const blob = new Blob(
    [JSON.stringify({ version: store.version, settings: store.settings, bookmarks: store.bookmarks }, null, 2)],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "focuspdf-bookmarks.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

async function renderBookmarksList() {
  const entries = Object.entries(store.bookmarks)
    .sort((a, b) => (b[1].lastOpenedAt || b[1].updatedAt || 0) - (a[1].lastOpenedAt || a[1].updatedAt || 0));
  bookmarksCountEl.textContent = `${entries.length} bookmark${entries.length === 1 ? "" : "s"}`;

  if (!entries.length) {
    bookmarksListEl.innerHTML = `<div class="bookmarks-empty">No bookmarks yet. Open a PDF to get started.</div>`;
    return;
  }

  bookmarksListEl.innerHTML = "";
  for (const [hash, bm] of entries) {
    const row = document.createElement("div");
    row.className = "bookmark-row";

    // Check if we have a handle we can still reach for this PDF
    let handleEntry = null;
    try { handleEntry = await getHandleForHash(hash); } catch {}
    let accessible = false;
    if (handleEntry && handleEntry.handle) {
      try {
        const perm = await handleEntry.handle.queryPermission({ mode: "read" });
        accessible = perm === "granted" || perm === "prompt";
      } catch { accessible = false; }
    }
    const missing = !handleEntry || !accessible;
    if (missing) row.classList.add("missing");

    const dot = document.createElement("div");
    dot.className = "bookmark-status";
    dot.title = missing ? "File location unknown or not granted — click Relink" : "File accessible";
    row.appendChild(dot);

    const main = document.createElement("div");
    main.className = "bookmark-main";
    const name = document.createElement("div");
    name.className = "bookmark-name";
    name.textContent = bm.fileName || "(unknown)";
    main.appendChild(name);
    const meta = document.createElement("div");
    meta.className = "bookmark-meta";
    const pageLine = typeof bm.page === "number" ? `page ${bm.page}` : "not yet read";
    const lastOpened = bm.lastOpenedAt ? new Date(bm.lastOpenedAt).toLocaleDateString() : "";
    const sizeKb = bm.fileSize ? `${Math.round(bm.fileSize / 1024)} KB` : "";
    meta.innerHTML = `${pageLine} · ${lastOpened || ""} ${sizeKb ? "· " + sizeKb : ""}<br><code>hash ${hash.slice(0, 10)}…</code>`;
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "bookmark-actions";

    if (!missing) {
      const openBtn = document.createElement("button");
      openBtn.textContent = "Open ↗";
      openBtn.title = "Open this PDF";
      openBtn.addEventListener("click", () => openBookmark(hash));
      actions.appendChild(openBtn);
    }

    const relinkBtn = document.createElement("button");
    relinkBtn.className = "relink";
    relinkBtn.textContent = missing ? "Relink →" : "Change file";
    relinkBtn.title = "Pick the file's new location in Finder";
    relinkBtn.addEventListener("click", () => relinkBookmark(hash));
    actions.appendChild(relinkBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.title = "Remove this bookmark";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete bookmark for "${bm.fileName}"? This only removes the saved position, not the PDF file.`)) return;
      deleteBookmark(hash);
      try { await idbDel(`bm:${hash}`); } catch {}
      await saveStoreNow();
      renderBookmarksList();
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);
    bookmarksListEl.appendChild(row);
  }
}

async function openBookmark(hash) {
  try {
    const entry = await getHandleForHash(hash);
    if (!entry || !entry.handle) {
      alert("This bookmark has no saved file location. Click Relink to point it at the PDF.");
      return;
    }
    let perm = await entry.handle.queryPermission({ mode: "read" });
    if (perm !== "granted") perm = await entry.handle.requestPermission({ mode: "read" });
    if (perm !== "granted") return;
    const file = await entry.handle.getFile();
    await loadFromFile(file);
    await saveLastHandle(entry.handle, entry.handle.name);
    closeSettings();
  } catch (e) {
    console.warn("Open bookmark failed:", e);
    // mark as missing in store
    setBookmark(hash, { missing: true });
    await saveStoreNow();
    renderBookmarksList();
  }
}

// Pick a PDF. Uses the File System Access API when available (gives us a
// persistent handle); falls back to a plain <input type="file"> otherwise.
// Returns { file, handle|null } or null on cancel.
function pickPdfFile() {
  if (window.showOpenFilePicker) {
    return (async () => {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
          multiple: false,
        });
        const file = await handle.getFile();
        return { file, handle };
      } catch {
        return null;
      }
    })();
  }
  // Fallback for non-Chromium browsers or restricted contexts
  return new Promise((resolve) => {
    const input = document.getElementById("relinkInput");
    const onChange = () => {
      input.removeEventListener("change", onChange);
      const file = input.files && input.files[0];
      input.value = "";
      resolve(file ? { file, handle: null } : null);
    };
    input.addEventListener("change", onChange);
    input.click();
  });
}

async function relinkBookmark(hash) {
  const picked = await pickPdfFile();
  if (!picked) return;
  const { file, handle } = picked;

  const buf = await file.arrayBuffer();
  const newHash = await hashBuffer(buf);
  const originalBm = store.bookmarks[hash] || {};

  if (newHash === hash) {
    if (handle) await saveHandleForHash(hash, handle, handle.name);
    setBookmark(hash, { fileName: file.name, fileSize: file.size, missing: false });
    await saveStoreNow();
    renderBookmarksList();
    alert(handle
      ? "Relinked successfully. This file will open automatically from the Bookmarks tab from now on."
      : "Relinked for this session. Your browser doesn't expose a persistent file handle, so you'll need to re-pick the file each time.");
    return;
  }

  // Hashes differ — contents are not identical to the original file
  const proceed = confirm(
    `The file you picked has different contents than the original bookmark.\n\n` +
    `Original: ${originalBm.fileName || "(unknown)"}\n` +
    `Picked:   ${file.name}\n\n` +
    `OK = keep the old bookmark's saved position and use this file anyway (likely wrong page).\n` +
    `Cancel = create a fresh bookmark for the new file and keep the old one too.`
  );
  if (proceed) {
    if (handle) await saveHandleForHash(hash, handle, handle.name);
    setBookmark(hash, { fileName: file.name, fileSize: file.size, missing: false });
  } else {
    if (handle) await saveHandleForHash(newHash, handle, handle.name);
    setBookmark(newHash, { fileName: file.name, fileSize: file.size, lastOpenedAt: Date.now() });
  }
  await saveStoreNow();
  renderBookmarksList();
}

// ---------- Startup ----------
(async function init() {
  await loadStore();
  // Apply stored defaults to the live controls
  state.wpm = store.settings.defaultWpm;
  state.bandSize = store.settings.defaultBandSize;
  state.zoom = store.settings.defaultZoom;
  state.autoScroll = !!store.settings.defaultAutoScroll;
  wpmSlider.value = state.wpm;
  bandSlider.value = state.bandSize;
  autoscrollChk.checked = state.autoScroll;
  updateWpmDisplay();
  updateBandDisplay();
  refreshSettingsUI();

  try {
    const last = await getLastHandle();
    if (last && last.handle) {
      resumeBtn.hidden = false;
      resumeBtn.textContent = `Resume: ${last.name}`;
      fileNameEl.textContent = "No file loaded";
      const perm = await last.handle.queryPermission({ mode: "read" });
      if (perm === "granted") {
        const file = await last.handle.getFile();
        await loadFromFile(file);
        resumeBtn.hidden = true;
      }
    }
  } catch (_) { /* ignore */ }
})();
