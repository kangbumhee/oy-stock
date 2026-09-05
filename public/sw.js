const CACHE_NAME = 'olivestock-app-v20260906-curator-shortlink-2';
const CORE_ASSETS = [
  '/',
  '/site.webmanifest',
  '/favicon.svg',
  '/favicon-48x48.png',
  '/favicon-192x192.png',
  '/favicon-512x512.png',
  '/apple-touch-icon.png',
  '/payment-info.html',
  '/terms.html',
  '/privacy.html',
  '/css/style.css?v=20260906-curator-shortlink-2',
  '/js/config.js?v=20260906-curator-shortlink-2',
  '/js/pwa.js?v=20260906-curator-shortlink-2',
  '/js/storage.js?v=20260906-curator-shortlink-2',
  '/js/api.js?v=20260820-search-completeness-1',
  '/js/ui.js?v=20260906-curator-shortlink-2',
  '/js/options.js?v=20260531-5',
  '/js/search.js?v=20260609-1',
  '/js/regions.js?v=20260531-5',
  '/js/inventory.js?v=20260531-5',
  '/js/alerts.js?v=20260906-curator-shortlink-2',
  '/js/app.js?v=20260906-curator-shortlink-2'
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
      fetch(request, { cache: 'no-store' }).catch(function () {
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

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type !== 'PRICE_ALERT_DEVICE_AUTH') return;
  var deviceId = String(data.deviceId || '');
  var deviceSecret = String(data.deviceSecret || '');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(deviceId.replace(/-/g, '_'))) return;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(deviceSecret)) return;
  event.waitUntil(savePriceAlertDevice({ deviceId: deviceId, deviceSecret: deviceSecret }));
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { type: 'price-change' };
  }
  if (data.type !== 'price-change') return;
  var previousPrice = positivePrice(data.previousPrice);
  var currentPrice = positivePrice(data.currentPrice);
  var targetPrice = positivePrice(data.targetPrice);
  var direction = data.direction === 'up' ? 'up' : 'down';
  var eventKey = String(
    data.eventKey ||
      [
        data.goodsNo || 'unknown',
        data.optionNumber || '',
        previousPrice,
        currentPrice,
        targetPrice,
        direction
      ].join(':')
  );
  var title = data.targetReached
    ? '🎯 목표가 도달'
    : direction === 'up'
      ? '📈 가격이 올랐어요'
      : '📉 가격이 내렸어요';
  var productName = String(data.goodsName || data.goodsNo || '올리브영 상품');
  var optionName = String(data.optionName || '').trim();
  if (optionName) productName += ' · ' + optionName;
  var body = productName + '\n' + formatWon(previousPrice) + ' → ' + formatWon(currentPrice);
  if (targetPrice) body += ' · 목표 ' + formatWon(targetPrice);
  var options = {
    body: body,
    icon: '/favicon-192x192.png',
    badge: '/favicon-48x48.png',
    tag: 'price-alert-' + eventKey,
    renotify: true,
    actions: [
      { action: 'open-product', title: '상품 확인' },
      { action: 'turn-off-price-alert', title: '가격 알림 끄기' }
    ],
    data: {
      type: 'price-change',
      alertId: String(data.alertId || ''),
      goodsNo: String(data.goodsNo || ''),
      optionNumber: String(data.optionNumber || ''),
      url: safeRelativeUrl(data.url)
    }
  };
  event.waitUntil(
    claimPriceAlertEvent(eventKey).then(function (isNew) {
      if (!isNew) return undefined;
      return self.registration.showNotification(title, options).then(function () {
        return prunePriceAlertEvents(120);
      });
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  if (event.action === 'turn-off-price-alert' && data.goodsNo) {
    event.waitUntil(
      disablePriceAlert(data.goodsNo, data.optionNumber)
        .then(function () {
          return postPriceAlertMessage({
            type: 'PRICE_ALERT_DISABLED',
            alertId: data.alertId || '',
            goodsNo: data.goodsNo,
            optionNumber: data.optionNumber || ''
          });
        })
        .catch(function () {
          return postPriceAlertMessage({
            type: 'PRICE_ALERT_DISABLE_FAILED',
            goodsNo: data.goodsNo,
            optionNumber: data.optionNumber || ''
          });
        })
    );
    return;
  }
  var targetUrl = new URL(safeRelativeUrl(data.url), self.location.origin).href;
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

function positivePrice(value) {
  var price = Number(value);
  return isFinite(price) && price > 0 ? Math.round(price) : 0;
}

function formatWon(value) {
  var price = positivePrice(value);
  return price ? price.toLocaleString('ko-KR') + '원' : '가격 미확인';
}

function safeRelativeUrl(value) {
  try {
    var parsed = new URL(String(value || '/'), self.location.origin);
    if (parsed.origin !== self.location.origin) return '/';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (error) {
    return '/';
  }
}

function openAlertActionDb() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open('olivestock-alert-actions', 3);
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains('disabledAlerts')) {
        db.createObjectStore('disabledAlerts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('priceAlertDevice')) {
        db.createObjectStore('priceAlertDevice', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('priceAlertEvents')) {
        db.createObjectStore('priceAlertEvents', { keyPath: 'eventKey' });
      }
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

function claimPriceAlertEvent(eventKey) {
  return openAlertActionDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction('priceAlertEvents', 'readwrite');
      var store = transaction.objectStore('priceAlertEvents');
      var request = store.get(eventKey);
      var isNew = false;
      request.onsuccess = function () {
        if (request.result) return;
        isNew = true;
        store.put({ eventKey: eventKey, notifiedAt: Date.now() });
      };
      transaction.oncomplete = function () {
        resolve(isNew);
      };
      transaction.onerror = function () {
        reject(transaction.error);
      };
    });
  });
}

function prunePriceAlertEvents(limit) {
  return openAlertActionDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction('priceAlertEvents', 'readwrite');
      var store = transaction.objectStore('priceAlertEvents');
      var request = store.getAll();
      request.onsuccess = function () {
        (request.result || [])
          .sort(function (a, b) {
            return Number(b.notifiedAt || 0) - Number(a.notifiedAt || 0);
          })
          .slice(Number(limit) || 120)
          .forEach(function (row) {
            if (row && row.eventKey) store.delete(row.eventKey);
          });
      };
      transaction.oncomplete = resolve;
      transaction.onerror = function () {
        reject(transaction.error);
      };
    });
  });
}

