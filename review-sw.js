/* Build scripts stamp the shell version and asset URLs. Card data and API responses never enter this cache. */
const CACHE = "interview-shell-8f7cabb0e48c";
const BASE = new URL("./", self.location.href);
const SHELL = ["review.html", "styles.css?v=8f7cabb0e48c", "review.js?v=8f7cabb0e48c", "review.webmanifest", "assets/app-icon-192.png", "assets/app-icon-512.png", "assets/vendor/qrcode-generator/qrcode.js?v=2.0.4"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    for (const path of SHELL) { const url = new URL(path, BASE); const response = await fetch(url, { cache: "reload" }); if (!response.ok) throw new Error("Offline shell incomplete"); await cache.put(url, response); }
    const page = await cache.match(new URL("review.html", BASE));
    await cache.put(BASE, page.clone()); await cache.put(new URL("index.html", BASE), page.clone());
  }));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("interview-shell-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request; const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== BASE.origin || url.pathname.startsWith("/api/") || request.headers.has("Authorization")) return;
  const relative = url.pathname.slice(BASE.pathname.length);
  const isReview = request.mode === "navigate" && (relative === "review.html" || (!['localhost', '127.0.0.1'].includes(url.hostname) && ["", "index.html"].includes(relative)));
  const shellAsset = SHELL.some(path => new URL(path, BASE).pathname === url.pathname);
  if (!isReview && !shellAsset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isReview) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
      try { const response = await fetch(request, { signal: controller.signal }); if (response.ok && response.headers.get("Content-Type")?.includes("text/html")) { await cache.put(request, response.clone()); return response; } } catch {} finally { clearTimeout(timer); }
      return await cache.match(new URL("review.html", BASE));
    }
    const cached = await cache.match(request); if (cached) return cached;
    try { const response = await fetch(request); if (response.ok) await cache.put(request, response.clone()); return response; }
    catch { return Response.error(); }
  })());
});
