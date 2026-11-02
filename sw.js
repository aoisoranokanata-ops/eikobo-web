/* ------------------------------------------------------------
   映工房 Web — Service Worker（オフラインで開けるようにするだけ）

   GitHub Pages では他の PWA と同じオリジンを共有するため：
   - キャッシュ名は "eikobo-web-" で始め、消すのは自分の古い版だけ
   - 参照するのも自分のキャッシュだけ（caches.match は使わない）
   - install では cache:'reload' で取得（HTTP キャッシュの旧版を掴まない）
   ネットワーク優先。iPad のホーム画面アプリでは待機中の SW が切り替わらないことがあるので、待機させない。
   ファイルを直したら、下の VERSION と js/util.js の APP_VERSION を必ず上げること。
   ------------------------------------------------------------ */
const VERSION = '1.2.0';
const PREFIX = 'eikobo-web-';
const CACHE = PREFIX + 'v' + VERSION;
// AI の部品（vendor/ の onnxruntime・models/ の重み、合わせて約 45MB）は版をまたいで取っておく別のキャッシュ。
// 初めて使う時に取りに行き、以降はキャッシュから（大きいので普段の 6 秒の待ち時間では落ちる）。中身を変える時はファイル名を変える。
const AI_CACHE = PREFIX + 'ai-1';
const ASSETS = [
  './', './index.html', './oauth.html', './manifest.webmanifest', './css/app.css',
  './js/util.js', './js/store.js', './js/opfs-worker.js', './js/mp4.js', './js/media.js', './js/project.js',
  './js/engine.js', './js/decode.js', './js/stabilize.js', './js/aienhance.js', './js/mux.js', './js/exporter.js', './js/stream-worker.js',
  './js/timeline.js', './js/inspector.js', './js/app.js',
  './js/keyframes.js', './js/grade.js', './js/audiofx.js', './js/mixer.js', './js/recorder.js', './js/zip.js', './js/ekp.js', './js/gdrive.js',
  './js/telop.js', './js/textrender.js', './js/motion.js', './js/telopdraw.js', './js/srt.js', './js/stylepicker.js',
  './assets/telop_styles/bases.json', './assets/telop_styles/palettes.json', './assets/telop_motions/motions.json',
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE && k !== AI_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  // アプリの画面（./ と index.html）だけを index.html として覚える。oauth.html（Google のサインインから戻る所）は別
  const isApp = req.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname.endsWith('/index.html'));

  const rel = url.pathname.slice(scope.pathname.length);
  if (rel.startsWith('vendor/') || rel.startsWith('models/')) {
    e.respondWith((async () => {
      const cache = await caches.open(AI_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') await cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetchWithTimeout(req, 6000);
      if (res && res.ok && res.type === 'basic') cache.put(isApp ? './index.html' : req, res.clone()).catch(() => {});
      return res;
    } catch {
      const hit = isApp ? await cache.match('./index.html') : await cache.match(req, { ignoreSearch: true });
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
