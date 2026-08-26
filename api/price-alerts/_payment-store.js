const crypto = require('node:crypto');
const {
  BlobPreconditionFailedError,
  BlobUnknownError,
  get,
  put
} = require('@vercel/blob');
const { configuredDataKey, decryptJson, encryptJson } = require('./_crypto');
const { normalizePaymentId } = require('./_entitlement');
const { configuredStoreRoot } = require('./_registry');

const INTENT_VERSION = 1;
const MAX_MUTATION_ATTEMPTS = 8;

class PaymentIntentConflictError extends Error {
  constructor() {
    super('payment intent write conflict');
    this.name = 'PaymentIntentConflictError';
  }
}

function intentPath(paymentId, key) {
  const normalized = normalizePaymentId(paymentId);
  if (!normalized) throw new Error('invalid payment intent id');
  const digest = crypto
    .createHmac('sha256', key || configuredDataKey())
    .update('price-alert-payment-intent:v1:')
    .update(normalized)
    .digest('hex');
  return `${configuredStoreRoot()}payments/${digest}.enc`;
}

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function validIntent(intent, paymentId) {
  return Boolean(
    intent &&
      intent.version === INTENT_VERSION &&
      normalizePaymentId(intent.paymentId) &&
      (!paymentId || intent.paymentId === paymentId) &&
      intent.ownerDeviceId &&
      intent.contract &&
      Number.isFinite(Number(intent.revision || 0))
  );
}

async function readIntent(paymentId, dependencies) {
  const pathname = intentPath(paymentId);
  const read = (dependencies && dependencies.get) || get;
  const result = await read(pathname, {
    access: 'public',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  });
  if (!result) return { intent: null, pathname, etag: '' };
  const intent = decryptJson(await streamText(result.stream), configuredDataKey());
  if (!validIntent(intent, paymentId)) throw new Error('invalid payment intent record');
  const etag = String((result.blob && result.blob.etag) || '');
  if (!etag) throw new Error('payment intent ETag missing');
  return { intent, pathname, etag };
}

function isConflict(error) {
  return (
    error instanceof BlobPreconditionFailedError ||
    [409, 412].includes(Number(error && (error.status || error.statusCode))) ||
    /precondition|etag mismatch|already exists|overwrite/i.test(String(error && error.message))
  );
}

async function writeIntent(intent, previous, dependencies) {
  if (!validIntent(intent, intent && intent.paymentId)) {
    throw new Error('invalid payment intent mutation');
  }
  const write = (dependencies && dependencies.put) || put;
  const pathname = intentPath(intent.paymentId);
  const etag = String((previous && previous.etag) || '');
  try {
    return await write(pathname, encryptJson(intent, configuredDataKey()), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: Boolean(etag),
      ...(etag ? { ifMatch: etag } : {}),
      contentType: 'application/octet-stream',
      cacheControlMaxAge: 60
    });
  } catch (error) {
    if (isConflict(error) || (!etag && error instanceof BlobUnknownError)) {
      throw new PaymentIntentConflictError();
    }
    throw error;
  }
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

async function mutateIntent(paymentId, mutation, dependencies) {
  const read = (dependencies && dependencies.readIntent) || readIntent;
  const write = (dependencies && dependencies.writeIntent) || writeIntent;
  const maximum = Math.max(
    1,
    Math.min(20, Number((dependencies && dependencies.maxAttempts) || MAX_MUTATION_ATTEMPTS))
  );
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const loaded = await read(paymentId, dependencies);
    const outcome = (await mutation(clone(loaded.intent), { attempt })) || { changed: false };
    const intent = outcome.intent === undefined ? loaded.intent : outcome.intent;
    if (!outcome.changed) return { ...outcome, intent, attempts: attempt, written: false };
    const previousRevision = Number((loaded.intent && loaded.intent.revision) || 0);
    intent.revision = previousRevision + 1;
    try {
      const blob = await write(intent, loaded, dependencies);
      return { ...outcome, intent, blob, attempts: attempt, written: true };
    } catch (error) {
      if (!(error instanceof PaymentIntentConflictError) || attempt === maximum) throw error;
    }
  }
  throw new PaymentIntentConflictError();
}

module.exports = {
  INTENT_VERSION,
  PaymentIntentConflictError,
  intentPath,
  mutateIntent,
  readIntent,
  validIntent,
  writeIntent
};
