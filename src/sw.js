// @ts-check
/// <reference lib="webworker" />
// Built into /sw.js by the service-worker plugin in vite.config.ts, which fills in the
// precache list and a version hash of every precached file.

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const VERSION = "__VERSION__";
const PRECACHE = /** @type {string[]} */ (/** @type {unknown} */ ("__PRECACHE__"));
const PREFIX = "video-to-audio-";
const CACHE = PREFIX + VERSION;

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== sw.location.origin) return;

  if (request.mode === "navigate") {
    // Network first so a new deploy shows up immediately; the cached page keeps it working offline.
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("./", { ignoreSearch: true })) ?? Response.error()),
    );
    return;
  }

  // ignoreVary: precached requests carried no Origin header, while the page's crossorigin
  // module/style requests do, so a "Vary: Origin" response would otherwise never match.
  event.respondWith(caches.match(request, { ignoreVary: true }).then((hit) => hit ?? fetch(request)));
});
