const { authenticateDevice } = require('./_auth');
const {
  configuredPromotion,
  entitlementFeatureEnabled,
  publicEntitlement
} = require('./_entitlement');
const { handleHttpError, methodNotAllowed, sendJson } = require('./_http');
const { configuredPortOne } = require('./_portone');
const { activeDeviceCapacity } = require('./_registry');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const loaded = await authenticateDevice(req, { allowCreate: true });
    const paymentConfiguration = configuredPortOne();
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
        entitlementFeatureEnabled() && configuredPromotion()
      ),
      entitlement: publicEntitlement(loaded.record)
    });
  } catch (error) {
    return handleHttpError(res, error);
  }
};
