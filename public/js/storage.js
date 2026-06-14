var Storage = {
  _key: function (k) {
    return 'oy_' + k;
  },

  getHistory: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('history'))) || [];
    } catch (e) {
      return [];
    }
  },
  setHistory: function (arr) {
    localStorage.setItem(this._key('history'), JSON.stringify((arr || []).slice(0, 20)));
  },

  getLocation: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('location')));
    } catch (e) {
      return null;
    }
  },
  setLocation: function (lat, lng, name) {
    localStorage.setItem(this._key('location'), JSON.stringify({ lat: lat, lng: lng, name: name }));
  },

  getOnlineDetailCache: function (ttlMs) {
    var ttl = Number(ttlMs) || 0;
    var now = Date.now();
    var raw;
    try {
      raw = JSON.parse(localStorage.getItem(this._key('online_detail_cache'))) || {};
    } catch (e) {
      raw = {};
    }
    var items = raw.items && typeof raw.items === 'object' ? raw.items : {};
    var pruned = {};
    Object.keys(items).forEach(function (gn) {
      var entry = items[gn];
      if (!entry || !entry.data || !entry.ts) return;
      if (ttl > 0 && now - entry.ts > ttl) return;
      pruned[gn] = entry;
    });
    return { items: pruned };
  },

  getOnlineDetails: function (goodsNos, ttlMs) {
    var cache = this.getOnlineDetailCache(ttlMs);
    var out = {};
    (goodsNos || []).forEach(function (gn) {
      var key = String(gn || '').trim();
      if (key && cache.items[key] && cache.items[key].data) out[key] = cache.items[key].data;
    });
    return out;
  },

  setOnlineDetail: function (goodsNo, detail, maxItems) {
    var gn = String(goodsNo || '').trim();
    if (!gn || !detail) return;
    var cache = this.getOnlineDetailCache(0);
    cache.items[gn] = { ts: Date.now(), data: detail };
    var limit = Number(maxItems) || 120;
    var keys = Object.keys(cache.items).sort(function (a, b) {
      return (cache.items[b].ts || 0) - (cache.items[a].ts || 0);
    });
    var kept = {};
    keys.slice(0, limit).forEach(function (k) {
      kept[k] = cache.items[k];
    });
    try {
      localStorage.setItem(this._key('online_detail_cache'), JSON.stringify({ items: kept }));
    } catch (e) {
      try {
        localStorage.removeItem(this._key('online_detail_cache'));
      } catch (ignore) {}
    }
  },

  _onlineTotalFromDetail: function (detail) {
    return (detail && detail.options ? detail.options : []).reduce(function (sum, opt) {
      return sum + (Number(opt.onlineQty) || 0);
    }, 0);
  },

  _money: function (value) {
    var n = Number(String(value == null ? '' : value).replace(/[^\d.-]/g, ''));
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  },

  getPurchaseLimitInfo: function (detail) {
    var options = detail && detail.options ? detail.options : [];
    var values = options
      .map(function (o) {
        return Number(o && o.maxOrderQty) || 0;
      })
      .filter(function (n) {
        return n > 0 && n < 999;
      });
    if (!values.length) {
      return {
        checked: !!options.length,
        limited: false,
        label: '제한없음',
        min: 0,
        max: 0,
        optionCount: 0
      };
    }
    var uniq = values
      .filter(function (n, idx) {
        return values.indexOf(n) === idx;
      })
      .sort(function (a, b) {
        return a - b;
      });
    var min = uniq[0];
    var max = uniq[uniq.length - 1];
    return {
      checked: true,
      limited: true,
      label: min === max ? '구매제한 ' + min + '개' : '구매제한 ' + min + '~' + max + '개',
      min: min,
      max: max,
      optionCount: values.length,
      values: uniq.slice(0, 8)
    };
  },

  getVelocityStore: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('velocity_store'))) || { products: {} };
    } catch (e) {
      return { products: {} };
    }
  },

  setVelocityStore: function (store, maxItems) {
    var products = (store && store.products) || {};
    var limit = Number(maxItems) || 180;
    var keys = Object.keys(products).sort(function (a, b) {
      return (products[b].lastSeen || 0) - (products[a].lastSeen || 0);
    });
    var kept = {};
    keys.slice(0, limit).forEach(function (k) {
      kept[k] = products[k];
    });
    try {
      localStorage.setItem(this._key('velocity_store'), JSON.stringify({ products: kept }));
    } catch (e) {
      try {
        localStorage.removeItem(this._key('velocity_store'));
      } catch (ignore) {}
    }
  },

  recordVelocitySnapshot: function (goodsNo, detail, meta, opts) {
    opts = opts || {};
    var gn = String(goodsNo || '').trim();
    if (!gn || !detail || !detail.options || !detail.options.length) return null;
    var now = Number(opts.ts) || Date.now();
    var pruneNow = Date.now();
    var total = this._onlineTotalFromDetail(detail);
    var store = this.getVelocityStore();
    var products = store.products || {};
    var item = products[gn] || { goodsNo: gn, observations: [] };
    var price =
      this._money(meta && (meta.priceToPay || meta.price)) ||
      this._money(detail.price) ||
      this._money(item.price);
    var observations = Array.isArray(item.observations) ? item.observations : [];
    var last = observations[observations.length - 1];
    if (!last || last.total !== total || now - last.ts > 10 * 1000) {
      observations.push({ ts: now, total: total, price: price });
    } else {
      last.ts = now;
      last.price = price || last.price || 0;
    }
    observations = observations.filter(function (o) {
      return o && pruneNow - o.ts <= (opts.keepMs || 6 * 60 * 60 * 1000);
    }).slice(-20);
    item.goodsNo = gn;
    item.goodsName = (meta && meta.goodsName) || detail.goodsName || item.goodsName || '';
    item.imageUrl = (meta && meta.imageUrl) || detail.thumbnail || item.imageUrl || '';
    item.price = price || item.price || 0;
    item.originalPrice = (meta && meta.originalPrice) || detail.originalPrice || item.originalPrice || 0;
    item.discountRate = (meta && meta.discountRate) || detail.discountRate || item.discountRate || 0;
    item.optionCount = detail.options.length;
    item.hasToday = detail.options.some(function (o) {
      return !!o.deliveredToday;
    });
    item.purchaseLimit = this.getPurchaseLimitInfo(detail);
    item.lastTotal = total;
    item.lastSeen = now;
    item.observations = observations;
    products[gn] = item;
    store.products = products;
    this.setVelocityStore(store, opts.maxItems || 180);
    return item;
  },

  getVelocityRanking: function (goodsNos, opts) {
    opts = opts || {};
    var allow = {};
    (goodsNos || []).forEach(function (gn) {
      var key = String(gn || '').trim();
      if (key) allow[key] = true;
    });
    var hasAllow = Object.keys(allow).length > 0;
    var windowMs = Number(opts.windowMs) || 30 * 60 * 1000;
    var now = Date.now();
    var products = (this.getVelocityStore().products) || {};
    var rows = [];

    Object.keys(products).forEach(function (gn) {
      if (hasAllow && !allow[gn]) return;
      var item = products[gn];
      var obs = (item && Array.isArray(item.observations) ? item.observations : [])
        .filter(function (o) {
          return o && now - o.ts <= windowMs;
        })
        .sort(function (a, b) {
          return a.ts - b.ts;
        });
      if (obs.length < 2) return;
      var latest = obs[obs.length - 1];
      var base = obs[0];
      var drop = 0;
      var restockUnits = 0;
      var restockEvents = 0;
      for (var i = 1; i < obs.length; i++) {
        var prevTotal = Number(obs[i - 1].total) || 0;
        var currTotal = Number(obs[i].total) || 0;
        var delta = currTotal - prevTotal;
        if (delta < 0) drop += Math.abs(delta);
        else if (delta > 0) {
          restockUnits += delta;
          restockEvents += 1;
        }
      }
      if (drop <= 0) return;
      var elapsedMs = Math.max(1, latest.ts - base.ts);
      var elapsedMin = elapsedMs / 60000;
      var effectiveMin = Math.max(1, elapsedMin);
      var perMin = drop / effectiveMin;
      var pct = base.total > 0 ? (drop / base.total) * 100 : 0;
      var price = Storage._money(item.price) || Storage._money(latest.price);
      rows.push({
        goodsNo: gn,
        goodsName: item.goodsName || gn,
        imageUrl: item.imageUrl || '',
        price: price,
        originalPrice: item.originalPrice || 0,
        discountRate: item.discountRate || 0,
        estimatedSales: drop,
        estimatedRevenue: drop * price,
        optionCount: item.optionCount || 0,
        hasToday: !!item.hasToday,
        purchaseLimit: item.purchaseLimit || null,
        fromTotal: Number(base.total) || 0,
        toTotal: Number(latest.total) || 0,
        drop: drop,
        dropPct: pct,
        perMin: perMin,
        perHour: perMin * 60,
        restockUnits: restockUnits,
        restockEvents: restockEvents,
        restockAdjusted: restockEvents > 0,
        elapsedMs: elapsedMs,
        fromTs: base.ts,
        toTs: latest.ts,
        chart: obs.map(function (o, idx) {
          return {
            ts: new Date(o.ts).toISOString(),
            total: Number(o.total) || 0,
            delta: idx ? (Number(o.total) || 0) - (Number(obs[idx - 1].total) || 0) : 0
          };
        }).slice(-72),
        score: perMin * 100 + drop + pct * 4
      });
    });

    return rows
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, Number(opts.limit) || 8)
      .map(function (row, idx) {
        row.rank = idx + 1;
        row.salesRank = idx + 1;
        return row;
      });
  },

  getVelocityEstimateMap: function (goodsNos, opts) {
    opts = opts || {};
    var limit = (goodsNos || []).length || 100;
    var rows = this.getVelocityRanking(goodsNos, {
      windowMs: opts.windowMs,
      limit: limit
    });
    var map = {};
    rows
      .slice()
      .sort(function (a, b) {
        if ((b.estimatedRevenue || 0) !== (a.estimatedRevenue || 0)) {
          return (b.estimatedRevenue || 0) - (a.estimatedRevenue || 0);
        }
        return (b.drop || 0) - (a.drop || 0);
      })
      .forEach(function (row, idx) {
        row.revenueRank = idx + 1;
      });
    rows.forEach(function (row, idx) {
      row.salesRank = idx + 1;
      map[row.goodsNo] = row;
    });
    return map;
  },

  getFavorites: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('favorites'))) || [];
    } catch (e) {
      return [];
    }
  },
  setFavorites: function (arr) {
    localStorage.setItem(this._key('favorites'), JSON.stringify(arr || []));
  },
  isFavorite: function (goodsNo) {
    var gn = String(goodsNo);
    return this.getFavorites().some(function (f) {
      return String(f.goodsNo || f.goodsNumber) === gn;
    });
  },
  addFavorite: function (product) {
    var favs = this.getFavorites();
    var gn = String(product.goodsNo || product.goodsNumber || '');
    if (!gn) return favs;
    if (favs.some(function (f) { return String(f.goodsNo || f.goodsNumber) === gn; })) return favs;
    favs.unshift({
      goodsNo: gn,
      goodsName: product.goodsName || '',
      imageUrl: product.imageUrl || product.thumbnail || '',
      price: product.price || product.priceToPay || 0,
      originalPrice: product.originalPrice || 0,
      discountRate: product.discountRate || 0,
      categoryNumber: product.categoryNumber || '',
      vendorDelivery: !!product.vendorDelivery,
      inventoryScope: product.inventoryScope || '',
      stockStatus: product.stockStatus || '',
      addedAt: new Date().toISOString()
    });
    this.setFavorites(favs);
    return favs;
  },
  removeFavorite: function (goodsNo) {
    var gn = String(goodsNo);
    var favs = this.getFavorites().filter(function (f) {
      return String(f.goodsNo || f.goodsNumber) !== gn;
    });
    this.setFavorites(favs);
    return favs;
  },
  toggleFavorite: function (product) {
    var gn = String(product.goodsNo || product.goodsNumber || '');
    if (this.isFavorite(gn)) {
      return { favs: this.removeFavorite(gn), added: false };
    }
    return { favs: this.addFavorite(Object.assign({}, product, { goodsNo: gn })), added: true };
  },

  isRestockAlertUnlocked: function () {
    return localStorage.getItem(this._key('restock_alert_unlocked')) === '1';
  },
  setRestockAlertUnlocked: function () {
    localStorage.setItem(this._key('restock_alert_unlocked'), '1');
  },
  getRestockAlertStore: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('restock_alerts'))) || { items: {} };
    } catch (e) {
      return { items: {} };
    }
  },
  setRestockAlertStore: function (store) {
    localStorage.setItem(
      this._key('restock_alerts'),
      JSON.stringify({ items: (store && store.items) || {}, updatedAt: new Date().toISOString() })
    );
  },
  getRestockAlerts: function () {
    var items = this.getRestockAlertStore().items || {};
    return Object.keys(items)
      .map(function (id) {
        return items[id];
      })
      .filter(function (item) {
        return item && item.enabled !== false;
      });
  },
  getRestockAlertItems: function () {
    var items = this.getRestockAlertStore().items || {};
    return Object.keys(items).map(function (id) {
      return items[id];
    });
  },
  getRestockAlert: function (id) {
    var items = this.getRestockAlertStore().items || {};
    return items[String(id || '')] || null;
  },
  upsertRestockAlert: function (alert) {
    if (!alert || !alert.id) return null;
    var store = this.getRestockAlertStore();
    if (!store.items) store.items = {};
    var prev = store.items[alert.id] || {};
    store.items[alert.id] = Object.assign({}, prev, alert, {
      enabled: true,
      updatedAt: new Date().toISOString()
    });
    this.setRestockAlertStore(store);
    return store.items[alert.id];
  },
  setRestockAlertEnabled: function (id, enabled) {
    var store = this.getRestockAlertStore();
    if (!store.items || !store.items[id]) return null;
    store.items[id].enabled = enabled !== false;
    store.items[id].updatedAt = new Date().toISOString();
    this.setRestockAlertStore(store);
    return store.items[id];
  },
  removeRestockAlert: function (id) {
    var store = this.getRestockAlertStore();
    if (store.items && store.items[id]) {
      delete store.items[id];
      this.setRestockAlertStore(store);
    }
  },
  removeRestockAlertsForGoodsNo: function (goodsNo) {
    var gn = String(goodsNo || '').trim();
    if (!gn) return;
    var store = this.getRestockAlertStore();
    var changed = false;
    Object.keys(store.items || {}).forEach(function (id) {
      if (String((store.items[id] && store.items[id].goodsNo) || '') === gn) {
        delete store.items[id];
        changed = true;
      }
    });
    if (changed) this.setRestockAlertStore(store);
  }
};
