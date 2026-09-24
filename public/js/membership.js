var Membership = {
  account: null,
  state: null,
  busy: false,
  visitShown: false,

  init: function () {
    this.mount();
    this.refresh();
    this.trackVisit();
    window.addEventListener('focus', function () {
      PriceAlerts.refreshEntitlement({ silent: true });
      Membership.trackVisit();
    });
    window.addEventListener('storage', function (event) {
      if (event.key === Storage._key('price_alert_device_v1')) {
        PriceAlerts.invalidateDeviceSession();
        PriceAlerts.syncServiceWorkerAuth();
        PriceAlerts.refreshEntitlement({ silent: true });
        Membership.refresh();
      }
    });
  },

  trackVisit: function () {
    if (!(this.account && this.account.verified) && !PriceAlerts._hasActiveEntitlement()) return;
    var now = Date.now();
    if (this._lastVisitCheck && now - this._lastVisitCheck < 60000) return;
    this._lastVisitCheck = now;
    var visit;
    var key = Storage._key('membership_visit_v1');
    try {
      visit = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (!visit || !/^[A-Za-z0-9_-]{20,80}$/.test(visit.id || '') || now - Number(visit.lastSeenAt) > 1800000) {
        visit = { id: Storage._randomBase64Url(24) };
      }
      visit.lastSeenAt = now;
      sessionStorage.setItem(key, JSON.stringify(visit));
    } catch (_) { return; }
    PriceAlerts._request('/api/price-alerts/account', {
      method: 'POST', body: { action: 'record-visit', visitId: visit.id }
    }).catch(function () {});
  },

  mount: function () {
    if (document.getElementById('membership-account')) return;
    var paywall = document.getElementById('price-alert-paywall');
    if (!paywall) return;
    var section = document.createElement('section');
    section.id = 'membership-account';
    section.className = 'price-alert-account';
    section.setAttribute('aria-label', '이용권 이메일과 복구');
    section.innerHTML = '<h4>이용권 이메일 · 한 브라우저 전용</h4>' +
      '<p id="membership-email-status" role="status">이메일 등록 상태 확인 중…</p>' +
      '<div id="membership-enroll"><label for="membership-email">결제 및 이용권 복구 이메일</label>' +
      '<div class="membership-row"><input id="membership-email" type="email" autocomplete="email" maxlength="254" placeholder="이메일 주소"><button type="button" id="membership-email-send">인증 키 받기</button></div>' +
      '<label for="membership-email-code">메일로 받은 인증 키</label><div class="membership-row"><input id="membership-email-code" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="80" placeholder="메일의 인증 키 입력"><button type="button" id="membership-email-verify">이메일 인증</button></div>' +
      '<p>결제 전에 이메일을 인증해 주세요. 이메일은 이용권 확인과 복구 안내에만 사용합니다.</p></div>' +
      '<details id="membership-recovery"><summary>다른 브라우저에서 이용권 복구 / 키를 잊었어요</summary>' +
      '<p>등록한 이메일로 일회용 복구 키를 보내드립니다. 복구하면 이 브라우저만 사용할 수 있으며 이전 브라우저는 즉시 권한이 해제됩니다.</p>' +
      '<label for="membership-recovery-email">등록한 이메일</label><div class="membership-row"><input id="membership-recovery-email" type="email" autocomplete="email" maxlength="254"><button type="button" id="membership-recovery-send">복구 키 받기</button></div>' +
      '<label for="membership-recovery-code">메일로 받은 복구 키</label><input id="membership-recovery-code" type="password" autocomplete="off" maxlength="80" placeholder="15분 내 사용 · 한 번만 사용 가능">' +
      '<label class="membership-transfer"><input id="membership-transfer-confirm" type="checkbox"> 기존 브라우저 사용을 해제하고 이 브라우저로 옮깁니다.</label>' +
      '<button type="button" id="membership-recover">이 브라우저로 복구</button></details>' +
      '<p id="membership-message" role="status" aria-live="polite"></p>';
    paywall.parentNode.insertBefore(section, paywall);
    var actions = {
      'membership-email-send': 'request-verification',
      'membership-email-verify': 'verify-email',
      'membership-recovery-send': 'request-recovery',
      'membership-recover': 'recover'
    };
    Object.keys(actions).forEach(function (id) {
      document.getElementById(id).addEventListener('click', function () { Membership.submit(actions[id]); });
    });
  },

  message: function (text, error) {
    var node = document.getElementById('membership-message');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('error', !!error);
  },

  refresh: async function () {
    this.recoveryAfterRevocation = false;
    this._refreshError = null;
    var identityVersion = PriceAlerts._deviceVersion || 0;
    try {
      var state = await PriceAlerts._request('/api/price-alerts/account');
      if (identityVersion !== (PriceAlerts._deviceVersion || 0)) return this.state;
      this.state = state;
      this.account = this.state.account || { verified: false };
    } catch (error) {
      if (identityVersion !== (PriceAlerts._deviceVersion || 0)) return this.state;
      this.state = null;
      this.account = null;
      this._refreshError = error;
      this.recoveryAfterRevocation = !!(error && error.status === 401);
    }
    this.render();
    if (this.account && this.account.verified) this.trackVisit();
    return this.state;
  },

  render: function () {
    var section = document.getElementById('membership-account');
    if (!section) return;
    var disabledFeature = this.state && this.state.recoveryEnabled === false;
    section.classList.toggle('hidden', !!disabledFeature);
    var verified = !!(this.account && this.account.verified);
    document.getElementById('membership-enroll').hidden = verified;
    document.getElementById('membership-email-status').textContent = verified
      ? '인증된 이메일: ' + this.account.email
      : this.recoveryAfterRevocation ? '다른 브라우저로 이용권이 이전되었습니다. 아래 이메일 복구로 다시 옮길 수 있습니다.'
        : !this.state ? '이메일 서비스를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'
        : this.state.available ? '이메일 인증 후 결제할 수 있습니다.' : '이메일 복구 서비스 준비 중입니다. 결제는 아직 시작할 수 없습니다.';
    var unavailable = !this.state || !this.state.available;
    section.querySelectorAll('button').forEach(function (button) {
      var recovery = button.id === 'membership-recovery-send' || button.id === 'membership-recover';
      button.disabled = Membership.busy || PriceAlerts.paymentBusy || (unavailable && !(recovery && Membership.recoveryAfterRevocation));
    });
  },

  requireVerifiedEmail: async function () {
    var state = await this.refresh();
    if (state && state.recoveryEnabled === false) return true;
    if (state && state.available && this.account && this.account.verified) return true;
    if (!state && this._refreshError) {
      if (this._refreshError.status === 429) PriceAlerts._setPaymentCooldown(this._refreshError);
      this.message(this.errorMessage(this._refreshError.code, this._refreshError), true);
      return false;
    }
    if (state && !state.available) {
      this.message('이메일 서비스를 확인할 수 없어 결제를 시작하지 않았습니다. 잠시 후 다시 확인해 주세요.', true);
      return false;
    }
    this.message('결제 전에 이메일 인증을 완료해 주세요. 복구 키를 받을 주소입니다.', true);
    var email = document.getElementById('membership-email');
    if (email) { email.scrollIntoView({ block: 'center' }); email.focus(); }
    return false;
  },

  errorMessage: function (code, error) {
    if ((error && error.status === 429) || code === 'rate_limited' || code === 'rate_limit_exceeded') {
      var seconds = Math.max(1, Math.min(86400, Number(error && error.retryAfter) || 60));
      return '요청이 많습니다. 약 ' + (seconds >= 60 ? Math.ceil(seconds / 60) + '분' : Math.ceil(seconds) + '초') +
        ' 후에 다시 시도해 주세요.';
    }
    var messages = {
      invalid_email: '올바른 이메일 주소를 입력해 주세요.',
      account_code_invalid: '키가 올바르지 않거나 만료되었습니다. 새 키를 받아 주세요.',
      account_code_expired: '키가 만료되었습니다. 새 키를 받아 주세요.',
      email_verification_required: '먼저 이메일을 인증해 주세요.',
      account_already_registered: '이미 등록된 주소입니다. 아래 이용권 복구를 이용해 주세요.',
      account_recovery_unavailable: '이메일 발송 서비스가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',
      account_email_conflict: '등록된 이메일은 변경할 수 없습니다. 관리자에게 문의해 주세요.',
      account_email_locked: '등록된 이메일은 변경할 수 없습니다. 관리자에게 문의해 주세요.',
      account_mail_not_configured: '이메일 복구 서비스 준비 중입니다. 잠시 후 다시 시도해 주세요.',
      account_mail_unavailable: '메일 전송에 실패했습니다. 잠시 후 다시 요청해 주세요.',
      account_recovery_disabled: '이메일 복구 기능 준비 중입니다.',
      device_auth_failed: '다른 브라우저로 이전되었거나 인증이 만료되었습니다. 아래 이메일 복구를 이용해 주세요.',
      credential_storage_failed: '복구한 인증정보를 저장하지 못했습니다. 브라우저 저장공간 설정을 확인해 주세요.'
    };
    return messages[code] || '요청을 처리하지 못했습니다. 키와 이메일을 확인하거나 잠시 후 다시 시도해 주세요.';
  },

  submit: async function (action) {
    if (this.busy || PriceAlerts.paymentBusy) return;
    if (!PriceAlerts._ensurePaymentSite()) return;
    var recovering = action === 'request-recovery' || action === 'recover';
    var email = document.getElementById(recovering ? 'membership-recovery-email' : 'membership-email');
    if (!email.value.trim() || !email.checkValidity()) {
      this.message('올바른 이메일 주소를 입력해 주세요.', true); email.focus(); return;
    }
    if (action === 'recover' && !document.getElementById('membership-transfer-confirm').checked) {
      this.message('기존 브라우저 사용 해제에 동의해 주세요.', true); return;
    }
    var body = { action: action, email: email.value.trim() };
    var input;
    if (action === 'verify-email' || action === 'recover') {
      input = document.getElementById(recovering ? 'membership-recovery-code' : 'membership-email-code');
      body.code = input.value.trim();
      if (!body.code) { this.message('메일로 받은 키를 입력해 주세요.', true); input.focus(); return; }
    }
    this.busy = true;
    this.message('처리 중…', false);
    this.render();
    try {
      var result = await PriceAlerts._request('/api/price-alerts/account', { method: 'POST', body: body });
      if (input) input.value = '';
      if (result.credentials) {
        if (!Storage.setPriceAlertDevice(result.credentials)) throw new Error('credential_storage_failed');
        PriceAlerts.invalidateDeviceSession();
        Storage.clearPriceAlertPaymentAttempt();
        Storage.replacePriceAlerts([]);
        PriceAlerts.syncServiceWorkerAuth();
        document.getElementById('membership-transfer-confirm').checked = false;
        document.getElementById('membership-recovery').open = false;
      }
      if (result.account) this.account = result.account;
      if (result.sent) {
        this.message(recovering
          ? '등록된 주소라면 복구 키를 보냈습니다. 메일함과 스팸함을 확인해 주세요. 15분 이내에 입력해 주세요.'
          : '인증 안내를 보냈습니다. 메일함과 스팸함을 확인해 주세요. 15분 이내에 키를 입력해 주세요.', false);
      } else {
        await this.refresh();
        await PriceAlerts.refreshEntitlement({ silent: true });
        await PriceAlerts.refreshFromServer({ silent: true });
        this._lastVisitCheck = 0;
        this.trackVisit();
        this.message(recovering ? '이 브라우저로 복구했습니다. 이전 브라우저는 더 이상 사용할 수 없습니다. 가격 알림은 이 브라우저에서 알림 허용을 다시 설정해 주세요.' : '이메일 인증을 완료했습니다. 이제 결제할 수 있습니다.', false);
      }
    } catch (error) {
      if (input) input.value = '';
      this.message(this.errorMessage(error && (error.code || error.message), error), true);
    } finally {
      body.code = '';
      this.busy = false;
      this.render();
    }
  },

  onEntitlement: function () {
    this.render();
    this.trackVisit();
    if (this.visitShown || !PriceAlerts._hasActiveEntitlement()) return;
    this.visitShown = true;
    if (PriceAlerts.modalState || /priceAlertPayment=/.test(window.location.search)) return;
    var days = Math.max(0, Math.ceil((Date.parse(PriceAlerts.entitlement.expiresAt) - Date.now()) / 86400000));
    PriceAlerts.openMembership();
    var title = document.getElementById('price-alert-title');
    title.textContent = PriceAlerts.entitlement.lifetime ? '평생 이용권 사용 중입니다' : '유료 이용기간 ' + days + '일 남았어요';
  }
};
