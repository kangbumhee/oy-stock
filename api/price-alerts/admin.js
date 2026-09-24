const { get, list } = require('@vercel/blob');
const { authenticateAdmin, configuredGoogleClientId } = require('./_admin-auth');
const { normalizeDeviceId } = require('./_core');
const { configuredDataKey, decryptJson } = require('./_crypto');
const { applyAdminExtension, entitlementFeatureEnabled, entitlementGrants, publicEntitlement } = require('./_entitlement');
const { HttpError, assertSameOrigin, handleHttpError, methodNotAllowed, readJson, sendJson } = require('./_http');
const { configuredStoreRoot, recordClaimsActiveCapacity, releaseActiveDeviceReservation, reserveActiveDevice } = require('./_registry');
const { mutateDevice, readDevice } = require('./_store');
const { publicPromotionSettings, readPromotionSettings, setPromotionCode } = require('./_promotion-settings');

function adminRecord(record) {
  const account = record.account || {};
  return {
    deviceId: record.deviceId,
    email: account.indexLinked === true && account.verifiedAt ? String(account.email || '').slice(0, 254) : null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    entitlement: publicEntitlement(record),
    sources: [...new Set(entitlementGrants(record).filter((grant) => grant && !grant.revokedAt &&
      ['payment', 'promotion', 'admin'].includes(grant.source)).map((grant) => grant.source))],
    lastSeenAt: record.activity && Number.isFinite(Date.parse(record.activity.lastSeenAt)) ? record.activity.lastSeenAt : null,
    visitCount: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(record.activity && record.activity.visitCount) || 0))),
    alertCount: (record.alerts || []).length,
    activeAlertCount: (record.alerts || []).filter((alert) => alert && alert.enabled !== false).length,
    pushActive: Boolean(record.push && record.push.active),
    audit: entitlementGrants(record).filter((grant) => grant && grant.source === 'admin').slice(-20).reverse().map((grant) => ({
      actionId: grant.actionId,
      durationDays: grant.durationDays,
      reason: String(grant.reason || '').slice(0, 200),
      actorEmail: grant.actorEmail,
      grantedAt: grant.grantedAt,
      endsAt: grant.endsAt,
      revokedAt: grant.revokedAt || null
    }))
  };
}

async function listAdminRecords(query, dependencies = {}) {
  const limit = query.limit == null ? 20 : Number(query.limit);
  const cursor = query.cursor == null ? '' : String(query.cursor);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || cursor.length > 2048 ||
      /[\u0000-\u0020\u007f]/.test(cursor)) throw new HttpError(400, 'invalid_admin_page');
  const prefix = `${configuredStoreRoot()}indexes/registered/`;
  const page = await (dependencies.list || list)({ prefix, limit, ...(cursor ? { cursor } : {}) });
  const blobs = Array.isArray(page && page.blobs) ? page.blobs.slice(0, limit) : [];
  const records = [];
  let unreadableCount = 0;
  // One provider page per request and five concurrent private reads at most.
  for (let offset = 0; offset < blobs.length; offset += 5) {
    const rows = await Promise.all(blobs.slice(offset, offset + 5).map(async (blob) => {
      try {
        const pathname = String(blob.pathname || '');
        if (!pathname.startsWith(prefix) || !/^[a-f0-9]\/[a-f0-9]{64}\.idx$/.test(pathname.slice(prefix.length))) return null;
        const signal = AbortSignal.timeout(10000);
        const result = await (dependencies.get || get)(pathname, { access: 'private', useCache: false, abortSignal: signal });
        if (!result || !result.stream || result.statusCode !== 200) return null;
        const chunks = [];
        let bytes = 0;
        for await (const chunk of result.stream) {
          bytes += chunk.length;
          if (bytes > 65536) throw new Error('index too large');
          chunks.push(Buffer.from(chunk));
        }
        const ref = decryptJson(Buffer.concat(chunks).toString('utf8'), configuredDataKey());
        if (!ref || ref.version !== 1 || ref.kind !== 'registered' || ref.deletedAt || !normalizeDeviceId(ref.deviceId)) return null;
        const loaded = await (dependencies.readDevice || readDevice)(ref.deviceId);
        return loaded.record && !loaded.record.deletedAt ? adminRecord(loaded.record) : null;
      } catch (_) {
        return null;
      }
    }));
    rows.forEach((record) => { if (record) records.push(record); else unreadableCount += 1; });
  }
  return { records, unreadableCount, nextCursor: page && page.hasMore && typeof page.cursor === 'string' ? page.cursor : null };
}

