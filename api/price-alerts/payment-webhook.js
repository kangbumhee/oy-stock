const { reconcilePayment } = require('./_payment-service');
const { normalizePaymentId } = require('./_entitlement');
const { configuredPortOne } = require('./_portone');
const {
  handleHttpError,
  methodNotAllowed,
  readJson,
  sendJson
} = require('./_http');
const { consumeRateLimit } = require('./_limits');

const KNOWN_EVENTS = new Set([
  'Transaction.Paid',
  'Transaction.Cancelled',
  'Transaction.PartialCancelled',
  'Transaction.Failed',
  'Transaction.PayPending',
  'Transaction.Ready'
]);

function webhookPaymentId(body) {
  if (!body || !KNOWN_EVENTS.has(String(body.type || ''))) return '';
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  return normalizePaymentId(data.paymentId || body.paymentId);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    await consumeRateLimit(req, 'payment_webhook');
    const body = await readJson(req, 64 * 1024);
    const paymentId = webhookPaymentId(body);
    if (!paymentId) return sendJson(res, 202, { success: true, accepted: false });
    const config = configuredPortOne();
    if (!config) return sendJson(res, 503, { success: false, error: 'payment_not_configured' });
    const result = await reconcilePayment(paymentId, null, config);
    if (result.unknown) return sendJson(res, 202, { success: true, accepted: false });
    return sendJson(res, 200, {
      success: true,
      accepted: true,
      paymentId: result.paymentId,
      status: result.status
    });
  } catch (error) {
    return handleHttpError(res, error);
  }
};

module.exports._test = { webhookPaymentId };
