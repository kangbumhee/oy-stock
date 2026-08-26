const crypto = require('node:crypto');
const { HttpError } = require('./_http');

const PASS_AMOUNT_KRW = 30000;
const PASS_DURATION_DAYS = 30;
const PASS_DURATION_MS = PASS_DURATION_DAYS * 24 * 60 * 60 * 1000;
const PAYMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const PASS_ORDER_NAME = '올리브재고 가격 알림 30일 이용권';

function enabledFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function entitlementFeatureEnabled() {
  return enabledFlag(process.env.PRICE_ALERT_ENTITLEMENT_ENABLED);
}

function normalizePaymentId(value) {
  const raw = String(value || '').trim();
  return /^oypa_[A-Za-z0-9_-]{20,96}$/.test(raw) ? raw : '';
}

function normalizeIdempotencyKey(value) {
  const raw = String(value || '').trim();
  return /^[\x21-\x7e]{20,160}$/.test(raw) ? raw : '';
}

function normalizeIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function paymentIdempotencyHash(deviceId, idempotencyKey) {
  return crypto
    .createHmac('sha256', require('./_crypto').configuredDataKey())
    .update('price-alert-payment-idempotency:v1:')
    .update(String(deviceId || ''))
    .update(':')
    .update(String(idempotencyKey || ''))
    .digest('base64url');
}

function newPaymentId() {
  return `oypa_${crypto.randomBytes(24).toString('base64url')}`;
}

function entitlementGrants(record) {
  return Array.isArray(record && record.entitlement && record.entitlement.grants)
    ? record.entitlement.grants
    : [];
}

function entitlementState(record) {
  if (!record.entitlement || typeof record.entitlement !== 'object') {
    record.entitlement = { version: 1, grants: [], paymentCancellations: [] };
  }
  if (!Array.isArray(record.entitlement.grants)) record.entitlement.grants = [];
  if (!Array.isArray(record.entitlement.paymentCancellations)) {
    record.entitlement.paymentCancellations = [];
  }
  record.entitlement.version = 1;
  return record.entitlement;
}

function recomputeGrantIntervals(record) {
  const entitlement = entitlementState(record);
  const payments = entitlement.grants
    .filter((grant) => grant && grant.source === 'payment' && normalizePaymentId(grant.paymentId))
    .sort((left, right) => {
      const time = Date.parse(left.grantedAt || 0) - Date.parse(right.grantedAt || 0);
      if (Number.isFinite(time) && time) return time;
      return String(left.paymentId).localeCompare(String(right.paymentId));
    });
  let cursor = 0;
  payments.forEach((grant) => {
    const grantedAt = Date.parse(grant.grantedAt || 0);
    if (!Number.isFinite(grantedAt)) {
      grant.startsAt = null;
      grant.endsAt = null;
      return;
    }
    if (grant.revokedAt) {
      grant.startsAt = null;
      grant.endsAt = null;
      return;
    }
    const startsAt = Math.max(grantedAt, cursor);
    const endsAt = startsAt + PASS_DURATION_MS;
    grant.startsAt = new Date(startsAt).toISOString();
    grant.endsAt = new Date(endsAt).toISOString();
    cursor = endsAt;
  });
  return entitlement;
}

function publicEntitlement(record, now) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const grants = entitlementGrants(record);
  const lifetime = grants.some(
    (grant) => grant && grant.source === 'promotion' && grant.lifetime === true && !grant.revokedAt
  );
  let expiresAt = null;
  grants.forEach((grant) => {
    if (!grant || grant.source !== 'payment' || grant.revokedAt) return;
    const end = Date.parse(grant.endsAt || '');
    if (Number.isFinite(end) && (!expiresAt || end > Date.parse(expiresAt))) {
      expiresAt = new Date(end).toISOString();
    }
  });
  return {
    active: lifetime || Boolean(expiresAt && Date.parse(expiresAt) > timestamp),
    lifetime,
    expiresAt: lifetime ? null : expiresAt,
    plan: {
      amount: PASS_AMOUNT_KRW,
      currency: 'KRW',
      durationDays: PASS_DURATION_DAYS,
      autoRenew: false
    }
  };
}

function requireActiveEntitlement(record, now) {
  if (!entitlementFeatureEnabled()) {
    throw new HttpError(503, 'entitlement_not_configured');
  }
  const status = publicEntitlement(record, now);
  if (!status.active) throw new HttpError(402, 'entitlement_required');
  return status;
}

function serviceEntitlementActive(record, now) {
  return entitlementFeatureEnabled() && publicEntitlement(record, now).active;
}

