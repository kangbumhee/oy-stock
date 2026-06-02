var API = {
  SEARCH_CACHE_TTL_MS: 5 * 60 * 1000,
  DIRECT_PRODUCTS_URL: 'https://mcp.aka.page/api/oliveyoung/products',
  COMMON_KEYWORD_CORRECTIONS: {
    '여뮤즈': '어뮤즈',
    '케일플러스': '케일',
    '문치치': '몬치치'
  },

  _correctKeyword: function (keyword) {
    var raw = String(keyword || '').trim();
    if (!raw) return '';
    var normalized = raw.normalize ? raw.normalize('NFC') : raw;
    normalized = normalized.toLowerCase().replace(/\s+/g, '');
    if (API.COMMON_KEYWORD_CORRECTIONS[normalized]) {
      return API.COMMON_KEYWORD_CORRECTIONS[normalized];
    }
    if (normalized.indexOf('여뮤즈') >= 0) return '어뮤즈';
    return raw;
  },

  _searchCacheKey: function (keyword, lat, lng, size) {
    return [
      'oy-search',
      String(keyword || '').trim().toLowerCase(),
      String(lat || CONFIG.DEFAULT_LAT),
      String(lng || CONFIG.DEFAULT_LNG),
      String(size || CONFIG.SEARCH_SIZE)
    ].join('|');
  },

  getCachedSearch: function (keyword, lat, lng, size) {
    try {
      var raw = sessionStorage.getItem(API._searchCacheKey(keyword, lat, lng, size));
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || Date.now() - cached.ts > API.SEARCH_CACHE_TTL_MS) return null;
      return cached.data || null;
    } catch (e) {
      return null;
    }
  },

  setCachedSearch: function (keyword, lat, lng, size, data) {
    try {
      sessionStorage.setItem(
        API._searchCacheKey(keyword, lat, lng, size),
        JSON.stringify({ ts: Date.now(), data: data })
      );
    } catch (e) {}
  },

  _normalizeErrorDetail: function (value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
      if (value.message != null) return API._normalizeErrorDetail(value.message);
      try {
        return JSON.stringify(value);
      } catch (e) {
        return String(value);
      }
    }
    return String(value);
  },

  _fetchWithTimeout: function (url, timeoutMs, outerSignal) {
    var controller = new AbortController();
    var timedOut = false;
    var tid = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    function onOuterAbort() {
      controller.abort();
    }
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort);
    }
    return fetch(url, { signal: controller.signal })
      .finally(function () {
        clearTimeout(tid);
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      })
      .catch(function (err) {
        if (timedOut && !(outerSignal && outerSignal.aborted)) {
          err.searchTimedOut = true;
        }
        throw err;
      });
  },

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

    function saveAndReturn(data) {
      API.setCachedSearch(keyword, lat, lng, size, data);
      return data;
    }

    function fetchViaProxy() {
      return fetch(url, Object.keys(init).length ? init : undefined).then(function (r) {
        if (r.ok) return r.json().then(saveAndReturn);
        return r.text().then(function (t) {
          var detail = '';
          try {
            var j = JSON.parse(t);
            detail = API._normalizeErrorDetail(j.error || j.message || j);
          } catch (e) {
            if (t) detail = String(t).slice(0, 280);
          }
          throw new Error(
            detail ? '서버오류 ' + r.status + ': ' + detail : '서버오류 ' + r.status
          );
        });
      });
    }

    if (opts.forceProxy) return fetchViaProxy();

    var correctedKeyword = API._correctKeyword(keyword);
    var directUrl =
      API.DIRECT_PRODUCTS_URL +
      '?keyword=' +
      encodeURIComponent(correctedKeyword) +
      '&size=' +
      encodeURIComponent(size || CONFIG.SEARCH_SIZE);

    return fetchViaProxy().catch(function (proxyErr) {
      if (opts.signal && opts.signal.aborted) throw proxyErr;
      return API._fetchWithTimeout(directUrl, 2500, opts.signal)
        .then(function (r) {
          if (r.ok)
            return r.json().then(function (data) {
              return saveAndReturn(data);
            });
          throw new Error('direct search ' + r.status);
        })
        .catch(function () {
          throw proxyErr;
        });
    });
  },

  viewRanking: function (size, opts) {
    opts = opts || {};
    var url =
      (CONFIG.HOT_RANK_API || '/api/oliveyoung/view-ranking') +
      '?size=' +
      encodeURIComponent(size || CONFIG.HOT_RANK_SIZE || 100);
    var init = {};
    if (opts.signal) init.signal = opts.signal;
    return fetch(url, Object.keys(init).length ? init : undefined).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || !data || data.success === false) {
          throw new Error((data && (data.message || data.error)) || '조회 인기템 로드 실패');
        }
        return data;
      });
    });
  },

  hotRanking: function (size, opts) {
    opts = opts || {};
    var url =
      (CONFIG.HOT_RANK_HISTORY_API || '/api/oliveyoung/hot-ranking-history') +
      '?size=' +
      encodeURIComponent(size || CONFIG.HOT_RANK_SIZE || 100);
    if (opts.range) url += '&range=' + encodeURIComponent(opts.range);
    if (opts.hours) url += '&hours=' + encodeURIComponent(opts.hours);
    url += '&_=' + encodeURIComponent(Date.now());
    var init = {};
    if (opts.signal) init.signal = opts.signal;
    return fetch(url, Object.keys(init).length ? init : undefined)
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok || !data || data.success === false) {
            throw new Error((data && (data.message || data.error)) || '인기템 누적 데이터 로드 실패');
          }
          return data;
        });
      })
      .catch(function () {
        return API.viewRanking(size, opts);
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
