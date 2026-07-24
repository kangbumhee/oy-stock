const CACHE_NAME = 'olivestock-app-v20260724-stock-timeout-1';
const CORE_ASSETS = [
  '/',
  '/site.webmanifest',
  '/favicon.svg',
  '/favicon-48x48.png',
  '/favicon-192x192.png',
  '/favicon-512x512.png',
  '/apple-touch-icon.png',
  '/css/style.css?v=20260723-game-coupang-1',
  '/js/config.js?v=20260724-stock-timeout-1',
  '/js/pwa.js?v=20260622-2',
  '/js/storage.js?v=20260622-2',
  '/js/api.js?v=20260721-1',
  '/js/ui.js?v=20260724-stock-timeout-1',
  '/js/options.js?v=20260531-5',
  '/js/search.js?v=20260609-1',
  '/js/regions.js?v=20260531-5',
  '/js/inventory.js?v=20260531-5',
  '/js/alerts.js?v=20260622-2',
  '/js/app.js?v=20260724-stock-timeout-1'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(CORE_ASSETS);
      })
      .then(function () {
        return self.skipWaiting();
      })
      .catch(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;
  var isNavigation =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').indexOf('text/html') >= 0;

  if (isNavigation) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .catch(function () {
          return caches.match('/');
        })
    );
    return;
  }

  if (url.pathname.indexOf('/blog/') === 0 || url.pathname.indexOf('/data/') === 0) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request)
        .then(function (response) {
          var copy = response.clone();
          if (response.ok) {
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(request, copy);
            });
          }
          return response;
        })
        .catch(function () {
          if (request.mode === 'navigate') return caches.match('/');
          return cached;
        });
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  if (event.action === 'turn-off-alert' && data.alertId) {
    event.waitUntil(
      saveDisabledAlert(data.alertId).then(function () {
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
          return Promise.all(
            clients.map(function (client) {
              return client.postMessage({ type: 'RESTOCK_ALERT_DISABLED', id: data.alertId });
            })
          );
        });
      })
    );
    return;
  }
  var targetUrl = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        if ('focus' in clients[i]) {
          clients[i].navigate(targetUrl);
          return clients[i].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    })
  );
});

function openAlertActionDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('olivestock-alert-actions', 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore('disabledAlerts', { keyPath: 'id' });
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error);
    };
  });
}

function saveDisabledAlert(id) {
  return openAlertActionDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('disabledAlerts', 'readwrite');
      tx.objectStore('disabledAlerts').put({ id: id, disabledAt: new Date().toISOString() });
      tx.oncomplete = resolve;
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  });
}
