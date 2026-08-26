var PriceAlerts = {
  app: null,
  loading: false,
  modalState: null,
  entitlement: null,
  entitlementEnabled: null,
  paymentAvailable: null,
  promotionAvailable: null,
  entitlementLoading: false,
  paymentBusy: false,
  _portOnePromise: null,
  _messageBound: false,

  init: function (app) {
    this.app = app || null;
    this._ensureModal();
    this._bindModalForm();
    this._bindServiceWorkerMessages();
    this.syncServiceWorkerAuth();
    this.refreshControls();
    this.refreshFromServer({ silent: true });
    this.refreshEntitlement({ silent: true });
    this._recoverPaymentReturn();
  },

  _apiHeaders: function () {
    var device = Storage.getPriceAlertDevice();
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Price-Alert-Device-Id': device.deviceId,
      'X-Price-Alert-Device-Secret': device.deviceSecret
    };
  },

  _request: function (url, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      headers: this._apiHeaders(),
      cache: 'no-store',
      credentials: 'same-origin'
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return fetch(url, init).then(async function (response) {
      var data = null;
      try {
        data = await response.json();
      } catch (e) {}
      if (!response.ok || !data || data.success === false) {
        var message =
          (data && (data.error || data.message)) ||
          '가격 알림 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
        var err = new Error(message);
        err.status = response.status;
        err.code = data && data.error ? String(data.error) : '';
        throw err;
      }
      return data;
    });
  },

  _hasActiveEntitlement: function () {
    return !!(this.entitlement && this.entitlement.active === true);
  },

  _entitlementLabel: function () {
    if (!this._hasActiveEntitlement()) return '가격 알림 이용권이 필요합니다';
    if (this.entitlement.lifetime === true) return '평생 이용권 활성';
    var expires = new Date(this.entitlement.expiresAt || '');
    if (!isFinite(expires.getTime())) return '30일 이용권 활성';
    return (
      '이용권 만료 ' +
      expires.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    );
  },

  _setPaywallMessage: function (message, isError) {
    var target = document.getElementById('price-alert-paywall-message');
    if (!target) return;
    target.textContent = message || '';
    target.classList.toggle('error', isError === true);
  },

  _renderEntitlement: function () {
    var status = document.getElementById('price-alert-entitlement-status');
    var paywall = document.getElementById('price-alert-paywall');
    var setup = document.getElementById('price-alert-setup');
    var payButton = document.getElementById('price-alert-pay-button');
    var promoButton = document.getElementById('price-alert-promo-button');
    var active = this._hasActiveEntitlement();

    if (status) {
      status.textContent = this.entitlementLoading
        ? '이용권 확인 중…'
        : this._entitlementLabel();
      status.classList.toggle('active', active);
    }
    if (paywall) paywall.classList.toggle('hidden', active);
    if (setup) setup.classList.toggle('hidden', !active);

    var configured = this.entitlementEnabled !== false;
    var controlsDisabled = this.entitlementLoading || this.paymentBusy || !configured;
    if (payButton) payButton.disabled = controlsDisabled || this.paymentAvailable !== true;
    if (promoButton) promoButton.disabled = controlsDisabled || this.promotionAvailable !== true;
    if (!active && this.entitlementEnabled === false) {
      this._setPaywallMessage(
        '가격 알림 이용권 결제가 아직 준비되지 않았습니다. 잠시 후 다시 확인해 주세요.',
        true
      );
    } else if (
      !active &&
      !this.entitlementLoading &&
      !this.paymentBusy &&
      this.paymentAvailable === false &&
      this.promotionAvailable === false
    ) {
      this._setPaywallMessage(
        '현재 신규 이용권 결제 준비 상태와 수용량을 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.',
        true
      );
    } else if (
      !active &&
      !this.entitlementLoading &&
      !this.paymentBusy &&
      this.paymentAvailable === false
    ) {
      this._setPaywallMessage(
        '현재 신규 이용권 결제 준비 상태와 수용량을 확인할 수 없습니다. 프로모션 코드가 있다면 적용할 수 있습니다.',
        true
      );
    } else if (!active && !this.entitlementLoading && !this.paymentBusy) {
      this._setPaywallMessage('30일 이용권을 결제하거나 프로모션 코드를 적용해 주세요.', false);
    }
  },

  refreshEntitlement: function (opts) {
    opts = opts || {};
    if (this.entitlementLoading && this._entitlementPromise) return this._entitlementPromise;
    this.entitlementLoading = true;
    this._renderEntitlement();
    var self = this;
    var task = this._request(CONFIG.PRICE_ALERT_ENTITLEMENT_API)
      .then(function (result) {
        self.entitlementEnabled = result.enabled !== false;
        self.paymentAvailable = result.paymentAvailable === true;
        self.promotionAvailable = result.promotionAvailable === true;
        self.entitlement = result.entitlement || { active: false, lifetime: false, expiresAt: null };
        if (!opts.silent) {
          UI.showSyncStatus(
            self._hasActiveEntitlement() ? self._entitlementLabel() : '가격 알림 이용권이 없습니다',
            false,
            4200
          );
        }
        return self.entitlement;
      })
      .catch(function (error) {
        self.entitlement = null;
        self.entitlementEnabled = error && error.status === 503 ? false : null;
        self.paymentAvailable = false;
        self.promotionAvailable = false;
        if (!opts.silent) {
          UI.showSyncStatus('이용권 상태를 확인하지 못했습니다. 다시 시도해 주세요.', true, 5000);
        }
        return null;
      })
      .finally(function () {
        self.entitlementLoading = false;
        self._entitlementPromise = null;
        self._renderEntitlement();
        if (self._hasActiveEntitlement() && self.modalState) {
          self._continueAlertSetup(self.modalState);
        }
      });
    this._entitlementPromise = task;
    return task;
  },

  applyPromotion: async function () {
    if (this.paymentBusy || this.promotionAvailable !== true) return;
    var input = document.getElementById('price-alert-promo-input');
    var code = input ? input.value : '';
    if (!code) {
      this._setPaywallMessage('프로모션 코드를 입력해 주세요.', true);
      if (input) input.focus();
      return;
    }
    if (input) input.value = '';
    this.paymentBusy = true;
    this._setPaywallMessage('프로모션 코드를 확인하고 있습니다…', false);
    this._renderEntitlement();
    try {
      var result = await this._request(CONFIG.PRICE_ALERT_PROMOTION_API, {
        method: 'POST',
        body: { code: code }
      });
      code = '';
      if (!result.entitlement || result.entitlement.active !== true || result.entitlement.lifetime !== true) {
        throw new Error('promotion_not_activated');
      }
      this.entitlementEnabled = true;
      this.promotionAvailable = true;
      this.entitlement = result.entitlement;
      this.paymentBusy = false;
      this._renderEntitlement();
      if (this.modalState) this._continueAlertSetup(this.modalState);
      UI.showSyncStatus('평생 가격 알림 이용권이 활성화되었습니다', false, 5000);
    } catch (error) {
      code = '';
      this.paymentBusy = false;
      this._renderEntitlement();
      this._setPaywallMessage(
        error && error.code === 'promotion_invalid'
          ? '유효하지 않은 프로모션 코드입니다.'
          : '프로모션 코드를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        true
      );
    }
  },

  _newPaymentIdempotencyKey: function () {
    return 'price-alert-' + Storage._randomBase64Url(32);
  },

  _validPaymentContract: function (result) {
    if (!result || typeof result !== 'object') return null;
    var request = result.requestPayment;
    var plan = result.plan;
    if (!request || typeof request !== 'object' || !plan || typeof plan !== 'object') return null;
    var requestKeys = Object.keys(request).sort().join(',');
    var planKeys = Object.keys(plan).sort().join(',');
    if (
      requestKeys !==
        'channelKey,currency,easyPay,noticeUrls,orderName,payMethod,paymentId,products,redirectUrl,storeId,totalAmount' ||
      planKeys !== 'amount,autoRenew,currency,durationDays'
    ) {
      return null;
    }
    var paymentId = String(result.paymentId || '');
    if (!/^oypa_[A-Za-z0-9_-]{20,96}$/.test(paymentId) || request.paymentId !== paymentId) {
      return null;
    }
    if (
      plan.amount !== 30000 ||
      plan.currency !== 'KRW' ||
      plan.durationDays !== 30 ||
      plan.autoRenew !== false ||
      request.orderName !== '올리브재고 가격 알림 30일 이용권' ||
      request.totalAmount !== 30000 ||
      request.currency !== 'KRW' ||
      request.payMethod !== 'EASY_PAY' ||
      !request.easyPay ||
      request.easyPay.easyPayProvider !== 'KAKAOPAY' ||
      Object.keys(request.easyPay).length !== 1 ||
      !/^store-[A-Za-z0-9_-]{6,120}$/.test(String(request.storeId || '')) ||
      !/^channel-key-[A-Za-z0-9_-]{6,160}$/.test(String(request.channelKey || '')) ||
      !Array.isArray(request.noticeUrls) ||
      request.noticeUrls.length !== 1 ||
      !Array.isArray(request.products) ||
      request.products.length !== 1
    ) {
      return null;
    }
    var product = request.products[0];
    if (
      !product ||
      typeof product !== 'object' ||
      product.id !== 'price_alert_30d' ||
      product.name !== '올리브재고 가격 알림 30일 이용권' ||
      product.amount !== 30000 ||
      product.quantity !== 1 ||
      Object.keys(product).length !== 4
    ) {
      return null;
    }
    try {
      var redirect = new URL(String(request.redirectUrl || ''), location.origin);
      var notice = new URL(String(request.noticeUrls[0] || ''), location.origin);
      var queryKeys = [];
      redirect.searchParams.forEach(function (_, key) {
        queryKeys.push(key);
      });
      if (
        redirect.origin !== location.origin ||
        redirect.username ||
        redirect.password ||
        redirect.pathname !== '/' ||
        redirect.hash ||
        queryKeys.length !== 1 ||
        redirect.searchParams.get('priceAlertPayment') !== 'complete' ||
        notice.origin !== location.origin ||
        notice.username ||
        notice.password ||
        notice.pathname !== '/api/price-alerts/payment-webhook' ||
        notice.search ||
        notice.hash
      ) {
        return null;
      }
    } catch (error) {
      return null;
    }
    return { paymentId: paymentId, requestPayment: request };
  },

  _loadPortOne: function () {
    if (window.PortOne && typeof window.PortOne.requestPayment === 'function') {
      return Promise.resolve(window.PortOne);
    }
    if (this._portOnePromise) return this._portOnePromise;
    var expected = 'https://cdn.portone.io/v2/browser-sdk.js';
    if (CONFIG.PRICE_ALERT_PORTONE_SDK_URL !== expected) {
      return Promise.reject(new Error('payment_sdk_not_configured'));
    }
    this._portOnePromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = expected;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = function () {
        if (window.PortOne && typeof window.PortOne.requestPayment === 'function') {
          resolve(window.PortOne);
        } else {
          reject(new Error('payment_sdk_unavailable'));
        }
      };
      script.onerror = function () {
        reject(new Error('payment_sdk_unavailable'));
      };
      document.head.appendChild(script);
    }).catch(function (error) {
      PriceAlerts._portOnePromise = null;
      throw error;
    });
    return this._portOnePromise;
  },

  startPayment: async function () {
    if (
      this.paymentBusy ||
      this.entitlementEnabled === false ||
      this.paymentAvailable !== true
    ) {
      return;
    }
    var attempt = Storage.getPriceAlertPaymentAttempt();
    if (attempt && attempt.paymentId && attempt.providerInvoked) {
      this._setPaywallMessage('진행 중인 결제를 서버에서 다시 확인합니다…', false);
      await this._completePayment(attempt.paymentId);
      return;
    }
    if (!attempt) {
      attempt = {
        idempotencyKey: this._newPaymentIdempotencyKey(),
        paymentId: '',
        providerInvoked: false
      };
      Storage.setPriceAlertPaymentAttempt(attempt);
    }
    this.paymentBusy = true;
    this._setPaywallMessage('안전한 결제 요청을 준비하고 있습니다…', false);
    this._renderEntitlement();
    var paymentId = '';
    var retryAllowed = false;
    try {
      var created = await this._request(CONFIG.PRICE_ALERT_PAYMENT_CREATE_API, {
        method: 'POST',
        body: { idempotencyKey: attempt.idempotencyKey }
      });
      var contract = this._validPaymentContract(created);
      if (!contract) throw new Error('payment_contract_mismatch');
      paymentId = contract.paymentId;
      attempt.paymentId = paymentId;
      attempt.providerInvoked = false;
      if (!Storage.setPriceAlertPaymentAttempt(attempt)) throw new Error('payment_state_unavailable');

      var portOne = await this._loadPortOne();
      attempt.providerInvoked = true;
      if (!Storage.setPriceAlertPaymentAttempt(attempt)) throw new Error('payment_state_unavailable');
      var providerResult;
      try {
        providerResult = portOne.requestPayment(contract.requestPayment);
      } catch (providerError) {
        // 동기 예외는 결제창 handoff 전에 SDK 호출 자체가 실패한 경우다.
        attempt.providerInvoked = false;
        Storage.setPriceAlertPaymentAttempt(attempt);
        retryAllowed = true;
        throw providerError;
      }
      try {
        await Promise.resolve(providerResult);
      } catch (providerError) {
        // Promise 거절은 결제창이 열렸을 수도 있어 중복 handoff를 허용하지 않는다.
      }
    } catch (error) {
      this.paymentBusy = false;
      if (
        error &&
        (error.code === 'payment_not_configured' ||
          error.code === 'active_device_capacity_reached')
      ) {
        this.paymentAvailable = false;
      }
      this._renderEntitlement();
      if (paymentId) {
        await this._completePayment(paymentId, {
          retryAllowed: retryAllowed || attempt.providerInvoked !== true
        });
        return;
      }
      this._setPaywallMessage(
        error && error.message === 'payment_contract_mismatch'
          ? '결제 요청 정보가 고정 이용권 조건과 일치하지 않아 결제를 시작하지 않았습니다.'
          : error && error.code === 'payment_not_configured'
            ? '결제 기능이 아직 준비되지 않았습니다. 잠시 후 다시 확인해 주세요.'
            : error && error.code === 'active_device_capacity_reached'
              ? '현재 신규 이용권 수용량이 모두 사용 중입니다. 결제를 시작하지 않았으며, 잠시 후 다시 확인해 주세요.'
            : '결제 요청을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        true
      );
      return;
    }
    this.paymentBusy = false;
    this._renderEntitlement();
    await this._completePayment(paymentId);
  },

  _completePayment: async function (paymentId, opts) {
    opts = opts || {};
    if (!/^oypa_[A-Za-z0-9_-]{20,96}$/.test(String(paymentId || ''))) return null;
    this.paymentBusy = true;
    this._setPaywallMessage('결제 결과를 서버에서 확인하고 있습니다…', false);
    this._renderEntitlement();
    var completionMessage = '';
    var completionError = false;
    try {
      var result = await this._request(CONFIG.PRICE_ALERT_PAYMENT_COMPLETE_API, {
        method: 'POST',
        body: { paymentId: paymentId }
      });
      if (result.paymentId !== paymentId) throw new Error('payment_identity_mismatch');
      if (result.status === 'paid' && result.entitlement && result.entitlement.active === true) {
        Storage.clearPriceAlertPaymentAttempt();
        this.entitlementEnabled = true;
        this.paymentAvailable = true;
        this.entitlement = result.entitlement;
        completionMessage = '결제가 확인되어 30일 이용권이 활성화되었습니다.';
        UI.showSyncStatus('30일 가격 알림 이용권이 활성화되었습니다', false, 5200);
      } else if (result.status === 'cancelled' || result.status === 'abandoned') {
        Storage.clearPriceAlertPaymentAttempt();
        completionMessage = '결제가 완료되지 않았습니다. 원할 때 다시 시도할 수 있습니다.';
        completionError = true;
      } else if (result.status === 'review_required') {
        completionMessage =
          '결제 확인에 추가 검토가 필요합니다. 결제 기록과 함께 kbhjjan@gmail.com으로 문의해 주세요.';
        completionError = true;
      } else {
        completionMessage =
          opts.retryAllowed === true
            ? '결제창이 열리지 않아 같은 결제를 안전하게 다시 시도할 수 있습니다.'
            : '결제가 아직 확인되지 않았습니다. 중복 결제를 피하려면 이용권 새로고침으로 먼저 확인해 주세요.';
      }
      return result;
    } catch (error) {
      completionMessage =
        '결제 결과를 확인하지 못했습니다. 재결제하지 말고 이용권 새로고침을 먼저 눌러 주세요.';
      completionError = true;
      return null;
    } finally {
      this.paymentBusy = false;
      this._renderEntitlement();
      if (completionMessage) this._setPaywallMessage(completionMessage, completionError);
      if (this._hasActiveEntitlement() && this.modalState) {
        this._continueAlertSetup(this.modalState);
      }
    }
  },

  _recoverPaymentReturn: function () {
    var paymentId = '';
    try {
      var raw = sessionStorage.getItem('oy_price_alert_payment_return_v1');
      sessionStorage.removeItem('oy_price_alert_payment_return_v1');
      var returned = raw ? JSON.parse(raw) : null;
      paymentId = String((returned && returned.paymentId) || '');
    } catch (error) {
      return;
    }
    var attempt = Storage.getPriceAlertPaymentAttempt();
    if (
      /^oypa_[A-Za-z0-9_-]{20,96}$/.test(paymentId) &&
      attempt &&
      attempt.paymentId === paymentId
    ) {
      this._completePayment(paymentId);
    }
  },

  _price: function (value) {
    var num = Number(String(value == null ? '' : value).replace(/[^0-9.-]/g, ''));
    return isFinite(num) && num > 0 ? Math.round(num) : 0;
  },

  _formatPrice: function (value) {
    var price = this._price(value);
    return price ? UI.num(price) + '원' : '확인 대기';
  },

  _formatCheckedAt: function (value) {
    if (!value) return '첫 확인 대기';
    var date = new Date(value);
    if (!isFinite(date.getTime())) return '첫 확인 대기';
    return date.toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  isEnabled: function (goodsNo, optionNumber) {
    if (optionNumber != null && String(optionNumber).trim()) {
      var exact = Storage.getPriceAlert(goodsNo, optionNumber);
      return !!(exact && exact.enabled !== false);
    }
    return Storage.getPriceAlertsForGoods(goodsNo).some(function (alert) {
      return alert && alert.enabled !== false;
    });
  },

  rememberProductSnapshot: function (goodsNo, meta) {
    var existing = Storage.getPriceAlert(goodsNo, '');
    if (!existing) return;
    meta = meta || {};
    var currentPrice = this._price(meta.currentPrice);
    var changed = false;
    if (currentPrice && currentPrice !== this._price(existing.displayCurrentPrice)) {
      existing.displayCurrentPrice = currentPrice;
      changed = true;
    }
    if (meta.goodsName && !existing.goodsName) {
      existing.goodsName = meta.goodsName;
      changed = true;
    }
    if (meta.imageUrl && !existing.imageUrl) {
      existing.imageUrl = meta.imageUrl;
      changed = true;
    }
    if (changed) Storage.upsertPriceAlert(existing);
  },

  productControlHtml: function (goodsNo, meta, classes) {
    meta = meta || {};
    this.rememberProductSnapshot(goodsNo, meta);
    var alerts = Storage.getPriceAlertsForGoods(goodsNo).filter(function (item) {
      return item && item.enabled !== false;
    });
    var alert = alerts[0] || null;
    var enabled = alerts.length > 0;
    var target = alerts.length === 1 ? this._price(alert.targetPrice) : 0;
    return (
      '<button type="button" class="price-alert-toggle ' +
      UI.escAttr(classes || '') +
      (enabled ? ' active' : '') +
      '" data-action="openPriceAlert" data-goodsno="' +
      UI.escAttr(goodsNo || '') +
      '" data-goodsname="' +
      UI.escAttr(meta.goodsName || (alert && alert.goodsName) || '') +
      '" data-imageurl="' +
      UI.escAttr(meta.imageUrl || (alert && alert.imageUrl) || '') +
      '" data-currentprice="' +
      UI.escAttr(String(this._price(meta.currentPrice) || '')) +
      '" aria-pressed="' +
      (enabled ? 'true' : 'false') +
      '">' +
      '<span class="price-alert-toggle-label">가격 알림</span>' +
      '<span class="price-alert-toggle-target">' +
      (alerts.length > 1 ? alerts.length + '개 ON' : target ? '목표 ' + UI.num(target) + '원' : '설정') +
      '</span>' +
      '<span class="price-alert-toggle-state">' +
      (enabled ? 'ON' : 'OFF') +
      '</span>' +
      '</button>'
    );
  },

  managerHtml: function () {
    var items = Storage.getPriceAlertItems()
      .filter(function (item) {
        return item && item.goodsNo && item.enabled !== false;
      })
      .sort(function (a, b) {
        return String(b.updatedAt || b.createdAt || '').localeCompare(
          String(a.updatedAt || a.createdAt || '')
        );
      });
    if (!items.length) return '';
    var rows = items
      .map(function (item) {
        var displayPrice =
          PriceAlerts._price(item.displayCurrentPrice) ||
          PriceAlerts._price(item.currentPrice) ||
          PriceAlerts._price(item.lastEvaluatedPrice);
        var baseline = PriceAlerts._price(item.lastEvaluatedPrice);
        return (
          '<div class="price-alert-manager-row">' +
          '<div class="price-alert-manager-main">' +
          '<strong>' +
          UI.esc(item.goodsName || item.goodsNo) +
          '</strong>' +
          (item.optionNumber
            ? '<small class="price-alert-manager-option">옵션 · ' +
              UI.esc(item.optionName || item.optionNumber) +
              (item.soldOut ? ' · 품절' : '') +
              '</small>'
            : '') +
          '<span>현재가 ' +
          UI.esc(PriceAlerts._formatPrice(displayPrice)) +
          ' · 목표가 ' +
          UI.esc(PriceAlerts._formatPrice(item.targetPrice)) +
          '</span>' +
          '<small>최근 기준가 ' +
          UI.esc(PriceAlerts._formatPrice(baseline)) +
          ' · ' +
          UI.esc(PriceAlerts._formatCheckedAt(item.lastCheckedAt)) +
          '</small>' +
          '</div>' +
          '<button type="button" class="price-alert-manager-edit" data-action="openPriceAlert" data-goodsno="' +
          UI.escAttr(item.goodsNo) +
          '" data-alertidentity="' +
          (item.optionNumber ? 'option' : 'product') +
          '" data-optionnumber="' +
          UI.escAttr(item.optionNumber || '') +
          '" data-optionname="' +
          UI.escAttr(item.optionName || '') +
          '" data-legacyitemnumber="' +
          UI.escAttr(item.legacyItemNumber || '') +
          '" data-goodsname="' +
          UI.escAttr(item.goodsName || '') +
          '" data-imageurl="' +
          UI.escAttr(item.imageUrl || '') +
          '" data-currentprice="' +
          UI.escAttr(String(displayPrice || '')) +
          '"><span>ON</span><b>수정</b></button>' +
          '</div>'
        );
      })
      .join('');
    return (
      '<section class="price-alert-manager" aria-label="가격 알림 설정">' +
      '<div class="price-alert-manager-head"><div><strong>가격 알림</strong><span>' +
      items.length +
      '개 ON</span></div>' +
      '<button type="button" data-action="refreshPriceAlerts">새로고침</button></div>' +
      '<p class="price-alert-manager-guide">60분마다 확인해 가격 상승·하락과 목표가 도달을 알려드립니다. 브라우저를 닫아도 Web Push로 받을 수 있습니다.</p>' +
      rows +
      '</section>'
    );
  },

  _ensureModal: function () {
    if (document.getElementById('price-alert-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'price-alert-modal';
    modal.className = 'price-alert-modal hidden';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML =
      '<div class="price-alert-modal-backdrop" data-action="closePriceAlert"></div>' +
      '<section class="price-alert-dialog" role="dialog" aria-modal="true" aria-labelledby="price-alert-title">' +
      '<form id="price-alert-form">' +
      '<div class="price-alert-dialog-head"><div><span>🔔 가격 변동 알림</span><h3 id="price-alert-title">가격 알림 설정</h3></div>' +
      '<button type="button" class="price-alert-close" data-action="closePriceAlert" aria-label="닫기">✕</button></div>' +
      '<div id="price-alert-entitlement-status" class="price-alert-entitlement-status" role="status">이용권 확인 중…</div>' +
      '<section id="price-alert-paywall" class="price-alert-paywall" aria-labelledby="price-alert-pass-title">' +
      '<div class="price-alert-pass"><div><span>PRICE WATCH PASS</span><h4 id="price-alert-pass-title">30일 이용권</h4><p>가격 상승·하락과 목표가 도달 Web Push</p></div><div><strong>30,000원</strong><b>자동결제 아님</b></div></div>' +
      '<p id="price-alert-paywall-message" class="price-alert-paywall-message">이용권 상태를 확인하고 있습니다.</p>' +
      '<button type="button" id="price-alert-pay-button" class="price-alert-pay-button" disabled>카카오페이로 30일 이용권 결제</button>' +
      '<div class="price-alert-promo"><label for="price-alert-promo-input">평생 이용 프로모션 코드</label><div><input id="price-alert-promo-input" type="password" maxlength="160" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="코드 입력"><button type="button" id="price-alert-promo-button">적용</button></div></div>' +
      '<p class="price-alert-browser-warning"><strong>이 브라우저 전용 이용권입니다.</strong> 사이트 데이터 삭제·시크릿 모드·기기 변경 시 자동 이용권 확인이 어려울 수 있습니다. 결제 기록을 보관하고 <a href="mailto:kbhjjan@gmail.com">kbhjjan@gmail.com</a>으로 문의해 주세요.</p>' +
      '<div class="price-alert-policy-links"><a href="/payment-info.html" target="_blank" rel="noopener">결제·환불 안내</a><a href="/privacy.html" target="_blank" rel="noopener">개인정보 안내</a><button type="button" id="price-alert-entitlement-refresh">이용권 새로고침</button></div>' +
      '</section>' +
      '<div id="price-alert-setup" class="price-alert-setup hidden">' +
      '<fieldset id="price-alert-option-section" class="price-alert-options hidden" aria-describedby="price-alert-option-help"><legend>알림을 설정할 옵션</legend>' +
      '<div id="price-alert-option-list" class="price-alert-option-list"></div>' +
      '<p id="price-alert-option-help">옵션마다 목표가격을 따로 저장할 수 있습니다. 품절 옵션도 등록할 수 있으며 재판매 후 가격 변동부터 확인합니다.</p></fieldset>' +
      '<div class="price-alert-current"><span>현재 공개 표시가</span><strong id="price-alert-current-price">확인 대기</strong></div>' +
      '<label class="price-alert-field" for="price-alert-target-input"><span>알림 목표가격</span>' +
      '<div><input id="price-alert-target-input" name="targetPrice" type="number" min="1" max="100000000" step="1" inputmode="numeric" required aria-describedby="price-alert-help"><b>원</b></div></label>' +
      '<p id="price-alert-help" class="price-alert-help">현재가보다 높거나 낮은 가격 모두 설정할 수 있습니다. 가격이 오르거나 내릴 때마다 알림을 보내고, 목표가에 도달하면 함께 표시합니다.</p>' +
      '<div class="price-alert-notes"><p>⏱️ 60분마다 가격을 확인합니다.</p><p>🏷️ 올리브영 공개 표시 판매가 기준이며 쿠폰·회원·카드 할인 제외</p><p>📲 알림을 허용하면 사이트를 닫아도 Web Push로 받을 수 있습니다.</p></div>' +
      '<p id="price-alert-error" class="price-alert-error" role="alert"></p>' +
      '<div class="price-alert-dialog-actions"><button type="button" id="price-alert-disable" class="price-alert-disable hidden" data-action="disablePriceAlert">알림 끄기</button>' +
      '<button type="button" class="price-alert-cancel" data-action="closePriceAlert">취소</button>' +
      '<button type="submit" id="price-alert-save" class="price-alert-save">저장</button></div>' +
      '</div></form></section>';
    document.body.appendChild(modal);
  },

  _bindModalForm: function () {
    var form = document.getElementById('price-alert-form');
    if (!form || form.__priceAlertBound) return;
    form.__priceAlertBound = true;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (PriceAlerts._hasActiveEntitlement()) {
        PriceAlerts.saveFromModal();
      } else {
        var promoInput = document.getElementById('price-alert-promo-input');
        if (promoInput && promoInput.value) PriceAlerts.applyPromotion();
        else PriceAlerts._setPaywallMessage('이용권을 결제하거나 프로모션 코드를 적용해 주세요.', true);
      }
    });
    form.addEventListener('change', function (event) {
      var input = event.target;
      if (input && input.name === 'priceAlertOption') {
        PriceAlerts.selectModalOption(input.value);
      }
    });
    var payButton = document.getElementById('price-alert-pay-button');
    if (payButton) payButton.addEventListener('click', function () {
      PriceAlerts.startPayment();
    });
    var promoButton = document.getElementById('price-alert-promo-button');
    if (promoButton) promoButton.addEventListener('click', function () {
      PriceAlerts.applyPromotion();
    });
    var refreshButton = document.getElementById('price-alert-entitlement-refresh');
    if (refreshButton) refreshButton.addEventListener('click', function () {
      PriceAlerts.refreshEntitlement({ silent: false });
    });
  },

  openFromElement: function (el) {
    if (!el) return;
    var goodsNo = String(el.dataset.goodsno || '').trim();
    if (!goodsNo) return;
    var requestedOptionNumber = String(el.dataset.optionnumber || '').trim();
    var existing = Storage.getPriceAlert(goodsNo, requestedOptionNumber);
    var currentPrice =
      this._price(el.dataset.currentprice) ||
      this._price(existing && existing.displayCurrentPrice) ||
      this._price(existing && existing.lastEvaluatedPrice);
    this.modalState = {
      goodsNo: goodsNo,
      goodsName: el.dataset.goodsname || (existing && existing.goodsName) || goodsNo,
      imageUrl: el.dataset.imageurl || (existing && existing.imageUrl) || '',
      productCurrentPrice: currentPrice,
      currentPrice: currentPrice,
      optionNumber: requestedOptionNumber,
      optionName: el.dataset.optionname || (existing && existing.optionName) || '',
      legacyItemNumber:
        el.dataset.legacyitemnumber || (existing && existing.legacyItemNumber) || '',
      soldOut: existing && existing.soldOut === true,
      existing: existing,
      options: [],
      optionsLoaded: false,
      optionLookupPending: false,
      lockProductIdentity: el.dataset.alertidentity === 'product'
    };
    var modal = document.getElementById('price-alert-modal');
    if (!modal) return;
    document.getElementById('price-alert-title').textContent = this.modalState.goodsName;
    this._applyModalIdentity({
      optionNumber: requestedOptionNumber,
      optionName: this.modalState.optionName,
      legacyItemNumber: this.modalState.legacyItemNumber,
      currentPrice: currentPrice,
      soldOut: this.modalState.soldOut
    });
    var optionSection = document.getElementById('price-alert-option-section');
    var optionList = document.getElementById('price-alert-option-list');
    if (optionSection) optionSection.classList.add('hidden');
    if (optionList) optionList.innerHTML = '';
    this._setModalError('');
    this._setModalBusy(false);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('price-alert-modal-open');
    var stateRef = this.modalState;
    this._renderEntitlement();
    if (this._hasActiveEntitlement()) this._continueAlertSetup(stateRef);
    this.refreshEntitlement({ silent: true });
  },

  _continueAlertSetup: function (stateRef) {
    if (!stateRef || this.modalState !== stateRef || !this._hasActiveEntitlement()) return;
    this._renderEntitlement();
    if (!stateRef.optionsLoaded) {
      stateRef.optionsLoaded = true;
      this._setOptionLookupPending(
        stateRef,
        !stateRef.optionNumber && !stateRef.lockProductIdentity
      );
      this._loadModalOptions(stateRef);
    }
    var input = document.getElementById('price-alert-target-input');
    window.setTimeout(function () {
      if (!input || PriceAlerts.modalState !== stateRef) return;
      input.focus();
      input.select();
    }, 30);
  },

  _applyModalIdentity: function (option) {
    if (!this.modalState) return;
    option = option || {};
    var optionNumber = String(option.optionNumber || '').trim();
    var existing = Storage.getPriceAlert(this.modalState.goodsNo, optionNumber);
    var currentPrice =
      this._price(option.currentPrice) ||
      this._price(existing && existing.displayCurrentPrice) ||
      this._price(existing && existing.lastEvaluatedPrice) ||
      (!optionNumber ? this._price(this.modalState.productCurrentPrice) : 0);
    this.modalState.optionNumber = optionNumber;
    this.modalState.optionName = optionNumber ? String(option.optionName || '').trim() : '';
    this.modalState.legacyItemNumber = optionNumber
      ? String(option.legacyItemNumber || '').trim()
      : '';
    this.modalState.soldOut = optionNumber && option.soldOut === true;
    this.modalState.currentPrice = currentPrice;
    this.modalState.existing = existing;

    var price = document.getElementById('price-alert-current-price');
    if (price) {
      price.textContent =
        this._formatPrice(currentPrice) + (this.modalState.soldOut ? ' · 현재 품절' : '');
    }
    var input = document.getElementById('price-alert-target-input');
    if (input) {
      input.value = existing && this._price(existing.targetPrice)
        ? this._price(existing.targetPrice)
        : '';
      input.placeholder = currentPrice ? String(currentPrice) : '원하는 가격 입력';
    }
    var disable = document.getElementById('price-alert-disable');
    if (disable) disable.classList.toggle('hidden', !(existing && existing.enabled !== false));
    var save = document.getElementById('price-alert-save');
    if (save) save.textContent = existing ? '수정 저장' : '알림 설정';
  },

  _normalizedStockOptions: function (value) {
    var seen = {};
    return (Array.isArray(value) ? value : [])
      .map(function (option) {
        option = option || {};
        var optionNumber = String(option.optionNumber || '').trim();
        var optionName = String(option.name || option.optionName || '').trim().slice(0, 120);
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(optionNumber) || !optionName || seen[optionNumber]) {
          return null;
        }
        seen[optionNumber] = true;
        var legacyItemNumber = String(
          option.legacyItemNumber || option.productId || ''
        ).trim();
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(legacyItemNumber)) legacyItemNumber = '';
        return {
          optionNumber: optionNumber,
          optionName: optionName,
          legacyItemNumber: legacyItemNumber,
          currentPrice: PriceAlerts._price(option.priceToPay),
          soldOut: option.soldOut === true
        };
      })
      .filter(Boolean);
  },

  _renderModalOptions: function (options, selectedOptionNumber) {
    var section = document.getElementById('price-alert-option-section');
    var list = document.getElementById('price-alert-option-list');
    if (!section || !list) return;
    if (!Array.isArray(options) || options.length <= 1) {
      section.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    list.innerHTML = options
      .map(function (option, index) {
        var inputId = 'price-alert-option-' + index;
        return (
          '<label class="price-alert-option" for="' +
          inputId +
          '"><input id="' +
          inputId +
          '" type="radio" name="priceAlertOption" value="' +
          UI.escAttr(option.optionNumber) +
          '"' +
          (option.optionNumber === selectedOptionNumber ? ' checked' : '') +
          '><span><b>' +
          UI.esc(option.optionName) +
          '</b><small>' +
          UI.esc(PriceAlerts._formatPrice(option.currentPrice)) +
          '</small></span>' +
          (option.soldOut ? '<em>품절 · 등록 가능</em>' : '<em class="available">판매중</em>') +
          '</label>'
        );
      })
      .join('');
    section.classList.remove('hidden');
  },

  _loadModalOptions: function (stateRef) {
    if (!stateRef || !CONFIG.REALTIME_API || stateRef.lockProductIdentity) {
      return Promise.resolve([]);
    }
    var url =
      CONFIG.REALTIME_API +
      '?goodsNo=' +
      encodeURIComponent(stateRef.goodsNo) +
      '&onlineOnly=true';
    return fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit'
    })
      .then(function (response) {
        if (!response.ok) throw new Error('option_lookup_failed');
        return response.json();
      })
      .then(function (result) {
        if (PriceAlerts.modalState !== stateRef) return [];
        if (!result || result.success === false) throw new Error('option_lookup_failed');
        var options = PriceAlerts._normalizedStockOptions(result.options);
        stateRef.options = options;
        if (options.length > 1) {
          var selected = options.find(function (option) {
            return option.optionNumber === stateRef.optionNumber;
          });
          if (!selected) selected = options[0];
          PriceAlerts._renderModalOptions(options, selected.optionNumber);
          PriceAlerts._applyModalIdentity(selected);
        } else if (options.length === 1 && stateRef.optionNumber === options[0].optionNumber) {
          PriceAlerts._applyModalIdentity(options[0]);
        }
        PriceAlerts._setOptionLookupPending(stateRef, false);
        return options;
      })
      .catch(function () {
        if (PriceAlerts.modalState === stateRef) {
          PriceAlerts._setOptionLookupPending(stateRef, false);
          PriceAlerts._setModalError(
            stateRef.optionNumber
              ? '옵션 목록을 새로 확인하지 못했습니다. 저장된 옵션 알림은 그대로 수정할 수 있습니다.'
              : '옵션 목록을 확인하지 못해 현재는 상품 대표 가격 알림만 설정할 수 있습니다.'
          );
        }
        return [];
      });
  },

  _setOptionLookupPending: function (stateRef, pending) {
    if (!stateRef || this.modalState !== stateRef) return;
    stateRef.optionLookupPending = pending === true;
    var save = document.getElementById('price-alert-save');
    if (!save || this.loading) return;
    save.disabled = stateRef.optionLookupPending;
    save.textContent = stateRef.optionLookupPending
      ? '옵션 확인 중…'
      : stateRef.existing
        ? '수정 저장'
        : '알림 설정';
  },

  selectModalOption: function (optionNumber) {
    if (!this.modalState) return;
    var selected = (this.modalState.options || []).find(function (option) {
      return option.optionNumber === String(optionNumber || '');
    });
    if (!selected) return;
    this._setModalError('');
    this._applyModalIdentity(selected);
  },

  closeModal: function () {
    if (this.loading) return;
    var modal = document.getElementById('price-alert-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('price-alert-modal-open');
    this.modalState = null;
  },

  _setModalBusy: function (busy) {
    this.loading = !!busy;
    var modal = document.getElementById('price-alert-modal');
    if (!modal) return;
    modal.classList.toggle('busy', this.loading);
    modal.querySelectorAll('button, input').forEach(function (control) {
      control.disabled = PriceAlerts.loading;
    });
    var save = document.getElementById('price-alert-save');
    if (save && this.loading) save.textContent = '저장 중…';
  },

  _setModalError: function (message) {
    var error = document.getElementById('price-alert-error');
    if (error) error.textContent = message || '';
  },

  ensureNotificationPermission: function () {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return Promise.reject(
        new Error('이 브라우저는 Web Push 알림을 지원하지 않습니다. Chrome 또는 Edge 최신 버전을 이용해 주세요.')
      );
    }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      return Promise.reject(new Error('보안 연결(HTTPS)에서만 가격 알림을 설정할 수 있습니다.'));
    }
    if (Notification.permission === 'granted') return Promise.resolve(true);
    if (Notification.permission === 'denied') {
      return Promise.reject(
        new Error('브라우저 알림이 차단되어 있습니다. 주소창의 사이트 설정에서 알림을 허용해 주세요.')
      );
    }
    return Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') {
        throw new Error('가격 알림을 받으려면 브라우저 알림 권한을 허용해 주세요.');
      }
      return true;
    });
  },

  _vapidKeyBytes: function (value) {
    var padding = '='.repeat((4 - (value.length % 4)) % 4);
    var base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    return Uint8Array.from(raw, function (char) {
      return char.charCodeAt(0);
    });
  },

  _serviceWorkerRegistration: function () {
    if (window.PWA && typeof PWA.readyRegistration === 'function') {
      return PWA.readyRegistration();
    }
    return navigator.serviceWorker.ready;
  },

  ensurePushSubscription: async function () {
    if (!this._hasActiveEntitlement()) {
      throw new Error('가격 알림 이용권을 먼저 활성화해 주세요.');
    }
    await this.ensureNotificationPermission();
    var registration = await this._serviceWorkerRegistration();
    var subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      var keyResponse = await fetch(CONFIG.PRICE_ALERT_PUBLIC_KEY_API, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin'
      });
      var keyData = null;
      try {
        keyData = await keyResponse.json();
      } catch (e) {}
      if (!keyResponse.ok || !keyData || !keyData.success || !keyData.publicKey) {
        throw new Error('가격 알림 공개키를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._vapidKeyBytes(keyData.publicKey)
      });
    }
    await this._request(CONFIG.PRICE_ALERT_SUBSCRIPTION_API, {
      method: 'POST',
      body: { subscription: subscription.toJSON() }
    });
    Storage.setPriceAlertSubscribed(true);
    this.syncServiceWorkerAuth();
    return subscription;
  },

  saveFromModal: async function () {
    if (this.loading || !this.modalState) return;
    if (!this._hasActiveEntitlement()) {
      this._renderEntitlement();
      this._setPaywallMessage('가격 알림 이용권을 먼저 활성화해 주세요.', true);
      return;
    }
    if (this.modalState.optionLookupPending) {
      this._setModalError('옵션 목록 확인이 끝날 때까지 잠시만 기다려 주세요.');
      return;
    }
    var input = document.getElementById('price-alert-target-input');
    var targetPrice = this._price(input && input.value);
    if (!targetPrice) {
      this._setModalError('목표가격을 1원 이상 숫자로 입력해 주세요.');
      if (input) input.focus();
      return;
    }
    var state = this.modalState;
    this._setModalError('');
    this._setModalBusy(true);
    try {
      await this.ensurePushSubscription();
      var result = await this._request(CONFIG.PRICE_ALERTS_API, {
        method: 'POST',
        body: {
          goodsNo: state.goodsNo,
          goodsName: state.goodsName,
          imageUrl: state.imageUrl,
          targetPrice: targetPrice,
          optionNumber: state.optionNumber || undefined,
          optionName: state.optionNumber ? state.optionName : undefined,
          legacyItemNumber: state.optionNumber ? state.legacyItemNumber || undefined : undefined,
          currentPrice: state.currentPrice || undefined
        }
      });
      var saved = Object.assign({}, state.existing || {}, result.alert || {}, {
        id: Storage.priceAlertKey(state.goodsNo, state.optionNumber),
        alertId: Storage.priceAlertKey(state.goodsNo, state.optionNumber),
        goodsNo: state.goodsNo,
        goodsName: state.goodsName,
        imageUrl: state.imageUrl,
        optionNumber: state.optionNumber || null,
        optionName: state.optionNumber ? state.optionName : '',
        legacyItemNumber: state.optionNumber ? state.legacyItemNumber || null : null,
        soldOut: state.optionNumber && state.soldOut === true,
        targetPrice: targetPrice,
        displayCurrentPrice: state.currentPrice || 0,
        enabled: true
      });
      Storage.upsertPriceAlert(saved);
      this._setModalBusy(false);
      this.closeModal();
      this._refreshAfterChange();
      UI.showSyncStatus(
        '가격 알림을 저장했습니다. 60분마다 상승·하락과 목표가 도달을 확인합니다.',
        false,
        5500
      );
    } catch (error) {
      this._setModalBusy(false);
      this._setModalError(error && error.message ? error.message : '가격 알림을 저장하지 못했습니다.');
      var save = document.getElementById('price-alert-save');
      if (save) save.textContent = state.existing ? '수정 저장' : '알림 설정';
    }
  },

  disableFromModal: async function () {
    if (this.loading || !this.modalState) return;
    var state = this.modalState;
    this._setModalError('');
    this._setModalBusy(true);
    try {
      await this._request(
        CONFIG.PRICE_ALERTS_API +
          '?goodsNo=' +
          encodeURIComponent(state.goodsNo) +
          (state.optionNumber
            ? '&optionNumber=' + encodeURIComponent(state.optionNumber)
            : ''),
        { method: 'DELETE' }
      );
      Storage.removePriceAlert(state.goodsNo, state.optionNumber);
      this._setModalBusy(false);
      this.closeModal();
      this._refreshAfterChange();
      UI.showSyncStatus('가격 알림을 껐습니다', false);
    } catch (error) {
      this._setModalBusy(false);
      this._setModalError(error && error.message ? error.message : '가격 알림을 끄지 못했습니다.');
      var save = document.getElementById('price-alert-save');
      if (save) save.textContent = '수정 저장';
    }
  },

  refreshFromServer: function (opts) {
    opts = opts || {};
    var self = this;
    return this._request(CONFIG.PRICE_ALERTS_API)
      .then(function (result) {
        Storage.replacePriceAlerts(result.alerts || []);
        Storage.setPriceAlertSubscribed(result.subscribed === true);
        self._refreshAfterChange();
        if (!opts.silent) UI.showSyncStatus('가격 알림 목록을 새로고침했습니다', false);
        return result;
      })
      .catch(function (error) {
        if (!opts.silent) {
          UI.showSyncStatus(error.message || '가격 알림 목록을 불러오지 못했습니다', true, 4500);
        }
        return null;
      });
  },

  refreshControls: function () {
    document.querySelectorAll('.price-alert-toggle').forEach(function (button) {
      var alerts = Storage.getPriceAlertsForGoods(button.dataset.goodsno || '').filter(function (item) {
        return item && item.enabled !== false;
      });
      var alert = alerts[0] || null;
      var enabled = alerts.length > 0;
      button.classList.toggle('active', enabled);
      button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      var target = button.querySelector('.price-alert-toggle-target');
      if (target) {
        target.textContent =
          alerts.length > 1
            ? alerts.length + '개 ON'
            : enabled && PriceAlerts._price(alert.targetPrice)
            ? '목표 ' + UI.num(PriceAlerts._price(alert.targetPrice)) + '원'
            : '설정';
      }
      var state = button.querySelector('.price-alert-toggle-state');
      if (state) state.textContent = enabled ? 'ON' : 'OFF';
    });
  },

  _refreshAfterChange: function () {
    if (
      this.app &&
      this.app.currentTab === 'favorites' &&
      typeof this.app._renderFavorites === 'function'
    ) {
      this.app._renderFavorites();
      return;
    }
    this.refreshControls();
  },

  syncServiceWorkerAuth: function () {
    if (!('serviceWorker' in navigator)) return;
    var device = Storage.getPriceAlertDevice();
    this._serviceWorkerRegistration()
      .then(function (registration) {
        var worker = navigator.serviceWorker.controller || registration.active;
        if (worker) {
          worker.postMessage({
            type: 'PRICE_ALERT_DEVICE_AUTH',
            deviceId: device.deviceId,
            deviceSecret: device.deviceSecret
          });
        }
      })
      .catch(function () {});
  },

  _bindServiceWorkerMessages: function () {
    if (!('serviceWorker' in navigator) || this._messageBound) return;
    this._messageBound = true;
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type === 'PRICE_ALERT_DISABLED' && data.goodsNo) {
        Storage.removePriceAlert(data.goodsNo, data.optionNumber || '');
        PriceAlerts._refreshAfterChange();
        UI.showSyncStatus('알림창에서 가격 알림을 껐습니다', false);
      } else if (data.type === 'PRICE_ALERT_DISABLE_FAILED') {
        UI.showSyncStatus('가격 알림을 끄지 못했습니다. 사이트에서 다시 시도해 주세요.', true, 5000);
      }
    });
  }
};
