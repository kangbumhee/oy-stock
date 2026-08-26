const { authenticateDevice } = require('./_auth');
const { normalizePaymentId } = require('./_entitlement');
const { reconcilePayment } = require('./_payment-service');
const { configuredPortOne } = require('./_portone');
const {
  HttpError,
  assertSameOrigin,
  handleHttpError,
  methodNotAllowed,
  readJson,
  sendJson
} = require('./_http');
const { consumeRateLimit } = require('./_limits');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    assertSameOrigin(req);
    await consumeRateLimit(req, 'payment_complete');
    const body = await readJson(req);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, 'paymentId') ||
      !normalizePaymentId(body.paymentId)
    ) {
      throw new HttpError(400, 'invalid_payment_request');
    }
    const config = configuredPortOne();
    if (!config) throw new HttpError(503, 'payment_not_configured');
    const loaded = await authenticateDevice(req);
    const result = await reconcilePayment(
      body && body.paymentId,
      loaded.record.deviceId,
      config
    );
    if (result.unknown) throw new HttpError(404, 'payment_not_found');
    return sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    return handleHttpError(res, error);
  }
};
