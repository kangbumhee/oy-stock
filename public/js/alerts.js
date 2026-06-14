var RestockAlerts = {
  app: null,
  timer: null,
  checking: false,

  init: function (app) {
    this.app = app || null;
    this._bindServiceWorkerMessages();
    this.syncDisabledFromServiceWorker();
    this.refreshControls();
    this.start();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) RestockAlerts.checkNow({ silent: true });
    });
  },

  buildId: function (goodsNo, optionKey) {
    return String(goodsNo || '').trim() + '::' + String(optionKey || 'product');
  },

  optionKey: function (option, idx) {
    if (option && option.productId != null && String(option.productId).trim() !== '') {
      return 'pid:' + String(option.productId).trim();
    }
    if (option && option.name) {
      return 'name:' + String(option.name).trim().toLowerCase();
    }
    return 'idx:' + String(idx || 0);
  },

  isFavorite: function (goodsNo) {
    return Storage.isFavorite(goodsNo);
  },

  isEnabled: function (goodsNo, optionKey) {
    var item = Storage.getRestockAlert(this.buildId(goodsNo, optionKey || 'product'));
    return !!(item && item.enabled !== false);
  },

  _controlHtml: function (opts) {
    opts = opts || {};
    var enabled = !!opts.enabled;
    var label = opts.label || '재입고 알림';
    var className = opts.className || '';
    return (
      '<button type="button" class="restock-alert-toggle ' +
      UI.esc(className) +
      (enabled ? ' active' : '') +
      '" data-action="toggleRestockAlert" data-goodsno="' +
      UI.esc(opts.goodsNo || '') +
      '" data-scope="' +
      UI.esc(opts.scope || 'product') +
      '" data-optionkey="' +
      UI.esc(opts.optionKey || 'product') +
      '" data-optionname="' +
      UI.esc(opts.optionName || '') +
      '" data-goodsname="' +
      UI.esc(opts.goodsName || '') +
      '" data-imageurl="' +
      UI.esc(opts.imageUrl || '') +
      '" aria-pressed="' +
      (enabled ? 'true' : 'false') +
      '">' +
      '<span class="restock-toggle-label">' +
      UI.esc(label) +
      '</span>' +
      '<span class="restock-switch" aria-hidden="true"><span></span></span>' +
      '<span class="restock-toggle-state">' +
      (enabled ? 'ON' : 'OFF') +
      '</span>' +
      '</button>'
    );
  },

  productControlHtml: function (goodsNo, meta, classes) {
    if (!this.isFavorite(goodsNo)) return '';
    var enabled = this.isEnabled(goodsNo, 'product');
    return this._controlHtml({
      enabled: enabled,
      goodsNo: goodsNo,
      scope: 'product',
      optionKey: 'product',
      goodsName: (meta && meta.goodsName) || '',
      imageUrl: (meta && meta.imageUrl) || '',
      label: '상품 알림',
      className: 'restock-alert-btn ' + (classes || '')
    });
  },

  optionControlHtml: function (goodsNo, option, meta, idx, compact) {
    if (!this.isFavorite(goodsNo)) return '';
    var optionKey = this.optionKey(option, idx);
    var optionName = (option && option.name) || '기본';
    var enabled = this.isEnabled(goodsNo, optionKey);
    return this._controlHtml({
      enabled: enabled,
      goodsNo: goodsNo,
      scope: 'option',
      optionKey: optionKey,
      optionName: optionName,
      goodsName: (meta && meta.goodsName) || '',
      imageUrl: (meta && meta.imageUrl) || '',
      label: compact ? '알림' : '이 옵션 알림',
      className: 'restock-alert-btn restock-alert-option' + (compact ? ' compact' : '')
    });
  },

  managerHtml: function () {
    var favMap = {};
    Storage.getFavorites().forEach(function (f) {
      var gn = String(f.goodsNo || f.goodsNumber || '').trim();
      if (gn) favMap[gn] = true;
    });
    var items = Storage.getRestockAlertItems()
      .filter(function (item) {
        return item && item.goodsNo && favMap[String(item.goodsNo)];
      })
      .sort(function (a, b) {
        return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
      });
    if (!items.length) return '';
    var activeCount = items.filter(function (item) {
      return item.enabled !== false;
    }).length;
    var rows = items
      .map(function (item) {
        var status = '확인전';
        if (item.lastAvailable === true) status = '온라인 ' + UI.num(item.lastQty || 0) + '개';
        else if (item.lastAvailable === false) status = '온라인 품절';
        var label = item.scope === 'option' && item.optionName ? item.optionName : '상품 전체';
        return (
          '<div class="restock-manager-row">' +
          '<div class="restock-manager-main">' +
          '<strong>' +
          UI.esc(item.goodsName || item.goodsNo) +
          '</strong>' +
          '<span>' +
          UI.esc(label) +
          '</span>' +
          '<small>' +
          UI.esc(status) +
          '</small>' +
          '</div>' +
          RestockAlerts._controlHtml({
            enabled: item.enabled !== false,
            goodsNo: item.goodsNo,
            scope: item.scope || 'product',
            optionKey: item.optionKey || 'product',
            optionName: item.optionName || '',
            goodsName: item.goodsName || '',
            imageUrl: item.imageUrl || '',
            label: '',
            className: 'manager-restock-toggle'
          }) +
          '</div>'
        );
      })
      .join('');
    return (
      '<section class="restock-manager" aria-label="재입고 알림 설정">' +
      '<div class="restock-manager-head"><strong>재입고 알림</strong><span>' +
      activeCount +
      '/' +
      items.length +
      ' ON</span></div>' +
      rows +
      '</section>'
    );
  },

  ensureUnlocked: function () {
    if (Storage.isRestockAlertUnlocked()) return true;
    var pass = window.prompt('재입고 알림 비밀번호를 입력해 주세요.');
    if (pass === CONFIG.RESTOCK_ALERT_PASSWORD) {
      Storage.setRestockAlertUnlocked();
      UI.showSyncStatus('재입고 알림 잠금이 해제됐습니다', false);
      return true;
    }
    UI.showSyncStatus('비밀번호가 맞지 않습니다', true);
    return false;
  },

  ensureNotificationPermission: function () {
    if (!('Notification' in window)) {
      UI.showSyncStatus('이 브라우저는 앱 알림을 지원하지 않습니다', true);
      return Promise.resolve(false);
    }
    if (Notification.permission === 'granted') return Promise.resolve(true);
    if (Notification.permission === 'denied') {
      UI.showSyncStatus('브라우저 알림 권한이 차단되어 있습니다', true, 4500);
      return Promise.resolve(false);
    }
    return Notification.requestPermission().then(function (permission) {
      var ok = permission === 'granted';
      if (!ok) UI.showSyncStatus('알림 권한을 허용해야 재입고 알림을 받을 수 있습니다', true, 4500);
      return ok;
    });
  },

  toggleFromElement: function (el) {
    var goodsNo = String(el.dataset.goodsno || '').trim();
    if (!goodsNo) return;
    if (!Storage.isFavorite(goodsNo)) {
      UI.showSyncStatus('즐겨찾기에 등록된 상품만 알림을 켤 수 있습니다', true, 4500);
      return;
    }
    if (!this.ensureUnlocked()) return;

    var optionKey = el.dataset.scope === 'option' ? el.dataset.optionkey || 'product' : 'product';
    var id = this.buildId(goodsNo, optionKey);
    var existing = Storage.getRestockAlert(id);
    if (existing && existing.enabled !== false) {
      Storage.setRestockAlertEnabled(id, false);
      this._refreshAfterChange();
      UI.showSyncStatus('재입고 알림을 껐습니다', false);
      return;
    }

    var self = this;
    this.ensureNotificationPermission().then(function (ok) {
      if (!ok) return;
      var alert = {
        id: id,
        goodsNo: goodsNo,
        scope: el.dataset.scope === 'option' ? 'option' : 'product',
        optionKey: optionKey,
        optionName: el.dataset.optionname || '',
        goodsName: el.dataset.goodsname || goodsNo,
        imageUrl: el.dataset.imageurl || '',
        lastAvailable: null,
        lastQty: 0,
        createdAt: new Date().toISOString()
      };
      if (existing) {
        alert = Object.assign({}, existing, alert, { enabled: true });
      }
      Storage.upsertRestockAlert(alert);
      self._refreshAfterChange();
      UI.showSyncStatus('온라인 재입고 알림을 켰습니다. 현재 온라인 재고 기준으로 감시합니다.', false, 4500);
      self.checkNow({ silent: true, baselineOnly: true, goodsNo: goodsNo });
    });
  },

  removeForGoodsNo: function (goodsNo) {
    Storage.removeRestockAlertsForGoodsNo(goodsNo);
    this._refreshAfterChange();
  },

  start: function () {
    if (this.timer) clearInterval(this.timer);
    var interval = Number(CONFIG.RESTOCK_ALERT_POLL_MS) || 5 * 60 * 1000;
    this.timer = setInterval(function () {
      RestockAlerts.checkNow({ silent: true });
    }, interval);
    window.setTimeout(function () {
      RestockAlerts.checkNow({ silent: true });
    }, 4000);
  },

  optionQty: function (option) {
    var online = Number(option && option.onlineQty);
    return isFinite(online) && online > 0 ? online : 0;
  },

  targetFromDetail: function (detail, alert) {
    var opts = (detail && detail.options) || [];
    if (!opts.length) return null;
    if (alert.scope === 'option') {
      for (var i = 0; i < opts.length; i++) {
        var optionKey = this.optionKey(opts[i], i);
        if (optionKey === alert.optionKey) {
          return {
            qty: this.optionQty(opts[i]),
            name: opts[i].name || alert.optionName || '옵션'
          };
        }
      }
      return null;
    }
    return {
      qty: opts.reduce(function (sum, option) {
        return sum + RestockAlerts.optionQty(option);
      }, 0),
      name: ''
    };
  },

  fetchDetail: function (goodsNo) {
    if (!CONFIG.REALTIME_API || !this.app) return Promise.resolve(null);
    var url =
      CONFIG.REALTIME_API +
      (CONFIG.REALTIME_API.indexOf('?') >= 0 ? '&' : '?') +
      'goodsNo=' +
      encodeURIComponent(goodsNo) +
      '&lat=' +
      encodeURIComponent(String(this.app.lat)) +
      '&lng=' +
      encodeURIComponent(String(this.app.lng)) +
      '&fresh=true';
    return fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        return d && d.success ? d : null;
      })
      .catch(function () {
        return null;
      });
  },

  checkNow: async function (opts) {
    opts = opts || {};
    if (this.checking) return;
    var alerts = Storage.getRestockAlerts().filter(function (alert) {
      if (!alert || !alert.goodsNo) return false;
      if (opts.goodsNo && String(alert.goodsNo) !== String(opts.goodsNo)) return false;
      return Storage.isFavorite(alert.goodsNo);
    });
    if (!alerts.length || !CONFIG.REALTIME_API) return;

    this.checking = true;
    var successes = 0;
    var detailCache = {};
    try {
      var max = Number(CONFIG.RESTOCK_ALERT_MAX_PER_RUN) || 40;
      for (var i = 0; i < alerts.length && i < max; i++) {
        var alert = alerts[i];
        if (!detailCache[alert.goodsNo]) {
          detailCache[alert.goodsNo] = await this.fetchDetail(alert.goodsNo);
        }
        var detail = detailCache[alert.goodsNo];
        if (!detail) continue;
        var target = this.targetFromDetail(detail, alert);
        if (!target) continue;
        var available = target.qty > 0;
        var prev = alert.lastAvailable;
        alert.goodsName = alert.goodsName || detail.goodsName || alert.goodsNo;
        alert.optionName = alert.optionName || target.name || '';
        alert.imageUrl = alert.imageUrl || detail.thumbnail || '';
        alert.lastAvailable = available;
        alert.lastQty = target.qty;
        alert.lastCheckedAt = new Date().toISOString();

        if (!opts.baselineOnly && prev === false && available) {
          var lastNotified = alert.lastNotifiedAt ? new Date(alert.lastNotifiedAt).getTime() : 0;
          if (!lastNotified || Date.now() - lastNotified > (CONFIG.RESTOCK_ALERT_NOTIFY_COOLDOWN_MS || 0)) {
            await this.notify(alert, target);
            alert.lastNotifiedAt = new Date().toISOString();
          }
        }
        Storage.upsertRestockAlert(alert);
        successes++;
      }
      this.refreshControls();
      if (opts.userInitiated) {
        UI.showSyncStatus('온라인 재입고 알림 확인 완료: ' + successes + '개 상품 확인', false);
      }
    } finally {
      this.checking = false;
    }
  },

  notify: function (alert) {
    var title = '올리브재고 재입고 알림';
    var body =
      alert.goodsName +
      (alert.scope === 'option' && alert.optionName ? ' · ' + alert.optionName : '') +
      ' 온라인 재고가 다시 확인됐습니다.';
    var url = '/?q=' + encodeURIComponent(alert.goodsName || alert.goodsNo);
    var options = {
      body: body,
      icon: alert.imageUrl || '/favicon-192x192.png',
      badge: '/favicon-48x48.png',
      tag: 'restock-' + alert.id,
      renotify: true,
      actions: [
        { action: 'open', title: '재고 확인' },
        { action: 'turn-off-alert', title: '이 옵션 알림 끄기' }
      ],
      data: {
        url: url,
        alertId: alert.id,
        goodsNo: alert.goodsNo,
        optionKey: alert.optionKey || 'product'
      }
    };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      return navigator.serviceWorker.ready.then(function (registration) {
        return registration.showNotification(title, options);
      });
    }
    try {
      new Notification(title, options);
    } catch (e) {}
    return Promise.resolve();
  },

  refreshControls: function () {
    document.querySelectorAll('.restock-alert-toggle').forEach(function (btn) {
      var goodsNo = btn.dataset.goodsno || '';
      var optionKey = btn.dataset.optionkey || 'product';
      var enabled = RestockAlerts.isEnabled(goodsNo, optionKey);
      btn.classList.toggle('active', enabled);
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      var state = btn.querySelector('.restock-toggle-state');
      if (state) state.textContent = enabled ? 'ON' : 'OFF';
    });
    this._refreshManagerSummary();
  },

  _refreshAfterChange: function () {
    if (
      this.app &&
      this.app.currentTab === 'favorites' &&
      typeof this.app._renderFavorites === 'function'
    ) {
      this.app._renderFavorites();
      return;
    }
    this.refreshControls();
  },

  _refreshManagerSummary: function () {
    var label = document.querySelector('.restock-manager-head span');
    if (!label) return;
    var favMap = {};
    Storage.getFavorites().forEach(function (f) {
      var gn = String(f.goodsNo || f.goodsNumber || '').trim();
      if (gn) favMap[gn] = true;
    });
    var items = Storage.getRestockAlertItems().filter(function (item) {
      return item && item.goodsNo && favMap[String(item.goodsNo)];
    });
    var activeCount = items.filter(function (item) {
      return item.enabled !== false;
    }).length;
    label.textContent = activeCount + '/' + items.length + ' ON';
  },

  _bindServiceWorkerMessages: function () {
    if (!navigator.serviceWorker || this._messageBound) return;
    this._messageBound = true;
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type === 'RESTOCK_ALERT_DISABLED' && data.id) {
        Storage.setRestockAlertEnabled(data.id, false);
        RestockAlerts._refreshAfterChange();
        if (window.UI) UI.showSyncStatus('폰 알림창에서 알림을 껐습니다', false);
      }
    });
  },

  _openDisableDb: function () {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
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
  },

  syncDisabledFromServiceWorker: function () {
    this._openDisableDb()
      .then(function (db) {
        if (!db) return [];
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('disabledAlerts', 'readwrite');
          var store = tx.objectStore('disabledAlerts');
          var allReq = store.getAll();
          allReq.onsuccess = function () {
            var rows = allReq.result || [];
            rows.forEach(function (row) {
              if (row && row.id) Storage.setRestockAlertEnabled(row.id, false);
            });
            store.clear();
            resolve(rows);
          };
          allReq.onerror = function () {
            reject(allReq.error);
          };
        });
      })
      .then(function (rows) {
        if (rows && rows.length) RestockAlerts._refreshAfterChange();
      })
      .catch(function () {});
  }
};
