/* Premium inventory stays in memory only. Every page is authorized by the server. */
var HiddenStock = {
  keyword: '',
  searchState: null,
  panelState: null,
  _generation: 0,
  _identity: '',
  _initialized: false,

  init: function () {
    if (this._initialized) return;
    this._initialized = true;
    this._identity = this._deviceIdentity();
    document.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-hidden-action]');
      if (!button) return;
      event.preventDefault();
      HiddenStock._handleAction(button);
    });
    document.addEventListener('keydown', function (event) {
      var root = document.getElementById('hidden-stock-panel');
      if (!root) return;
      var accessModal = document.getElementById('price-alert-modal');
      if (accessModal && !accessModal.classList.contains('hidden') && !accessModal.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); HiddenStock.closePanel(); }
      if (event.key !== 'Tab') return;
      var controls = Array.prototype.slice.call(root.querySelectorAll('button:not([disabled]), [tabindex="0"]'));
      if (!controls.length) return;
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.addEventListener('error', function (event) {
      var img = event.target;
      if (img && img.tagName === 'IMG' && img.dataset.hiddenImage === '1') {
        img.hidden = true;
        if (img.nextElementSibling) img.nextElementSibling.hidden = false;
      }
    }, true);
    window.addEventListener('storage', function () { HiddenStock._guard(); });
    window.addEventListener('pagehide', function () { HiddenStock.clearPremium(); });
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) { HiddenStock.clearPremium(); PriceAlerts.refreshEntitlement({ silent: true }); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) HiddenStock.clearPremium();
      else PriceAlerts.refreshEntitlement({ silent: true });
    });
    this._guardTimer = window.setInterval(function () { HiddenStock._guard(); }, 1000);
  },

  _deviceIdentity: function () {
    if (!window.PriceAlerts) return '';
    var headers = PriceAlerts._apiHeaders();
    return String(headers['X-Price-Alert-Device-Id'] || '') + ':' +
      String(headers['X-Price-Alert-Device-Secret'] || '');
  },

  _hasAccess: function () {
    var entitlement = window.PriceAlerts && PriceAlerts.entitlement;
    if (!entitlement || entitlement.active !== true) return false;
    return entitlement.lifetime === true || Date.parse(entitlement.expiresAt || '') > Date.now();
  },

  _guard: function () {
    var identity = this._deviceIdentity();
    if (identity !== this._identity) {
      this._identity = identity;
      if (window.PriceAlerts) PriceAlerts.entitlement = null;
      this.clearPremium();
      return false;
    }
    if (!this._hasAccess()) {
      if (this.searchState || this.panelState) this.clearPremium();
      return false;
    }
    return true;
  },

  onEntitlementChange: function () {
    if (!this._initialized) return;
    this._guard();
    this._renderSearch();
  },

  clearPremium: function () {
    this._generation++;
    this.searchState = null;
    this.closePanel();
    this._renderSearch();
  },

  _esc: function (value) { return UI.esc(String(value == null ? '' : value)); },
  _key: function (option) {
    return [option.goodsNo, option.optionNumber, option.productId].map(function (value) {
      return String(value || '');
    }).join('|');
  },
  _merge: function (previous, incoming, key) {
    var map = new Map();
    previous.concat(incoming).forEach(function (row) { map.set(key(row), row); });
    return Array.from(map.values());
  },

  _imageHtml: function (option) {
    var src = '';
    try {
      var url = new URL(option.image || '');
      if (url.protocol === 'https:' && /(^|\.)oliveyoung\.co\.kr$/i.test(url.hostname) && !url.username && !url.password) src = url.href;
    } catch (_) {}
    return '<div class="hidden-stock-image">' + (src ? '<img data-hidden-image="1" src="' + this._esc(src) +
      '" width="72" height="72" alt="' + this._esc((option.goodsName || option.name || '상품') + ' 참고 이미지') +
      '" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') +
      '<span' + (src ? ' hidden' : '') + '>이미지 준비 중</span></div>';
  },

  _location: function () {
    var app = window.App || {}, config = window.CONFIG || {};
    var lat = app.lat != null ? app.lat : config.DEFAULT_LAT;
    var lng = app.lng != null ? app.lng : config.DEFAULT_LNG;
    if (lat === '' || lng === '' || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) ||
      Number(lat) < -90 || Number(lat) > 90 || Number(lng) < -180 || Number(lng) > 180) return null;
    return { lat: Number(lat), lng: Number(lng), name: String(app.locationName || config.DEFAULT_LOCATION || '선택한 위치') };
  },

  _sortStores: function (stores) {
    return stores.sort(function (a, b) {
      var left = typeof a.dist === 'number' && Number.isFinite(a.dist) && a.dist >= 0 ? a.dist : Infinity;
      var right = typeof b.dist === 'number' && Number.isFinite(b.dist) && b.dist >= 0 ? b.dist : Infinity;
      return left === right ? 0 : left - right;
    });
  },

  _request: async function (params) {
    if (!this._guard()) { var denied = new Error('access_required'); denied.status = 402; throw denied; }
    var generation = this._generation, identity = this._identity;
    var query = new URLSearchParams();
    Object.keys(params).forEach(function (key) {
      if (key === 'cursor' && (params.action === 'options' || !params[key])) return;
      query.set(key, params[key]);
    });
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 60000);
    try {
      var response = await PriceAlerts._request('/api/oliveyoung/hidden-stock?' + query.toString(), { signal: controller.signal });
      if (!this._guard() || generation !== this._generation || identity !== this._identity) {
        var stale = new Error('discarded_response'); stale.discarded = true; throw stale;
      }
      return response;
    } catch (error) {
      if ([401, 402, 403].indexOf(error.status) !== -1) {
        PriceAlerts.entitlement = null;
        this.clearPremium();
        if (UI.showSyncStatus) UI.showSyncStatus('이용권 인증이 필요합니다. 이용권 확인을 다시 눌러 주세요.', true, 5000);
      }
      throw error;
    } finally { window.clearTimeout(timer); }
  },

  search: async function (keyword) {
    this.keyword = String(keyword || '').trim();
    this.searchState = null;
    this._renderSearch();
    var requestedKeyword = this.keyword;
    if (!requestedKeyword || !window.PriceAlerts) return;
    await PriceAlerts.refreshEntitlement({ silent: true });
    if (this.keyword !== requestedKeyword || !this._guard()) { this._renderSearch(); return; }
    this.searchState = this._newState('search');
    await this.loadSearch();
  },

  _newState: function (mode) {
    return { mode: mode, options: [], stores: [], nextCursor: null, coverage: null, busy: false, loaded: false, error: '', auto: false, autoCount: 0, autoLimited: false };
  },

  loadSearch: async function () {
    var state = this.searchState;
    if (!state || state.busy) return;
    state.busy = true; state.error = ''; this._renderSearch();
    try {
      var response = await this._request({ action: 'search', keyword: this.keyword, cursor: state.nextCursor || '' });
      if (this.searchState !== state) return;
      if (!Array.isArray(response.options)) throw new Error('invalid_response');
      state.options = this._merge(state.options, response.options, this._key);
      state.nextCursor = response.nextCursor || null;
      state.coverage = response.coverage || null;
      state.loaded = true;
    } catch (error) {
      if (this.searchState === state && !error.discarded) state.error = '숨겨진 옵션을 불러오지 못했습니다. 품절을 뜻하지 않습니다.';
    } finally {
      state.busy = false;
      if (this.searchState === state) this._renderSearch();
    }
  },

  productButtonHtml: function (goodsNo) {
    return '<button type="button" class="hidden-stock-button" data-hidden-action="options" data-goodsno="' +
      this._esc(goodsNo) + '">매장 숨겨진 옵션 보기 · 이용권</button>';
  },

  normalStoreButtonHtml: function (goodsNo, option, detail) {
    if (!option || !option.productId) return '';
    return '<button type="button" class="hidden-stock-button" data-hidden-action="normal-stores" data-goodsno="' + this._esc(goodsNo) +
      '" data-productid="' + this._esc(option.productId) + '" data-optionnumber="' + this._esc(option.optionNumber || '') +
      '" data-optionname="' + this._esc(option.name || '') + '" data-image="' + this._esc(option.image || (detail && detail.thumbnail) || '') +
      '" data-goodsname="' + this._esc((detail && detail.goodsName) || '') + '">전국 매장 전체 이어서 조회 · 이용권</button>';
  },

  openOptions: async function (goodsNo) {
    if (!this._guard()) return this.openAccess(function () { HiddenStock.openOptions(goodsNo); });
    this._returnFocus = document.activeElement;
    var state = this._newState('options');
    state.goodsNo = String(goodsNo || '');
    this.panelState = state;
    this._renderPanel(true);
    await this.loadPanel();
  },

  openStores: async function (option, scope) {
    if (!option) return;
    if (!this._guard()) return this.openAccess(function () { HiddenStock.openStores(option, scope); });
    if (!this.panelState) this._returnFocus = document.activeElement;
    var state = this._newState('stores');
    state.goodsNo = option.goodsNo;
    state.option = option;
    state.scope = scope === 'national' ? 'national' : 'nearby';
    state.location = this._location();
    state.optionsParent = this.panelState && this.panelState.mode === 'options' ? this.panelState : null;
    this.panelState = state;
    this._renderPanel(true);
    if (state.scope === 'nearby' && !state.location) return;
    await this.loadPanel();
  },

  openNational: async function () {
    var previous = this.panelState;
    if (!previous || previous.mode !== 'stores' || previous.scope !== 'nearby' || !this._guard()) return;
    var state = this._newState('stores');
    state.goodsNo = previous.goodsNo; state.option = previous.option;
    state.scope = 'national'; state.location = previous.location;
    state.nearbyParent = previous; state.optionsParent = previous.optionsParent;
    this.panelState = state;
    this._renderPanel(true);
    await this.loadPanel();
    if (this.panelState === state && !state.error) await this.startContinuousStores();
  },

  backPanel: function (kind) {
    var state = this.panelState;
    var previous = state && (kind === 'nearby' ? state.nearbyParent : state.optionsParent);
    if (!previous || !this._guard()) return;
    state.auto = false;
    this.panelState = previous;
    this._renderPanel(true);
    if (!previous.loaded && !previous.busy) this.loadPanel();
  },

  loadPanel: async function () {
    var state = this.panelState;
    if (!state || state.busy) return;
    if (state.mode === 'stores' && state.scope === 'nearby' && !state.location) return;
    state.busy = true; state.error = ''; this._renderPanel();
    var params = { action: state.mode, goodsNo: state.goodsNo, cursor: state.nextCursor || '' };
    if (state.option) {
      params.productId = state.option.productId;
      params.scope = state.scope;
      if (state.location) { params.lat = state.location.lat; params.lng = state.location.lng; }
    }
    try {
      var response = await this._request(params);
      if (this.panelState !== state) return;
      var storesMode = state.mode === 'stores';
      var rows = storesMode ? response.stores : response.options;
      if (!Array.isArray(rows)) throw new Error('invalid_response');
      if (storesMode) {
        state.stores = this._sortStores(this._merge(state.stores, rows, function (store) { return String(store.code || store.name + '|' + store.addr); }));
      } else state.options = this._merge(state.options, rows, this._key);
      state.nextCursor = response.nextCursor || null;
      state.coverage = response.coverage || null;
      state.loaded = true;
    } catch (error) {
      if (this.panelState === state && !error.discarded) state.error = '조회하지 못했습니다. 재고 없음으로 판단하지 말고 다시 확인해 주세요.';
    } finally {
      state.busy = false;
      if (this.panelState === state) this._renderPanel();
    }
  },

  _coverageText: function (state) {
    var coverage = state.coverage || {};
    var complete = coverage.complete === true && !state.nextCursor;
    if (state.mode === 'stores' && state.scope === 'nearby') return complete ?
      '선택한 위치 주변의 조회 범위를 확인했습니다. 다른 지역은 아래 전국 재고 조회에서 확인하세요.' :
      '주변 매장 일부를 확인했습니다. 추가 조회로 더 확인할 수 있으며, 전국 품절을 뜻하지 않습니다.';
    return complete ? '이번 조회 범위 확인 완료 · 매장 방문 전 재고를 다시 확인해 주세요.' :
      '일부 범위 조회 결과입니다. 표시되지 않은 옵션·매장도 있을 수 있습니다.';
  },

  _pace: function () { return new Promise(function (resolve) { window.setTimeout(resolve, 300); }); },

  startContinuousStores: async function () {
    var state = this.panelState;
    if (!state || state.mode !== 'stores' || state.scope !== 'national' || state.busy || state.autoRunning || !state.nextCursor || !this._guard()) return;
    state.autoRunning = true;
    state.auto = true; state.autoCount = 0; state.autoLimited = false;
    try {
      while (this.panelState === state && state.auto && state.nextCursor && !state.error && state.autoCount < 60) {
        if (!this._guard()) break;
        state.autoCount++;
        await this.loadPanel();
        if (this.panelState !== state || !state.auto || !state.nextCursor || state.error) break;
        if (state.autoCount < 60) await this._pace();
      }
    } finally {
      state.auto = false;
      state.autoRunning = false;
      state.autoLimited = state.autoCount >= 60 && !!state.nextCursor;
      if (this.panelState === state) this._renderPanel();
    }
  },

  pauseContinuousStores: function () {
    if (!this.panelState) return;
    this.panelState.auto = false;
    this._renderPanel();
  },

  _optionRows: function (options, source) {
    return options.map(function (option, index) {
      return '<li class="hidden-stock-option"><div class="hidden-stock-option-summary">' + HiddenStock._imageHtml(option) +
        '<div><p class="hidden-stock-product">' + HiddenStock._esc(option.goodsName || '') +
        '</p><h4>' + HiddenStock._esc(option.name) + '</h4><p>숨겨진 옵션 · 매장 재고 별도 조회</p></div></div>' +
        '<button type="button" class="hidden-stock-button" data-hidden-action="stores" data-source="' + source +
        '" data-index="' + index + '">근처 매장 재고 확인</button></li>';
    }).join('');
  },

  _statusHtml: function (state, action) {
    var html = state.error ? '<p class="hidden-stock-error" role="alert">' + this._esc(state.error) + '</p>' : '';
    if (state.loaded) html += '<p class="hidden-stock-coverage">' + this._coverageText(state) + '</p>';
    if (state.auto) html += '<p role="status">남은 전국 범위를 순서대로 확인 중입니다. 한 번에 한 요청만 진행합니다.</p>' +
      '<button type="button" class="hidden-stock-button" data-hidden-action="pause-stores">연속 조회 일시정지</button>';
    else if (state.busy) html += '<p role="status">옵션·매장 정보를 확인하고 있습니다…</p>';
    else if (state.nextCursor || state.error) html += '<button type="button" class="hidden-stock-button" data-hidden-action="' + action +
      '">' + (state.error ? '다시 조회' : '다음 범위 더 보기') + '</button>';
    if (state.mode === 'stores' && state.scope === 'national' && state.nextCursor && !state.busy && !state.autoRunning && !state.error) {
      if (state.autoLimited) html += '<p>안전을 위해 60회 요청 후 멈췄습니다. 아직 남은 범위가 있으니 이어서 조회할 수 있습니다.</p>';
      html += '<button type="button" class="hidden-stock-button" data-hidden-action="continuous-stores">' +
        (state.autoLimited ? '남은 전국 범위 계속 연속 조회' : '남은 전국 범위 연속 조회') + '</button>';
    }
    return html;
  },

  _renderSearch: function () {
    var root = document.getElementById('hidden-stock-search');
    if (!root) return;
    root.hidden = !this.keyword;
    if (!this.keyword) { root.innerHTML = ''; return; }
    var html = '<h3 id="hidden-stock-search-title">매장 숨겨진 옵션</h3>';
    if (!this._hasAccess()) {
      root.innerHTML = html + '<p>온라인에 표시되지 않는 옵션의 매장 재고를 이용권으로 확인하세요. 가격 알림 이용권과 함께 사용할 수 있습니다.</p>' +
        '<button type="button" class="hidden-stock-button" data-hidden-action="access">이용권 확인 / 프로모션 입력</button>';
      return;
    }
    var state = this.searchState;
    if (!state) {
      root.innerHTML = html + '<button type="button" class="hidden-stock-button" data-hidden-action="search">이 검색어로 숨겨진 옵션 조회</button>';
      return;
    }
    html += '<ul class="hidden-stock-options">' + this._optionRows(state.options, 'search') + '</ul>';
    if (state.loaded && !state.options.length && !state.error) html += '<p>이번 조회 범위에서는 일치하는 숨겨진 옵션을 찾지 못했습니다. 전체 매장 품절이라는 뜻은 아닙니다.</p>';
    root.innerHTML = html + this._statusHtml(state, 'search-more');
  },

  _renderPanel: function (focus) {
    var state = this.panelState;
    if (!state || !this._hasAccess()) return;
    var root = document.getElementById('hidden-stock-panel');
    var hadFocus = root && root.contains(document.activeElement);
    var focusedAction = hadFocus && document.activeElement.dataset ? document.activeElement.dataset.hiddenAction : '';
    var oldDialog = root && root.querySelector('.hidden-stock-dialog');
    var scrollTop = !focus && oldDialog ? oldDialog.scrollTop : 0;
    if (!root) { root = document.createElement('div'); root.id = 'hidden-stock-panel'; root.className = 'hidden-stock-overlay'; document.body.appendChild(root); }
    var title = state.mode === 'stores' ? (state.scope === 'nearby' ? '근처 매장 재고' : '전국 매장 재고') : '이 상품의 숨겨진 옵션';
    var html = '<div class="hidden-stock-backdrop" data-hidden-action="close"></div><section class="hidden-stock-dialog" role="dialog" aria-modal="true" aria-labelledby="hidden-stock-panel-title">' +
      '<div class="hidden-stock-heading"><h3 id="hidden-stock-panel-title">' + title + '</h3><button type="button" data-hidden-action="close" aria-label="숨겨진 옵션 닫기">✕</button></div>';
    if (state.mode === 'stores') {
      if (state.nearbyParent) html += '<button type="button" class="hidden-stock-back" data-hidden-action="back-nearby">‹ 근처 재고로 돌아가기</button>';
      else if (state.optionsParent) html += '<button type="button" class="hidden-stock-back" data-hidden-action="back-options">‹ 숨겨진 옵션 목록</button>';
      html += '<div class="hidden-stock-option-summary hidden-stock-selected">' + this._imageHtml(state.option) + '<div><p class="hidden-stock-product">' +
        this._esc(state.option.goodsName || '') + '</p><h4>' + this._esc(state.option.name) +
        '</h4></div></div><p class="hidden-stock-image-note">상품 참고 이미지로, 옵션의 실제 구성·패키지와 다를 수 있습니다.</p>' +
        '<p>온라인 판매 여부 확인 불가 · 매장 방문 전 재고 확인 권장</p>';
      if (state.location) html += '<p class="hidden-stock-location">📍 ' + this._esc(state.location.name) + ' 기준 · 가까운 매장순</p>';
      else if (state.scope === 'nearby') html += '<p class="hidden-stock-error">선택한 위치를 확인할 수 없습니다. 창을 닫고 상단에서 지역을 선택하거나 아래 전국 재고 조회를 눌러 주세요.</p>';
      html += '<ul class="hidden-stock-stores">';
      state.stores.forEach(function (store) {
        var qty = typeof store.qty === 'number' && Number.isFinite(store.qty) && store.qty >= 0 ? store.qty : null;
        var dist = typeof store.dist === 'number' && Number.isFinite(store.dist) && store.dist >= 0 ? store.dist : null;
        html += '<li><div><strong>' + HiddenStock._esc(store.name) + '</strong><span class="hidden-stock-distance">' +
          (dist !== null ? HiddenStock._esc(Number(dist.toFixed(2))) + 'km' : '거리 미확인') + '</span><p>' + HiddenStock._esc(store.region || '') + ' ' + HiddenStock._esc(store.addr || '') +
          '</p></div><span class="' + (qty > 0 ? 'stock-ok' : qty === 0 ? 'stock-out' : '') + '">' + (qty === null ? '수량 확인 불가' : qty > 0 ? '재고 ' + qty + '개' : '조회 시점 재고 0개') + '</span></li>';
      });
      html += '</ul>';
      if (state.loaded && !state.stores.length && !state.error) html += '<p>이번 범위에 표시할 매장 정보가 없습니다. 전국 품절을 뜻하지 않습니다.</p>';
    } else {
      html += '<ul class="hidden-stock-options">' + this._optionRows(state.options, 'panel') + '</ul>';
      if (state.loaded && !state.options.length && !state.error) html += '<p>이번 조회 범위에서 확인된 숨겨진 옵션이 없습니다.</p>';
    }
    html += this._statusHtml(state, 'panel-more');
    if (state.mode === 'stores' && state.scope === 'nearby') html += '<div class="hidden-stock-national-footer"><button type="button" class="hidden-stock-button" data-hidden-action="national-stores">전국 재고 조회</button><p>다른 지역까지 순서대로 확인합니다.</p></div>';
    root.innerHTML = html + '</section>';
    document.body.classList.add('hidden-stock-open');
    if (focus || hadFocus) {
      var nextFocus = !focus && focusedAction ? root.querySelector('[data-hidden-action="' + focusedAction + '"]') : null;
      (nextFocus || root.querySelector('button')).focus({ preventScroll: true });
    }
    root.querySelector('.hidden-stock-dialog').scrollTop = scrollTop;
  },

  closePanel: function () {
    if (this.panelState) this.panelState.auto = false;
    this.panelState = null;
    var root = document.getElementById('hidden-stock-panel');
    if (root) root.remove();
    document.body.classList.remove('hidden-stock-open');
    if (this._returnFocus && this._returnFocus.isConnected) this._returnFocus.focus();
    this._returnFocus = null;
  },

  openAccess: function (callback) {
    if (!window.PriceAlerts || !PriceAlerts.openAccess) return;
    PriceAlerts.openAccess(callback || function () { HiddenStock.search(HiddenStock.keyword); });
  },

  _handleAction: function (button) {
    switch (button.dataset.hiddenAction) {
      case 'access': this.openAccess(); break;
      case 'search': this.search(this.keyword); break;
      case 'search-more': this.loadSearch(); break;
      case 'options': this.openOptions(button.dataset.goodsno); break;
      case 'normal-stores': this.openStores({ goodsNo: button.dataset.goodsno, productId: button.dataset.productid,
        optionNumber: button.dataset.optionnumber, name: button.dataset.optionname, image: button.dataset.image,
        goodsName: button.dataset.goodsname }, 'national'); break;
      case 'stores': {
        var state = button.dataset.source === 'search' ? this.searchState : this.panelState;
        var option = state && state.options[Number(button.dataset.index)];
        this.openStores(option); break;
      }
      case 'panel-more': this.loadPanel(); break;
      case 'national-stores': this.openNational(); break;
      case 'back-nearby': this.backPanel('nearby'); break;
      case 'back-options': this.backPanel('options'); break;
      case 'continuous-stores': this.startContinuousStores(); break;
      case 'pause-stores': this.pauseContinuousStores(); break;
      case 'close': this.closePanel(); break;
    }
  }
};
