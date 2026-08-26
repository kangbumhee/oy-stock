const {
  PASS_AMOUNT_KRW,
  PASS_ORDER_NAME,
  normalizePaymentId
} = require('./_entitlement');

const PORTONE_API_ORIGIN = 'https://api.portone.io';

class PortOneSafeError extends Error {
  constructor(code, retryable) {
    super(code);
    this.name = 'PortOneSafeError';
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

function safeToken(value, pattern) {
  const raw = String(value || '').trim();
  return pattern.test(raw) ? raw : '';
}

function configuredPortOne() {
  const enabled = /^(?:1|true|yes|on)$/i.test(
    String(process.env.PRICE_ALERT_ENTITLEMENT_ENABLED || '').trim()
  );
  const storeId = safeToken(
    process.env.PRICE_ALERT_PORTONE_STORE_ID,
    /^store-[A-Za-z0-9_-]{6,120}$/
  );
  const channelKey = safeToken(
    process.env.PRICE_ALERT_PORTONE_CHANNEL_KEY,
    /^channel-key-[A-Za-z0-9_-]{6,160}$/
  );
  const apiSecret = String(process.env.PRICE_ALERT_PORTONE_API_SECRET || '').trim();
  const expectedChannelType = safeToken(
    process.env.PRICE_ALERT_PORTONE_EXPECTED_CHANNEL_TYPE || 'LIVE',
    /^[A-Z_]{2,32}$/
  );
  let publicSiteUrl = '';
  try {
    const parsed = new URL(String(process.env.PRICE_ALERT_PUBLIC_SITE_URL || '').trim());
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
      publicSiteUrl = parsed.origin;
    }
  } catch (_) {}
  if (
    !enabled ||
    !storeId ||
    !channelKey ||
    apiSecret.length < 16 ||
    /[\u0000-\u0020\u007f]/.test(apiSecret) ||
    !expectedChannelType ||
    !publicSiteUrl
  ) {
    return null;
  }
  return { storeId, channelKey, apiSecret, expectedChannelType, publicSiteUrl };
}

function paymentContract(config) {
  return {
    amount: PASS_AMOUNT_KRW,
    currency: 'KRW',
    orderName: PASS_ORDER_NAME,
    payMethod: 'EASY_PAY',
    easyPayProvider: 'KAKAOPAY',
    storeId: config.storeId,
    channelKey: config.channelKey,
    channelType: config.expectedChannelType
  };
}

function requestPaymentPayload(intent, config) {
  const product = {
    id: 'price_alert_30d',
    name: PASS_ORDER_NAME,
    amount: PASS_AMOUNT_KRW,
    quantity: 1
  };
  return {
    storeId: config.storeId,
    channelKey: config.channelKey,
    paymentId: intent.paymentId,
    orderName: PASS_ORDER_NAME,
    totalAmount: PASS_AMOUNT_KRW,
    currency: 'KRW',
    payMethod: 'EASY_PAY',
    easyPay: { easyPayProvider: 'KAKAOPAY' },
    redirectUrl: `${config.publicSiteUrl}/?priceAlertPayment=complete`,
    noticeUrls: [`${config.publicSiteUrl}/api/price-alerts/payment-webhook`],
    products: [product]
  };
}

async function safeResponseJson(response) {
  const contentLength = Number(response && response.headers && response.headers.get
    ? response.headers.get('content-length')
    : 0);
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    throw new PortOneSafeError('portone_invalid_response', false);
  }
  try {
    if (response && typeof response.text === 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
        throw new PortOneSafeError('portone_invalid_response', false);
      }
      const parsed = JSON.parse(text || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      return parsed;
    }
    const parsed = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch (error) {
    if (error instanceof PortOneSafeError) throw error;
    throw new PortOneSafeError('portone_invalid_response', false);
  }
}

async function portoneRequest(config, path, options, dependencies) {
  const request = (dependencies && dependencies.fetch) || fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(
    60000,
    Math.min(120000, Number(process.env.PRICE_ALERT_PORTONE_TIMEOUT_MS || 65000) || 65000)
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(`${PORTONE_API_ORIGIN}${path}`, {
      method: options.method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `PortOne ${config.apiSecret}`,
        ...(options.headers || {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
  } catch (_) {
    throw new PortOneSafeError('portone_unavailable', true);
  } finally {
    clearTimeout(timeout);
  }
}

async function preRegisterPayment(config, intent, idempotencyKey, dependencies) {
  const response = await portoneRequest(
    config,
    `/payments/${encodeURIComponent(intent.paymentId)}/pre-register`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': JSON.stringify(idempotencyKey) },
      body: {
        storeId: config.storeId,
        totalAmount: PASS_AMOUNT_KRW,
        currency: 'KRW'
      }
    },
    dependencies
  );
  if ([200, 201, 204].includes(Number(response.status))) return;
  throw new PortOneSafeError(
    Number(response.status) === 409 ? 'portone_request_pending' : 'portone_pre_register_failed',
    [408, 409, 425, 429].includes(Number(response.status)) || Number(response.status) >= 500
  );
}

function optionalNonnegativeInteger(value) {
  if (value == null) return null;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizePortOnePayment(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PortOneSafeError('portone_invalid_response', false);
  }
  const method = payload.paymentMethod && typeof payload.paymentMethod === 'object'
    ? payload.paymentMethod
    : payload.method && typeof payload.method === 'object'
      ? payload.method
      : {};
  const channel = payload.channel && typeof payload.channel === 'object' ? payload.channel : {};
  const amount = payload.amount && typeof payload.amount === 'object' ? payload.amount : {};
  const rawMethod = String(method.type || '').trim();
  const methodType = rawMethod === 'PaymentMethodEasyPay' ? 'EASY_PAY' : rawMethod;
  const easyPay = method.easyPay && typeof method.easyPay === 'object' ? method.easyPay : {};
  return {
    paymentId: normalizePaymentId(payload.id || payload.paymentId),
    status: String(payload.status || '').trim().toUpperCase(),
    amount: optionalNonnegativeInteger(amount.total != null ? amount.total : payload.totalAmount),
    cancelledAmount: optionalNonnegativeInteger(
      amount.cancelled != null ? amount.cancelled : payload.cancelledAmount
    ),
    currency: String(payload.currency || '').trim().toUpperCase(),
    storeId: String(payload.storeId || '').trim(),
    channelKey: String(channel.key || payload.channelKey || '').trim(),
    channelType: String(channel.type || '').trim().toUpperCase(),
    payMethod: methodType,
    easyPayProvider: String(
      method.provider || method.easyPayProvider || easyPay.provider || payload.easyPayProvider || ''
    ).trim().toUpperCase(),
    paidAt: normalizeProviderTime(payload.paidAt),
    cancelledAt: normalizeProviderTime(payload.cancelledAt)
  };
}

function normalizeProviderTime(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

async function getPayment(config, paymentId, dependencies) {
  const normalized = normalizePaymentId(paymentId);
  if (!normalized) throw new PortOneSafeError('payment_not_found', false);
  const response = await portoneRequest(
    config,
    `/payments/${encodeURIComponent(normalized)}`,
    { method: 'GET' },
    dependencies
  );
  if (Number(response.status) !== 200) {
    throw new PortOneSafeError(
      'portone_lookup_failed',
      [408, 409, 425, 429].includes(Number(response.status)) || Number(response.status) >= 500
    );
  }
  return normalizePortOnePayment(await safeResponseJson(response));
}

function verifyPayment(payment, intent) {
  const expected = intent.contract || {};
  if (!payment.paymentId || payment.paymentId !== intent.paymentId) {
    return { action: 'review_required', reason: 'payment_id_mismatch' };
  }
  if (payment.status === 'FAILED') return { action: 'abandoned', reason: 'provider_failed' };
  if (!['PAID', 'CANCELLED', 'PARTIAL_CANCELLED'].includes(payment.status)) {
    return { action: 'pending', reason: 'provider_not_final' };
  }
  if (payment.status === 'PARTIAL_CANCELLED') {
    return {
      action: 'review_required',
      reason: 'partial_cancellation',
      suspendGrant: true,
      effectiveAt: payment.cancelledAt || ''
    };
  }
  const checks = [
    [payment.amount === PASS_AMOUNT_KRW && payment.amount === expected.amount, 'amount_mismatch'],
    [payment.currency === 'KRW' && payment.currency === expected.currency, 'currency_mismatch'],
    [payment.storeId === expected.storeId, 'store_mismatch'],
    [payment.channelKey === expected.channelKey, 'channel_key_mismatch'],
    [payment.channelType === expected.channelType, 'channel_type_mismatch'],
    [payment.payMethod === 'EASY_PAY' && expected.payMethod === 'EASY_PAY', 'payment_method_mismatch'],
    [payment.easyPayProvider === 'KAKAOPAY' && expected.easyPayProvider === 'KAKAOPAY', 'provider_mismatch']
  ];
  for (const [matches, reason] of checks) {
    if (!matches) return { action: 'review_required', reason };
  }
  if (payment.status === 'PAID') {
    if (payment.cancelledAmount !== 0) {
      return { action: 'review_required', reason: 'paid_cancelled_amount_mismatch' };
    }
    if (!payment.paidAt) return { action: 'review_required', reason: 'paid_at_missing' };
    return { action: 'paid', reason: 'verified_paid', effectiveAt: payment.paidAt };
  }
  if (payment.status === 'CANCELLED') {
    if (payment.cancelledAmount !== PASS_AMOUNT_KRW) {
      return { action: 'review_required', reason: 'cancelled_amount_mismatch' };
    }
    if (!payment.cancelledAt) {
      return { action: 'review_required', reason: 'cancelled_at_missing' };
    }
    return {
      action: 'cancelled',
      reason: 'verified_full_cancellation',
      effectiveAt: payment.cancelledAt
    };
  }
  return { action: 'review_required', reason: 'provider_final_state_mismatch' };
}

module.exports = {
  PORTONE_API_ORIGIN,
  PortOneSafeError,
  configuredPortOne,
  getPayment,
  normalizePortOnePayment,
  normalizeProviderTime,
  paymentContract,
  preRegisterPayment,
  requestPaymentPayload,
  verifyPayment
};
