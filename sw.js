// Service worker: cache the app shell + PDF.js assets so the app works offline
// after first install. Uses stale-while-revalidate for a snappy launch.

const CACHE = "focuspdf-v1";
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
      // Best-effort: don't fail the install if CDN temporarily can't be reached.
      await cache.addAll(APP_SHELL).catch(() => {});
      await Promise.allSettled(
        PDFJS_ASSETS.map((url) =>
          fetch(url, { mode: "cors" }).then((r) => r.ok && cache.put(url, r.clone())).catch(() => {})
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

  // Stale-while-revalidate for same-origin GETs and the cached CDN PDF.js files
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
});
