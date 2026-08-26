const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;

function decodeDataKey(value) {
  const raw = String(value || '').trim();
  let key = null;

  if (/^(?:hex:)?[a-f0-9]{64}$/i.test(raw)) {
    key = Buffer.from(raw.replace(/^hex:/i, ''), 'hex');
  } else {
    const base64 = raw.replace(/^base64:/i, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      key = Buffer.from(base64, 'base64');
    } else if (/^[A-Za-z0-9_-]+$/.test(base64)) {
      key = Buffer.from(base64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    }
  }

  if (!key || key.length !== 32) {
    throw new Error('PRICE_ALERT_DATA_KEY must encode exactly 32 bytes');
  }
  return key;
}

function configuredDataKey() {
  return decodeDataKey(process.env.PRICE_ALERT_DATA_KEY);
}

function encryptJson(value, key) {
  const encryptionKey = key || configuredDataKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
  cipher.setAAD(Buffer.from('oliveyoung-price-alerts:v1', 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: ENVELOPE_VERSION,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    data: ciphertext.toString('base64url')
  });
}

function decryptJson(envelopeText, key) {
  const encryptionKey = key || configuredDataKey();
  let envelope;
  try {
    envelope = JSON.parse(String(envelopeText || ''));
  } catch (_) {
    throw new Error('invalid encrypted price alert payload');
  }
  if (
    !envelope ||
    envelope.v !== ENVELOPE_VERSION ||
    envelope.alg !== 'A256GCM' ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.data
  ) {
    throw new Error('unsupported encrypted price alert payload');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey,
      Buffer.from(envelope.iv, 'base64url')
    );
    decipher.setAAD(Buffer.from('oliveyoung-price-alerts:v1', 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (_) {
    throw new Error('price alert payload authentication failed');
  }
}

function devicePathHash(deviceId, key) {
  const encryptionKey = key || configuredDataKey();
  return crypto
    .createHmac('sha256', encryptionKey)
    .update('device-path:v1:')
    .update(String(deviceId || ''))
    .digest('hex');
}

module.exports = {
  configuredDataKey,
  decodeDataKey,
  decryptJson,
  devicePathHash,
  encryptJson
};
