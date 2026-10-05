'use strict';
const crypto = require('node:crypto');
const SITE_ORIGIN = 'https://ph-pro-guide.kbhjjan100.chatgpt.site';
const SITE_PATHS = new Set(['/', '/verify', '/guide', '/checkout', '/pay', '/unsubscribe', '/email-settings']);
const ROOT = 'ph-guide-relay/v1/';
const AMOUNT = 50000, LEASE_MS = 90000, MAX_ATTEMPTS = 5;
const STRONG_ETAG = /^"[\x21\x23-\x7e]*"$/;
class SafeError extends Error { constructor(status, code, retryAfter) { super(code); this.status = status; this.code = code; this.retryAfter = retryAfter; } }
function fail(status, code, retryAfter) { throw new SafeError(status, code, retryAfter); }
function equal(a, b) { return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest()); }
function token(value, pattern) { return typeof value === 'string' && pattern.test(value) ? value : null; }
function dataKey(env) { try { const raw = String(env.PRICE_ALERT_DATA_KEY || '').trim(); const key = /^(?:hex:)?[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw.replace(/^hex:/i, ''), 'hex') : Buffer.from(raw.replace(/^base64:/i, ''), 'base64url'); return key.length === 32 ? key : null; } catch { return null; } }
function configuration(env) {
  const secret = token(env.PH_GUIDE_RELAY_SECRET, /^[^\x00-\x20\x7f]{32,1024}$/), key = dataKey(env);
  const storage = Boolean(key && env.BLOB_READ_WRITE_TOKEN);
  const host = token(env.PRICE_ALERT_SMTP_HOST, /^[A-Za-z0-9.-]+$/), port = Number(env.PRICE_ALERT_SMTP_PORT || 465);
  const user = token(env.PRICE_ALERT_SMTP_USER, /^[^\r\n\x00]{1,254}$/), password = token(env.PRICE_ALERT_SMTP_PASSWORD, /^[^\r\n\x00]{1,1024}$/);
  const from = token(env.PRICE_ALERT_SMTP_FROM, /^[^\s<>@\x00-\x1f]+@[^\s<>@\x00-\x1f]+\.[^\s<>@\x00-\x1f]+$/);
  const smtp = host && [465, 587].includes(port) && user && password && from ? { host, port, user, password, from } : null;
  const storeId = token(env.PRICE_ALERT_PORTONE_STORE_ID, /^store-[A-Za-z0-9_-]{6,120}$/), channelKey = token(env.PRICE_ALERT_PORTONE_CHANNEL_KEY, /^channel-key-[A-Za-z0-9_-]{6,160}$/);
  const apiSecret = token(env.PRICE_ALERT_PORTONE_API_SECRET, /^[^\x00-\x20\x7f]{16,1024}$/);
  const channelType = env.PRICE_ALERT_PORTONE_EXPECTED_CHANNEL_TYPE || 'LIVE';
  return { secret, key, storage, smtp, originReady: env.PH_GUIDE_SITE_ORIGIN === SITE_ORIGIN, payment: storeId && channelKey && apiSecret && channelType === 'LIVE' ? { storeId, channelKey, apiSecret } : null };
}
function encrypt(value, key) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('ph-guide-relay:v1')); const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: bytes.toString('base64url') }); }
function decrypt(value, key) { try { const e = JSON.parse(value); if (e.v !== 1) throw new Error(); const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64url')); cipher.setAAD(Buffer.from('ph-guide-relay:v1')); cipher.setAuthTag(Buffer.from(e.tag, 'base64url')); return JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.data, 'base64url')), cipher.final()]).toString()); } catch { return fail(503, 'relay_storage_invalid'); } }
function digest(value, config) { return crypto.createHmac('sha256', config.key).update('ph-guide-relay:v1:' + value).digest('hex'); }
function conflict(error) { return [409, 412].includes(Number(error?.status || error?.statusCode)) || error?.name === 'BlobPreconditionFailedError'; }
function exact(body, allowed) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'invalid_request'); }
function paymentId(value) { if (!token(value, /^ph_[a-f0-9]{32}$/)) fail(400, 'invalid_payment_id'); return value; }
function validateMail(body) {
  exact(body, ['action', 'eventId', 'to', 'subject', 'text']);
  if (!token(body.eventId, /^mail_[a-f0-9]{32}$/)) fail(400, 'invalid_mail_event');
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
  if (to.length > 254 || !/^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/.test(to)) fail(400, 'invalid_email');
  if (!token(body.subject, /^\[PH 연결 가이드\][^\r\n\x00-\x1f\x7f]{1,120}$/) || typeof body.text !== 'string' || body.text.length < 10 || Buffer.byteLength(body.text) > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.text)) fail(400, 'invalid_mail_content');
  if (/(?:javascript|data|ftp|file):|(?:^|\s)www\./i.test(body.text)) fail(400, 'invalid_mail_link');
  for (const raw of body.text.match(/(?:https?:\/\/|mailto:)[^\s<>"']+/gi) || []) {
    try { const url = new URL(raw); if (url.protocol === 'mailto:') { if (raw !== 'mailto:kbhjjan@naver.com') throw new Error(); } else if (url.origin !== SITE_ORIGIN || url.username || url.password || !SITE_PATHS.has(url.pathname) || url.hash) throw new Error(); }
    catch { fail(400, 'invalid_mail_link'); }
  }
  return { eventId: body.eventId, to, subject: body.subject, text: body.text };
}
async function jsonBody(req) {
  if (!(req.headers?.['content-type'] || '').startsWith('application/json')) fail(415, 'json_required');
  if (Number(req.headers?.['content-length']) > 16384) fail(413, 'body_too_large');
  if (req.body !== undefined) { const text = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body); if (Buffer.byteLength(text) > 16384) fail(413, 'body_too_large'); try { return JSON.parse(text); } catch { return fail(400, 'invalid_json'); } }
  const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16384) fail(413, 'body_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return fail(400, 'invalid_json'); }
}
function send(res, status, body, retryAfter) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'private,no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); if (retryAfter) res.setHeader('Retry-After', String(retryAfter)); res.end(JSON.stringify(body)); }
function createRelay(dependencies = {}) {
  const env = dependencies.env || process.env, clock = dependencies.clock || Date.now;
  const config = configuration(env);
  const blob = () => dependencies.blob || require('@vercel/blob');
  function pathname(kind, id) { if (!['mail', 'payment', 'limits'].includes(kind) || !/^[a-f0-9]{64}$/.test(id)) fail(503, 'relay_storage_invalid'); return ROOT + kind + '/' + id + '.enc'; }
  async function read(kind, id) {
    const result = await blob().get(pathname(kind, id), { token: env.BLOB_READ_WRITE_TOKEN, access: 'private', useCache: false, abortSignal: AbortSignal.timeout(8000), headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
    if (!result) return null;
    const chunks = []; let size = 0; for await (const chunk of result.stream) { size += chunk.length; if (size > 16384) fail(503, 'relay_storage_invalid'); chunks.push(Buffer.from(chunk)); }
    const value = decrypt(Buffer.concat(chunks).toString(), config.key), etag = String(result.blob?.etag || '');
    if (!STRONG_ETAG.test(etag) || value.v !== 1 || value.id !== id) fail(503, 'relay_storage_invalid');
    return { value, etag };
  }
  async function write(kind, id, value, etag = '') { return blob().put(pathname(kind, id), encrypt(value, config.key), { token: env.BLOB_READ_WRITE_TOKEN, access: 'private', addRandomSuffix: false, allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {}), contentType: 'application/octet-stream', cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(8000) }); }
  async function rate(action) {
    const hour = Math.floor(clock() / 3600000), id = digest('limit:' + action + ':' + hour, config), max = { mail: 120, 'pre-register': 120, payment: 600, status: 600 }[action];
    for (let attempt = 0; attempt < 4; attempt++) { const old = await read('limits', id), count = old?.value.count || 0; if (!Number.isInteger(count) || count < 0) fail(503, 'relay_storage_invalid'); if (count >= max) fail(429, 'relay_rate_limit', 3600 - Math.floor(clock() / 1000) % 3600); try { await write('limits', id, { v: 1, id, count: count + 1, expiresAt: (hour + 2) * 3600000 }, old?.etag); return; } catch (error) { if (!conflict(error)) throw error; } }
    fail(503, 'relay_storage_busy', 5);
  }
  function smtpTransport() { const create = dependencies.createTransport || require('nodemailer').createTransport; const s = config.smtp; return create({ host: s.host, port: s.port, secure: s.port === 465, requireTLS: true, auth: { user: s.user, pass: s.password }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, logger: false, debug: false }); }
  async function mail(body) {
    const message = validateMail(body); if (!config.smtp || !config.storage) fail(503, 'mail_not_configured');
    const rendered = (await import('./ph-guide-mail.mjs')).renderMail(message.subject, message.text, SITE_ORIGIN);
    const id = digest('mail:' + message.eventId, config), hash = digest('message:' + JSON.stringify(message), config);
    let record = await read('mail', id);
    if (!record) { try { await write('mail', id, { v: 1, id, hash, state: 'queued', attempts: 0, nextAt: 0, leaseUntil: 0 }); } catch (error) { if (!conflict(error)) throw error; } record = await read('mail', id); }
    if (!record || record.value.hash !== hash) fail(409, 'mail_event_mismatch');
    let value = record.value;
    if (value.state === 'sent') return { success: true, smtpAccepted: true, deduplicated: true };
    if (value.state === 'ambiguous') fail(409, 'mail_delivery_ambiguous');
    if (value.state === 'failed' || value.attempts >= MAX_ATTEMPTS) fail(409, 'mail_attempts_exhausted');
    if (value.leaseUntil > clock()) fail(409, 'mail_delivery_pending', Math.ceil((value.leaseUntil - clock()) / 1000));
    if (value.state === 'sending') { await write('mail', id, { ...value, state: 'ambiguous', leaseUntil: 0 }, record.etag); fail(409, 'mail_delivery_ambiguous'); }
    if (value.nextAt > clock()) fail(429, 'mail_retry_later', Math.ceil((value.nextAt - clock()) / 1000));
    const leaseId = crypto.randomBytes(16).toString('hex');
    value = { ...value, state: 'leased', attempts: value.attempts + 1, leaseId, leaseUntil: clock() + LEASE_MS };
    try { await write('mail', id, value, record.etag); } catch (error) { if (conflict(error)) fail(409, 'mail_delivery_pending', 5); throw error; }
    record = await read('mail', id); if (!record || record.value.leaseId !== leaseId) fail(409, 'mail_delivery_pending', 5);
    await write('mail', id, { ...record.value, state: 'sending' }, record.etag);
    record = await read('mail', id); if (!record || record.value.leaseId !== leaseId) fail(409, 'mail_delivery_pending', 5);
    let transporter, accepted = false, definitiveFailure = false;
    try {
      transporter = smtpTransport();
      const result = await transporter.sendMail({ from: config.smtp.from, to: message.to, ...rendered, messageId: '<' + id + '@ph-pro-guide.kbhjjan100.chatgpt.site>', disableFileAccess: true, disableUrlAccess: true });
      accepted = Array.isArray(result?.accepted) && result.accepted.length === 1 && String(result.accepted[0]).toLowerCase() === message.to && (!result.rejected || result.rejected.length === 0);
      definitiveFailure = !accepted && Array.isArray(result?.rejected) && result.rejected.some(item => String(item).toLowerCase() === message.to);
    } catch (error) {
      // SMTP DATA timeout can mean accepted delivery; never retry it blindly.
      definitiveFailure = ['EDNS', 'EAUTH'].includes(error?.code) || ['CONN', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(error?.command) || (Number(error?.responseCode) >= 400 && Number(error?.responseCode) <= 599);
    } finally { transporter?.close?.(); }
    const state = accepted ? 'sent' : definitiveFailure ? (record.value.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued') : 'ambiguous';
    const nextAt = definitiveFailure ? clock() + [60000, 300000, 1800000, 7200000, 7200000][record.value.attempts - 1] : 0;
    try { await write('mail', id, { ...record.value, state, nextAt, leaseUntil: 0, completedAt: accepted ? clock() : null }, record.etag); }
    catch { fail(503, 'mail_delivery_ambiguous'); }
    if (accepted) return { success: true, smtpAccepted: true, deduplicated: false };
    fail(state === 'ambiguous' ? 409 : 503, state === 'ambiguous' ? 'mail_delivery_ambiguous' : 'mail_not_accepted', definitiveFailure ? Math.ceil((nextAt - clock()) / 1000) : undefined);
  }
  async function provider(path, method, body, idem) {
    let response; try { response = await (dependencies.fetch || fetch)('https://api.portone.io' + path, { method, headers: { Authorization: 'PortOne ' + config.payment.apiSecret, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idem ? { 'Idempotency-Key': JSON.stringify(idem) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) }); } catch { return fail(503, 'provider_unavailable'); }
    return response;
  }
  async function preregister(body) {
    exact(body, ['action', 'paymentId', 'idempotencyKey']); const payment = paymentId(body.paymentId);
    if (body.idempotencyKey !== 'ph-pre-register:' + payment) fail(400, 'invalid_idempotency_key');
    if (!config.payment || !config.storage) fail(503, 'payment_not_configured');
    const id = digest('payment:' + payment, config); let record = await read('payment', id);
    if (!record) { try { await write('payment', id, { v: 1, id, paymentId: payment, state: 'created', amount: AMOUNT, createdAt: clock() }); } catch (error) { if (!conflict(error)) throw error; } record = await read('payment', id); }
    if (!record || record.value.paymentId !== payment || record.value.amount !== AMOUNT) fail(503, 'relay_storage_invalid');
    if (record.value.state === 'prepared') return { success: true, prepared: true, deduplicated: true };
    const response = await provider('/payments/' + payment + '/pre-register', 'POST', { storeId: config.payment.storeId, totalAmount: AMOUNT, currency: 'KRW' }, body.idempotencyKey);
    if (![200, 201, 204].includes(response.status)) { await response.body?.cancel(); fail(503, response.status === 409 ? 'provider_request_pending' : 'provider_pre_register_failed'); }
    await response.body?.cancel();
    try { await write('payment', id, { ...record.value, state: 'prepared' }, record.etag); } catch (error) { if (!conflict(error)) throw error; const current = await read('payment', id); if (current?.value.state !== 'prepared') fail(503, 'relay_storage_busy'); }
    return { success: true, prepared: true, deduplicated: false };
  }
  async function lookup(body) {
    exact(body, ['action', 'paymentId']); const payment = paymentId(body.paymentId);
    if (!config.payment || !config.storage) fail(503, 'payment_not_configured');
    const record = await read('payment', digest('payment:' + payment, config)); if (!record || record.value.paymentId !== payment) fail(404, 'provider_payment_not_found');
    const response = await provider('/payments/' + payment, 'GET');
    if (response.status === 404) { await response.body?.cancel(); fail(404, 'provider_payment_not_found'); }
    if (!response.ok) { await response.body?.cancel(); fail(503, 'provider_lookup_failed'); }
    let p; try { const reader = response.body.getReader(); const chunks = []; let size = 0; while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 65536) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(item.value)); } p = JSON.parse(Buffer.concat(chunks).toString()); } catch { return fail(502, 'provider_invalid_response'); }
    if (!p || p.id !== payment || !['READY', 'PAY_PENDING', 'PENDING', 'VIRTUAL_ACCOUNT_ISSUED', 'FAILED', 'PAID', 'CANCELLED', 'PARTIAL_CANCELLED'].includes(p.status)) fail(502, 'provider_invalid_response');
    const method = p.paymentMethod || p.method || {}, channel = p.channel || {}, amount = p.amount || {};
    const providerName = method.provider || method.easyPayProvider || method.easyPay?.provider;
    if (['PAID', 'CANCELLED', 'PARTIAL_CANCELLED'].includes(p.status) && (amount.total !== AMOUNT || p.currency !== 'KRW' || p.storeId !== config.payment.storeId || channel.key !== config.payment.channelKey || channel.type !== 'LIVE' || !['PaymentMethodEasyPay', 'EASY_PAY'].includes(method.type) || providerName !== 'KAKAOPAY')) fail(502, 'provider_contract_mismatch');
    const time = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
    const text = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) ? value : null;
    const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { success: true, payment: { id: payment, status: p.status, currency: text(p.currency), storeId: text(p.storeId), amount: { total: number(amount.total), cancelled: number(amount.cancelled) }, channel: { key: text(channel.key), type: text(channel.type) }, method: { type: text(method.type), provider: text(providerName) }, paidAt: time(p.paidAt), cancelledAt: time(p.cancelledAt) } };
  }
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') fail(405, 'method_not_allowed');
      if (!config.secret || !equal(req.headers?.authorization || '', 'Bearer ' + config.secret)) fail(401, 'relay_unauthorized');
      if (!config.originReady) fail(503, 'relay_site_origin_mismatch');
      const body = await jsonBody(req); if (!['status', 'mail', 'pre-register', 'payment'].includes(body?.action)) fail(400, 'invalid_action');
      if (!config.storage) { if (body.action !== 'status') fail(503, 'relay_storage_not_configured'); }
      else await rate(body.action);
      if (body.action === 'status') {
        exact(body, ['action', 'verifySmtp']); if (body.verifySmtp !== undefined && body.verifySmtp !== true) fail(400, 'invalid_request');
        let smtpVerified = null; if (body.verifySmtp === true && config.smtp) { const transport = smtpTransport(); try { await transport.verify(); smtpVerified = true; } catch { smtpVerified = false; } finally { transport.close?.(); } }
        return send(res, 200, { success: true, mailReady: Boolean(config.smtp && config.storage && smtpVerified !== false), paymentReady: Boolean(config.payment && config.storage), storeId: config.payment?.storeId || null, channelKey: config.payment?.channelKey || null, smtpVerified, siteOrigin: SITE_ORIGIN });
      }
      const result = body.action === 'mail' ? await mail(body) : body.action === 'pre-register' ? await preregister(body) : await lookup(body);
      send(res, 200, result);
    } catch (error) { send(res, error instanceof SafeError ? error.status : 503, { success: false, error: error instanceof SafeError ? error.code : 'relay_unavailable' }, error.retryAfter); }
  };
}
module.exports = { createRelay, validateMail, configuration, SITE_ORIGIN };
