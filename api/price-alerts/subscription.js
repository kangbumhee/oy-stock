const { mutateAuthenticatedDevice } = require('./_auth');
const { normalizePushSubscription } = require('./_core');
const { requireActiveEntitlement } = require('./_entitlement');
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
  reserveDeviceRegistration,
  tombstoneRecord
} = require('./_registry');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return methodNotAllowed(res, ['POST', 'DELETE']);
  }

  try {
    assertSameOrigin(req);
    await consumeRateLimit(req, 'mutation');
    const now = new Date().toISOString();

    if (req.method === 'POST') {
      const body = await readJson(req);
      const subscription = normalizePushSubscription(body);
      if (!subscription) throw new HttpError(400, 'invalid_push_subscription');
      let creationRateConsumed = false;
      const saved = await mutateAuthenticatedDevice(
        req,
        { allowCreate: true },
        async (record, context) => {
          requireActiveEntitlement(record);
          if (context.created) {
            if (!creationRateConsumed) {
              await consumeRateLimit(req, 'create');
              creationRateConsumed = true;
            }
            await reserveDeviceRegistration(record);
          }
          record.push = { active: true, subscription, updatedAt: now };
          record.updatedAt = now;
          return { changed: true, value: { created: context.created } };
        }
      );
      return sendJson(res, saved.value.created ? 201 : 200, {
        success: true,
        subscribed: true
      });
    }

    await mutateAuthenticatedDevice(req, null, (record) => {
      record.push = { active: false, subscription: null, updatedAt: now };
      record.updatedAt = now;
      return {
        changed: true,
        record: recordIsDisposable(record) ? tombstoneRecord(record, now) : record
      };
    });
    return sendJson(res, 200, { success: true, subscribed: false });
  } catch (error) {
    return handleHttpError(res, error);
  }
};
