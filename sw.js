// Rose Studio offline support: the app shell is cached so the installed app opens without internet.
const VERSION = 'rose-1.4.0', SOUNDS = 'rose-sounds-1';   // instrument samples never change, so they get their own long-lived cache
const SHELL = ['./', './index.html', './css/rose.css', './js/app.js', './js/engine.js', './js/effects.js', './js/instruments.js', './js/chordgen.js', './templates/templates.json', './loops/index.json',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-64.png', './icons/logo.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== SOUNDS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin && (u.pathname.includes('/sounds/') || u.pathname.includes('/loops/')) && !u.pathname.endsWith('.json')) {
    e.respondWith(caches.open(SOUNDS).then(c => c.match(e.request).then(r => r || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; }))));
  } else if (u.origin === location.origin) {
    // network first so updates arrive, cache as the offline fallback
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })));
  }
});
