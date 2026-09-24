const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);

function unexpectedPaymentDiagnostic(error) {
  const frames = String(error && error.stack || '').split('\n').slice(1, 12)
    .map((line) => line.match(/(?:[/\\])((?:_payment-service|_payment-store|_portone|_auth|_store|_registry|_crypto|payment-create)\.js:\d+:\d+)/))
    .filter(Boolean).map((match) => match[1]).slice(0, 6);
  return {
    phase: 'payment_create_unexpected',
    errorType: SAFE_ERROR_NAMES.has(error && error.name) ? error.name : 'Error',
    frames
  };
}

module.exports = { unexpectedPaymentDiagnostic };
