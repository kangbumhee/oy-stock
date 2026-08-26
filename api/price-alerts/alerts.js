const { authenticateDevice, mutateAuthenticatedDevice } = require('./_auth');
const { requireActiveEntitlement } = require('./_entitlement');
const {
  MAX_ALERTS_PER_DEVICE,
  alertIdFor,
  normalizeGoodsNo,
  normalizeOptionNumber,
  publicAlert,
  removeAlert,
  upsertAlert
} = require('./_core');
const {
  HttpError,
  assertSameOrigin,
  handleHttpError,
  methodNotAllowed,
  readJson,
  sendJson
} = require('./_http');
const { consumeRateLimit } = require('./_limits');
const {
  recordIsDisposable,
  recordNeedsHourlyWork,
  reserveActiveDevice,
  tombstoneRecord
} = require('./_registry');

function requestedAlertIdentity(req, body) {
  const goodsNo = normalizeGoodsNo(
    (req.query && req.query.goodsNo) || (body && body.goodsNo) || ''
  );
  const rawOptionNumber = String(
    (req.query && req.query.optionNumber) || (body && body.optionNumber) || ''
  ).trim();
  const optionNumber = rawOptionNumber ? normalizeOptionNumber(rawOptionNumber) : '';
  return {
    goodsNo,
    optionNumber,
    valid: Boolean(goodsNo && (!rawOptionNumber || optionNumber))
  };
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  }

  try {
    if (req.method !== 'GET') assertSameOrigin(req);
    if (req.method === 'GET') {
      const loaded = await authenticateDevice(req);
      const alerts = Array.isArray(loaded.record.alerts) ? loaded.record.alerts : [];
      return sendJson(res, 200, {
        success: true,
        alerts: alerts.filter((item) => item && item.enabled !== false).map(publicAlert),
        maxAlerts: MAX_ALERTS_PER_DEVICE,
        subscribed: Boolean(
          loaded.record.push && loaded.record.push.active && loaded.record.push.subscription
        )
      });
    }

    await consumeRateLimit(req, 'mutation');
    const body = await readJson(req);
    const now = new Date().toISOString();
    if (req.method === 'POST') {
      const saved = await mutateAuthenticatedDevice(req, null, async (record) => {
        requireActiveEntitlement(record);
        const wasActive = recordNeedsHourlyWork(record);
        const result = upsertAlert(record, body, now);
        if (result.error === 'alert_limit_reached') {
          throw new HttpError(409, 'alert_limit_reached');
        }
        if (result.error) throw new HttpError(400, result.error);
        if (!wasActive && recordNeedsHourlyWork(record)) {
          await reserveActiveDevice(record);
        }
        return { changed: true, value: { alert: result.alert } };
      });
      return sendJson(res, 200, {
        success: true,
        alert: publicAlert(saved.value.alert)
      });
    }

    const requested = requestedAlertIdentity(req, body);
    if (!requested.valid) throw new HttpError(400, 'invalid_alert_identity');
    const removed = await mutateAuthenticatedDevice(req, null, (record) => {
      const didRemove = removeAlert(
        record,
        requested.goodsNo,
        requested.optionNumber,
        now
      );
      return {
        changed: didRemove,
        record: didRemove && recordIsDisposable(record) ? tombstoneRecord(record, now) : record,
        value: { removed: didRemove }
      };
    });
    return sendJson(res, 200, {
      success: true,
      removed: removed.value.removed,
      alertId: alertIdFor(requested.goodsNo, requested.optionNumber),
      goodsNo: requested.goodsNo,
      optionNumber: requested.optionNumber || null
    });
  } catch (error) {
    return handleHttpError(res, error);
  }
};