function savePriceAlertDevice(device) {
  return openAlertActionDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction('priceAlertDevice', 'readwrite');
      transaction.objectStore('priceAlertDevice').put({
        key: 'current',
        deviceId: device.deviceId,
        deviceSecret: device.deviceSecret,
        updatedAt: new Date().toISOString()
      });
      transaction.oncomplete = resolve;
      transaction.onerror = function () {
        reject(transaction.error);
      };
    });
  });
}

function getPriceAlertDevice() {
  return openAlertActionDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction('priceAlertDevice', 'readonly');
      var request = transaction.objectStore('priceAlertDevice').get('current');
      request.onsuccess = function () {
        resolve(request.result || null);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  });
}

function disablePriceAlert(goodsNo, optionNumber) {
  return getPriceAlertDevice().then(function (device) {
    if (!device || !device.deviceId || !device.deviceSecret) {
      throw new Error('price alert device unavailable');
    }
    var url = '/api/price-alerts/alerts?goodsNo=' + encodeURIComponent(goodsNo);
    if (optionNumber) url += '&optionNumber=' + encodeURIComponent(optionNumber);
    return fetch(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        'X-Price-Alert-Device-Id': device.deviceId,
        'X-Price-Alert-Device-Secret': device.deviceSecret
      },
      cache: 'no-store',
      credentials: 'same-origin'
    }).then(function (response) {
      if (!response.ok) throw new Error('price alert disable failed');
      return response;
    });
  });
}

function postPriceAlertMessage(message) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    return Promise.all(
      clients.map(function (client) {
        return client.postMessage(message);
      })
    );
  });
}
