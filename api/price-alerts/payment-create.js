const { createPayment } = require('./_payment-service');
const { configuredPortOne } = require('./_portone');
const { authenticateDevice } = require('./_auth');
const { accountRecoveryEnabled, requireVerifiedAccount } = require('./_account-service');
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
    await consumeRateLimit(req, 'payment_create');
    const body = await readJson(req);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'idempotencyKey')
    ) {
      throw new HttpError(400, 'invalid_payment_request');
    }
    const config = configuredPortOne();
    if (!config) throw new HttpError(503, 'payment_not_configured');
    if (accountRecoveryEnabled()) {
      const loaded = await authenticateDevice(req, { allowCreate: true });
      requireVerifiedAccount(loaded.record);
    }
    const result = await createPayment(req, config, body.idempotencyKey);
    return sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    return handleHttpError(res, error);
  }
};
