const crypto = require('node:crypto');
const net = require('node:net');
const nodemailer = require('nodemailer');
const { BlobPreconditionFailedError, get, put, del, list } = require('@vercel/blob');
const { configuredDataKey, encryptJson, decryptJson } = require('./_crypto');
const { configuredStoreRoot } = require('./_registry');
const { configuredAccountMail } = require('./_account-mail');
const { PASS_AMOUNT_KRW, PASS_ORDER_NAME, normalizePaymentId } = require('./_entitlement');

const OWNER_EMAIL = 'kbhjjan@gmail.com';
const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60 * 1000;
const RETRY_MS = [60000, 5 * 60000, 30 * 60000, 2 * 3600000];
const MAX_SENDS = 20;
const MAX_SCAN = 1000;
const RUN_BUDGET_MS = 45000;
const STRONG_ETAG = /^"[\x21\x23-\x7e]*"$/;
const DIGEST = /^[a-f0-9]{64}$/;

function clock(dependencies) {
  return dependencies.clock ? Number(dependencies.clock()) : Date.now();
}

function runScope(dependencies) {
  const controller = new AbortController();
  const budget = Math.max(1, Math.min(RUN_BUDGET_MS, Number(dependencies.budgetMs) || RUN_BUDGET_MS));
  const timer = setTimeout(() => controller.abort(), budget);
  return {
    dependencies: { ...dependencies, _deadline: clock(dependencies) + budget,
      _signal: controller.signal, _abort: () => controller.abort() },
    close: () => { clearTimeout(timer); controller.abort(); }
  };
}

function assertBudget(dependencies) {
  if (dependencies._signal.aborted || clock(dependencies) >= dependencies._deadline) {
    dependencies._abort();
    throw new Error('owner_mail_budget_exhausted');
  }
}

function configuration(dependencies) {
  const env = dependencies.env || process.env;
  const rawStart = String(env.PRICE_ALERT_PAYMENT_OWNER_MAIL_START_AT || '').trim();
  const startAt = Date.parse(rawStart);
  if (String(env.PRICE_ALERT_PAYMENT_OWNER_MAIL_ENABLED || '').trim().toLowerCase() !== 'true' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(rawStart) ||
      !Number.isFinite(startAt)) return null;
  return { startAt };
}

function dataKey(dependencies) {
  return dependencies.dataKey || configuredDataKey();
}

function eventDigest(eventKey, dependencies) {
  return crypto.createHmac('sha256', dataKey(dependencies))
    .update('owner-payment-mail:v1:').update(eventKey).digest('hex');
}

function rootPath() {
  return `${configuredStoreRoot()}owner-payment-mail/`;
}

function recordPath(kind, id) {
  if (!['pending', 'receipts'].includes(kind) || !DIGEST.test(id)) throw new Error('invalid mail record');
  return `${rootPath()}${kind}/${id}.enc`;
}

function verifiedCustomerEmail(record, intent) {
  const account = record && record.account;
  const email = String(account && account.email || '').trim().toLowerCase();
  return record && record.deviceId === intent.ownerDeviceId && account && account.indexLinked === true &&
    Number.isFinite(Date.parse(account.verifiedAt || '')) && email.length <= 254 &&
    /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/.test(email)
    ? email : null;
}

