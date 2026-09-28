// Fonctionnement hors-ligne : fichiers de l'app en « réseau d'abord », bibliothèques CDN en cache.
const VERSION = 'pc-v1';
const APP = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/listener.js', 'js/score.js', 'js/keyboard.js',
  'js/sheet.js', 'js/roll.js', 'js/practice.js',
  'demo/ode-a-la-joie.musicxml', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
const CDN = [
  'https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@2.1.3/build/opensheetmusicdisplay.min.js',
  'https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll([...APP, ...CDN])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === 'https://cdn.jsdelivr.net') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
      return res;
    })));
  } else if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
