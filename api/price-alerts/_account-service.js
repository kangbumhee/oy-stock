const crypto = require('node:crypto');
const { authenticateDevice, mutateAuthenticatedDevice } = require('./_auth');
const { hashDeviceSecret, normalizeDeviceId, normalizeDeviceSecret } = require('./_core');
const { configuredDataKey } = require('./_crypto');
const { publicEntitlement } = require('./_entitlement');
const { HttpError, deviceCredentials } = require('./_http');
const { configuredAccountMail, sendAccountMail } = require('./_account-mail');
const { mutateAccountIndex, readAccountIndex } = require('./_account-store');
const { mutateDevice } = require('./_store');
const { reserveDeviceRegistration } = require('./_registry');

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_EMAIL_SENDS = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;

function accountRecoveryEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED || '').trim());
}

function normalizeEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(raw)) return '';
  const local = raw.split('@')[0];
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !raw.includes('..') ? raw : '';
}

function publicAccount(record) {
  const account = record && record.account;
  const verified = Boolean(account && account.indexLinked === true && normalizeEmail(account.email) &&
    Number.isFinite(Date.parse(account.verifiedAt || '')));
  return { email: verified ? account.email : null, verified };
}

function assertAccountConfigured(dependencies = {}) {
  if (!accountRecoveryEnabled()) throw new HttpError(503, 'account_recovery_disabled');
  const config = (dependencies.configuredAccountMail || configuredAccountMail)();
  if (!config) throw new HttpError(503, 'account_mail_not_configured');
}

function requireVerifiedAccount(record) {
  if (!accountRecoveryEnabled()) return;
  assertAccountConfigured();
  if (!publicAccount(record).verified) throw new HttpError(403, 'email_verification_required');
}

function nowMs(dependencies) {
  return Number.isFinite(dependencies.now) ? dependencies.now : Date.now();
}

function requestCredentials(req) {
  const credentials = deviceCredentials(req);
  if (!normalizeDeviceId(credentials.deviceId) || !normalizeDeviceSecret(credentials.deviceSecret)) {
    throw new HttpError(401, 'device_auth_required');
  }
  return credentials;
}

function codeDigest(code, email, purpose, challengeId) {
  const normalized = String(code || '').replace(/[\s-]/g, '').toUpperCase();
  return crypto.createHmac('sha256', configuredDataKey())
    .update(`account-code:v1:${purpose}:${email}:${challengeId}:`).update(normalized).digest('hex');
}

function newChallenge(email, purpose, timestamp, dependencies) {
  const code = dependencies.newCode ? dependencies.newCode() : crypto.randomBytes(12).toString('hex').toUpperCase();
  const id = crypto.randomBytes(16).toString('hex');
  return { code, challenge: { id, email, purpose, codeHash: codeDigest(code, email, purpose, id),
    createdAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + CODE_TTL_MS).toISOString(),
    attempts: 0, consumedAt: null } };
}