function applyPaymentGrant(record, paymentId, paidAt) {
  const normalizedPaymentId = normalizePaymentId(paymentId);
  const timestamp = normalizeIso(paidAt) || new Date().toISOString();
  if (!normalizedPaymentId) throw new Error('invalid payment grant');
  const entitlement = entitlementState(record);
  if (
    entitlement.paymentCancellations.some(
      (item) => item && item.paymentId === normalizedPaymentId
    )
  ) {
    recomputeGrantIntervals(record);
    return { changed: false, grant: null, cancelled: true, entitlement: publicEntitlement(record) };
  }
  const existing = entitlement.grants.find(
    (grant) => grant && grant.source === 'payment' && grant.paymentId === normalizedPaymentId
  );
  if (existing) {
    recomputeGrantIntervals(record);
    return { changed: false, grant: existing, entitlement: publicEntitlement(record) };
  }
  const grant = {
    source: 'payment',
    paymentId: normalizedPaymentId,
    grantedAt: timestamp,
    durationDays: PASS_DURATION_DAYS,
    revokedAt: null,
    startsAt: null,
    endsAt: null
  };
  entitlement.grants.push(grant);
  recomputeGrantIntervals(record);
  return { changed: true, grant, entitlement: publicEntitlement(record) };
}

function revokePaymentGrant(record, paymentId, cancelledAt) {
  const normalizedPaymentId = normalizePaymentId(paymentId);
  if (!normalizedPaymentId) throw new Error('invalid payment revocation');
  const entitlement = entitlementState(record);
  const timestamp = normalizeIso(cancelledAt) || new Date().toISOString();
  const knownCancellation = entitlement.paymentCancellations.some(
    (item) => item && item.paymentId === normalizedPaymentId
  );
  if (!knownCancellation) {
    entitlement.paymentCancellations.push({ paymentId: normalizedPaymentId, cancelledAt: timestamp });
  }
  const grant = entitlement.grants.find(
    (item) => item && item.source === 'payment' && item.paymentId === normalizedPaymentId
  );
  if (!grant || grant.revokedAt) {
    recomputeGrantIntervals(record);
    return {
      changed: !knownCancellation,
      grant: grant || null,
      entitlement: publicEntitlement(record)
    };
  }
  grant.revokedAt = timestamp;
  recomputeGrantIntervals(record);
  return { changed: true, grant, entitlement: publicEntitlement(record) };
}

function promotionDigest(code, pepper) {
  return crypto
    .createHmac('sha256', String(pepper || ''))
    .update(String(code || ''))
    .digest('base64url');
}

function configuredPromotion() {
  const pepper = String(process.env.PRICE_ALERT_PROMO_CODE_PEPPER || '');
  const configuredDigest = String(process.env.PRICE_ALERT_PROMO_CODE_DIGEST || '').trim();
  if (pepper.length < 16) return null;
  let digest = null;
  if (/^[A-Fa-f0-9]{64}$/.test(configuredDigest)) {
    digest = Buffer.from(configuredDigest, 'hex');
  } else if (/^[A-Za-z0-9_-]{43}$/.test(configuredDigest)) {
    digest = Buffer.from(configuredDigest, 'base64url');
  }
  if (!digest || digest.length !== 32) return null;
  return { pepper, digest, publicId: crypto.createHash('sha256').update(digest).digest('hex').slice(0, 24) };
}

function promotionMatches(code, configuration) {
  const raw = String(code == null ? '' : code);
  if (!configuration || raw.length < 6 || raw.length > 160 || /[\u0000-\u001f\u007f]/.test(raw)) {
    return false;
  }
  const actual = Buffer.from(promotionDigest(raw, configuration.pepper), 'base64url');
  return actual.length === configuration.digest.length && crypto.timingSafeEqual(actual, configuration.digest);
}

function applyLifetimePromotion(record, promotionId, now) {
  const timestamp = normalizeIso(now) || new Date().toISOString();
  const entitlement = entitlementState(record);
  const existing = entitlement.grants.find(
    (grant) => grant && grant.source === 'promotion' && grant.promotionId === promotionId
  );
  if (existing) return { changed: false, grant: existing, entitlement: publicEntitlement(record) };
  const grant = {
    source: 'promotion',
    promotionId,
    grantedAt: timestamp,
    lifetime: true,
    revokedAt: null
  };
  entitlement.grants.push(grant);
  return { changed: true, grant, entitlement: publicEntitlement(record) };
}

function pendingPaymentActive(pending, now) {
  if (!pending || !normalizePaymentId(pending.paymentId)) return false;
  if (!['created', 'prepared', 'pending', 'review_required'].includes(pending.status)) return false;
  const expiresAt = Date.parse(pending.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > Number(now || Date.now());
}

function pendingPaymentClaimsActiveCapacity(pending, now) {
  return (
    pendingPaymentActive(pending, now) &&
    ['created', 'prepared', 'pending'].includes(pending.status)
  );
}

module.exports = {
  PASS_AMOUNT_KRW,
  PASS_DURATION_DAYS,
  PASS_DURATION_MS,
  PASS_ORDER_NAME,
  PAYMENT_INTENT_TTL_MS,
  applyLifetimePromotion,
  applyPaymentGrant,
  configuredPromotion,
  entitlementFeatureEnabled,
  entitlementGrants,
  newPaymentId,
  normalizeIdempotencyKey,
  normalizePaymentId,
  paymentIdempotencyHash,
  pendingPaymentActive,
  pendingPaymentClaimsActiveCapacity,
  promotionDigest,
  promotionMatches,
  publicEntitlement,
  recomputeGrantIntervals,
  requireActiveEntitlement,
  serviceEntitlementActive,
  revokePaymentGrant
};
