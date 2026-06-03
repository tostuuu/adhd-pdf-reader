// Standalone Notes editor — drag this OS window to your second monitor.
// Talks to the main app via BroadcastChannel("focuspdf-notes") to learn which
// PDF is currently open, then loads and saves notes directly through the
// server at /api/notes-html/<hash>. The host editor (if also open) is told to
// reload after every save here, so the two views stay in sync.

const CHANNEL = "focuspdf-notes";
const channel = new BroadcastChannel(CHANNEL);

const $ = (id) => document.getElementById(id);
const titleEl    = $("notesTitle");
const statusEl   = $("notesStatus");
const statusDot  = $("notesStatusDot");
const editorEl   = $("notesEditor");
const toolbarEl  = $("notesToolbar");

let currentHash = null;
let currentPdfName = null;
let saveTimer = null;
let lastSeen = 0;
// Set true while we're programmatically replacing editor content from a
// server fetch; the text-change handler must not treat that as a user edit.
let suppressTextChange = false;

const Quill = window.Quill;
if (!Quill) {
  statusEl.textContent = "Quill failed to load. Try reopening the popup.";
}

const quill = Quill ? new Quill(editorEl, {
  theme: "snow",
  placeholder: "Take notes — saved automatically per PDF.",
  modules: {
    toolbar: {
      container: "#notesToolbar",
      handlers: {
        time: () => insertTimestamp(),
        insertTable: () => insertTable(),
        tableAddRow: () => withTableModule((m) => m.insertRowBelow?.() || m.appendRow?.()),
        tableAddCol: () => withTableModule((m) => m.insertColumnRight?.() || m.appendColumn?.()),
        tableDelRow: () => withTableModule((m) => m.deleteRow?.()),
        tableDelCol: () => withTableModule((m) => m.deleteColumn?.()),
        tableDelete: () => withTableModule((m) => m.deleteTable?.()),
      },
    },
  },
}) : null;

if (quill) quill.disable();

// ---------- Timestamp / table helpers (mirror of host) ----------
function timestampString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `[${dateStr} ${days[d.getDay()]} ${timeStr}]`;
}

function insertTimestamp() {
  if (!quill) return;
  const range = quill.getSelection(true);
  const ts = timestampString();
  quill.insertText(range.index, ts, "bold", true, "user");
  quill.insertText(range.index + ts.length, "\n", "bold", false, "user");
  quill.setSelection(range.index + ts.length + 1, 0, "user");
}

function insertTable() {
  if (!quill) return;
  const tableModule = quill.getModule("table");
  if (tableModule && typeof tableModule.insertTable === "function") {
    tableModule.insertTable(3, 3);
  } else {
    const html =
      "<table><tbody>" +
      "<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>".repeat(3) +
      "</tbody></table><p><br></p>";
    const range = quill.getSelection(true);
    quill.clipboard.dangerouslyPasteHTML(range.index, html, "user");
  }
}

function withTableModule(fn) {
  if (!quill) return;
  const m = quill.getModule("table");
  if (!m) return;
  const range = quill.getSelection();
  if (!range) return;
  const node = quill.getLeaf(range.index)?.[0]?.domNode;
  const cell = node && (node.closest ? node.closest("td") : null);
  if (!cell) return;
  try { fn(m); } catch (e) { console.warn("[focuspdf] table op failed:", e); }
}

// Dim the table-edit buttons when the cursor isn't inside a table cell.
function updateTableContext() {
  if (!quill || !toolbarEl) return;
  const range = quill.getSelection();
  let inTable = false;
  if (range) {
    const node = quill.getLeaf(range.index)?.[0]?.domNode;
    inTable = !!(node && node.closest && node.closest("td"));
  }
  toolbarEl.classList.toggle("no-table-context", !inTable);
}

// ---------- Server I/O ----------
async function loadNoteHtml(hash) {
  const res = await fetch(`/api/notes-html/${encodeURIComponent(hash)}`, { cache: "no-store" });
  return res.ok ? await res.text() : "";
}

async function saveNoteHtml(hash, html) {
  try {
    const res = await fetch(`/api/notes-html/${encodeURIComponent(hash)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- Load / save ----------
async function loadNote() {
  if (!quill) return;
  if (!currentHash) {
    suppressTextChange = true;
    quill.setContents([], "silent");
    suppressTextChange = false;
    quill.disable();
    titleEl.textContent = "📝 Notes";
    statusEl.textContent = "open a PDF in the main window";
    return;
  }
  quill.disable();
  statusEl.textContent = "Loading…";
  try {
    const html = await loadNoteHtml(currentHash);
    suppressTextChange = true;
    quill.setContents([], "silent");
    if (html) quill.clipboard.dangerouslyPasteHTML(0, html, "silent");
    suppressTextChange = false;
    quill.enable();
    titleEl.textContent = `📝 ${currentPdfName || "Notes"}`;
    statusEl.textContent = html ? "Loaded" : "Empty — start typing.";
    updateTableContext();
  } catch (e) {
    statusEl.textContent = "Load failed";
  }
}

async function saveNote() {
  if (!quill || !currentHash) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const hash = currentHash;
  const html = quill.root.innerHTML;
  const ok = await saveNoteHtml(hash, html);
  statusEl.textContent = ok ? "Saved" : "Save failed";
  if (ok) channel.postMessage({ type: "noteSaved", hash });
}

if (quill) {
  quill.on("text-change", (_d, _o, source) => {
    if (suppressTextChange) return;
    if (source !== "user" || !currentHash) return;
    statusEl.textContent = "Saving…";
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNote, 400);
  });
  quill.on("selection-change", updateTableContext);
}

// Best-effort save when the window is closed — keepalive lets the request
// outlive the unload.
window.addEventListener("beforeunload", () => {
  if (!quill || !currentHash) return;
  if (!saveTimer) return;
  const html = quill.root.innerHTML;
  fetch(`/api/notes-html/${encodeURIComponent(currentHash)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
    keepalive: true,
  });
});

// ---------- Connection health indicator ----------
function refreshStatus() {
  const stale = !lastSeen || Date.now() - lastSeen > 8000;
  statusDot.classList.toggle("disconnected", stale);
  statusDot.title = stale
    ? "No signal from the main window — keep that tab open."
    : "Connected to main window";
}
setInterval(refreshStatus, 1000);
refreshStatus();

// ---------- Channel ----------
channel.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type === "context") {
    lastSeen = Date.now();
    const newHash = m.hash || null;
    const newName = m.pdfName || null;
    if (newHash !== currentHash) {
      // Flush any pending save against the OLD hash before switching contexts.
      if (saveTimer && currentHash) {
        clearTimeout(saveTimer);
        saveTimer = null;
        const html = quill.root.innerHTML;
        saveNoteHtml(currentHash, html).then((ok) => {
          if (ok) channel.postMessage({ type: "noteSaved", hash: currentHash });
        });
      }
      currentHash = newHash;
      currentPdfName = newName;
      loadNote();
    } else if (newName !== currentPdfName) {
      currentPdfName = newName;
      titleEl.textContent = `📝 ${currentPdfName || "Notes"}`;
    }
    refreshStatus();
    return;
  }
  if (m.type === "noteSaved") {
    lastSeen = Date.now();
    if (m.hash !== currentHash) return;
    if (saveTimer) return;
    if (quill && quill.hasFocus && quill.hasFocus()) return;
    loadNote();
    refreshStatus();
    return;
  }
});

// Greet the host so it sends its current context immediately.
channel.postMessage({ type: "hello" });
