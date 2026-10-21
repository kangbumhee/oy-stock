const { mutateAuthenticatedDevice } = require('./_auth');
const {
  applyThirtyDayPromotion,
  configuredPromotion,
  entitlementFeatureEnabled,
  promotionMatches,
  publicEntitlement
} = require('./_entitlement');
const { resolvedPromotion } = require('./_promotion-settings');
const { publicAccount } = require('./_account-service');
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
  reserveActiveDevice
} = require('./_registry');

function createPromotionHandler(dependencies = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    try {
      assertSameOrigin(req);
      await (dependencies.consumeRateLimit || consumeRateLimit)(req, 'promotion');
      const body = await readJson(req);
      if (!entitlementFeatureEnabled() || !body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((key) => key !== 'code')) {
        throw new HttpError(400, 'promotion_invalid');
      }
      const entryConfiguration = (dependencies.configuredPromotion || configuredPromotion)();
      const entryMatches = promotionMatches(body.code, entryConfiguration);
      // The entry password is an explicitly authorized, separate invitation.
      // Non-entry invitations still resolve current admin settings fail-closed;
      // a settings outage must never resurrect a previously replaced admin key.
      const configuration = entryMatches ? entryConfiguration :
        await (dependencies.resolvedPromotion || resolvedPromotion)();
      if (!configuration || !promotionMatches(body.code, configuration)) {
        throw new HttpError(400, 'promotion_invalid');
      }
      const now = new Date(Number.isFinite(dependencies.now) ? dependencies.now : Date.now()).toISOString();
      let activeReservation = null;
      let saved;
      try {
        saved = await (dependencies.mutateAuthenticatedDevice || mutateAuthenticatedDevice)(
          req,
          { allowCreate: false },
          async (record) => {
            const previousPromotion = record.entitlement && Array.isArray(record.entitlement.grants) &&
              record.entitlement.grants.some((grant) => grant && grant.source === 'promotion');
            // Email verification creates and canonically links the account. It
            // is required even if optional payment-email enforcement is disabled.
            if (!previousPromotion && !publicAccount(record).verified) {
              throw new HttpError(403, 'email_verification_required');
            }
            const result = applyThirtyDayPromotion(record, now);
            const reservation = result.changed ?
              await (dependencies.reserveActiveDevice || reserveActiveDevice)(record) : null;
            if (reservation && reservation.created) {
              // A CAS retry can create a replacement reservation after another
              // writer removed the previous one. Roll back the latest slot we
              // actually created, without touching a newer committed revision.
              activeReservation = {
                deviceId: record.deviceId,
                revision: Math.max(0, Number(record.revision || 0))
              };
            }
            if (result.changed) record.updatedAt = now;
            return {
              changed: result.changed,
              record,
              value: {
                idempotent: !result.changed,
                entitlement: publicEntitlement(record, Date.parse(now))
              }
            };
          }
        );
      } catch (error) {
        if (activeReservation) {
          await (dependencies.releaseActiveDeviceReservation || releaseActiveDeviceReservation)(activeReservation).catch(() => {});
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
}

module.exports = createPromotionHandler();
module.exports._test = { createPromotionHandler };