// Only normalized, authoritative GET data and the LAST committed intent belong here.
// Webhook/client event names, recipient addresses and amounts are never inputs.
function buildEvent({ payment, intent, decision, ownerRecord, now }, config, dependencies) {
  if (!payment || !intent || !decision || !normalizePaymentId(intent.paymentId) ||
      payment.paymentId !== intent.paymentId || !intent.ownerDeviceId) return null;
  const contract = intent.contract || {};
  if (contract.amount !== PASS_AMOUNT_KRW || contract.currency !== 'KRW' ||
      contract.orderName !== PASS_ORDER_NAME || contract.channelType !== 'LIVE' ||
      contract.payMethod !== 'EASY_PAY' || contract.easyPayProvider !== 'KAKAOPAY' ||
      !/^store-[A-Za-z0-9_-]{6,120}$/.test(String(contract.storeId || '')) ||
      !/^channel-key-[A-Za-z0-9_-]{6,160}$/.test(String(contract.channelKey || ''))) return null;
  for (const key of ['amount', 'currency', 'storeId', 'channelKey', 'channelType', 'payMethod', 'easyPayProvider']) {
    if (payment[key] !== contract[key]) return null;
  }
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : clock(dependencies);
  const createdAt = Date.parse(intent.createdAt || '');
  const expiresAt = Date.parse(intent.expiresAt || '');
  let type;
  let occurredAt;
  if (payment.status === 'PAID' && decision.action === 'paid' && decision.reason === 'verified_paid' &&
      intent.status === 'paid' && intent.decisionReason === 'verified_paid' && payment.cancelledAmount === 0) {
    type = 'paid';
    occurredAt = Date.parse(payment.paidAt || '');
    if (!Number.isFinite(expiresAt) || occurredAt > expiresAt) return null;
  } else if (payment.status === 'CANCELLED' && decision.action === 'cancelled' &&
      decision.reason === 'verified_full_cancellation' && intent.status === 'cancelled' &&
      intent.decisionReason === 'verified_full_cancellation' && payment.cancelledAmount === PASS_AMOUNT_KRW) {
    type = 'cancelled';
    occurredAt = Date.parse(payment.cancelledAt || '');
  } else if (payment.status === 'PARTIAL_CANCELLED' && decision.action === 'review_required' &&
      decision.reason === 'partial_cancellation' && decision.suspendGrant === true &&
      intent.status === 'review_required' && intent.decisionReason === 'partial_cancellation' &&
      Number.isInteger(payment.cancelledAmount) && payment.cancelledAmount > 0 &&
      payment.cancelledAmount < PASS_AMOUNT_KRW) {
    type = 'partial_cancelled';
    occurredAt = Date.parse(payment.cancelledAt || '');
  } else return null;
  if (!Number.isFinite(timestamp) || !Number.isFinite(createdAt) || !Number.isFinite(occurredAt) ||
      occurredAt < createdAt || occurredAt < config.startAt || occurredAt > timestamp) return null;
  const eventKey = `${intent.paymentId}:${type === 'paid' ? 'paid' : `cancelled:${payment.cancelledAmount}`}`;
  return {
    id: eventDigest(eventKey, dependencies), eventKey, type, paymentId: intent.paymentId,
    productName: PASS_ORDER_NAME, amount: PASS_AMOUNT_KRW, currency: 'KRW',
    cancelledAmount: payment.cancelledAmount, occurredAt: new Date(occurredAt).toISOString(),
    customerEmail: verifiedCustomerEmail(ownerRecord, intent)
  };
}

function conflict(error) {
  return error instanceof BlobPreconditionFailedError ||
    [409, 412].includes(Number(error && (error.status || error.statusCode))) ||
    (error && error.name === 'BlobPreconditionFailedError');
}

async function readRecord(kind, id, dependencies) {
  assertBudget(dependencies);
  const result = await (dependencies.get || get)(recordPath(kind, id), {
    access: 'private', useCache: false, abortSignal: dependencies._signal,
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', 'Accept-Encoding': 'identity' }
  });
  if (!result) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of result.stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32768) throw new Error('invalid mail record');
    chunks.push(buffer);
  }
  const body = decryptJson(Buffer.concat(chunks).toString('utf8'), dataKey(dependencies));
  const etag = String(result.blob && result.blob.etag || '');
  if (!body || body.version !== 1 || body.id !== id || !STRONG_ETAG.test(etag)) {
    throw new Error('invalid mail record');
  }
  if (kind === 'receipts') {
    if (!['sent', 'failed'].includes(body.state)) throw new Error('invalid mail receipt');
  } else if (!body.event || body.event.id !== id ||
      eventDigest(body.event.eventKey, dependencies) !== id ||
      !['queued', 'sending', 'sent', 'failed'].includes(body.state) ||
      !Number.isInteger(body.attempts) || body.attempts < 0 || body.attempts > MAX_ATTEMPTS) {
    throw new Error('invalid pending mail');
  }
  return { body, etag };
}

