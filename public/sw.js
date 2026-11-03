// Service Worker for Expenser PWA.
// Caches shell assets for fast loading and offline fallback.
// Never caches API requests to preserve live financial state.

const CACHE_NAME = "expenser-v2";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/icons.svg",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.json",
  "/js/main.js",
  "/js/api.js",
  "/js/composer.js",
  "/js/editing.js",
  "/js/format.js",
  "/js/render.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip caching API routes entirely
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Network-first strategy with cache fallback for static shell
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.method === "GET") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
