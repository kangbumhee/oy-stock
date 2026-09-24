(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const API = '/api/price-alerts/admin';
  let credential = '';
  let generation = 0;
  let nextCursor = null;
  let displayedRecords = [];
  let selected = null;
  let pendingAction = null;
  let extending = false;
  let changingPromotion = false;
  let pendingPromotionAction = null;
  const messages = {
    admin_not_configured: '관리자 Google 로그인이 아직 설정되지 않았습니다.',
    admin_auth_required: 'Google 로그인을 해 주세요.',
    admin_auth_failed: '로그인이 만료되었거나 확인되지 않았습니다. 다시 로그인해 주세요.',
    admin_access_denied: '이 Google 계정에는 관리자 권한이 없습니다.',
    active_device_capacity_reached: '현재 이용권 활성화 한도에 도달했습니다.',
    device_not_found: '해당 기기를 찾을 수 없습니다.',
    invalid_device_id: '기기 ID를 확인해 주세요.',
    admin_action_conflict: '이전 연장 요청과 내용이 다릅니다. 회원을 다시 선택해 주세요.',
    entitlement_not_configured: '유료 이용권 기능이 아직 활성화되지 않았습니다.',
    invalid_promotion_update: '새 키와 변경 사유의 길이를 확인해 주세요.',
    promotion_settings_unavailable: '무료 이용 키 설정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'
  };

  function status(message, error = false) {
    byId('status').textContent = message;
    byId('status').classList.toggle('error', error);
  }

  function clearLogin() {
    credential = '';
    generation += 1;
    selected = null;
    pendingAction = null;
    nextCursor = null;
    displayedRecords = [];
    pendingPromotionAction = null;
    byId('promotion-code').value = '';
    byId('promotion-reason').value = '';
    byId('promotion-audit').replaceChildren();
    byId('admin-panel').hidden = true;
    byId('detail-panel').hidden = true;
    byId('members').replaceChildren();
    byId('audit-list').replaceChildren();
    byId('login-panel').hidden = false;
  }

  async function api(query = '', body) {
    const response = await fetch(API + query, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
      headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json();
    if (!response.ok || payload.success !== true) {
      if ([401, 403].includes(response.status) && /^admin_/.test(payload.error || '')) clearLogin();
      throw new Error(messages[payload.error] || '요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return payload;
  }

  function date(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '—';
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function planLabel(record) {
    return record.entitlement.lifetime ? '평생 이용' : record.entitlement.active ? '이용 중' : '만료 / 미이용';
  }

  function renderRows(records) {
    const fragment = document.createDocumentFragment();
    records.forEach((record) => {
      const row = document.createElement('tr');
      const account = document.createElement('td');
      account.className = 'account';
      account.dataset.label = '회원 / 기기';
      account.textContent = record.email || record.deviceId;
      account.title = record.email || record.deviceId;
      const state = document.createElement('td');
      state.dataset.label = '이용권';
      const pill = document.createElement('span');
      pill.className = `pill${record.entitlement.active ? '' : ' expired'}`;
      const sourceLabels = { payment: '유료', promotion: '무료', admin: '관리자 연장' };
      const origins = (record.sources || []).map((source) => sourceLabels[source]).filter(Boolean).join(' · ');
      pill.textContent = `${planLabel(record)}${origins ? ` (${origins})` : ''}`;
      state.append(pill);
      const expiry = document.createElement('td');
      expiry.dataset.label = '만료일';
      expiry.textContent = record.entitlement.lifetime ? '기간 제한 없음' : date(record.entitlement.expiresAt);
      const alerts = document.createElement('td');
      alerts.dataset.label = '알림';
      alerts.textContent = `${record.activeAlertCount}개 / ${record.pushActive ? '수신 켜짐' : '수신 꺼짐'}`;
      const manage = document.createElement('td');
      manage.dataset.label = '관리';
      const lastSeen = document.createElement('td');
      lastSeen.dataset.label = '마지막 접속'; lastSeen.textContent = date(record.lastSeenAt);
      const visits = document.createElement('td');
      visits.dataset.label = '접속 횟수'; visits.textContent = `${Number(record.visitCount) || 0}회`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '상세 / 연장';
      button.addEventListener('click', () => { if (!extending) showDetail(record); });
      manage.append(button);
      row.append(account, state, expiry, alerts, lastSeen, visits, manage);
      fragment.append(row);
    });
    if (!records.length) {
      const row = document.createElement('tr');
      const empty = document.createElement('td');
      empty.colSpan = 7; empty.className = 'empty'; empty.textContent = '이 페이지에 표시할 회원이 없습니다.';
      row.append(empty); fragment.append(row);
    }
    byId('members').replaceChildren(fragment);
  }

  function showDetail(record) {
    selected = record;
    pendingAction = null;
    byId('detail-account').textContent = record.email || '이메일 미연결 기기';
    byId('detail-id').textContent = `기기 ID: ${record.deviceId}`;
    byId('detail-plan').textContent = `${planLabel(record)} · 만료일: ${record.entitlement.lifetime ? '기간 제한 없음' : date(record.entitlement.expiresAt)}`;
    byId('extension-reason').value = '';
    byId('extend-button').disabled = record.entitlement.lifetime;
    const fragment = document.createDocumentFragment();
    (record.audit || []).forEach((item) => {
      const entry = document.createElement('div'); entry.className = 'audit';
      const summary = document.createElement('p'); summary.textContent = `+${item.durationDays}일 · ${item.reason}`;
      const time = document.createElement('p'); time.className = 'muted'; time.textContent = `${date(item.grantedAt)} · ${item.actorEmail}`;
      entry.append(summary, time); fragment.append(entry);
    });
    if (!fragment.childNodes.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '수동 연장 기록이 없습니다.'; fragment.append(empty);
    }
    byId('audit-list').replaceChildren(fragment);
    byId('detail-panel').hidden = false;
  }

  async function loadPage(cursor = null) {
    const current = generation;
    byId('refresh').disabled = true;
    byId('next-page').disabled = true;
    status('회원 이용 현황을 불러오고 있습니다.');
    try {
      const result = await api(`?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (current !== generation || !credential) return;
      nextCursor = result.nextCursor;
      displayedRecords = result.records;
      renderRows(result.records);
      byId('admin-identity').textContent = result.administrator;
      byId('page-summary').textContent = `이번 페이지 ${result.records.length}명${result.unreadableCount ? ` · 확인하지 못한 항목 ${result.unreadableCount}개` : ''}`;
      byId('admin-panel').hidden = false;
      byId('login-panel').hidden = true;
      status('회원의 이용권과 알림 상태를 확인할 수 있습니다.');
    } catch (error) { status(error.message, true); }
    finally { byId('refresh').disabled = false; byId('next-page').disabled = !nextCursor; }
  }

  function showPromotionSettings(settings) {
    byId('promotion-state').textContent = settings.configured
      ? `무료 이용 키 사용 중${settings.updatedAt ? ` · 마지막 변경 ${date(settings.updatedAt)}` : ''}`
      : '등록된 무료 이용 키가 없습니다.';
    const fragment = document.createDocumentFragment();
    (settings.audit || []).forEach((entry) => {
      const line = document.createElement('p'); line.className = 'muted';
      line.textContent = `${date(entry.changedAt)} · ${entry.actorEmail} 변경`;
      fragment.append(line);
    });
    byId('promotion-audit').replaceChildren(fragment);
  }

  async function loadPromotionSettings() {
    const current = generation;
    try {
      const result = await api('?action=promotion-settings');
      if (current === generation && credential) showPromotionSettings(result.settings);
    } catch (error) { byId('promotion-state').textContent = error.message; }
  }

  byId('refresh').addEventListener('click', () => loadPage());
  byId('first-page').addEventListener('click', () => loadPage());
  byId('next-page').addEventListener('click', () => loadPage(nextCursor));
  byId('logout').addEventListener('click', () => {
    clearLogin();
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    status('로그아웃했습니다.');
  });
  byId('lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (extending) return;
    const current = generation;
    try {
      const result = await api(`?deviceId=${encodeURIComponent(byId('lookup-id').value.trim())}`);
      if (current === generation && credential) { showDetail(result.record); status('회원 정보를 확인했습니다.'); }
    } catch (error) { status(error.message, true); }
  });
  byId('extend-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selected || extending || selected.entitlement.lifetime || !event.target.reportValidity()) return;
    const command = { action: 'extend', deviceId: selected.deviceId, durationDays: Number(byId('extension-days').value), reason: byId('extension-reason').value.trim() };
    const fingerprint = JSON.stringify(command);
    if (!pendingAction || pendingAction.fingerprint !== fingerprint) pendingAction = { fingerprint, actionId: crypto.randomUUID() };
    const current = generation;
    extending = true;
    byId('extend-button').disabled = true;
    status('이용기간을 추가하고 있습니다.');
    try {
      const result = await api('', { ...command, actionId: pendingAction.actionId });
      if (current !== generation || !credential) return;
      showDetail(result.record);
      displayedRecords = displayedRecords.map((record) => record.deviceId === result.record.deviceId ? result.record : record);
      renderRows(displayedRecords);
      status(`${result.idempotent ? '이미 반영된 연장을 확인했습니다.' : `${command.durationDays}일을 추가했습니다.`} 만료일: ${date(result.record.entitlement.expiresAt)}`);
    } catch (error) { status(error.message, true); }
    finally { extending = false; byId('extend-button').disabled = Boolean(selected && selected.entitlement.lifetime); }
  });

  byId('promotion-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!credential || changingPromotion || !event.target.reportValidity()) return;
    const command = { action: 'set-promotion', code: byId('promotion-code').value, reason: byId('promotion-reason').value.trim() };
    const fingerprint = JSON.stringify(command);
    if (!pendingPromotionAction || pendingPromotionAction.fingerprint !== fingerprint) pendingPromotionAction = { fingerprint, actionId: crypto.randomUUID() };
    const current = generation;
    changingPromotion = true; byId('promotion-button').disabled = true;
    status('무료 이용 키를 변경하고 있습니다.');
    try {
      const result = await api('', { ...command, actionId: pendingPromotionAction.actionId });
      if (current !== generation || !credential) return;
      showPromotionSettings(result.settings);
      byId('promotion-code').value = ''; byId('promotion-reason').value = '';
      pendingPromotionAction = null;
      status('무료 이용 키를 변경했습니다. 기존 무료 이용권은 유지됩니다.');
    } catch (error) { status(error.message, true); }
    finally { changingPromotion = false; byId('promotion-button').disabled = false; }
  });

  async function initialize() {
    try {
      const config = await api('?action=config');
      if (!config.clientId) { status(messages.admin_not_configured, true); return; }
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
        script.onload = resolve; script.onerror = () => reject(new Error('Google 로그인 화면을 불러오지 못했습니다.'));
        document.head.append(script);
      });
      google.accounts.id.initialize({
        client_id: config.clientId, auto_select: false,
        callback: (response) => {
          clearLogin();
          credential = typeof response.credential === 'string' ? response.credential : '';
          if (credential) { loadPage(); loadPromotionSettings(); }
          else status('Google 로그인을 다시 시도해 주세요.', true);
        }
      });
      google.accounts.id.renderButton(byId('google-signin'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ko' });
      status('Google 계정으로 로그인해 주세요.');
    } catch (error) { status(error.message, true); }
  }
  initialize();
})();