async function writeRecord(kind, body, etag, dependencies) {
  assertBudget(dependencies);
  return (dependencies.put || put)(recordPath(kind, body.id), encryptJson(body, dataKey(dependencies)), {
    access: 'private', addRandomSuffix: false, allowOverwrite: Boolean(etag), abortSignal: dependencies._signal,
    ...(etag ? { ifMatch: etag } : {}), contentType: 'application/octet-stream', cacheControlMaxAge: 60
  });
}

async function deletePending(id, dependencies) {
  assertBudget(dependencies);
  return (dependencies.del || del)(recordPath('pending', id), { abortSignal: dependencies._signal });
}

async function finishTerminal(pending, dependencies) {
  const id = pending.body.id;
  let receipt = await readRecord('receipts', id, dependencies);
  if (!receipt) {
    try {
      await writeRecord('receipts', {
        version: 1, id, state: pending.body.state,
        completedAt: pending.body.completedAt || new Date(clock(dependencies)).toISOString()
      }, '', dependencies);
    } catch (error) {
      if (!conflict(error)) throw error;
      receipt = await readRecord('receipts', id, dependencies);
      if (!receipt) throw new Error('mail receipt unavailable');
    }
  }
  // A receipt is permanent. Even a racing recreated pending record cannot resend.
  await deletePending(id, dependencies);
  return { state: receipt ? receipt.body.state : pending.body.state, attempted: false };
}

function emailMessage(event) {
  const label = { paid: '결제 승인', cancelled: '전액 취소', partial_cancelled: '부분 취소' }[event.type];
  const money = (amount) => Number(amount).toLocaleString('ko-KR') + '원';
  return {
    messageId: `<owner-payment-${event.id}@olivestock.co.kr>`,
    subject: `[올리브재고] ${label} · ${money(event.type === 'paid' ? event.amount : event.cancelledAmount)}`,
    text: [
      `올리브재고 이용권 ${label} 알림입니다.`,
      `상품: ${event.productName}`, `결제번호: ${event.paymentId}`,
      `결제금액: ${money(event.amount)}`,
      ...(event.type === 'paid' ? [] : [`누적 취소금액: ${money(event.cancelledAmount)}`, `남은 결제금액: ${money(event.amount - event.cancelledAmount)}`]),
      `확인된 거래 시각: ${new Date(event.occurredAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} (한국시간)`,
      ...(event.customerEmail ? [`인증된 고객 이메일: ${event.customerEmail}`] : []),
      '', 'PortOne 서버 조회로 확인한 거래입니다.',
      ...(event.type === 'partial_cancelled' ? ['부분 취소로 이용권이 중지되었으며 운영 확인이 필요합니다.'] : [])
    ].join('\n')
  };
}

async function sendMail(message, dependencies, deadline) {
  assertBudget(dependencies);
  const config = dependencies.config || configuredAccountMail(dependencies.env || process.env);
  if (!config) throw new Error('owner_mail_not_configured');
  const remaining = Math.min(20000, Math.max(1, deadline - clock(dependencies)));
  // Nodemailer's non-pooled close() does not terminate an in-flight SMTP connection.
  // Own its underlying socket so the hard deadline really stops network work.
  const socket = (dependencies.createSocket || (() => new net.Socket()))();
  const connect = socket.connect;
  let stopped = false;
  socket.connect = function (...args) {
    // DNS may complete after timeout; never resurrect the destroyed socket.
    if (stopped) throw new Error('owner_mail_socket_closed');
    return connect.apply(this, args);
  };
  const stopSocket = () => { stopped = true; socket.destroy(); };
  const transporter = (dependencies.createTransport || nodemailer.createTransport)({
    host: config.host, port: config.port, secure: config.port === 465, socket,
    requireTLS: true, auth: { user: config.user, pass: config.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: Math.min(10000, remaining), greetingTimeout: Math.min(10000, remaining),
    socketTimeout: remaining, logger: false, debug: false
  });
  let timer;
  let abortListener;
  try {
    const result = await Promise.race([
      transporter.sendMail({ ...message, from: config.from, to: OWNER_EMAIL,
        disableFileAccess: true, disableUrlAccess: true }),
      new Promise((_, reject) => {
        abortListener = () => { stopSocket(); reject(new Error('owner_mail_timeout')); };
        timer = setTimeout(abortListener, remaining);
        dependencies._signal.addEventListener('abort', abortListener, { once: true });
        if (dependencies._signal.aborted) abortListener();
      })
    ]);
    if (!result || !Array.isArray(result.accepted) ||
        !result.accepted.some((address) => String(address).toLowerCase() === OWNER_EMAIL)) {
      throw new Error('owner_mail_not_accepted');
    }
  } finally {
    clearTimeout(timer);
    if (abortListener) dependencies._signal.removeEventListener('abort', abortListener);
    stopSocket();
    if (typeof transporter.close === 'function') transporter.close();
  }
}

async function updateClaim(id, leaseId, mutation, dependencies) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readRecord('pending', id, dependencies);
    if (!current || current.body.state !== 'sending' || current.body.leaseId !== leaseId) return null;
    const next = mutation({ ...current.body });
    try {
      await writeRecord('pending', next, current.etag, dependencies);
      return { body: next };
    } catch (error) { if (!conflict(error) || attempt === 4) throw error; }
  }
  return null;
}

