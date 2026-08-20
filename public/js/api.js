var API = {
  SEARCH_CACHE_TTL_MS: 5 * 60 * 1000,
  DIRECT_PRODUCTS_URL: 'https://oy-stock-api-3596046881.asia-northeast3.run.app/api/search',
  COMMON_KEYWORD_CORRECTIONS: {
    '여뮤즈': '어뮤즈',
    '케일플러스': '케일',
    '문치치': '몬치치'
  },

  _correctKeyword: function (keyword) {
    var raw = String(keyword || '').trim();
    if (!raw) return '';
    var canonical = raw.normalize ? raw.normalize('NFC') : raw;
    canonical = canonical.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    var normalized = canonical.toLowerCase().replace(/\s+/g, '');
    if (API.COMMON_KEYWORD_CORRECTIONS[normalized]) {
      return API.COMMON_KEYWORD_CORRECTIONS[normalized];
    }
    if (normalized.indexOf('여뮤즈') >= 0) return '어뮤즈';
    return canonical;
  },

  _searchCacheKey: function (keyword, lat, lng, size) {
    return [
      'oy-search',
      API._correctKeyword(keyword).toLowerCase(),
      String(lat || CONFIG.DEFAULT_LAT),
      String(lng || CONFIG.DEFAULT_LNG),
      String(size || CONFIG.SEARCH_SIZE)
    ].join('|');
  },

  getCachedSearch: function (keyword, lat, lng, size) {
    try {
      var key = API._searchCacheKey(keyword, lat, lng, size);
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (
        !cached ||
        Date.now() - cached.ts > API.SEARCH_CACHE_TTL_MS ||
        !cached.data ||
        cached.data.success === false ||
        API._productCountFromSearchData(cached.data) === 0 ||
        API._isIncompleteSearch(cached.data, size)
      ) {
        sessionStorage.removeItem(key);
        return null;
      }
      return cached.data || null;
    } catch (e) {
      try {
        if (key) sessionStorage.removeItem(key);
      } catch (ignore) {}
      return null;
    }
  },

  setCachedSearch: function (keyword, lat, lng, size, data) {
    try {
      var key = API._searchCacheKey(keyword, lat, lng, size);
      if (
        !data ||
        data.success === false ||
        API._productCountFromSearchData(data) === 0 ||
        API._isIncompleteSearch(data, size)
      ) {
        sessionStorage.removeItem(key);
        return;
      }
      sessionStorage.setItem(
        key,
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

  _productCountFromSearchData: function (data) {
    var dd = (data && data.data) || {};
    var inv = dd.inventory != null ? dd.inventory : data && data.inventory;
    var flat =
      dd.products != null
        ? dd.products
        : data && data.products != null
          ? data.products
          : null;
    if (Array.isArray(inv)) return inv.length;
    if (inv && typeof inv === 'object' && Array.isArray(inv.products)) return inv.products.length;
    if (Array.isArray(flat)) return flat.length;
    return 0;
  },

  _searchSource: function (data) {
    var dd = (data && data.data) || {};
    return String((data && data.source) || dd.source || '').toLowerCase().trim();
  },

  _searchTotalCountFromData: function (data) {
    var dd = (data && data.data) || {};
    var inv = dd.inventory != null ? dd.inventory : data && data.inventory;
    var candidates = [
      dd.totalCount,
      inv && !Array.isArray(inv) ? inv.totalCount : null,
      data && data.totalCount,
      data && data.meta ? data.meta.total : null,
      data && data.meta ? data.meta.totalCount : null,
      dd && dd.meta ? dd.meta.total : null,
      dd && dd.meta ? dd.meta.totalCount : null
    ];
    var found = false;
    var total = 0;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] == null || candidates[i] === '') continue;
      var n = Number(candidates[i]);
      if (isFinite(n) && n >= 0) {
        found = true;
        total = Math.max(total, n);
      }
    }
    return found ? total : API._productCountFromSearchData(data);
  },

  _isIncompleteSearch: function (data, requestedSize) {
    if (!data || data.success === false) return true;
    var dd = (data && data.data) || {};
    var inv = dd.inventory != null ? dd.inventory : data && data.inventory;
    var source = API._searchSource(data);
    var bareSupplement = source === 'search-supplement' || source === 'vendor-supplement';
    var flaggedIncomplete =
      data.fallback === true ||
      data.partial === true ||
      data.incomplete === true ||
      data.complete === false ||
      dd.fallback === true ||
      dd.partial === true ||
      dd.incomplete === true ||
      dd.complete === false ||
      (data.meta &&
        (data.meta.partial === true ||
          data.meta.incomplete === true ||
          data.meta.complete === false)) ||
      (dd.meta &&
        (dd.meta.partial === true || dd.meta.incomplete === true || dd.meta.complete === false)) ||
      (!!inv && !Array.isArray(inv) &&
        (inv.fallback === true ||
          inv.partial === true ||
          inv.incomplete === true ||
          inv.complete === false));
    var fallbackSource =
      source === 'local' ||
      source.indexOf('fallback') >= 0 ||
      source.indexOf('local-stock-detail-cache') >= 0;

    if (flaggedIncomplete || fallbackSource || bareSupplement) return true;

    var returned = API._productCountFromSearchData(data);
    var total = API._searchTotalCountFromData(data);
    var requested = Number(requestedSize);
    if (!isFinite(requested) || requested < 1) requested = Number(CONFIG.SEARCH_SIZE) || 0;
    if (total > 0 && requested > 0 && returned < Math.min(total, requested)) return true;
    return false;
  },

  _isLocalFallbackSearch: function (data) {
    var source = API._searchSource(data);
    return (
      source.indexOf('local-stock-detail-cache') >= 0 ||
      source.indexOf('fallback-local') >= 0
    );
  },

  _shouldTryDirectAfterProxy: function (data, requestedSize) {
    if (!data || data.success === false) return true;
    return (
      API._productCountFromSearchData(data) === 0 ||
      API._isIncompleteSearch(data, requestedSize)
    );
  },

  _searchUnavailableError: function (partialData, cause) {
    var err = new Error(
      '검색 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'
    );
    err.name = 'SearchUnavailableError';
    err.searchIncomplete = true;
    err.partialData = partialData || null;
    if (cause) err.cause = cause;
    return err;
  },

  _fetchWithTimeout: function (url, timeoutMs, outerSignal, consumeResponse) {
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
      .then(function (response) {
        return typeof consumeResponse === 'function'
          ? consumeResponse(response)
          : response;
      })
      .catch(function (err) {
        if (timedOut && !(outerSignal && outerSignal.aborted)) {
          err.searchTimedOut = true;
        }
        throw err;
      })
      .finally(function () {
        clearTimeout(tid);
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      });
  },

  search: function (keyword, lat, lng, size, opts) {
    opts = opts || {};
    var correctedKeyword = API._correctKeyword(keyword);
    var requestedSize = size || CONFIG.SEARCH_SIZE;
    var url =
      '/api/oliveyoung/search?keyword=' +
      encodeURIComponent(correctedKeyword) +
      '&lat=' +
      (lat || CONFIG.DEFAULT_LAT) +
      '&lng=' +
      (lng || CONFIG.DEFAULT_LNG) +
      '&size=' +
      requestedSize;
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

    var directUrl =
      API.DIRECT_PRODUCTS_URL +
      '?keyword=' +
      encodeURIComponent(correctedKeyword) +
      '&size=' +
      encodeURIComponent(size || CONFIG.SEARCH_SIZE);

    function fetchDirectProducts() {
      return API._fetchWithTimeout(
        directUrl,
        CONFIG.SEARCH_DIRECT_FETCH_TIMEOUT_MS || 32000,
        opts.signal,
        function (r) {
          if (r.ok)
            return r.json().then(function (data) {
              if (
                data &&
                data.success !== false &&
                !API._isIncompleteSearch(data, requestedSize)
              ) {
                return saveAndReturn(data);
              }
              throw API._searchUnavailableError(data);
            });
          throw new Error('direct search ' + r.status);
        }
      );
    }

    if (opts.forceProxy)
      return fetchViaProxy().then(function (data) {
        if (API._isIncompleteSearch(data, requestedSize)) {
          throw API._searchUnavailableError(data);
        }
        return data;
      });

    return fetchViaProxy().then(
      function (data) {
        if (!API._shouldTryDirectAfterProxy(data, requestedSize)) return data;
        return fetchDirectProducts().catch(function (directErr) {
          if (opts.signal && opts.signal.aborted) throw directErr;
          if (data && data.success !== false && !API._isIncompleteSearch(data, requestedSize)) {
            return data;
          }
          throw API._searchUnavailableError(data, directErr);
        });
      },
      function (proxyErr) {
        if (opts.signal && opts.signal.aborted) throw proxyErr;
        return fetchDirectProducts().catch(function (directErr) {
          if (opts.signal && opts.signal.aborted) throw directErr;
          throw API._searchUnavailableError(null, proxyErr);
        });
      }
    );
  },

  viewRanking: function (size, opts) {
    opts = opts || {};
    var url =
      (CONFIG.HOT_RANK_API || '/api/oliveyoung/view-ranking') +
      '?size=' +
      encodeURIComponent(size || CONFIG.HOT_RANK_SIZE || 100);
    if (opts.category || opts.categoryId) {
      url += '&category=' + encodeURIComponent(opts.category || opts.categoryId);
    }
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
    if (opts.category || opts.categoryId) {
      url += '&category=' + encodeURIComponent(opts.category || opts.categoryId);
    }
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
