/* ------------------------------------------------------------
   映工房 Web — Service Worker（オフラインで開けるようにするだけ）

   GitHub Pages では他の PWA と同じオリジンを共有するため：
   - キャッシュ名は "eikobo-web-" で始め、消すのは自分の古い版だけ
   - 参照するのも自分のキャッシュだけ（caches.match は使わない）
   - install では cache:'reload' で取得（HTTP キャッシュの旧版を掴まない）
   ネットワーク優先。iPad のホーム画面アプリでは待機中の SW が切り替わらないことがあるので、待機させない。
   ファイルを直したら、下の VERSION と js/util.js の APP_VERSION を必ず上げること。
   ------------------------------------------------------------ */
const VERSION = '0.2.0';
const PREFIX = 'eikobo-web-';
const CACHE = PREFIX + 'v' + VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/util.js', './js/store.js', './js/opfs-worker.js', './js/mp4.js', './js/media.js', './js/project.js',
  './js/engine.js', './js/decode.js', './js/mux.js', './js/exporter.js', './js/stream-worker.js',
  './js/timeline.js', './js/inspector.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetchWithTimeout(req, 6000);
      if (res && res.ok && res.type === 'basic') cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone()).catch(() => {});
      return res;
    } catch {
      const hit = req.mode === 'navigate' ? await cache.match('./index.html') : await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req, { cache: 'no-cache' }).then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
  });
}