async function dispatch(id, dependencies, config, deadline, onAttempt) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const receipt = await readRecord('receipts', id, dependencies);
    if (receipt) {
      await deletePending(id, dependencies);
      return { state: receipt.body.state, attempted: false };
    }
    const pending = await readRecord('pending', id, dependencies);
    if (!pending) return { state: 'ignored', attempted: false };
    if (['sent', 'failed'].includes(pending.body.state)) return finishTerminal(pending, dependencies);
    const now = clock(dependencies);
    if (pending.body.state === 'sending' && Date.parse(pending.body.leaseUntil || '') > now) {
      return { state: 'queued', attempted: false };
    }
    if (pending.body.attempts >= MAX_ATTEMPTS || Date.parse(pending.body.event.occurredAt) < config.startAt) {
      const failed = { ...pending.body, state: 'failed', completedAt: new Date(now).toISOString(), leaseId: '', leaseUntil: null };
      try {
        await writeRecord('pending', failed, pending.etag, dependencies);
        return finishTerminal({ body: failed }, dependencies);
      } catch (error) { if (conflict(error) && attempt < 4) continue; throw error; }
    }
    if (Date.parse(pending.body.nextAttemptAt || '') > now || now >= deadline) return { state: 'queued', attempted: false };
    const leaseId = crypto.randomUUID();
    const claim = { ...pending.body, state: 'sending', leaseId, leaseUntil: new Date(now + LEASE_MS).toISOString(),
      attempts: pending.body.attempts + 1 };
    try { await writeRecord('pending', claim, pending.etag, dependencies); }
    catch (error) { if (conflict(error) && attempt < 4) continue; throw error; }
    // Close the enqueue/receipt race after claiming, immediately before SMTP.
    const finalReceipt = await readRecord('receipts', id, dependencies);
    if (finalReceipt) {
      await deletePending(id, dependencies);
      return { state: finalReceipt.body.state, attempted: false };
    }
    assertBudget(dependencies);
    if (onAttempt) onAttempt();
    let sent = false;
    try { await sendMail(emailMessage(claim.event), dependencies, deadline); sent = true; }
    catch (_) { /* SMTP exceptions may contain addresses, credentials and provider responses. */ }
    // SMTP and Blob cannot commit atomically. A crash after acceptance but before
    // this sent write may resend after lease expiry; stable Message-ID mitigates
    // duplicates but this outbox does not promise exactly-once inbox delivery.
    const completedAt = new Date(clock(dependencies)).toISOString();
    const terminal = sent || claim.attempts >= MAX_ATTEMPTS;
    const updated = await updateClaim(id, leaseId, (current) => ({
      ...current, state: sent ? 'sent' : terminal ? 'failed' : 'queued', leaseId: '', leaseUntil: null,
      ...(terminal ? { completedAt } : { nextAttemptAt: new Date(clock(dependencies) + RETRY_MS[claim.attempts - 1]).toISOString() })
    }), dependencies);
    if (!updated) return { state: 'queued', attempted: true, delivered: sent };
    if (terminal) {
      const result = await finishTerminal(updated, dependencies);
      return { ...result, attempted: true, delivered: sent };
    }
    return { state: 'queued', attempted: true, delivered: false };
  }
  return { state: 'queued', attempted: false };
}