function consumeChallenge(challenge, code, email, purpose, timestamp) {
  if (!challenge || challenge.email !== email || challenge.purpose !== purpose ||
      challenge.consumedAt || Date.parse(challenge.expiresAt) <= timestamp ||
      !Number.isFinite(Date.parse(challenge.expiresAt)) || challenge.attempts >= MAX_CODE_ATTEMPTS) return false;
  challenge.attempts = Number(challenge.attempts || 0) + 1;
  const actual = Buffer.from(codeDigest(code, email, purpose, challenge.id), 'hex');
  const expected = Buffer.from(String(challenge.codeHash || ''), 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  challenge.consumedAt = new Date(timestamp).toISOString();
  return true;
}

function sentResponse() {
  return { success: true, sent: true, expiresInSeconds: CODE_TTL_MS / 1000, resendAfterSeconds: RESEND_MS / 1000 };
}

async function reserveEmailSend(email, timestamp, dependencies) {
  const mutate = dependencies.mutateAccountIndex || mutateAccountIndex;
  return mutate(email, (index) => {
    const previous = Number(index.lastSentAt || 0);
    const sameWindow = timestamp - Number(index.sendWindowStartedAt || 0) < SEND_WINDOW_MS;
    if ((previous && timestamp - previous < RESEND_MS) ||
        (sameWindow && Number(index.sendCount || 0) >= MAX_EMAIL_SENDS)) {
      return { changed: false, value: { allowed: false } };
    }
    index.lastSentAt = timestamp;
    index.sendWindowStartedAt = sameWindow ? index.sendWindowStartedAt : timestamp;
    index.sendCount = sameWindow ? Number(index.sendCount || 0) + 1 : 1;
    return { changed: true, value: { allowed: true } };
  }, dependencies.accountStore);
}

async function requestEmailVerification(req, rawEmail, dependencies = {}) {
  assertAccountConfigured(dependencies);
  const email = normalizeEmail(rawEmail);
  if (!email) throw new HttpError(400, 'invalid_email');
  const authenticate = dependencies.authenticateDevice || authenticateDevice;
  const loaded = await authenticate(req, { allowCreate: true });
  const ownAccount = publicAccount(loaded.record);
  if (ownAccount.verified) {
    if (ownAccount.email !== email) throw new HttpError(409, 'account_email_locked');
    return sentResponse();
  }
  const timestamp = nowMs(dependencies);
  const reservation = await reserveEmailSend(email, timestamp, dependencies);
  if (!reservation.value.allowed) return sentResponse();
  const send = dependencies.sendAccountMail || sendAccountMail;
  if (reservation.index.deviceId && reservation.index.deviceId !== loaded.record.deviceId) {
    await send({ email, purpose: 'existing' });
    return sentResponse();
  }
  const { code, challenge } = newChallenge(email, 'verification', timestamp, dependencies);
  const mutate = dependencies.mutateAuthenticatedDevice || mutateAuthenticatedDevice;
  let reserved = false;
  await mutate(req, { allowCreate: true }, async (record, context) => {
    if (publicAccount(record).verified) throw new HttpError(409, 'account_email_locked');
    if (context.created && !reserved) {
      await (dependencies.reserveDeviceRegistration || reserveDeviceRegistration)(record, dependencies.registry);
      reserved = true;
    }
    record.account = { ...record.account, emailChallenge: challenge, pendingVerificationId: null };
    record.updatedAt = new Date(timestamp).toISOString();
    return { changed: true, record };
  });
  await send({ email, code, purpose: 'verification' });
  return sentResponse();
}

async function verifyEmail(req, rawEmail, code, dependencies = {}) {
  assertAccountConfigured(dependencies);
  const email = normalizeEmail(rawEmail);
  if (!email) throw new HttpError(400, 'invalid_email');
  const timestamp = nowMs(dependencies);
  const mutateAuth = dependencies.mutateAuthenticatedDevice || mutateAuthenticatedDevice;
  const consumed = await mutateAuth(req, null, (record) => {
    const account = record.account || {};
    const challenge = account.emailChallenge;
    const valid = !publicAccount(record).verified && consumeChallenge(challenge, code, email, 'verification', timestamp);
    if (valid) {
      account.pendingEmail = email;
      account.pendingVerificationId = challenge.id;
    }
    record.account = account;
    return { changed: Boolean(challenge), record, value: { valid, verificationId: valid ? challenge.id : null } };
  });
  if (!consumed.value.valid) throw new HttpError(400, 'account_code_invalid');
  const mutateIndex = dependencies.mutateAccountIndex || mutateAccountIndex;
  await mutateIndex(email, (index) => {
    if (index.deviceId && index.deviceId !== consumed.record.deviceId) {
      throw new HttpError(400, 'account_code_invalid');
    }
    index.deviceId = consumed.record.deviceId;
    index.linkedAt = new Date(timestamp).toISOString();
    return { changed: true };
  }, dependencies.accountStore);
  const saved = await mutateAuth(req, null, (record) => {
    if (!record.account || record.account.pendingVerificationId !== consumed.value.verificationId ||
        record.account.pendingEmail !== email) throw new HttpError(400, 'account_code_invalid');
    record.account.email = email;
    record.account.verifiedAt = new Date(timestamp).toISOString();
    record.account.indexLinked = true;
    record.account.pendingEmail = null;
    record.account.pendingVerificationId = null;
    record.updatedAt = new Date(timestamp).toISOString();
    return { changed: true, record };
  });
  return { success: true, account: publicAccount(saved.record), entitlement: publicEntitlement(saved.record, timestamp) };
}

async function requestRecovery(req, rawEmail, dependencies = {}) {
  assertAccountConfigured(dependencies);
  requestCredentials(req);
  const email = normalizeEmail(rawEmail);
  if (!email) throw new HttpError(400, 'invalid_email');
  const timestamp = nowMs(dependencies);
  const reservation = await reserveEmailSend(email, timestamp, dependencies);
  if (!reservation.value.allowed) return sentResponse();
  const send = dependencies.sendAccountMail || sendAccountMail;
  if (!reservation.index.deviceId) {
    // Both known and unknown addresses take the mail path. Only the inbox owner
    // learns whether the address is registered; HTTP results stay identical.
    await send({ email, purpose: 'recovery-unavailable' }).catch(() => {});
    return sentResponse();
  }
  const { code, challenge } = newChallenge(email, 'recovery', timestamp, dependencies);
  const mutate = dependencies.mutateDevice || mutateDevice;
  const saved = await mutate(reservation.index.deviceId, (record) => {
    if (!record || !publicAccount(record).verified || record.account.email !== email) {
      return { changed: false, record, value: { send: false } };
    }
    record.account.recoveryChallenge = challenge;
    record.updatedAt = new Date(timestamp).toISOString();
    return { changed: true, record, value: { send: true } };
  }, dependencies.deviceStore);
  if (saved.value.send) {
    // Delivery failure must not reveal whether an email has an account.
    await send({ email, code, purpose: 'recovery' }).catch(() => {});
  } else await send({ email, purpose: 'recovery-unavailable' }).catch(() => {});
  return sentResponse();
}

async function recoverAccount(req, rawEmail, code, dependencies = {}) {
  assertAccountConfigured(dependencies);
  requestCredentials(req);
  const email = normalizeEmail(rawEmail);
  if (!email) throw new HttpError(400, 'invalid_email');
  const loaded = await (dependencies.readAccountIndex || readAccountIndex)(email, dependencies.accountStore);
  if (!loaded.index || !loaded.index.deviceId) throw new HttpError(400, 'account_code_invalid');
  const timestamp = nowMs(dependencies);
  // Generate once outside the CAS callback. A retry must not reactivate an earlier credential.
  const deviceSecret = crypto.randomBytes(32).toString('base64url');
  const secretHash = hashDeviceSecret(loaded.index.deviceId, deviceSecret);
  const mutate = dependencies.mutateDevice || mutateDevice;
  const saved = await mutate(loaded.index.deviceId, (record) => {
    if (!record || !publicAccount(record).verified || record.account.email !== email) {
      return { changed: false, record, value: { valid: false } };
    }
    const challenge = record.account.recoveryChallenge;
    const valid = consumeChallenge(challenge, code, email, 'recovery', timestamp);
    if (valid) {
      record.secretHash = secretHash;
      record.push = { active: false, subscription: null, updatedAt: new Date(timestamp).toISOString() };
      record.pendingNotifications = [];
      record.account.recoveredAt = new Date(timestamp).toISOString();
      record.account.credentialVersion = Number(record.account.credentialVersion || 0) + 1;
      // Invalidate any older enrollment challenge together with the old credential.
      record.account.emailChallenge = null;
      record.account.pendingVerificationId = null;
      record.updatedAt = new Date(timestamp).toISOString();
    }
    return { changed: Boolean(challenge), record, value: { valid } };
  }, dependencies.deviceStore);
  if (!saved.value.valid) throw new HttpError(400, 'account_code_invalid');
  return { success: true, account: publicAccount(saved.record), entitlement: publicEntitlement(saved.record, timestamp),
    credentials: { deviceId: saved.record.deviceId, deviceSecret } };
}

async function accountStatus(req, dependencies = {}) {
  const loaded = await (dependencies.authenticateDevice || authenticateDevice)(req, { allowCreate: true });
  const recoveryEnabled = accountRecoveryEnabled();
  const account = publicAccount(loaded.record);
  return { success: true, recoveryEnabled,
    available: Boolean(recoveryEnabled && (dependencies.configuredAccountMail || configuredAccountMail)()),
    emailRequired: recoveryEnabled && !account.verified, account,
    entitlement: publicEntitlement(loaded.record, nowMs(dependencies)) };
}

async function recordVisit(req, visitId, dependencies = {}) {
  if (typeof visitId !== 'string' || !/^[A-Za-z0-9_-]{20,80}$/.test(visitId)) {
    throw new HttpError(400, 'invalid_visit_id');
  }
  const timestamp = nowMs(dependencies);
  const mutate = dependencies.mutateAuthenticatedDevice || mutateAuthenticatedDevice;
  await mutate(req, { allowCreate: false }, (record) => {
    const activity = record.activity || {};
    const recentVisits = Array.from(new Set((Array.isArray(activity.recentVisits) ? activity.recentVisits : [])
      .filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(id)))).slice(-64);
    const isNewVisit = !recentVisits.includes(visitId);
    const previousCount = Number.isSafeInteger(activity.visitCount) && activity.visitCount >= 0 ? activity.visitCount : 0;
    const previousSeen = Date.parse(activity.lastSeenAt || '');
    const lastSeenAt = new Date(Math.max(Number.isFinite(previousSeen) ? previousSeen : 0, timestamp)).toISOString();
    if (!isNewVisit && activity.lastSeenAt === lastSeenAt) return { changed: false, record };
    record.activity = {
      lastSeenAt,
      visitCount: Math.min(Number.MAX_SAFE_INTEGER, previousCount + Number(isNewVisit)),
      recentVisits: isNewVisit ? [...recentVisits, visitId].slice(-64) : recentVisits
    };
    const previousUpdated = Date.parse(record.updatedAt || '');
    record.updatedAt = new Date(Math.max(Number.isFinite(previousUpdated) ? previousUpdated : 0, timestamp)).toISOString();
    return { changed: true, record };
  });
  return { success: true };
}

module.exports = { CODE_TTL_MS, MAX_CODE_ATTEMPTS, accountRecoveryEnabled, accountStatus, codeDigest,
  consumeChallenge, normalizeEmail, publicAccount, recoverAccount, requestEmailVerification,
  requestRecovery, requireVerifiedAccount, verifyEmail, recordVisit };