async function extendAdminRecord(body, administrator, dependencies = {}) {
  if (!entitlementFeatureEnabled()) throw new HttpError(503, 'entitlement_not_configured');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_admin_extension');
  const deviceId = normalizeDeviceId(body.deviceId);
  if (!deviceId) throw new HttpError(400, 'invalid_device_id');
  const command = {
    actionId: body.actionId, durationDays: body.durationDays,
    reason: body.reason, actorEmail: administrator.email
  };
  const timestamp = new Date(Number.isFinite(dependencies.now) ? dependencies.now : Date.now()).toISOString();
  let reserved = false;
  try {
    const outcome = await (dependencies.mutateDevice || mutateDevice)(deviceId, async (record) => {
      if (!record || record.deletedAt) throw new HttpError(404, 'device_not_found');
      const result = applyAdminExtension(record, command, timestamp);
      if (result.changed) {
        const reservation = await (dependencies.reserveActiveDevice || reserveActiveDevice)(record);
        reserved = reserved || Boolean(reservation && reservation.created);
        record.updatedAt = timestamp;
      }
      return { record, changed: result.changed, value: { idempotent: !result.changed } };
    });
    return { record: adminRecord(outcome.record), idempotent: Boolean(outcome.value && outcome.value.idempotent) };
  } catch (error) {
    if (reserved) {
      try {
        const loaded = await (dependencies.readDevice || readDevice)(deviceId);
        if (loaded.record && !recordClaimsActiveCapacity(loaded.record)) {
          await (dependencies.releaseActiveDeviceReservation || releaseActiveDeviceReservation)(loaded.record);
        }
      } catch (_) { /* A reservation remains recoverable by registry maintenance. */ }
    }
    throw error;
  }
}

function createHandler(dependencies = {}) {
  return async function adminHandler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization');
    try {
      if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
      const query = req.query || Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
      if (req.method === 'GET' && query.action === 'config') {
        return sendJson(res, 200, { success: true, clientId: configuredGoogleClientId() || null });
      }
      const administrator = await authenticateAdmin(req, dependencies);
      if (req.method === 'POST') {
        if (!(req.headers || {}).origin) throw new HttpError(403, 'origin_required');
        assertSameOrigin(req);
        const body = await readJson(req, 4096);
        if (body && body.action === 'set-promotion') {
          const result = await setPromotionCode(body, administrator, dependencies);
          return sendJson(res, 200, { success: true, ...result });
        }
        if (!body || body.action !== 'extend') throw new HttpError(400, 'invalid_admin_action');
        const result = await extendAdminRecord(body, administrator, dependencies);
        return sendJson(res, 200, { success: true, ...result });
      }
      if (query.action === 'promotion-settings') {
        const loaded = await (dependencies.readPromotionSettings || readPromotionSettings)(dependencies);
        return sendJson(res, 200, { success: true, settings: publicPromotionSettings(loaded.settings) });
      }
      if (query.deviceId) {
        const deviceId = normalizeDeviceId(query.deviceId);
        if (!deviceId) throw new HttpError(400, 'invalid_device_id');
        const loaded = await (dependencies.readDevice || readDevice)(deviceId);
        if (!loaded.record || loaded.record.deletedAt) throw new HttpError(404, 'device_not_found');
        return sendJson(res, 200, { success: true, administrator: administrator.email, record: adminRecord(loaded.record) });
      }
      const page = await listAdminRecords(query, dependencies);
      return sendJson(res, 200, { success: true, administrator: administrator.email, ...page });
    } catch (error) {
      handleHttpError(res, error);
    }
  };
}

module.exports = createHandler();
module.exports._test = { adminRecord, createHandler, extendAdminRecord, listAdminRecords };
