// Watchora service worker: app shell + offline-first ML assets.
//
// The heavy local-perception assets (YOLO ONNX model, onnxruntime-web WASM core,
// Tesseract.js worker/core/traineddata) are the real offline story for this app:
// once loaded once, hazard detection and reading should work with no network.
// They are ~45MB total, so they are cached with a background-install strategy
// (cache-on-success from normal browsing) rather than blocking `install`, which
// keeps first paint fast on slow connections.

const CACHE_NAME = 'watchora-shell-v4';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

// These are large and content-addressed-ish; we never want the SW to serve a stale
// version of the app bundle, so the hashed Vite assets (assets/*) are cache-first
// only within the lifetime of this cache version.
const ML_ASSET_PREFIXES = ['/models/', '/ort/', '/tesseract/'];

// The full offline capability (YOLO + onnxruntime + Tesseract eng data) is
// ~60MB. A first-visit user who goes offline before touching the camera has
// no hazard detection or OCR at all, because these were previously
// cache-on-first-FETCH. Warming them in the background after install fixes
// that without delaying first paint. Run at most once per cache version.
async function warmMlAssets() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const already = await cache.keys('/models/yolov8n.onnx');
    if (already.length) return; // warmed in this cache generation
    const WARM_LIST = [
      '/models/yolov8n.onnx',
      // onnxruntime-web (actual files shipped in /ort)
      '/ort/ort-wasm-simd-threaded.wasm',
      '/ort/ort-wasm-simd-threaded.jsep.wasm',
      '/ort/ort-wasm-simd-threaded.mjs',
      '/ort/ort-wasm-simd-threaded.jsep.mjs',
      // Tesseract.js (actual files shipped in /tesseract)
      '/tesseract/worker.min.js',
      '/tesseract/tesseract-core-simd-lstm.wasm.js',
      '/tesseract/tesseract-core-simd-lstm.wasm',
      '/tesseract/tesseract-core-simd-lstm.js',
      '/tesseract/eng.traineddata.gz',
    ];
    for (const url of WARM_LIST) {
      // Sequential: on slow mobile data, parallel 60MB bursts starve the UI.
      await cache.add(url).catch(() => {
        // A single missing optional file must not abort the rest of warming.
      });
    }
  } catch {
    // Warming is best-effort; cache-on-first-fetch remains the fallback path.
  }
}

/**
 * Precaches the app shell AND all hashed bundle assets — the ones referenced
 * by index.html plus lazily-loaded chunks (workers, dynamic imports) that are
 * referenced only inside the entry bundle. This matters because the SW is
 * first registered during the very first page load — assets fetched before
 * activation are never seen by the SW — so without this step a first-visit
 * user could never boot the app offline.
 */
async function precacheShellAndBundle() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL);
  try {
    const res = await fetch('/');
    const html = await res.text();
    const urls = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]));
    const entryJs = [...urls].find((u) => u.endsWith('.js'));
    if (entryJs) {
      const js = await (await fetch(entryJs)).text();
      for (const m of js.matchAll(/["'`](\/assets\/[A-Za-z0-9._/-]+\.(?:js|css))["'`]/g)) urls.add(m[1]);
      for (const m of js.matchAll(/["'`](assets\/[A-Za-z0-9._-]+\.js)["'`]/g)) urls.add('/' + m[1]);
    }
    await Promise.all([...urls].map((u) => cache.add(u).catch(() => {})));
  } catch {
    // Offline first visit: the shell HTML remains cached; nothing else to do.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShellAndBundle().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      // After activation, pull the ML assets in the background so offline
      // capability exists from the FIRST visit, not the first camera use.
      .then(() => warmMlAssets()),
  );
});

function isMlAsset(url) {
  return ML_ASSET_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.__errors = [];

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'watchora-debug') {
    event.ports[0].postMessage({ errors: self.__errors.slice(-10), cacheName: CACHE_NAME });
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts (cross-origin): stale-while-revalidate into the same cache so
  // the app keeps its typography offline. Fonts are immutable (long cache
  // headers), and the CSS is small; serving stale on first paint is fine.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached || Response.error());
        return cached ? (event.waitUntil(network.then(() => undefined)), cached) : network;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // never intercept API/cross-origin calls

  // Navigations: network-first with cached shell fallback (offline).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/', { ignoreVary: true }).then((cached) => cached || Response.error())),
    );
    return;
  }

  // ML assets: cache-first so offline detection/OCR works after first successful
  // load. This is the key offline capability for a blind-user assistive app.
  if (isMlAsset(url)) {
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
    return;
  }

  // Everything else (app bundle, icons, fonts): cache-first with background
  // revalidation. Serving from cache offline or on first paint is the point of
  // an offline-first assistive app; freshness is refreshed in the background
  // and only replaced when the network actually succeeds.
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      if (cached) {
        // Background revalidate: refresh the cached copy, never block the
        // response on the network. Offline this fetch rejects harmlessly.
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
      .catch((err) => {
        self.__errors.push('SW fetch ' + request.url.split('/').pop() + ': ' + String(err));
        return Response.error();
      }),
  );
});
