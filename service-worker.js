// POS Service Worker
// 1. Caches the app shell so the PWA installs and opens instantly, even offline.
// 2. Owns the outbound queue: bills created while offline are stored in IndexedDB
//    by the app, and this worker retries POSTing them whenever connectivity returns.

const CACHE_NAME = "pos-shell-v12"; // bumped: new slate/teal theme + light theme-color/manifest (fixes dark status bar/splash on mobile)
const APP_SHELL = [
  "/",
  "/index.html",
  "/signup.html",
  "/forgot-password.html",
  "/reset-password.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/admin.html",
  "/dashboard.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Chrome refuses to let a service worker respond to a *navigation* request with a
// Response that came from a followed redirect (response.redirected === true) — it
// fails the whole navigation with net::ERR_FAILED instead of just showing the final
// page. Cloudflare Pages issues exactly such a redirect for every *.html URL (e.g.
// /signup.html -> /signup), so without this, tapping any .html link is broken.
// Rebuilding a fresh Response strips that flag and keeps navigation working.
async function toSafeResponse(response) {
  if (response && response.redirected) {
    const body = await response.blob();
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return response;
}

// Cache-first for the app shell, network-first for API calls (never serve stale POS data as if it were current).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // let API calls hit the network directly; app handles queueing on failure
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return toSafeResponse(cached);
      const network = await fetch(event.request);
      return toSafeResponse(network);
    })()
  );
});

// Background Sync: when the browser regains connectivity, it fires this event.
// The app registers a 'sync-bills' sync when a bill is queued offline.
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-bills") {
    event.waitUntil(flushQueuedBills());
  }
});

async function flushQueuedBills() {
  const clientsList = await self.clients.matchAll();
  // Actual queue lives in IndexedDB, managed by the app (service workers can use idb too,
  // but keeping the read/write logic in one place — the app — avoids two copies of queue logic).
  // This just tells every open tab/window "try flushing now."
  clientsList.forEach((client) => client.postMessage({ type: "FLUSH_BILL_QUEUE" }));
}
