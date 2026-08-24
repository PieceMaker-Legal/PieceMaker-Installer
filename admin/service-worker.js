const CACHE_NAME = 'piecemaker-admin-secours-v1';
const CACHE_PREFIX = 'piecemaker-admin-secours-';
const OFFLINE_URL = '/admin/offline.html';
const OFFLINE_ASSETS = [
  OFFLINE_URL,
  '/admin/icons/icon-192.png',
  '/admin/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Aucune donnée de dossier ni réponse API n’est mise en cache. Seule la page
// de secours statique est servie quand le serveur local ne répond plus.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
    return;
  }
  if (event.request.mode === 'navigate' && url.pathname.startsWith('/admin/')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
  }
});
