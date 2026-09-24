const { authenticateDevice } = require('./_auth');
const {
  entitlementFeatureEnabled,
  publicEntitlement
} = require('./_entitlement');
const { handleHttpError, methodNotAllowed, sendJson } = require('./_http');
const { configuredPortOne } = require('./_portone');
const { activeDeviceCapacity } = require('./_registry');
const { resolvedPromotion } = require('./_promotion-settings');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const loaded = await authenticateDevice(req, { allowCreate: true });
    const paymentConfiguration = configuredPortOne();
    const promotionConfiguration = entitlementFeatureEnabled()
      ? await resolvedPromotion().catch(() => null) : null;
    let capacityAvailable = false;
    if (paymentConfiguration) {
      try {
        capacityAvailable = (await activeDeviceCapacity(loaded.record)).available;
      } catch (_) {
        capacityAvailable = false;
      }
    }
    return sendJson(res, 200, {
      success: true,
      enabled: entitlementFeatureEnabled(),
      paymentAvailable: Boolean(paymentConfiguration && capacityAvailable),
      promotionAvailable: Boolean(
        entitlementFeatureEnabled() && promotionConfiguration
      ),
      entitlement: publicEntitlement(loaded.record)
    });
  } catch (error) {
    return handleHttpError(res, error);
  }
};
