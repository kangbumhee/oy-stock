const App = {
  products: [],
  searchHistory: [],
  lat: 37.6152,
  lng: 126.7156,
  regionName: '김포 사우',
  gpsLat: null,
  gpsLng: null,

  _cfg() {
    return typeof Config !== 'undefined' ? Config : typeof CONFIG !== 'undefined' ? CONFIG : {};
  },

  _dataUrl(kind) {
    const c = this._cfg();
    if (kind === 'stock') return c.STOCK_JSON_URL || '/data/stock.json';
    if (kind === 'detail') return c.DETAIL_JSON_URL || '/data/stock-detail.json';
    return c.STOCK_JSON_URL || '/data/stock.json';
  },

  _liveSearchSize() {
    const c = this._cfg();
    return c.LIVE_SEARCH_SIZE != null ? c.LIVE_SEARCH_SIZE : 50;
  },

  regions: [
    { n: '김포 사우', lat: 37.6152, lng: 126.7156, t: ['김포', '사우', 'gimpo'] },
    { n: '김포 풍무', lat: 37.6053, lng: 126.7219, t: ['풍무'] },
    { n: '김포 장기', lat: 37.6444, lng: 126.6677, t: ['장기'] },
    { n: '김포 구래', lat: 37.6443, lng: 126.6268, t: ['구래'] },
    { n: '김포 걸포', lat: 37.6325, lng: 126.7049, t: ['걸포', '걸포북변'] },
    { n: '김포 고촌', lat: 37.6005, lng: 126.7713, t: ['고촌'] },
    { n: '김포 운양', lat: 37.6543, lng: 126.6834, t: ['운양'] },
    { n: '검단', lat: 37.5931, lng: 126.7127, t: ['검단', '인천검단'] },
    { n: '검단신도시', lat: 37.5949, lng: 126.6725, t: ['검단신도시'] },
    { n: '인천 부평', lat: 37.5075, lng: 126.7219, t: ['부평'] },
    { n: '인천 계양', lat: 37.5382, lng: 126.7385, t: ['계양'] },
    { n: '서울 강남', lat: 37.4979, lng: 127.0276, t: ['강남', '역삼'] },
    { n: '서울 홍대', lat: 37.5563, lng: 126.9236, t: ['홍대', '마포'] },
    { n: '서울 시청', lat: 37.5665, lng: 126.978, t: ['시청', '서울', '명동'] },
    { n: '서울 잠실', lat: 37.5133, lng: 127.1001, t: ['잠실', '송파'] },
    { n: '부산 서면', lat: 35.1577, lng: 129.0596, t: ['부산', '서면'] },
    { n: '부산 해운대', lat: 35.1631, lng: 129.1638, t: ['해운대'] },
    { n: '대구 동성로', lat: 35.869, lng: 128.5946, t: ['대구'] },
    { n: '광주 충장로', lat: 35.1491, lng: 126.9171, t: ['광주'] },
    { n: '대전 둔산', lat: 36.3544, lng: 127.3784, t: ['대전'] },
    { n: '수원역', lat: 37.2658, lng: 127.0, t: ['수원'] },
    { n: '성남 분당', lat: 37.3825, lng: 127.119, t: ['분당', '성남', '판교'] },
    { n: '일산', lat: 37.6584, lng: 126.7717, t: ['일산', '고양'] },
    { n: '천안', lat: 36.8151, lng: 127.1139, t: ['천안'] },
    { n: '전주', lat: 35.8175, lng: 127.1087, t: ['전주'] },
    { n: '제주', lat: 33.489, lng: 126.4983, t: ['제주'] }
  ],

  init() {
    this._load();
    this._bind();
    UI.renderHistory(this.searchHistory);
    this._updateRegion();
    const ri = document.getElementById('region-input');
    if (ri && this.regionName && this.regionName.indexOf('현재위치') === -1) ri.value = this.regionName;
    this._tryGPS();
  },

  _load() {
    try {
      const h = localStorage.getItem('oy_h') || localStorage.getItem('oy_hist');
      if (h) this.searchHistory = JSON.parse(h);
      const r = localStorage.getItem('oy_r') || localStorage.getItem('oy_region');
      if (r) {
        const d = JSON.parse(r);
        this.lat = d.lat;
        this.lng = d.lng;
        this.regionName = d.n != null ? d.n : d.name != null ? d.name : this.regionName;
      }
    } catch (e) {}
  },

  _save() {
    try {
      localStorage.setItem('oy_h', JSON.stringify(this.searchHistory.slice(0, 20)));
      localStorage.setItem('oy_r', JSON.stringify({ lat: this.lat, lng: this.lng, n: this.regionName }));
    } catch (e) {}
  },

  _updateRegion() {
    const el = document.getElementById('current-region');
    if (el) el.textContent = '📍 ' + this.regionName;
  },

  _tryGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.gpsLat = pos.coords.latitude;
        this.gpsLng = pos.coords.longitude;
        let best = null;
        let bestD = Infinity;
        this.regions.forEach((r) => {
          const d = this._haversine(this.gpsLat, this.gpsLng, r.lat, r.lng);
          if (d < bestD) {
            bestD = d;
            best = r;
          }
        });
        if (best && bestD < 15) {
          this.lat = this.gpsLat;
          this.lng = this.gpsLng;
          this.regionName = '현재위치 (' + best.n + ' 근처)';
          this._save();
          this._updateRegion();
          const ri = document.getElementById('region-input');
          if (ri) ri.value = '';
        }
      },
      () => {},
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
    );
  },

  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  _bind() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (!a) return;
      const act = a.dataset.action;
      if (act === 'search') {
        this._setQ(a.dataset.keyword);
        this.doSearch(a.dataset.keyword);
      } else if (act === 'clearHistory') {
        this.searchHistory = [];
        this._save();
        UI.renderHistory([]);
      } else if (act === 'selectRegion') {
        this._pickRegion(a);
      } else if (act === 'showDetail') {
        e.stopPropagation();
        this._openDetail(+a.dataset.index);
      } else if (act === 'closePopup') {
        UI.closePopup();
      } else if (act === 'toggleStores') {
        UI.toggleStores(a);
      } else if (act === 'selectOption') {
        UI.selectOption(+a.dataset.optIdx);
      } else if (act === 'showHistory') {
        if (typeof Inventory !== 'undefined' && Inventory.showHistory) {
          Inventory.showHistory();
        }
      }
    });

    const form = document.getElementById('search-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const inp = document.getElementById('search-input');
        const v = inp && inp.value.trim();
        if (v) this.doSearch(v);
      });
    }

    const ri = document.getElementById('region-input');
    if (ri) {
      ri.addEventListener('input', () => this._regionAC(ri));
      ri.addEventListener('focus', () => this._regionAC(ri));
    }

    document.addEventListener('click', (e) => {
      const dd = document.getElementById('region-dropdown');
      const ri2 = document.getElementById('region-input');
      if (dd && ri2 && !ri2.contains(e.target) && !dd.contains(e.target)) dd.style.display = 'none';
    });

    const btnGps = document.getElementById('btn-gps');
    if (btnGps) btnGps.addEventListener('click', () => this._gpsClick());
  },

  _setQ(v) {
    const el = document.getElementById('search-input');
    if (el) el.value = v;
  },

  _regionAC(input) {
    const v = input.value.trim().toLowerCase();
    const dd = document.getElementById('region-dropdown');
    if (!dd) return;
    if (v.length < 1) {
      dd.style.display = 'none';
      return;
    }
    const m = this.regions
      .filter(
        (r) => r.n.toLowerCase().includes(v) || r.t.some((t) => String(t).toLowerCase().includes(v))
      )
      .slice(0, 10);
    if (!m.length) {
      dd.style.display = 'none';
      return;
    }
    dd.style.display = 'block';
    dd.innerHTML = m
      .map(
        (r) =>
          `<div class="dd-item" data-action="selectRegion" data-n="${UI.esc(r.n)}" data-lat="${r.lat}" data-lng="${r.lng}">📍 ${UI.esc(r.n)}</div>`
      )
      .join('');
  },

  _pickRegion(el) {
    this.regionName = el.dataset.n;
    this.lat = +el.dataset.lat;
    this.lng = +el.dataset.lng;
    this._save();
    this._updateRegion();
    const ri = document.getElementById('region-input');
    if (ri) ri.value = el.dataset.n;
    const dd = document.getElementById('region-dropdown');
    if (dd) dd.style.display = 'none';
    const q = document.getElementById('search-input');
    if (q && q.value.trim()) this.doSearch(q.value.trim());
  },

  _gpsClick() {
    const btn = document.getElementById('btn-gps');
    if (!btn || !navigator.geolocation) {
      alert('위치 사용 불가');
      return;
    }
    btn.textContent = '⏳';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.lat = pos.coords.latitude;
        this.lng = pos.coords.longitude;
        let best = null;
        let bestD = Infinity;
        this.regions.forEach((r) => {
          const d = this._haversine(this.lat, this.lng, r.lat, r.lng);
          if (d < bestD) {
            bestD = d;
            best = r;
          }
        });
        this.regionName = '현재위치' + (best ? ' (' + best.n + ' 근처)' : '');
        this._save();
        this._updateRegion();
        btn.textContent = '📍';
        const ri = document.getElementById('region-input');
        if (ri) ri.value = '';
        const q = document.getElementById('search-input');
        if (q && q.value.trim()) this.doSearch(q.value.trim());
      },
      () => {
        btn.textContent = '📍';
        alert('위치 권한을 허용해주세요');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  },

  async doSearch(keyword) {
    this.searchHistory = [keyword, ...this.searchHistory.filter((h) => h !== keyword)].slice(0, 20);
    this._save();
    UI.renderHistory(this.searchHistory);
    UI.showLoading(keyword);
    try {
      let stockData = null;
      let detailData = null;
      if (typeof API !== 'undefined' && API.loadStockCache && API.loadDetailCache) {
        try {
          [stockData, detailData] = await Promise.all([API.loadStockCache(), API.loadDetailCache()]);
        } catch (e) {}
      } else {
        try {
          const sr = await fetch(this._dataUrl('stock'));
          if (sr.ok) stockData = await sr.json();
        } catch (e) {}
        try {
          const dr = await fetch(this._dataUrl('detail'));
          if (dr.ok) detailData = await dr.json();
        } catch (e) {}
      }

      const sz = this._liveSearchSize();
      const r = await fetch(
        `/api/oliveyoung/search?keyword=${encodeURIComponent(keyword)}&lat=${this.lat}&lng=${this.lng}&size=${sz}`
      );
      if (!r.ok) throw new Error('서버오류 ' + r.status);
      const d = await r.json();
      if (d.success === false) throw new Error(d.message || d.error || '실패');
      const inv = d.data?.inventory || d.inventory || {};
      this.products = inv.products || [];
      UI.renderProducts(this.products, stockData, detailData);
    } catch (err) {
      UI.showError(err.message || '검색 실패');
    }
  },

  async _openDetail(idx) {
    const p = this.products[idx];
    if (!p) return;
    UI.showPopupLoading(p);
    try {
      const gk = String(p.goodsNumber);

      let detail = null;
      try {
        let dd = null;
        if (typeof API !== 'undefined' && API.loadDetailCache) {
          dd = await API.loadDetailCache();
        } else {
          const dr = await fetch(this._dataUrl('detail'));
          if (dr.ok) dd = await dr.json();
        }
        if (dd) detail = dd.products && dd.products[gk];
      } catch (e) {}

      if (detail && detail.options && detail.options.length > 0) {
        let stockData = null;
        try {
          if (typeof API !== 'undefined' && API.loadStockCache) {
            stockData = await API.loadStockCache();
          } else {
            const sr = await fetch(this._dataUrl('stock'));
            if (sr.ok) stockData = await sr.json();
          }
        } catch (e) {}

        const scanProduct =
          stockData && stockData.products
            ? stockData.products.find(function (x) {
                return String(x.goodsNo) === gk;
              })
            : null;

        UI.showPopup(p, {
          success: true,
          _cached: true,
          _updatedAt: detail.updatedAt,
          _status: scanProduct ? scanProduct.status : 'active',
          _statusLabel: scanProduct ? scanProduct.statusLabel : '',
          goodsInfo: {
            goodsNumber: p.goodsNumber,
            goodsName: detail.goodsName || p.goodsName,
            priceToPay: scanProduct
              ? scanProduct.price
              : detail.price != null
                ? detail.price
                : p.priceToPay,
            originalPrice: scanProduct
              ? scanProduct.originalPrice
              : detail.originalPrice != null
                ? detail.originalPrice
                : p.originalPrice,
            discountRate: scanProduct
              ? scanProduct.discountRate
              : detail.discountRate != null
                ? detail.discountRate
                : p.discountRate,
            thumbnailUrl: detail.thumbnail || p.imageUrl,
            itemCount: detail.options.length
          },
          options: detail.options.map(function (o) {
            var basePrice = scanProduct
              ? scanProduct.price
              : detail.price != null
                ? detail.price
                : p.priceToPay;
            return {
              itemName: o.name,
              legacyItemNumber: o.productId,
              quantity: o.totalQty || 0,
              priceToPay: basePrice,
              o2oRemainQuantity: 0,
              deliveredToday: false,
              imageUrl: detail.thumbnail || p.imageUrl
            };
          }),
          storesByOption: detail.options.map(function (o) {
            return {
              itemName: o.name,
              productId: o.productId,
              totalCount: o.totalStores || 0,
              stores: (o.stores || []).map(function (s) {
                return {
                  storeName: s.name,
                  storeCode: s.code || '',
                  distance: s.dist,
                  remainQuantity: s.qty,
                  o2oRemainQuantity: s.o2o,
                  pickupYn: s.pickup,
                  openYn: s.open,
                  address: '',
                  startTime: '',
                  endTime: ''
                };
              })
            };
          })
        });
        return;
      }

      try {
        let sd2 = null;
        if (typeof API !== 'undefined' && API.loadStockCache) {
          sd2 = await API.loadStockCache();
        } else {
          const sr2 = await fetch(this._dataUrl('stock'));
          if (sr2.ok) sd2 = await sr2.json();
        }
        if (sd2) {
          const found = (sd2.products || []).find(function (x) {
            return String(x.goodsNo) === gk;
          });
          if (found) {
            UI.showPopupBasic(p, found, sd2.updatedAt);
            return;
          }
        }
      } catch (e) {}

      const gn = encodeURIComponent(p.goodsNumber);
      const fb = this._cfg().FALLBACK_API || '/api/oliveyoung/stock';
      const r = await fetch(`${fb}?goodsNo=${gn}&lat=${this.lat}&lng=${this.lng}`);
      const d = await r.json();
      if (d._serverFallbackGuide && d.consoleScript) {
        UI.showStockGuidePopup(p, d);
        return;
      }
      if (!d.success) throw new Error(d.message || '조회 실패');
      UI.showPopup(p, d);
    } catch (e) {
      UI.showPopupError(p, e.message || '오류');
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
