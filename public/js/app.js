var App = {
  products: [],
  searchHistory: [],
  lat: CONFIG.DEFAULT_LAT,
  lng: CONFIG.DEFAULT_LNG,
  locationName: CONFIG.DEFAULT_LOCATION,
  detailData: null,
  currentTab: 'search',
  hotProducts: [],
  hotUpdatedAt: null,
  hotLastStockRunAt: null,
  hotDataSource: '',
  hotIncludedMeasuredCount: 0,
  hotFetchedAt: 0,
  hotAutoTimer: null,
  hotServerEstimates: {},
  hotPurchaseLimits: {},
  hotSortMode: 'view',
  hotRange: (CONFIG.HOT_RANK_DEFAULT_RANGE || '1d'),
  hotCategory: (CONFIG.HOT_RANK_DEFAULT_CATEGORY || ''),
  hotFetchedRange: '',
  hotFetchedCategory: '',
  hotRefreshState: 'idle',
  hotRefreshMessage: '',
  hotRefreshTimer: null,

  /** 온라인 재고 배치 조회용 (상품 클릭 시 abort → 팝업 닫은 뒤 pendingBatch만 이어서) */
  batchAbortController: null,
  pendingBatch: [],
  onlineEnrichSource: null,
  velocityRefreshTimer: null,

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
        e.preventDefault();
        e.stopPropagation();
        var popRoot = document.getElementById('popup-root');
        if (popRoot && popRoot.contains(el)) break;
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
      case 'showRankDetail':
        this._pauseOnlineBatchForPopup();
        this._openRankDetail(el.dataset.goodsno);
        break;
      case 'showHotDetail':
        this._pauseOnlineBatchForPopup();
        this._openHotDetail(el.dataset.goodsno);
        break;
      case 'refreshRanking':
        e.preventDefault();
        this._refreshVelocityRankingNow();
        break;
      case 'refreshHotRanking':
        e.preventDefault();
        this._loadHotRanking(true, { userInitiated: true });
        break;
      case 'setHotSort':
        e.preventDefault();
        e.stopPropagation();
        this.hotSortMode =
          el.dataset.sort === 'revenue' ? 'revenue' : el.dataset.sort === 'sales' ? 'sales' : 'view';
        this._renderHotRanking();
        break;
      case 'setHotRange':
        e.preventDefault();
        e.stopPropagation();
        this.hotRange = el.dataset.range || (CONFIG.HOT_RANK_DEFAULT_RANGE || '1d');
        this._loadHotRanking(true);
        break;
      case 'setHotCategory':
        e.preventDefault();
        e.stopPropagation();
        this.hotCategory = el.dataset.category || '';
        this.hotFetchedAt = 0;
        this.hotProducts = [];
        this.hotIncludedMeasuredCount = 0;
        this.hotServerEstimates = {};
        this.hotPurchaseLimits = {};
        this.hotRefreshState = 'idle';
        this.hotRefreshMessage = '';
        UI.showHotRankingLoading();
        this._loadHotRanking(true);
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
      case 'retrySearch': {
        var rkw = String(el.dataset.keyword || '').trim();
        if (rkw) {
          var inpr = document.getElementById('search-input');
          if (inpr) inpr.value = rkw;
          this.doSearch(rkw);
        }
        break;
      }
      case 'clearSearchHistory':
        this.searchHistory = [];
        Storage.setHistory([]);
        UI.renderHistory([]);
        break;
      case 'tabSearch':
        this.currentTab = 'search';
        this._stopHotAutoRefresh();
        this._pauseOnlineBatchForPopup();
        UI.setActiveTab('search');
        if (this.products && this.products.length) this._startVelocityAutoRefresh();
        break;
      case 'tabHot':
        this.currentTab = 'hot';
        this._stopVelocityAutoRefresh();
        UI.setActiveTab('hot');
        this._loadHotRanking(false);
        break;
      case 'tabFavorites':
        this.currentTab = 'favorites';
        this._stopVelocityAutoRefresh();
        this._stopHotAutoRefresh();
        this._pauseOnlineBatchForPopup();
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

  _searchNeedsFull: function (data, products, fullSize) {
    var count = products && products.length ? products.length : 0;
    if (!data || count >= fullSize) return false;
    var dd = (data && data.data) || {};
    if (dd.nextPage === true) return true;
    if (typeof dd.totalCount === 'number' && dd.totalCount > count) return true;
    var inv = dd.inventory;
    if (inv && typeof inv.totalCount === 'number' && inv.totalCount > count) return true;
    return count >= (CONFIG.SEARCH_PREVIEW_SIZE || fullSize);
  },

  _goodsNosFromProducts: function (products) {
    return (products || [])
      .map(function (p) {
        return String((p && (p.goodsNumber || p.goodsNo)) || '').trim();
      })
      .filter(function (gn) {
        return gn !== '';
      });
  },

  _productMetaForGoodsNo: function (goodsNo) {
    var gn = String(goodsNo || '').trim();
    if (!gn) return null;
    var product = (this.products || []).find(function (p) {
      return String(p.goodsNumber || p.goodsNo || '') === gn;
    });
    if (product) {
      return {
        goodsNo: gn,
        goodsName: product.goodsName || '',
        imageUrl: product.imageUrl || '',
        priceToPay: product.priceToPay || 0,
        originalPrice: product.originalPrice || 0,
        discountRate: product.discountRate || 0
      };
    }
    var hot = (this.hotProducts || []).find(function (p) {
      return String(p.goodsNumber || p.goodsNo || '') === gn;
    });
    if (hot) {
      return {
        goodsNo: gn,
        goodsName: hot.goodsName || '',
        imageUrl: hot.imageUrl || '',
        priceToPay: hot.priceToPay || hot.price || 0,
        originalPrice: hot.originalPrice || 0,
        discountRate: hot.discountRate || 0
      };
    }
    var fav = Storage.getFavorites().find(function (f) {
      return String(f.goodsNo || f.goodsNumber || '') === gn;
    });
    return fav || null;
  },

  _recordVelocitySnapshot: function (goodsNo, detail, meta, opts) {
    opts = opts || {};
    try {
      if (detail && detail.options && detail.options.length) {
        this.hotPurchaseLimits[String(goodsNo || '').trim()] = Storage.getPurchaseLimitInfo(detail);
      }
      Storage.recordVelocitySnapshot(goodsNo, detail, meta || this._productMetaForGoodsNo(goodsNo), {
        maxItems: CONFIG.VELOCITY_RANK_MAX_ITEMS || 180,
        ts: opts.ts
      });
      if (this.currentTab === 'hot') this._renderHotRanking();
      else this._renderVelocityRanking();
    } catch (e) {
      console.warn('recordVelocitySnapshot', e);
    }
  },

  _renderVelocityRanking: function () {
    var goodsNos = this._goodsNosFromProducts(this.products);
    if (!goodsNos.length) {
      UI.renderVelocityRanking([], { hasProducts: false });
      return;
    }
    var rows = Storage.getVelocityRanking(goodsNos, {
      windowMs: CONFIG.VELOCITY_RANK_WINDOW_MS || 30 * 60 * 1000,
      limit: CONFIG.VELOCITY_RANK_LIMIT || 8
    });
    UI.renderVelocityRanking(rows, {
      hasProducts: true,
      windowLabel: '30분'
    });
  },

  _hotGoodsNos: function () {
    return this._goodsNosFromProducts(this.hotProducts);
  },

  _hotRangeMs: function () {
    var ranges = CONFIG.HOT_RANK_RANGES || {};
    var cfg = ranges[this.hotRange] || ranges[CONFIG.HOT_RANK_DEFAULT_RANGE || '1d'];
    var hours = cfg && cfg.hours ? Number(cfg.hours) : 24;
    return Math.max(1, hours) * 60 * 60 * 1000;
  },

  _hotEstimateMap: function () {
    var merged = {};
    Object.keys(this.hotServerEstimates || {}).forEach(function (gn) {
      var r = this.hotServerEstimates[gn];
      if (!r) return;
      merged[gn] = {
        goodsNo: r.goodsNo || gn,
        goodsName: r.goodsName || gn,
        imageUrl: r.imageUrl || '',
        price: r.price || 0,
        originalPrice: r.originalPrice || 0,
        discountRate: r.discountRate || 0,
        fromTotal: r.fromTotal || 0,
        toTotal: r.toTotal || 0,
        drop: r.estimatedSales || r.drop || 0,
        estimatedSales: r.estimatedSales || r.drop || 0,
        windowEstimatedSales:
          r.windowEstimatedSales != null
            ? r.windowEstimatedSales
            : r.dailyEstimatedSales != null
              ? r.dailyEstimatedSales
              : r.estimatedSales || r.drop || 0,
        dailyEstimatedSales:
          r.dailyEstimatedSales != null
            ? r.dailyEstimatedSales
            : r.estimatedSales || r.drop || 0,
        estimatedRevenue:
          r.estimatedRevenue != null
            ? r.estimatedRevenue
            : r.revenue != null
              ? r.revenue
              : (r.price || 0) * (r.estimatedSales || r.drop || 0),
        dailyEstimatedRevenue:
          r.dailyEstimatedRevenue != null
            ? r.dailyEstimatedRevenue
            : r.estimatedRevenue != null
              ? r.estimatedRevenue
              : r.revenue != null
                ? r.revenue
                : (r.price || 0) * (r.estimatedSales || r.drop || 0),
        windowEstimatedRevenue:
          r.windowEstimatedRevenue != null
            ? r.windowEstimatedRevenue
            : r.dailyEstimatedRevenue != null
              ? r.dailyEstimatedRevenue
              : r.estimatedRevenue != null
                ? r.estimatedRevenue
                : r.revenue != null
                  ? r.revenue
                  : (r.price || 0) * (r.estimatedSales || r.drop || 0),
        perMin: (r.perHour || 0) / 60,
        perHour: r.perHour || 0,
        elapsedMs:
          r.fromTs && r.toTs ? Math.max(1, new Date(r.toTs) - new Date(r.fromTs)) : 0,
        restockUnits: r.restockUnits || 0,
        restockEvents: r.restockEvents || 0,
        restockAdjusted: !!r.restockAdjusted,
        fromTs: r.fromTs,
        toTs: r.toTs,
        optionCount: r.optionCount || 0,
        hasToday: !!r.hasToday,
        purchaseLimit: r.purchaseLimit || null,
        salesRank: r.salesRank,
        revenueRank: r.revenueRank,
        rankTrends: r.rankTrends || {},
        chart: r.chart || [],
        viewChart: r.viewChart || [],
        salesChart: r.salesChart || [],
        revenueChart: r.revenueChart || [],
        source: 'server'
      };
    }, this);
    var local = Storage.getVelocityEstimateMap(this._hotGoodsNos(), {
      windowMs: this._hotRangeMs()
    });
    Object.keys(local || {}).forEach(function (gn) {
      if (!merged[gn]) {
        merged[gn] = local[gn];
        return;
      }
      if (!merged[gn].price && local[gn].price) merged[gn].price = local[gn].price;
      if ((!merged[gn].chart || !merged[gn].chart.length) && local[gn].chart) {
        merged[gn].chart = local[gn].chart;
      }
    });
    return merged;
  },

  _renderHotRanking: function () {
    UI.renderHotRanking(this.hotProducts, {
      updatedAt: this.hotUpdatedAt,
      lastStockRunAt: this.hotLastStockRunAt,
      source: this.hotDataSource,
      includedMeasuredCount: this.hotIncludedMeasuredCount,
      estimates: this._hotEstimateMap(),
      purchaseLimits: this.hotPurchaseLimits,
      sortMode: this.hotSortMode,
      range: this.hotRange,
      category: this.hotCategory,
      refreshState: this.hotRefreshState,
      refreshMessage: this.hotRefreshMessage
    });
  },

  _setHotRefreshState: function (state, message, clearAfterMs) {
    if (this.hotRefreshTimer) {
      clearTimeout(this.hotRefreshTimer);
      this.hotRefreshTimer = null;
    }

    this.hotRefreshState = state || 'idle';
    this.hotRefreshMessage = message || '';
    if (this.currentTab === 'hot') this._renderHotRanking();

    if (clearAfterMs) {
      var self = this;
      var expectedState = this.hotRefreshState;
      this.hotRefreshTimer = setTimeout(function () {
        if (self.hotRefreshState !== expectedState) return;
        self.hotRefreshState = 'idle';
        self.hotRefreshMessage = '';
        self.hotRefreshTimer = null;
        if (self.currentTab === 'hot') self._renderHotRanking();
      }, clearAfterMs);
    }
  },

  _startHotAutoRefresh: function () {
    var self = this;
    if (this.hotAutoTimer) clearInterval(this.hotAutoTimer);
    var ms = Number(CONFIG.HOT_RANK_AUTO_REFRESH_MS) || 3 * 60 * 1000;
    this.hotAutoTimer = setInterval(function () {
      if (self.currentTab !== 'hot') return;
      var root = document.getElementById('popup-root');
      if (root && root.innerHTML.trim()) return;
      self._loadHotRanking(true);
    }, ms);
    if (this.hotAutoTimer.unref) this.hotAutoTimer.unref();
  },

  _stopHotAutoRefresh: function () {
    if (this.hotAutoTimer) clearInterval(this.hotAutoTimer);
    this.hotAutoTimer = null;
  },

  _applyCachedHotSnapshots: function (products) {
    var goodsNos = this._goodsNosFromProducts(products);
    var goodsSet = {};
    goodsNos.forEach(function (gn) {
      goodsSet[gn] = true;
    });
    var cache;
    try {
      cache = Storage.getOnlineDetailCache(CONFIG.ONLINE_DETAIL_CACHE_TTL_MS || 0);
    } catch (e) {
      cache = { items: {} };
    }
    var entries = (cache && cache.items) || {};
    Object.keys(entries).forEach(function (gn) {
      if (!goodsSet[gn] || !entries[gn] || !entries[gn].data) return;
      var detail = entries[gn].data;
      if (!this.detailData) this.detailData = { products: {} };
      if (!this.detailData.products) this.detailData.products = {};
      this.detailData.products[gn] = detail;
      this._recordVelocitySnapshot(gn, detail, this._productMetaForGoodsNo(gn), {
        ts: entries[gn].ts
      });
    }, this);
    this._renderHotRanking();
  },

  _enrichHotRankingStock: function (products) {
    if (!CONFIG.REALTIME_API || !products || !products.length) return;
    if (this.batchAbortController) {
      this.batchAbortController.abort();
      this.batchAbortController = null;
    }
    var limit = parseInt(String(CONFIG.HOT_RANK_STOCK_ENRICH_LIMIT), 10);
    if (!isFinite(limit) || limit <= 0) return;
    var items = products
      .filter(function (p) {
        return String((p && (p.goodsNumber || p.goodsNo)) || '').trim() !== '';
      })
      .slice(0, limit);
    if (!items.length) return;

    var self = this;
    self._applyCachedHotSnapshots(items);
    self.onlineEnrichSource = 'hot';
    self.pendingBatch = [];
    items.forEach(function (p) {
      self._pushPendingGoodsNo(p.goodsNumber || p.goodsNo);
    });

    var ac = new AbortController();
    self.batchAbortController = ac;
    void (async function () {
      try {
        await self._runOnlineEnrichBatches(items, ac.signal, {
          batchSize: CONFIG.HOT_RANK_BATCH_SIZE || 3,
          delayMs: CONFIG.HOT_RANK_BATCH_DELAY_MS || 120
        });
      } catch (e) {
        console.warn('enrichHotRankingStock', e);
      } finally {
        if (self.batchAbortController === ac) self.batchAbortController = null;
        if (self.currentTab === 'hot') self._renderHotRanking();
      }
    })();
  },

  _loadHotRanking: function (force, opts) {
    opts = opts || {};
    var self = this;
    var now = Date.now();
    var showRefreshFeedback = !!opts.userInitiated;
    if (showRefreshFeedback && this.hotRefreshState === 'loading') return;

    if (
      !force &&
      this.hotProducts &&
      this.hotProducts.length &&
      this.hotFetchedRange === this.hotRange &&
      this.hotFetchedCategory === this.hotCategory &&
      now - this.hotFetchedAt < (CONFIG.HOT_RANK_CACHE_TTL_MS || 45000)
    ) {
      this._renderHotRanking();
      this._startHotAutoRefresh();
      return;
    }

    if (showRefreshFeedback) {
      this.hotRefreshState = 'loading';
      this.hotRefreshMessage = '저장 데이터 확인 중...';
      if (this.hotProducts && this.hotProducts.length) this._renderHotRanking();
    }

    if (!this.hotProducts || !this.hotProducts.length) UI.showHotRankingLoading();
    var requestRange = this.hotRange;
    var requestCategory = this.hotCategory;
    API.hotRanking(CONFIG.HOT_RANK_SIZE || 100, {
      range: requestRange,
      category: requestCategory
    })
      .then(function (data) {
        if (self.hotRange !== requestRange || self.hotCategory !== requestCategory) return;
        var dd = (data && data.data) || {};
        self.hotProducts = dd.products || [];
        self.hotServerEstimates = dd.estimates || {};
        self.hotPurchaseLimits = {};
        self.hotProducts.forEach(function (p) {
          if (p && p.goodsNo && p.purchaseLimit) self.hotPurchaseLimits[p.goodsNo] = p.purchaseLimit;
        });
        Object.keys(self.hotServerEstimates || {}).forEach(function (gn) {
          var e = self.hotServerEstimates[gn];
          if (e && e.purchaseLimit) self.hotPurchaseLimits[gn] = e.purchaseLimit;
        });
        self.hotUpdatedAt = dd.updatedAt || new Date().toISOString();
        self.hotLastStockRunAt = dd.lastStockRunAt || dd.updatedAt || null;
        self.hotDataSource = dd.source || '';
        self.hotIncludedMeasuredCount = Number(dd.includedMeasuredCount || 0);
        self.hotFetchedAt = Date.now();
        self.hotFetchedRange = self.hotRange;
        self.hotFetchedCategory = self.hotCategory;
        if (showRefreshFeedback) {
          self._setHotRefreshState('success', '저장 데이터 확인됨', 2400);
          UI.showSyncStatus('인기템 데이터 확인 완료', false, 1800);
        } else {
          self._renderHotRanking();
        }
        self._startHotAutoRefresh();
        if (dd.source === 'oliveyoung-view-rank' || dd.source === 'oliveyoung-view-rank-category') {
          self._enrichHotRankingStock(self.hotProducts);
        }
      })
      .catch(function (err) {
        if (!self.hotProducts || !self.hotProducts.length) {
          self.hotProducts = [];
          self._renderHotRanking();
        }
        if (showRefreshFeedback) self._setHotRefreshState('error', '확인 실패', 3500);
        UI.showSyncStatus(err.message || '조회 인기템 로드 실패', true);
      });
  },

  _startVelocityAutoRefresh: function () {
    var self = this;
    if (this.velocityRefreshTimer) clearInterval(this.velocityRefreshTimer);
    var ms = Number(CONFIG.VELOCITY_AUTO_REFRESH_MS) || 60000;
    this.velocityRefreshTimer = setInterval(function () {
      if (self.currentTab !== 'search' || !self.products || !self.products.length) return;
      var root = document.getElementById('popup-root');
      if (root && root.innerHTML.trim()) return;
      self._enrichSearchOnline(self.products);
    }, ms);
    if (this.velocityRefreshTimer.unref) this.velocityRefreshTimer.unref();
  },

  _stopVelocityAutoRefresh: function () {
    if (this.velocityRefreshTimer) clearInterval(this.velocityRefreshTimer);
    this.velocityRefreshTimer = null;
  },

  _refreshVelocityRankingNow: function () {
    this._renderVelocityRanking();
    if (this.products && this.products.length) {
      this._enrichSearchOnline(this.products);
    }
  },

  _onlineOnlySnapshot: function (detail) {
    if (!detail || !detail.options || !detail.options.length) return null;
    var options = (detail.options || []).map(function (o) {
      return {
        name: o.name || '',
        productId: o.productId || '',
        image: o.image || '',
        totalStores: 0,
        inStock: 0,
        totalQty: 0,
        onlineQty: o.onlineQty || 0,
        maxOrderQty: o.maxOrderQty || 0,
        deliveredToday: !!o.deliveredToday,
        presentable: !!o.presentable,
        stores: []
      };
    });
    var totalOnline = options.reduce(function (a, o) {
      return a + (o.onlineQty || 0);
    }, 0);
    return {
      success: true,
      source: 'live-online',
      inventoryScope: 'online',
      goodsNo: detail.goodsNo || '',
      goodsName: detail.goodsName || '',
      price: detail.price,
      originalPrice: detail.originalPrice,
      discountRate: detail.discountRate,
      thumbnail: detail.thumbnail || '',
      itemCount: detail.itemCount,
      status: totalOnline > 0 ? 'active' : 'soldout',
      statusLabel: totalOnline > 0 ? '🛒 온라인 재고' : '🛒 온라인 품절',
      options: options,
      updatedAt: detail.updatedAt || new Date().toISOString()
    };
  },

  _isVendorDeliveryProduct: function (item) {
    return UI.isVendorDeliveryProduct(item);
  },

  _vendorDetailFromProduct: function (product) {
    var gn = String((product && (product.goodsNumber || product.goodsNo)) || '').trim();
    if (!gn) return null;
    return {
      success: true,
      goodsNo: gn,
      goodsNumber: gn,
      goodsName: product.goodsName || gn,
      thumbnail: product.imageUrl || product.thumbnail || '',
      price: product.priceToPay || product.price || 0,
      originalPrice: product.originalPrice || product.priceToPay || product.price || 0,
      discountRate: product.discountRate || 0,
      categoryNumber: product.categoryNumber || '',
      status: 'vendor_delivery',
      source: 'vendor-delivery',
      inventoryScope: 'vendor',
      vendorDelivery: true,
      options: [],
      updatedAt: new Date().toISOString()
    };
  },

  _rememberOnlineStock: function (goodsNo, detail) {
    var snapshot = this._onlineOnlySnapshot(detail);
    if (!snapshot) return null;
    snapshot.goodsNo = snapshot.goodsNo || String(goodsNo || '').trim();
    try {
      Storage.setOnlineDetail(
        snapshot.goodsNo,
        snapshot,
        CONFIG.ONLINE_DETAIL_CACHE_MAX || 120
      );
    } catch (e) {}
    return snapshot;
  },

  _cachedOnlineDetailMap: function (products) {
    try {
      return Storage.getOnlineDetails(
        this._goodsNosFromProducts(products),
        CONFIG.ONLINE_DETAIL_CACHE_TTL_MS || 0
      );
    } catch (e) {
      return {};
    }
  },

  _detailDataForSearchList: function (products) {
    var merged = { products: {} };
    if (this.detailData && this.detailData.products) {
      Object.keys(this.detailData.products).forEach(function (gn) {
        merged.products[gn] = this.detailData.products[gn];
      }, this);
    }
    var cachedOnline = this._cachedOnlineDetailMap(products);
    Object.keys(cachedOnline).forEach(function (gn) {
      merged.products[gn] = cachedOnline[gn];
    });
    return merged;
  },

  _applyCachedOnlineBadges: function (products) {
    var goodsNos = this._goodsNosFromProducts(products);
    var goodsSet = {};
    goodsNos.forEach(function (gn) {
      goodsSet[gn] = true;
    });
    var cache;
    try {
      cache = Storage.getOnlineDetailCache(CONFIG.ONLINE_DETAIL_CACHE_TTL_MS || 0);
    } catch (e) {
      cache = { items: {} };
    }
    var entries = (cache && cache.items) || {};
    Object.keys(entries).forEach(function (gn) {
      if (!goodsSet[gn] || !entries[gn] || !entries[gn].data) return;
      var detail = entries[gn].data;
      if (!this.detailData) this.detailData = { products: {} };
      if (!this.detailData.products) this.detailData.products = {};
      if (!UI.inventoryOnlineOnly(this.detailData.products[gn])) {
        this.detailData.products[gn] = detail;
      }
      this._recordVelocitySnapshot(gn, detail, this._productMetaForGoodsNo(gn), {
        ts: entries[gn].ts
      });
      UI.updateCardBadge(gn, detail);
    }, this);
    this._renderVelocityRanking();
  },

  _renderSearchResponse: function (data) {
    this.products = UI.productsFromSearchApiResponse(data);
    UI.renderProducts(this.products, this._detailDataForSearchList(this.products), {
      searchListCacheMode: true
    });
    this._renderVelocityRanking();
    if (this.products && this.products.length) this._startVelocityAutoRefresh();
    return this.products;
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

  _runOnlineEnrichBatches: async function (items, batchSignal, opts) {
    opts = opts || {};
    var self = this;
    items = (items || []).filter(function (item) {
      return !self._isVendorDeliveryProduct(item);
    });
    var batchSize = parseInt(String(opts.batchSize || CONFIG.SEARCH_ONLINE_BATCH_SIZE || 4), 10);
    if (!isFinite(batchSize) || batchSize < 1) batchSize = 4;
    var delayMs = Number(opts.delayMs || CONFIG.SEARCH_ONLINE_BATCH_DELAY_MS || 80);
    for (var i = 0; i < items.length; i += batchSize) {
      if (batchSignal.aborted) break;
      var batch = items.slice(i, i + batchSize);
      var settled = await Promise.allSettled(
        batch.map(function (item) {
          return self._fetchStockDetail(item, {
            onlineOnly: true,
            fresh: true,
            batchSignal: batchSignal
          });
        })
      );
      settled.forEach(function (s) {
        var r = s.status === 'fulfilled' ? s.value : null;
        if (!r) return;
        if (!self.detailData) self.detailData = { products: {} };
        if (!self.detailData.products) self.detailData.products = {};
        var onlineSnapshot = self._rememberOnlineStock(r.goodsNo, r.data) || r.data;
        self.detailData.products[r.goodsNo] = onlineSnapshot;
        UI.updateCardBadge(r.goodsNo, onlineSnapshot);
        self._recordVelocitySnapshot(r.goodsNo, onlineSnapshot);
        self._removeFromPendingBatch(r.goodsNo);
      });
      if (batchSignal.aborted) break;
      if (i + batchSize < items.length) {
        await self._sleepUnlessAborted(delayMs, batchSignal);
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
    if (opts.fresh) q += '&fresh=true';
    var url =
      CONFIG.REALTIME_API +
      (CONFIG.REALTIME_API.indexOf('?') >= 0 ? '&' : '?') +
      q;
    var combined = new AbortController();
    var tid = setTimeout(function () {
      combined.abort();
    }, CONFIG.STOCK_DETAIL_FETCH_TIMEOUT_MS || 20000);
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

  _enrichSearchOnline: function (products) {
    if (!CONFIG.REALTIME_API || !products || !products.length) return;
    if (this.batchAbortController) {
      this.batchAbortController.abort();
      this.batchAbortController = null;
    }

    var limit = parseInt(String(CONFIG.SEARCH_ONLINE_ENRICH_LIMIT || 20), 10);
    if (!isFinite(limit) || limit < 1) limit = 20;
    var self = this;
    var items = products
      .filter(function (p) {
        return String((p && (p.goodsNumber || p.goodsNo)) || '').trim() !== '';
      })
      .filter(function (p) {
        return !self._isVendorDeliveryProduct(p);
      })
      .slice(0, limit);
    if (!items.length) return;

    self._applyCachedOnlineBadges(items);
    self.onlineEnrichSource = 'search';
    self.pendingBatch = [];
    items.forEach(function (p) {
      self._pushPendingGoodsNo(p.goodsNumber || p.goodsNo);
    });

    var ac = new AbortController();
    self.batchAbortController = ac;
    void (async function () {
      try {
        await self._runOnlineEnrichBatches(items, ac.signal);
      } catch (e) {
        console.warn('enrichSearchOnline', e);
      } finally {
        if (self.batchAbortController === ac) self.batchAbortController = null;
      }
    })();
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

    self.products = [];
    UI.clearResults();
    UI.renderVelocityRanking([], { hasProducts: false });
    self._stopVelocityAutoRefresh();

    var fullSize = CONFIG.SEARCH_SIZE;
    var previewSize = parseInt(String(CONFIG.SEARCH_PREVIEW_SIZE || fullSize), 10);
    if (!isFinite(previewSize) || previewSize < 1) previewSize = fullSize;
    previewSize = Math.min(previewSize, fullSize);

    var fullCached = API.getCachedSearch(kw, self.lat, self.lng, fullSize);
    var previewCached =
      !fullCached && previewSize < fullSize
        ? API.getCachedSearch(kw, self.lat, self.lng, previewSize)
        : null;
    var cachedSearch = fullCached || previewCached;
    var cachedProducts = [];
    if (cachedSearch) {
      cachedProducts = self._renderSearchResponse(cachedSearch);
      self._enrichSearchOnline(cachedProducts);
    } else {
      UI.showSearchLoading(kw);
    }

    API.loadDetailCache().then(function (d) {
      if (seq !== self._searchSeq) return;
      if (d) self.detailData = d;
      if (self.products && self.products.length) {
        UI.renderProducts(self.products, self._detailDataForSearchList(self.products), {
          searchListCacheMode: true
        });
      }
    });

    function fetchAndRender(size) {
      return API.search(kw, self.lat, self.lng, size, {
        signal: self._searchAbortCtrl.signal
      }).then(function (d) {
        if (seq !== self._searchSeq) return null;
        if (d.success === false) throw new Error(d.message || d.error || '실패');
        var products = self._renderSearchResponse(d);
        self._enrichSearchOnline(products);
        return { data: d, products: products };
      });
    }

    var request;
    if (fullCached) {
      request = fetchAndRender(fullSize);
    } else if (previewCached) {
      request = self._searchNeedsFull(previewCached, cachedProducts, fullSize)
        ? fetchAndRender(fullSize)
        : null;
    } else {
      request = fetchAndRender(previewSize).then(function (result) {
        if (!result || seq !== self._searchSeq) return null;
        if (
          previewSize < fullSize &&
          ((!result.products || result.products.length === 0) ||
            self._searchNeedsFull(result.data, result.products, fullSize))
        ) {
          return fetchAndRender(fullSize);
        }
        return result;
      });
    }

    if (request) {
      request.catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (seq !== self._searchSeq) return;
        if (self.products && self.products.length) return;
        UI.showSearchError(err.message || '검색 실패', kw);
      });
    }
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
      discountRate: p.discountRate || 0,
      categoryNumber: p.categoryNumber || '',
      vendorDelivery: !!p.vendorDelivery,
      inventoryScope: p.inventoryScope || '',
      stockStatus: p.stockStatus || ''
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

  _openRankDetail: function (goodsNo) {
    var gn = String(goodsNo || '').trim();
    if (!gn) return;
    var idx = (this.products || []).findIndex(function (p) {
      return String(p.goodsNumber || p.goodsNo || '') === gn;
    });
    if (idx >= 0) {
      this._openDetail(idx);
      return;
    }
    this._openFavDetail(gn);
  },

  _openHotDetail: function (goodsNo) {
    var gn = String(goodsNo || '').trim();
    if (!gn) return;
    var product = (this.hotProducts || []).find(function (p) {
      return String(p.goodsNumber || p.goodsNo || '') === gn;
    });
    if (product) {
      this._openProductDetail(product);
      return;
    }
    this._openRankDetail(gn);
  },

  _openDetail: async function (idx) {
    var p = this.products[idx];
    if (!p) return;
    return this._openProductDetail(p);
  },

  _openProductDetail: async function (p) {
    var gn = String(p.goodsNumber || p.goodsNo || '').trim();
    if (!gn) return;
    var detail =
      this.detailData && this.detailData.products ? this.detailData.products[gn] : null;
    if (this._isVendorDeliveryProduct(p) || this._isVendorDeliveryProduct(detail)) {
      var vendorDetail = detail && this._isVendorDeliveryProduct(detail) ? detail : this._vendorDetailFromProduct(p);
      if (vendorDetail) UI.showDetailPopup(vendorDetail, gn);
      return;
    }
    var hasStoreScope =
      detail &&
      detail.options &&
      detail.options.length > 0 &&
      detail.inventoryScope !== 'online' &&
      detail.source !== 'live-online';
    if (!CONFIG.REALTIME_API && hasStoreScope) {
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
            '&fresh=true'
        );
        var d = await r.json();
        if (d.success && d.options && d.options.length > 0) {
          if (!this.detailData) this.detailData = { products: {} };
          if (!this.detailData.products) this.detailData.products = {};
          this.detailData.products[gn] = d;
          var onlineSnapshot = this._rememberOnlineStock(gn, d);
          if (onlineSnapshot) UI.updateCardBadge(gn, onlineSnapshot);
          this._recordVelocitySnapshot(gn, onlineSnapshot || d, this._productMetaForGoodsNo(gn));
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
    if (this._isVendorDeliveryProduct(fav) || this._isVendorDeliveryProduct(detail)) {
      var favVendorDetail =
        detail && this._isVendorDeliveryProduct(detail)
          ? detail
          : this._vendorDetailFromProduct(fav || { goodsNo: gn, goodsName: name });
      if (favVendorDetail) UI.showDetailPopup(favVendorDetail, gn);
      return;
    }
    var hasStoreScopeFav =
      detail &&
      detail.options &&
      detail.options.length > 0 &&
      detail.inventoryScope !== 'online' &&
      detail.source !== 'live-online';
    if (!CONFIG.REALTIME_API && hasStoreScopeFav) {
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
            '&fresh=true'
        );
        var d = await r.json();
        if (d.success && d.options && d.options.length > 0) {
          if (!this.detailData) this.detailData = { products: {} };
          if (!this.detailData.products) this.detailData.products = {};
          this.detailData.products[gn] = d;
          var favOnlineSnapshot = this._rememberOnlineStock(gn, d);
          if (favOnlineSnapshot) UI.updateCardBadge(gn, favOnlineSnapshot);
          this._recordVelocitySnapshot(gn, favOnlineSnapshot || d, this._productMetaForGoodsNo(gn));
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
