var API = {
  useFallback: false,

  fetchMCP: function (path, params) {
    params = params || {};
    var qs = new URLSearchParams(params).toString();
    var directUrl = CONFIG.MCP_BASE + path + (qs ? '?' + qs : '');
    var self = this;

    if (!this.useFallback) {
      return fetch(directUrl)
        .then(function (r) {
          if (r.ok) {
            return r.json().then(function (json) {
              if (json.success) return json;
              throw new Error(json.error || 'MCP error');
            });
          }
          return r.text().then(function (t) {
            throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 120) : ''));
          });
        })
        .catch(function (e) {
          if (
            (e.message && e.message.indexOf('Failed to fetch') !== -1) ||
            e.name === 'TypeError' ||
            (e.message && e.message.indexOf('CORS') !== -1) ||
            (e.message && e.message.indexOf('NetworkError') !== -1)
          ) {
            self.useFallback = true;
            return self._proxy(path, params);
          }
          throw e;
        });
    }
    return this._proxy(path, params);
  },

  _proxy: function (path, params) {
    var pp = Object.assign({ path: '/api/oliveyoung' + path }, params);
    var qs = new URLSearchParams(pp).toString();
    return fetch(CONFIG.PROXY_PATH + '?' + qs).then(function (r) {
      return r.text().then(function (text) {
        var json;
        try {
          json = JSON.parse(text);
        } catch (err) {
          throw new Error('프록시 응답이 JSON이 아닙니다');
        }
        if (!r.ok) throw new Error(json.error || 'Proxy HTTP ' + r.status);
        if (!json.success) throw new Error(json.error || 'Failed');
        return json;
      });
    });
  },

  searchInventory: function (keyword, lat, lng, size, page) {
    var p = { keyword: keyword, lat: lat, lng: lng, size: size || CONFIG.SEARCH_SIZE };
    if (page && page > 1) p.page = page;
    return this.fetchMCP('/inventory', p);
  },

  searchStores: function (keyword, lat, lng, limit) {
    return this.fetchMCP('/stores', { keyword: keyword, lat: lat, lng: lng, limit: limit || 20 });
  },

  checkSingleProductStock: function (goodsName, lat, lng) {
    var cleanName = goodsName || '';
    cleanName = cleanName.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
    var words = cleanName.split(/\s+/);
    var searchKeyword = '';
    if (words.length <= 4) {
      searchKeyword = words.join(' ');
    } else {
      searchKeyword = words.slice(0, 4).join(' ');
    }
    if (!searchKeyword || searchKeyword.length < 2) {
      searchKeyword = (goodsName || '').substring(0, 30).trim();
    }
    return this.fetchMCP('/inventory', {
      keyword: searchKeyword,
      lat: lat,
      lng: lng,
      size: 3
    });
  },

  _jsonUrl: function (key) {
    var C = typeof Config !== 'undefined' ? Config : typeof CONFIG !== 'undefined' ? CONFIG : {};
    if (key === 'stock') return C.STOCK_JSON_URL || '/data/stock.json';
    if (key === 'detail') return C.DETAIL_JSON_URL || '/data/stock-detail.json';
    if (key === 'history') return C.HISTORY_JSON_URL || '/data/history.json';
    return '/data/stock.json';
  },

  loadStockCache: function () {
    return fetch(this._jsonUrl('stock'))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  },

  loadDetailCache: function () {
    return fetch(this._jsonUrl('detail'))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  },

  loadHistory: function () {
    return fetch(this._jsonUrl('history'))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  }
};
