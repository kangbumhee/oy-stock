const test = require('node:test');
const assert = require('node:assert/strict');
const { unexpectedPaymentDiagnostic } = require('../api/price-alerts/_payment-diagnostics');

test('payment diagnostics expose only fixed error class and allowlisted source locations', () => {
  const error = new TypeError('credential=SECRET customer@example.com');
  error.stack = 'TypeError: SECRET\n at f (/private/customer@example.com/api/price-alerts/_payment-service.js:123:4)\n at f (/private/SECRET/unknown.js:4:5)';
  assert.deepEqual(unexpectedPaymentDiagnostic(error), {
    phase: 'payment_create_unexpected', errorType: 'TypeError', frames: ['_payment-service.js:123:4']
  });
  assert.doesNotMatch(JSON.stringify(unexpectedPaymentDiagnostic(error)), /SECRET|customer@example/);
});

test('unknown error names and missing stacks never echo arbitrary data', () => {
  assert.deepEqual(unexpectedPaymentDiagnostic({name:'SECRET',message:'SECRET'}), {
    phase: 'payment_create_unexpected', errorType: 'Error', frames: []
  });
});
