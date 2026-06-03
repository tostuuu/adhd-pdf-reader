// rsvp-popup.js — standalone Rapid Serial Visual Presentation window.
//
// Renders the current word being read in the main Focus PDF Reader window,
// and forwards user actions (play, prev/next, wpm) back to it.
// Communication is via a same-origin BroadcastChannel; no PDF or bookmark
// logic lives here — this window is a pure remote display.

const CHANNEL = "focuspdf-rsvp";
const channel = new BroadcastChannel(CHANNEL);

const $ = (id) => document.getElementById(id);
const preEl       = $("rsvpPre");
const orpEl       = $("rsvpOrp");
const postEl      = $("rsvpPost");
const wordEl      = $("rsvpWord");
const progressEl  = $("rsvpProgress");
const statusEl    = $("rsvpStatus");
const playBtn     = $("rsvpPlay");
const prevBtn     = $("rsvpPrev");
const nextBtn     = $("rsvpNext");
const wpmSlider   = $("rsvpWpm");
const wpmValEl    = $("rsvpWpmVal");
const fontSmaller = $("rsvpFontSmaller");
const fontBigger  = $("rsvpFontBigger");

// ---------- ORP (must match host) ----------
function orpIndex(len) {
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
}

// ---------- Word-size preference ----------
// Same localStorage key as the host so changes in either place stick.
const STYLE_KEY = "focuspdf_rsvp_style";
const FONT_MIN = 36;
const FONT_MAX = 220;
function loadStyle() {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    return raw ? JSON.parse(raw) : { fontSize: 96 };
  } catch { return { fontSize: 96 }; }
}
function saveStyle(s) {
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(s)); } catch {}
}
function applyStyle() {
  wordEl.style.fontSize = `${loadStyle().fontSize}px`;
}
applyStyle();

// ---------- Render a state snapshot from the host ----------
function render(s) {
  const str = s.word ?? "";
  if (!str) {
    preEl.textContent = "";
    orpEl.textContent = "—";
    postEl.textContent = "";
    progressEl.textContent = s.total ? "no word" : "no PDF in main window";
    playBtn.textContent = "▶";
    return;
  }
  const i = Math.min(orpIndex(str.length), str.length - 1);
  preEl.textContent  = str.slice(0, i);
  orpEl.textContent  = str.slice(i, i + 1);
  postEl.textContent = str.slice(i + 1);
  progressEl.textContent = `p${s.page} · w${s.wordIdx + 1}/${s.total}`;
  playBtn.textContent = s.playing ? "⏸" : "▶";
  // Don't fight the user while they're dragging the slider.
  if (Number.isFinite(s.wpm) && document.activeElement !== wpmSlider) {
    wpmSlider.value = s.wpm;
    wpmValEl.textContent = `${s.wpm} wpm`;
  }
}

// ---------- Connection health ----------
// If we haven't heard from the host in a few seconds, show a red pulsing dot.
let lastSeen = 0;
function refreshStatus() {
  const stale = !lastSeen || Date.now() - lastSeen > 5000;
  statusEl.classList.toggle("disconnected", stale);
  statusEl.title = stale
    ? "No signal from main window — reopen it or click the buttons to reconnect"
    : "Connected";
}
setInterval(refreshStatus, 1000);
refreshStatus();

channel.addEventListener("message", (e) => {
  if (e.data?.type !== "state") return;
  lastSeen = Date.now();
  render(e.data);
  refreshStatus();
});

// Greet the host so it sends us its current state immediately.
channel.postMessage({ type: "hello" });

// ---------- User actions → host commands ----------
playBtn.addEventListener("click", () => channel.postMessage({ type: "togglePlay" }));
prevBtn.addEventListener("click", () => channel.postMessage({ type: "step", delta: -1 }));
nextBtn.addEventListener("click", () => channel.postMessage({ type: "step", delta: +1 }));
wpmSlider.addEventListener("input", () => {
  const v = Number(wpmSlider.value);
  wpmValEl.textContent = `${v} wpm`;
  channel.postMessage({ type: "setWpm", value: v });
});

function bumpFont(delta) {
  const s = loadStyle();
  s.fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, s.fontSize + delta));
  saveStyle(s);
  applyStyle();
}
fontSmaller.addEventListener("click", () => bumpFont(-12));
fontBigger.addEventListener("click", () => bumpFont(+12));

// Keyboard shortcuts in this window: Space, ←, →. Same semantics as host.
document.addEventListener("keydown", (e) => {
  if (e.target?.isContentEditable || e.target?.tagName === "INPUT") return;
  if (e.key === " ")           { e.preventDefault(); channel.postMessage({ type: "togglePlay" }); }
  else if (e.key === "ArrowLeft")  { e.preventDefault(); channel.postMessage({ type: "step", delta: -1 }); }
  else if (e.key === "ArrowRight") { e.preventDefault(); channel.postMessage({ type: "step", delta: +1 }); }
});
