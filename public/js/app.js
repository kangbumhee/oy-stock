var App = {
  products: [],
  searchHistory: [],
  lat: CONFIG.DEFAULT_LAT,
  lng: CONFIG.DEFAULT_LNG,
  locationName: CONFIG.DEFAULT_LOCATION,
  detailData: null,
  currentTab: 'search',

  /** 온라인 재고 배치 조회용 (상품 클릭 시 abort → 팝업 닫은 뒤 pendingBatch만 이어서) */
  batchAbortController: null,
  pendingBatch: [],
  onlineEnrichSource: null,

  _searchSeq: 0,
  _searchAbortCtrl: null,

  init: function () {
    var self = this;
    var loc = Storage.getLocation();
    if (loc) {
      this.lat = loc.lat;
      this.lng = loc.lng;
      this.locationName = loc.name || '';
    }
    var locEl = document.getElementById('current-location');
    if (locEl) locEl.textContent = '📍 ' + this.locationName;

    this.searchHistory = Storage.getHistory();
    UI.renderHistory(this.searchHistory);

    API.loadDetailCache().then(function (d) {
      self.detailData = d;
      if (d && d.updatedAt) {
        var t = new Date(d.updatedAt).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          hour: '2-digit',
          minute: '2-digit'
        });
        var info = document.getElementById('cache-info');
        if (info)
          info.textContent =
            '📦 ' + t + ' 수집 | ' + (d.summary ? d.summary.total + '개 상품' : '');
      }
    });

    this._updateFavCount();
    UI._bindPopupEvents();
    document.addEventListener('click', this._onClick.bind(this));

    var form = document.getElementById('search-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('search-input');
        var kw = input && (input.value || '').trim();
        if (kw) App.doSearch(kw);
      });
    }

    UI.setActiveTab('search');

    // GPS 현재 위치 자동 감지 (저장된 위치가 없을 때만)
    if (!loc && navigator.geolocation) {
      this._detectLocation();
    }
  },

  _detectLocation: function () {
    var self = this;
    var locEl = document.getElementById('current-location');
    if (locEl) locEl.textContent = '📍 위치 확인중...';

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var lat = pos.coords.latitude;
        var lng = pos.coords.longitude;
        self.lat = lat;
        self.lng = lng;

        // 카카오 역지오코딩으로 주소 가져오기
        self._reverseGeocode(lat, lng).then(function (name) {
          self.locationName = name;
          Storage.setLocation(lat, lng, name);
          if (locEl) locEl.textContent = '📍 ' + name;
        });
      },
      function (err) {
        console.log('GPS 실패:', err.message);
        if (locEl) locEl.textContent = '📍 ' + self.locationName;
      },
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 }
    );
  },

  _reverseGeocode: function (lat, lng) {
    var url =
      '/api/kakao/geo?x=' + encodeURIComponent(lng) + '&y=' + encodeURIComponent(lat);

    return fetch(url)
      .then(function (r) {
        return r.ok ? r.json() : { documents: [] };
      })
      .then(function (data) {
        var docs = data.documents || [];
        var region = docs.find(function (d) {
          return d.region_type === 'H';
        }) || docs[0];
        if (region) {
          var parts = [];
          if (region.region_2depth_name)
            parts.push(region.region_2depth_name.replace(/시$|군$|구$/, '').trim());
          if (region.region_3depth_name) parts.push(region.region_3depth_name);
          return parts.join(' ') || region.address_name || '내 위치';
        }
        return '내 위치';
      })
      .catch(function () {
        return '내 위치 (' + lat.toFixed(2) + ', ' + lng.toFixed(2) + ')';
      });
  },

  _onClick: function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.dataset.action;

    switch (action) {
      case 'buyNow': {
        e.stopPropagation();
        var bGn = el.dataset.goodsno;
        if (bGn) UI.openOliveYoungProduct(el);
        break;
      }
      case 'showDetail':
        this._pauseOnlineBatchForPopup();
        this._openDetail(parseInt(el.dataset.index, 10));
        break;
      case 'showFavDetail':
        this._pauseOnlineBatchForPopup();
        this._openFavDetail(el.dataset.goodsno);
        break;
      case 'toggleFav':
        this._toggleFav(parseInt(el.dataset.index, 10));
        break;
      case 'removeFav':
        this._removeFav(el.dataset.goodsno);
        break;
      case 'searchHistory': {
        var kw = el.dataset.keyword;
        var inp = document.getElementById('search-input');
        if (inp) inp.value = kw || '';
        if (kw) this.doSearch(kw);
        break;
      }
      case 'clearSearchHistory':
        this.searchHistory = [];
        Storage.setHistory([]);
        UI.renderHistory([]);
        break;
      case 'tabSearch':
        this.currentTab = 'search';
        UI.setActiveTab('search');
        break;
      case 'tabFavorites':
        this.currentTab = 'favorites';
        UI.setActiveTab('favorites');
        this._renderFavorites();
        break;
      case 'showHistory':
        Inventory.showHistory();
        break;
      case 'syncFavorites':
        this._syncFavorites();
        break;
      case 'detectLocation':
        this._detectLocation();
        break;
      case 'toggleOptions': {
        e.stopPropagation();
        var gno = el.dataset.goodsno;
        if (!gno) break;
        var card = el.closest('.card');
        var panel =
          (card && card.querySelector('.card-options')) || document.getElementById('opts-' + gno);
        if (panel) {
          var isHidden = panel.classList.contains('hidden');
          panel.classList.toggle('hidden');
          var n = panel.children.length;
          el.textContent = isHidden ? '옵션 ' + n + '개 ▴' : '옵션 ' + n + '개 ▾';
        }
        break;
      }
      default:
        break;
    }
  },

  _updateFavCount: function () {
    var el = document.getElementById('fav-count');
    var count = Storage.getFavorites().length;
    if (el) el.textContent = count > 0 ? String(count) : '';
  },

  _save: function () {
    Storage.setHistory(this.searchHistory);
  },

  _pauseOnlineBatchForPopup: function () {
    if (this.batchAbortController) {
      this.batchAbortController.abort();
      this.batchAbortController = null;
    }
  },

  _pushPendingGoodsNo: function (gn) {
    var g = String(gn || '').trim();
    if (!g) return;
    if (this.pendingBatch.indexOf(g) === -1) this.pendingBatch.push(g);
  },

  _removeFromPendingBatch: function (gn) {
    var g = String(gn || '').trim();
    if (!g || !this.pendingBatch.length) return;
    this.pendingBatch = this.pendingBatch.filter(function (x) {
      return String(x) !== g;
    });
  },

  _sleepUnlessAborted: function (ms, signal) {
    return new Promise(function (resolve) {
      if (signal.aborted) {
        resolve();
        return;
      }
      var t = setTimeout(resolve, ms);
      signal.addEventListener('abort', function onAb() {
        clearTimeout(t);
        signal.removeEventListener('abort', onAb);
        resolve();
      });
    });
  },

  _runOnlineEnrichBatches: async function (items, batchSignal) {
    var self = this;
    var batchSize = 2;
    for (var i = 0; i < items.length; i += batchSize) {
      if (batchSignal.aborted) break;
      var batch = items.slice(i, i + batchSize);
      var settled = await Promise.allSettled(
        batch.map(function (item) {
          return self._fetchStockDetail(item, {
            onlineOnly: true,
            batchSignal: batchSignal
          });
        })
      );
      settled.forEach(function (s) {
        var r = s.status === 'fulfilled' ? s.value : null;
        if (!r) return;
        if (!self.detailData) self.detailData = { products: {} };
        if (!self.detailData.products) self.detailData.products = {};
        self.detailData.products[r.goodsNo] = r.data;
        UI.updateCardBadge(r.goodsNo, r.data);
        self._removeFromPendingBatch(r.goodsNo);
      });
      if (batchSignal.aborted) break;
      if (i + batchSize < items.length) {
        await self._sleepUnlessAborted(300, batchSignal);
      }
    }
  },

  _resumePendingOnlineEnrich: function () {
    var self = this;
    if (!this.pendingBatch || this.pendingBatch.length === 0) return;
    if (!CONFIG.REALTIME_API) return;
    if (this.batchAbortController) return;

    var pendingSet = {};
    this.pendingBatch.forEach(function (g) {
      pendingSet[String(g)] = true;
    });

    var items;
    if (this.onlineEnrichSource === 'favorites') {
      items = Storage.getFavorites().filter(function (f) {
        var g = String(f.goodsNo || f.goodsNumber || '').trim();
        return g && pendingSet[g];
      });
    } else {
      items = (this.products || []).filter(function (p) {
        var g = String(p.goodsNumber || p.goodsNo || '').trim();
        return g && pendingSet[g];
      });
    }
    if (!items.length) return;

    var ac = new AbortController();
    this.batchAbortController = ac;
    void (async function () {
      try {
        await self._runOnlineEnrichBatches(items, ac.signal);
      } catch (e) {
        console.warn('resumePendingOnlineEnrich', e);
      } finally {
        if (self.batchAbortController === ac) self.batchAbortController = null;
      }
    })();
  },

  _fetchStockDetail: function (pOrFav, opts) {
    opts = opts || {};
    var onlineOnly = !!opts.onlineOnly;
    var withOnline = !!opts.withOnline;
    var gn = String(
      (pOrFav && (pOrFav.goodsNumber || pOrFav.goodsNo)) || ''
    ).trim();
    if (!gn) return Promise.resolve(null);
    var self = this;
    var q =
      'goodsNo=' +
      encodeURIComponent(gn) +
      '&lat=' +
      encodeURIComponent(String(self.lat)) +
      '&lng=' +
      encodeURIComponent(String(self.lng));
    if (withOnline) q += '&withOnline=true';
    if (onlineOnly) q += '&onlineOnly=true';
    var url =
      CONFIG.REALTIME_API +
      (CONFIG.REALTIME_API.indexOf('?') >= 0 ? '&' : '?') +
      q;
    var combined = new AbortController();
    var tid = setTimeout(function () {
      combined.abort();
    }, 10000);
    function onBatchAbort() {
      clearTimeout(tid);
      combined.abort();
    }
    if (opts.batchSignal) {
      if (opts.batchSignal.aborted) onBatchAbort();
      else opts.batchSignal.addEventListener('abort', onBatchAbort);
    }
    return fetch(url, { signal: combined.signal })
      .finally(function () {
        clearTimeout(tid);
        if (opts.batchSignal) opts.batchSignal.removeEventListener('abort', onBatchAbort);
      })
      .then(function (r) {
        return r.json().then(function (d) {
          return d && d.success ? { goodsNo: gn, data: d } : null;
        });
      })
      .catch(function () {
        return null;
      });
  },

  _enrichFavorites: async function (favorites) {
    try {
      if (!CONFIG.REALTIME_API || !favorites || !favorites.length) return;

      if (this.batchAbortController) {
        this.batchAbortController.abort();
        this.batchAbortController = null;
      }

      document.querySelectorAll('.badges').forEach(function (b) {
        if (!b.innerHTML.trim()) {
          b.innerHTML = '<span class="badge bg-gray">⏳ 온라인 재고 확인 중...</span>';
        }
      });
      var self = this;
      self.onlineEnrichSource = 'favorites';
      self.pendingBatch = [];
      favorites.forEach(function (f) {
        self._pushPendingGoodsNo(f.goodsNo || f.goodsNumber);
      });

      var ac = new AbortController();
      self.batchAbortController = ac;
      try {
        await self._runOnlineEnrichBatches(favorites, ac.signal);
      } catch (e) {
        console.warn('enrichFavorites', e);
      } finally {
        if (self.batchAbortController === ac) self.batchAbortController = null;
      }
    } catch (e) {
      console.warn('enrichFavorites', e);
    }
  },

  doSearch: function (keyword) {
    var self = this;
    var kw = String(keyword || '').trim();
    if (!kw) return;

    var seq = ++self._searchSeq;

    if (self._searchAbortCtrl) {
      try {
        self._searchAbortCtrl.abort();
      } catch (e) {}
    }
    self._searchAbortCtrl = new AbortController();

    this.searchHistory = [kw]
      .concat(
        this.searchHistory.filter(function (h) {
          return h !== kw;
        })
      )
      .slice(0, 20);
    this._save();
    UI.renderHistory(this.searchHistory);
    UI.showSearchLoading(kw);

    API.loadDetailCache().then(function (d) {
      if (seq !== self._searchSeq) return;
      if (d) self.detailData = d;
      if (self.products && self.products.length) {
        UI.renderProducts(self.products, self.detailData, { searchListCacheMode: true });
      }
    });

    API.search(kw, self.lat, self.lng, CONFIG.SEARCH_SIZE, {
      signal: self._searchAbortCtrl.signal
    })
      .then(function (d) {
        if (seq !== self._searchSeq) return;
        if (d.success === false) throw new Error(d.message || d.error || '실패');
        var inv = (d.data && d.data.inventory) || d.inventory || {};
        self.products = inv.products || [];
        UI.renderProducts(self.products, self.detailData, { searchListCacheMode: true });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (seq !== self._searchSeq) return;
        UI.showError(err.message || '검색 실패');
      });
  },

  _renderFavorites: function () {
    var favs = Storage.getFavorites();
    UI.renderFavorites(favs, this.detailData);
    void this._enrichFavorites(favs);
  },

  _toggleFav: function (idx) {
    var p = this.products[idx];
    if (!p) return;
    var product = {
      goodsNo: p.goodsNumber || p.goodsNo,
      goodsName: p.goodsName,
      imageUrl: p.imageUrl || '',
      price: p.priceToPay || 0,
      originalPrice: p.originalPrice || 0,
      discountRate: p.discountRate || 0
    };
    var result = Storage.toggleFavorite(product);
    this._updateFavCount();
    var btn = document.querySelector('[data-action="toggleFav"][data-index="' + idx + '"]');
    if (btn) {
      btn.textContent = result.added ? '★' : '☆';
      btn.classList.toggle('active', result.added);
    }
    UI.showSyncStatus(result.added ? '⭐ 즐겨찾기 추가' : '즐겨찾기 해제', false);
  },

  _removeFav: function (goodsNo) {
    Storage.removeFavorite(goodsNo);
    this._updateFavCount();
    this._renderFavorites();
    UI.showSyncStatus('즐겨찾기 해제', false);
  },

  _toggleFavFromPopup: function (goodsNo, btnEl) {
    var detail =
      this.detailData && this.detailData.products ? this.detailData.products[goodsNo] : null;
    var product = {
      goodsNo: goodsNo,
      goodsName: detail ? detail.goodsName : '',
      imageUrl: detail ? detail.thumbnail : '',
      price: detail ? detail.price : 0,
      originalPrice: detail ? detail.originalPrice : 0,
      discountRate: detail ? detail.discountRate : 0
    };
    var searchP = this.products.find(function (p) {
      return String(p.goodsNumber || p.goodsNo) === String(goodsNo);
    });
    if (searchP) {
      product.goodsName = product.goodsName || searchP.goodsName;
      product.imageUrl = product.imageUrl || searchP.imageUrl;
      product.price = product.price || searchP.priceToPay;
    }
    var result = Storage.toggleFavorite(product);
    this._updateFavCount();
    if (btnEl) {
      btnEl.textContent = result.added ? '★ 즐겨찾기 됨' : '☆ 즐겨찾기 추가';
      btnEl.classList.toggle('active', result.added);
    }
  },

  _syncFavorites: function () {
    return;
  },

  _openDetail: async function (idx) {
    var p = this.products[idx];
    if (!p) return;
    var gn = String(p.goodsNumber || p.goodsNo || '').trim();
    if (!gn) return;
    var detail =
      this.detailData && this.detailData.products ? this.detailData.products[gn] : null;
    var hasStoreScope =
      detail &&
      detail.options &&
      detail.options.length > 0 &&
      detail.inventoryScope !== 'online' &&
      detail.source !== 'live-online';
    if (hasStoreScope) {
      UI.showDetailPopup(detail, gn);
      return;
    }
    if (CONFIG.REALTIME_API) {
      var catHint =
        p.categoryNumber != null && String(p.categoryNumber).trim() !== ''
          ? String(p.categoryNumber).trim()
          : p.masterCategoryNumber != null && String(p.masterCategoryNumber).trim() !== ''
            ? String(p.masterCategoryNumber).trim()
            : '';
      UI.showPopupStockSkeleton({
        goodsName: p.goodsName,
        goodsNo: gn,
        category: catHint,
        price: p.priceToPay,
        originalPrice: p.originalPrice,
        discountRate: p.discountRate || 0,
        imageUrl: p.imageUrl || ''
      });
      try {
        var r = await fetch(
          CONFIG.REALTIME_API +
            (CONFIG.REALTIME_API.indexOf('?') >= 0 ? '&' : '?') +
            'goodsNo=' +
            encodeURIComponent(gn) +
            '&lat=' +
            encodeURIComponent(String(this.lat)) +
            '&lng=' +
            encodeURIComponent(String(this.lng)) +
            '&withOnline=true'
        );
        var d = await r.json();
        if (d.success && d.options && d.options.length > 0) {
          if (!this.detailData) this.detailData = { products: {} };
          if (!this.detailData.products) this.detailData.products = {};
          this.detailData.products[gn] = d;
          UI.showDetailPopup(d, gn);
          return;
        }
        UI.showPopupError(p.goodsName, d.error || '조회 실패', gn);
        return;
      } catch (e) {
        UI.showPopupError(p.goodsName, '서버 연결 실패: ' + (e.message || String(e)), gn);
        return;
      }
    }
    UI.showPopupError(
      p.goodsName,
      '아직 수집되지 않은 상품입니다. 즐겨찾기에 추가하면 다음 수집 시 자동 반영됩니다.',
      gn
    );
  },

  _openFavDetail: async function (goodsNo) {
    var gn = String(goodsNo || '').trim();
    if (!gn) return;
    var fav = Storage.getFavorites().find(function (f) {
      return String(f.goodsNo || f.goodsNumber) === gn;
    });
    var name = fav ? fav.goodsName : gn;
    var detail =
      this.detailData && this.detailData.products ? this.detailData.products[gn] : null;
    var hasStoreScopeFav =
      detail &&
      detail.options &&
      detail.options.length > 0 &&
      detail.inventoryScope !== 'online' &&
      detail.source !== 'live-online';
    if (hasStoreScopeFav) {
      UI.showDetailPopup(detail, gn);
      return;
    }
    if (CONFIG.REALTIME_API) {
      var favCat =
        fav && fav.categoryNumber != null && String(fav.categoryNumber).trim() !== ''
          ? String(fav.categoryNumber).trim()
          : '';
      UI.showPopupStockSkeleton({
        goodsName: name,
        goodsNo: gn,
        category: favCat,
        price: fav ? fav.price || fav.priceToPay : null,
        originalPrice: fav ? fav.originalPrice : null,
        discountRate: fav ? fav.discountRate || 0 : 0,
        imageUrl: fav ? fav.imageUrl || '' : ''
      });
      try {
        var r = await fetch(
          CONFIG.REALTIME_API +
            (CONFIG.REALTIME_API.indexOf('?') >= 0 ? '&' : '?') +
            'goodsNo=' +
            encodeURIComponent(gn) +
            '&lat=' +
            encodeURIComponent(String(this.lat)) +
            '&lng=' +
            encodeURIComponent(String(this.lng)) +
            '&withOnline=true'
        );
        var d = await r.json();
        if (d.success && d.options && d.options.length > 0) {
          if (!this.detailData) this.detailData = { products: {} };
          if (!this.detailData.products) this.detailData.products = {};
          this.detailData.products[gn] = d;
          UI.showDetailPopup(d, gn);
          return;
        }
      } catch (e) {}
    }
    UI.showPopupError(name, '다음 수집 시 재고가 업데이트됩니다.', gn);
  }
};

document.addEventListener('DOMContentLoaded', function () {
  App.init();
});
