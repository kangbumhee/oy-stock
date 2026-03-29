var App = {
  products: [],
  searchHistory: [],
  lat: CONFIG.DEFAULT_LAT,
  lng: CONFIG.DEFAULT_LNG,
  locationName: CONFIG.DEFAULT_LOCATION,
  detailData: null,
  currentTab: 'search',

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
    var key = CONFIG.KAKAO_REST_KEY;
    if (!key || key.indexOf('여기에') > -1) {
      return Promise.resolve('내 위치 (' + lat.toFixed(2) + ', ' + lng.toFixed(2) + ')');
    }

    var url =
      'https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?x=' +
      encodeURIComponent(lng) +
      '&y=' +
      encodeURIComponent(lat);

    return fetch(url, {
      headers: { Authorization: 'KakaoAK ' + key }
    })
      .then(function (r) {
        return r.ok ? r.json() : { documents: [] };
      })
      .then(function (data) {
        var docs = data.documents || [];
        // 행정동 우선, 없으면 법정동
        var region = docs.find(function (d) {
          return d.region_type === 'H';
        }) || docs[0];
        if (region) {
          // "경기도 김포시 사우동" → "김포 사우동"
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
      case 'showDetail':
        this._openDetail(parseInt(el.dataset.index, 10));
        break;
      case 'showFavDetail':
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

  doSearch: function (keyword) {
    var self = this;
    this.searchHistory = [keyword]
      .concat(
        this.searchHistory.filter(function (h) {
          return h !== keyword;
        })
      )
      .slice(0, 20);
    this._save();
    UI.renderHistory(this.searchHistory);
    UI.showLoading('"' + keyword + '" 검색 중...');

    API.search(keyword, this.lat, this.lng, CONFIG.SEARCH_SIZE)
      .then(function (d) {
        if (d.success === false) throw new Error(d.message || d.error || '실패');
        var inv = (d.data && d.data.inventory) || d.inventory || {};
        self.products = inv.products || [];
        return API.loadDetailCache();
      })
      .then(function (detail) {
        self.detailData = detail || self.detailData;
        UI.renderProducts(self.products, self.detailData);
      })
      .catch(function (err) {
        UI.showError(err.message || '검색 실패');
      });
  },

  _renderFavorites: function () {
    UI.renderFavorites(Storage.getFavorites(), this.detailData);
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
    UI.showSyncStatus('동기화 중...', false);
    var favs = Storage.getFavorites();
    API.syncFavorites(favs, {
      lat: this.lat,
      lng: this.lng,
      name: this.locationName
    }).then(function (res) {
      if (res.success)
        UI.showSyncStatus('✅ 동기화 완료! 다음 1시간 내 재고 수집됩니다.', false, 5000);
      else UI.showSyncStatus('⚠️ 동기화 실패: ' + (res.error || JSON.stringify(res)), true);
    });
  },

  _openDetail: async function (idx) {
    var p = this.products[idx];
    if (!p) return;
    var gn = String(p.goodsNumber || p.goodsNo);
    var detail =
      this.detailData && this.detailData.products ? this.detailData.products[gn] : null;
    if (detail && detail.options && detail.options.length > 0) {
      UI.showDetailPopup(detail, gn);
      return;
    }
    if (CONFIG.REALTIME_API) {
      UI.showPopupLoading(p.goodsName, '실시간 매장 재고 조회 중…');
      try {
        var url =
          CONFIG.REALTIME_API +
          (CONFIG.REALTIME_API.indexOf('?') >= 0 ? '&' : '?') +
          'goodsNo=' +
          encodeURIComponent(gn) +
          '&lat=' +
          encodeURIComponent(String(this.lat)) +
          '&lng=' +
          encodeURIComponent(String(this.lng));
        var r = await fetch(url);
        var d = await r.json();
        if (d.success && d.options && d.options.length > 0) {
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
    var gn = String(goodsNo);
    var fav = Storage.getFavorites().find(function (f) {
      return String(f.goodsNo) === gn;
    });
    var name = fav ? fav.goodsName : gn;
    var detail =
      this.detailData && this.detailData.products ? this.detailData.products[gn] : null;
    if (detail && detail.options && detail.options.length > 0) {
      UI.showDetailPopup(detail, gn);
      return;
    }
    if (CONFIG.REALTIME_API) {
      UI.showPopupLoading(name, '실시간 매장 재고 조회 중…');
      try {
        var url =
          CONFIG.REALTIME_API +
          (CONFIG.REALTIME_API.indexOf('?') >= 0 ? '&' : '?') +
          'goodsNo=' +
          encodeURIComponent(gn) +
          '&lat=' +
          encodeURIComponent(String(this.lat)) +
          '&lng=' +
          encodeURIComponent(String(this.lng));
        var r = await fetch(url);
        var d = await r.json();
        if (d.success && d.options && d.options.length > 0) {
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
