const { mutateAuthenticatedDevice } = require('./_auth');
const {
  applyLifetimePromotion,
  configuredPromotion,
  entitlementFeatureEnabled,
  promotionMatches,
  publicEntitlement
} = require('./_entitlement');
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
  releaseActiveDeviceReservation,
  reserveActiveDevice,
  reserveDeviceRegistration
} = require('./_registry');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    assertSameOrigin(req);
    await consumeRateLimit(req, 'promotion');
    const body = await readJson(req);
    const configuration = configuredPromotion();
    if (
      !entitlementFeatureEnabled() ||
      !configuration ||
      !promotionMatches(body && body.code, configuration)
    ) {
      throw new HttpError(400, 'promotion_invalid');
    }
    const now = new Date().toISOString();
    let registrationReserved = false;
    let activeReservation = null;
    let saved;
    try {
      saved = await mutateAuthenticatedDevice(
        req,
        { allowCreate: true },
        async (record, context) => {
          const reservation = await reserveActiveDevice(record);
          if (reservation.created && !activeReservation) {
            activeReservation = {
              deviceId: record.deviceId,
              revision: Math.max(0, Number(record.revision || 0))
            };
          }
          if (context.created && !registrationReserved) {
            await reserveDeviceRegistration(record);
            registrationReserved = true;
          }
          const result = applyLifetimePromotion(record, configuration.publicId, now);
          if (result.changed) record.updatedAt = now;
          return {
            changed: result.changed,
            record,
            value: {
              idempotent: !result.changed,
              entitlement: publicEntitlement(record)
            }
          };
        }
      );
    } catch (error) {
      if (activeReservation) {
        await releaseActiveDeviceReservation(activeReservation).catch(() => {});
      }
      throw error;
    }
    return sendJson(res, 200, {
      success: true,
      idempotent: saved.value.idempotent,
      entitlement: saved.value.entitlement
    });
  } catch (error) {
    return handleHttpError(res, error);
  }
};
