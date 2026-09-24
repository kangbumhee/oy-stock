const { createPayment } = require('./_payment-service');
const { configuredPortOne } = require('./_portone');
const { authenticateDevice } = require('./_auth');
const { normalizeIdempotencyKey } = require('./_entitlement');
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
const { unexpectedPaymentDiagnostic } = require('./_payment-diagnostics');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    assertSameOrigin(req);
    const body = await readJson(req);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'idempotencyKey') ||
      !normalizeIdempotencyKey(body.idempotencyKey)
    ) {
      throw new HttpError(400, 'invalid_payment_request');
    }
    const config = configuredPortOne();
    if (!config) throw new HttpError(503, 'payment_not_configured');
    await consumeRateLimit(req, 'payment_auth');
    const loaded = await authenticateDevice(req, { allowCreate: true });
    if (accountRecoveryEnabled()) {
      requireVerifiedAccount(loaded.record);
    }
    // Unregistered legacy clients keep the network guard. Verified, persisted
    // devices get their own quota, shared across networks but not other users.
    await consumeRateLimit(req, 'payment_create', {
      authenticatedDeviceId: loaded.created ? undefined : loaded.record.deviceId
    });
    const result = await createPayment(req, config, body.idempotencyKey);
    return sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      try {
        console.error('[price-alert-payment]', JSON.stringify(unexpectedPaymentDiagnostic(error)));
      } catch (_) {
        // Logging must not replace the original response or expose its data.
      }
    }
    return handleHttpError(res, error);
  }
};
