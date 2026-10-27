/* HeartConfia service worker
 * - Offline-friendly app shell (network first for pages, cache fallback)
 * - Stale-while-revalidate for static assets (icons, fonts, the supabase-js CDN script)
 * - Never touches Supabase API calls, auth, realtime or any non-GET request
 * - Web Push: shows notifications and opens the right story when tapped
 * Bump VERSION whenever you change this file or the shell, so old caches are removed.
 */
const VERSION = 'v2';
const SHELL_CACHE = 'hc-shell-' + VERSION;
const ASSET_CACHE = 'hc-assets-' + VERSION;

const SHELL = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.png'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="theme-color" content="#0b080c"><title>HeartConfia is offline</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#0b080c;color:#f6eef1;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px}' +
  'h1{font-size:22px;margin:12px 0 6px}p{color:#c4b3bb;margin:0 0 20px;line-height:1.5}' +
  'button{background:#f2486f;color:#fff;border:0;border-radius:100px;padding:12px 24px;font-size:15px;font-weight:700}</style></head>' +
  '<body><div><div style="font-size:48px">💔</div><h1>You\'re offline</h1>' +
  '<p>HeartConfia needs a connection to load stories.<br>Check your internet and try again.</p>' +
  '<button onclick="location.reload()">Try again</button></div></body></html>';

/* ---------- install / activate ---------- */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Add one by one so a single missing file never blocks installation.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if ((k.indexOf('hc-shell-') === 0 && k !== SHELL_CACHE) ||
            (k.indexOf('hc-assets-') === 0 && k !== ASSET_CACHE)) {
          return caches.delete(k);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------- fetch ---------- */

function isStaticAsset(url) {
  return /\.(?:png|jpg|jpeg|webp|svg|ico|woff2?|ttf|css|js)$/i.test(url.pathname);
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') return;

  // Pages: network first, fall back to the cached shell, then the offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok && url.origin === self.location.origin && url.pathname === '/') {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put('/', copy); }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return caches.match('/').then(function (hit) {
          return hit || new Response(OFFLINE_HTML, {
            status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        });
      })
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const cdn = CDN_HOSTS.indexOf(url.hostname) !== -1;

  // Everything else that is not our site or an approved CDN (Supabase, analytics, ...) goes straight to the network.
  if (!sameOrigin && !cdn) return;
  if (sameOrigin && !isStaticAsset(url) && url.pathname !== '/manifest.json') return;

  // Static assets: serve from cache immediately, refresh in the background.
  event.respondWith(
    caches.open(ASSET_CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        const network = fetch(req).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(function () {});
          return res;
        }).catch(function () { return hit; });
        return hit || network;
      });
    })
  );
});

/* ---------- web push ---------- */
/* The Edge Function sends JSON: { title, body, url, tag } */

self.addEventListener('push', function (event) {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (e) { d = { body: event.data ? event.data.text() : '' }; }

  const title = d.title || 'HeartConfia';
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  let target;
  try { target = new URL(raw, self.location.origin); } catch (e) { target = new URL('/', self.location.origin); }
  // Only ever open our own site.
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          return c.focus().then(function (focused) {
            const w = focused || c;
            if ('navigate' in w) return w.navigate(target.href).catch(function () {});
          });
        }
      }
      return self.clients.openWindow(target.href);
    })
  );
});
