const CACHE_NAME = 'gitlib-cache-v1';
const ASSETS = [
  '/', '/index.html',
  '/css/reset.css', '/css/variables.css', '/css/components.css', '/css/responsive.css',
  '/js/app.js', '/js/navigation.js', '/js/animations.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request)));
});
