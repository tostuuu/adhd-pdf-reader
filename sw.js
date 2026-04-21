// Service worker: network-first for our own files (so code updates apply
// immediately), stale-while-revalidate for the PDF.js CDN (for speed and
// offline). Bump CACHE when you ship significant changes.

const CACHE = "focuspdf-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/icon.svg",
  "/manifest.webmanifest",
];

const PDFJS_ASSETS = [
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(APP_SHELL).catch(() => {});
      await Promise.allSettled(
        PDFJS_ASSETS.map((url) =>
          fetch(url, { mode: "cors" })
            .then((r) => r.ok && cache.put(url, r.clone()))
            .catch(() => {})
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Never intercept API or dynamic backend calls; let them hit the server directly.
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  if (url.origin === self.location.origin) {
    // Same-origin app shell: network-first so updates apply immediately.
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        } catch {
          const cached = await caches.match(req, { ignoreSearch: true });
          if (cached) return cached;
          throw new Error("offline and no cache");
        }
      })()
    );
  } else {
    // Cross-origin (CDN): stale-while-revalidate.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req, { ignoreSearch: true });
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && (res.type === "basic" || res.type === "cors")) {
              cache.put(req, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })()
    );
  }
});

// Allow the page to ask for an immediate update
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
