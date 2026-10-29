// The offline side of the page. Without a network the page and its pinned
// libraries come from the cache, and so do the last answers of the API that
// it reads (the account, the cars, their events and reminders), marked
// x-offline with the time they were fetched (x-fetched). With a network
// everything is fetched as before and the cache only follows. Files, map
// tiles and every write go past the cache; the page queues the new events
// itself (app.js, the outbox).
const SHELL = "cars-shell-v4";
const DATA = "cars-data-v1";
const PAGE = ["/", "/index.html", "/app.js", "/stats.js", "/charts.js", "/i18n.js", "/styles.css", "/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/config.js", "/manifest.json"];
// Versioned and with subresource integrity: kept once fetched. The two the
// page needs to sign in come with the page; Leaflet when the map opens.
const LIBRARIES = ["https://cdn.jsdelivr.net/npm/", "https://cdnjs.cloudflare.com/ajax/libs/"];
const SIGN_IN = [
  "https://cdn.jsdelivr.net/npm/amazon-cognito-identity-js@6.3.15/dist/amazon-cognito-identity.min.js",
  "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js",
];
const READS = /^\/api\/(me|version|cars(\/[^/]+(\/(events|reminders))?)?|share\/.+)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL)
    .then((cache) => cache.addAll(PAGE).then(() => Promise.all(SIGN_IN.map((url) => cache.add(new Request(url, { mode: "cors" })).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== SHELL && name !== DATA).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

// The page that signs out forgets what it read.
self.addEventListener("message", (event) => {
  if (event.data === "forget") event.waitUntil(caches.delete(DATA));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (LIBRARIES.some((prefix) => request.url.startsWith(prefix))) {
    event.respondWith(caches.open(SHELL).then(async (cache) => {
      const kept = await cache.match(request);
      if (kept) return kept;
      const answer = await fetch(request);
      if (answer.ok) await cache.put(request, answer.clone());
      return answer;
    }));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith("/files/")) return;
  if (url.pathname.startsWith("/api/")) {
    if (READS.test(url.pathname)) event.respondWith(read(request));
    return;
  }
  // The page: fresh when there is a network, else the last one. Only a
  // navigation falls back to the page itself; a missing script is missing.
  const key = request.mode === "navigate" ? "/index.html" : request;
  event.respondWith(fetch(request).then((answer) => {
    if (answer.ok) {
      const copy = answer.clone();
      event.waitUntil(caches.open(SHELL).then((cache) => cache.put(key, copy)));
    }
    return answer;
  }).catch(async () => (await caches.match(key, { ignoreSearch: true })) || Response.error()));
});

async function read(request) {
  const cache = await caches.open(DATA);
  try {
    const answer = await fetch(request);
    if (answer.ok) {
      const headers = new Headers(answer.headers);
      headers.set("x-fetched", new Date().toISOString());
      await cache.put(request, new Response(await answer.clone().blob(), { status: answer.status, headers }));
    }
    return answer;
  } catch (error) {
    const kept = await cache.match(request);
    if (!kept) {
      return new Response(JSON.stringify({ error: "No network", code: "offline" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const headers = new Headers(kept.headers);
    headers.set("x-offline", "1");
    return new Response(await kept.blob(), { status: kept.status, headers });
  }
}
