const crypto = require('node:crypto');
const { BlobPreconditionFailedError, BlobUnknownError, get, put } = require('@vercel/blob');
const { configuredDataKey, decryptJson, encryptJson } = require('./_crypto');
const { configuredStoreRoot } = require('./_registry');

function accountIndexPath(email) {
  const digest = crypto.createHmac('sha256', configuredDataKey())
    .update('price-alert-account-email:v1:').update(email).digest('hex');
  return `${configuredStoreRoot()}accounts/${digest}.enc`;
}

async function readAccountIndex(email, dependencies = {}) {
  const result = await (dependencies.get || get)(accountIndexPath(email), {
    access: 'private', useCache: false,
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  });
  if (!result) return { index: null, etag: '' };
  const chunks = [];
  let bytes = 0;
  for await (const chunk of result.stream) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('account index too large');
    chunks.push(Buffer.from(chunk));
  }
  const index = decryptJson(Buffer.concat(chunks).toString('utf8'));
  const etag = String(result.blob && result.blob.etag || '');
  if (!index || index.version !== 1 || !etag) throw new Error('invalid account index');
  return { index, etag };
}

async function mutateAccountIndex(email, mutation, dependencies = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const loaded = await (dependencies.readAccountIndex || readAccountIndex)(email, dependencies);
    const current = loaded.index ? JSON.parse(JSON.stringify(loaded.index)) : { version: 1, revision: 0 };
    const outcome = await mutation(current);
    if (!outcome.changed) return { ...outcome, index: current, written: false };
    current.revision = Number(current.revision || 0) + 1;
    try {
      await (dependencies.put || put)(accountIndexPath(email), encryptJson(current), {
        access: 'private', addRandomSuffix: false, allowOverwrite: Boolean(loaded.etag),
        ...(loaded.etag ? { ifMatch: loaded.etag } : {}),
        contentType: 'application/octet-stream', cacheControlMaxAge: 60
      });
      return { ...outcome, index: current, written: true };
    } catch (error) {
      const conflict = error instanceof BlobPreconditionFailedError ||
        (!loaded.etag && error instanceof BlobUnknownError) ||
        [409, 412].includes(Number(error && (error.status || error.statusCode)));
      if (!conflict || attempt === 7) throw error;
    }
  }
  throw new Error('account index write conflict');
}

module.exports = { accountIndexPath, readAccountIndex, mutateAccountIndex };
