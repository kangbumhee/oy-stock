var API = {
  search: function (keyword, lat, lng, size, opts) {
    opts = opts || {};
    var url =
      '/api/oliveyoung/search?keyword=' +
      encodeURIComponent(keyword) +
      '&lat=' +
      (lat || CONFIG.DEFAULT_LAT) +
      '&lng=' +
      (lng || CONFIG.DEFAULT_LNG) +
      '&size=' +
      (size || CONFIG.SEARCH_SIZE);
    var init = {};
    if (opts.signal) init.signal = opts.signal;
    return fetch(url, Object.keys(init).length ? init : undefined).then(function (r) {
      if (!r.ok) throw new Error('서버오류 ' + r.status);
      return r.json();
    });
  },

  loadDetailCache: function () {
    return fetch(CONFIG.DETAIL_JSON_URL)
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  },

  loadHistory: function () {
    return fetch(CONFIG.HISTORY_JSON_URL)
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  },

  syncFavorites: function (favorites, location) {
    return fetch(CONFIG.FAVORITES_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        favorites: favorites.map(function (f) {
          return {
            goodsNo: f.goodsNo || f.goodsNumber,
            goodsName: f.goodsName,
            addedAt: f.addedAt
          };
        }),
        location: location
      })
    })
      .then(function (r) {
        return r.json();
      })
      .catch(function (e) {
        console.error('즐겨찾기 동기화 실패:', e);
        return { success: false, error: e.message };
      });
  }
};
