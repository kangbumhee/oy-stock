const crypto = require('node:crypto');
const { BlobPreconditionFailedError, BlobUnknownError, get, put } = require('@vercel/blob');
const { configuredDataKey, decryptJson, encryptJson } = require('./_crypto');
const { configuredPromotion, promotionDigest } = require('./_entitlement');
const { HttpError } = require('./_http');
const { configuredStoreRoot } = require('./_registry');

const MAX_ACTIONS = 2000;

function settingsPath() {
  return `${configuredStoreRoot()}settings/promotion.enc`;
}

function configurationFromSettings(settings) {
  if (!settings || settings.version !== 1 || typeof settings.pepper !== 'string' ||
      settings.pepper.length < 32 || !/^[A-Za-z0-9_-]{43}$/.test(settings.digest || '') ||
      !Array.isArray(settings.actions) || settings.actions.length > MAX_ACTIONS) {
    throw new HttpError(503, 'promotion_settings_unavailable');
  }
  const digest = Buffer.from(settings.digest, 'base64url');
  return {
    pepper: settings.pepper, digest,
    publicId: crypto.createHash('sha256').update(digest).digest('hex').slice(0, 24)
  };
}

async function readPromotionSettings(dependencies = {}) {
  try {
    const response = await (dependencies.get || get)(settingsPath(), {
      access: 'private', useCache: false, abortSignal: AbortSignal.timeout(10000)
    });
    if (!response) return { settings: null, etag: '' };
    if (response.statusCode !== 200 || !response.stream) throw new Error('settings read failed');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.stream) {
      bytes += chunk.length;
      if (bytes > 768 * 1024) throw new Error('settings too large');
      chunks.push(Buffer.from(chunk));
    }
    const settings = decryptJson(Buffer.concat(chunks).toString('utf8'), configuredDataKey());
    configurationFromSettings(settings);
    const etag = String((response.blob || {}).etag || '');
    if (!etag) throw new Error('settings ETag missing');
    return { settings, etag };
  } catch (_) {
    throw new HttpError(503, 'promotion_settings_unavailable');
  }
}

async function resolvedPromotion(dependencies = {}) {
  const loaded = await (dependencies.readPromotionSettings || readPromotionSettings)(dependencies);
  // Only a confirmed absent override permits the original environment code.
  // A storage failure must never silently reactivate a replaced code.
  return loaded.settings ? configurationFromSettings(loaded.settings) : configuredPromotion();
}

function publicPromotionSettings(settings) {
  return {
    configured: Boolean(settings || configuredPromotion()),
    updatedAt: settings ? settings.updatedAt : null,
    updatedBy: settings ? settings.updatedBy : null,
    audit: settings ? settings.actions.slice(-20).reverse().map((item) => ({
      changedAt: item.changedAt, actorEmail: item.actorEmail
    })) : []
  };
}

async function setPromotionCode(command, administrator, dependencies = {}) {
  const { code, actionId, reason } = command || {};
  if (administrator.email !== 'kbhjjan@gmail.com' ||
      typeof code !== 'string' || code.length < 6 || code.length > 160 || /[\u0000-\u001f\u007f]/.test(code) ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(String(actionId || '')) ||
      typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new HttpError(400, 'invalid_promotion_update');
  }
  const key = configuredDataKey();
  const requestDigest = crypto.createHmac('sha256', key).update('promotion-admin-action:v1:').update(JSON.stringify([actionId, code, reason.trim()])).digest('base64url');
  const pepper = crypto.randomBytes(32).toString('base64url');
  const digest = promotionDigest(code, pepper);
  const changedAt = new Date(Number.isFinite(dependencies.now) ? dependencies.now : Date.now()).toISOString();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const loaded = await (dependencies.readPromotionSettings || readPromotionSettings)(dependencies);
    const actions = loaded.settings ? loaded.settings.actions : [];
    const existing = actions.find((item) => item.actionId === actionId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new HttpError(409, 'admin_action_conflict');
      return { idempotent: true, settings: publicPromotionSettings(loaded.settings) };
    }
    if (actions.length >= MAX_ACTIONS) throw new HttpError(503, 'promotion_audit_capacity_reached');
    const settings = {
      version: 1, revision: Number(loaded.settings && loaded.settings.revision || 0) + 1,
      pepper, digest, updatedAt: changedAt, updatedBy: administrator.email,
      actions: [...actions, { actionId, requestDigest, changedAt, actorEmail: administrator.email }]
    };
    try {
      await (dependencies.put || put)(settingsPath(), encryptJson(settings, key), {
        access: 'private', addRandomSuffix: false, allowOverwrite: Boolean(loaded.etag),
        ...(loaded.etag ? { ifMatch: loaded.etag } : {}),
        contentType: 'application/octet-stream', cacheControlMaxAge: 60
      });
      return { idempotent: false, settings: publicPromotionSettings(settings) };
    } catch (error) {
      const conflict = error instanceof BlobPreconditionFailedError || error instanceof BlobUnknownError ||
        [409, 412].includes(Number(error && (error.statusCode || error.status))) ||
        /precondition|etag mismatch|already exists|overwrite/i.test(String(error && error.message));
      if (conflict && attempt < 7) continue;
      throw new HttpError(503, 'promotion_settings_unavailable');
    }
  }
  throw new HttpError(503, 'promotion_settings_unavailable');
}

module.exports = { configurationFromSettings, publicPromotionSettings, readPromotionSettings, resolvedPromotion, setPromotionCode, settingsPath };