async function notifyOwnerPayment(context, dependencies = {}) {
  let scope;
  try {
    const config = configuration(dependencies);
    if (!config) return { state: 'disabled' };
    const event = buildEvent(context, config, dependencies);
    if (!event) return { state: 'ignored' };
    scope = runScope(dependencies);
    dependencies = scope.dependencies;
    const deadline = dependencies._deadline;
    const receipt = await readRecord('receipts', event.id, dependencies);
    if (receipt) return { state: receipt.body.state };
    const pending = await readRecord('pending', event.id, dependencies);
    if (!pending) {
      try {
        await writeRecord('pending', {
          version: 1, id: event.id, event, state: 'queued', attempts: 0,
          nextAttemptAt: new Date(clock(dependencies)).toISOString(), leaseId: '', leaseUntil: null
        }, '', dependencies);
      } catch (error) { if (!conflict(error)) throw error; }
    }
    const result = await dispatch(event.id, dependencies, config, deadline);
    return { state: result.state };
  } catch (_) { return { state: 'queue_error' }; }
  finally { if (scope) scope.close(); }
}

async function retryOwnerPaymentNotifications(dependencies = {}) {
  const stats = { enabled: false, scanned: 0, attempted: 0, sent: 0, queued: 0, failed: 0, errors: 0 };
  let scope;
  try {
    const config = configuration(dependencies);
    if (!config) return stats;
    stats.enabled = true;
    scope = runScope(dependencies);
    dependencies = scope.dependencies;
    const deadline = dependencies._deadline;
    const prefix = `${rootPath()}pending/`;
    let cursor;
    do {
      if (clock(dependencies) >= deadline || stats.attempted >= MAX_SENDS) break;
      assertBudget(dependencies);
      const page = await (dependencies.list || list)({ prefix, cursor, limit: Math.min(100, MAX_SCAN - stats.scanned),
        abortSignal: dependencies._signal });
      for (const blob of page && page.blobs || []) {
        if (stats.scanned >= MAX_SCAN || stats.attempted >= MAX_SENDS || clock(dependencies) >= deadline) break;
        stats.scanned++;
        const pathname = String(blob.pathname || '');
        const id = pathname.startsWith(prefix) ? pathname.slice(prefix.length).replace(/\.enc$/, '') : '';
        if (!DIGEST.test(id) || pathname !== `${prefix}${id}.enc`) { stats.errors++; continue; }
        try {
          const result = await dispatch(id, dependencies, config, deadline, () => { stats.attempted++; });
          if (result.delivered) stats.sent++;
          if (result.state === 'queued') stats.queued++;
          if (result.state === 'failed') stats.failed++;
        } catch (_) { stats.errors++; }
      }
      const next = page && page.hasMore ? page.cursor : undefined;
      if (!next || next === cursor) break;
      cursor = next;
    } while (stats.scanned < MAX_SCAN);
  } catch (_) { stats.errors++; }
  finally { if (scope) scope.close(); }
  return stats;
}

// Explicit operator test only. This helper never creates a payment or a fake transaction event.
async function sendOwnerPaymentTest(dependencies = {}) {
  let scope;
  try {
    if (!configuration(dependencies)) return { state: 'disabled' };
    scope = runScope(dependencies);
    dependencies = scope.dependencies;
    await sendMail({
      messageId: `<owner-payment-test-${crypto.randomUUID()}@olivestock.co.kr>`,
      subject: '[올리브재고] 운영자 결제 알림 테스트 (실결제 아님)',
      text: '운영자 결제 승인·취소 이메일 알림의 연결 확인용 테스트입니다.\n실제 결제·취소·이용권 변경은 발생하지 않았습니다.'
    }, dependencies, dependencies._deadline);
    return { state: 'sent' };
  } catch (_) { return { state: 'failed' }; }
  finally { if (scope) scope.close(); }
}

module.exports = { notifyOwnerPayment, retryOwnerPaymentNotifications, sendOwnerPaymentTest };
