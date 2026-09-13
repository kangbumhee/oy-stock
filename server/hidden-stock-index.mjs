import crypto from 'node:crypto';
import { get, put } from '@vercel/blob';

export const HIDDEN_INDEX_SHARD_COUNT = 64;
export const MAX_HIDDEN_INDEX_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const HIDDEN_INDEX_CACHE_MS = 30000;
const READ_CONCURRENCY = 8;
const namespace = () => String(process.env.HIDDEN_STOCK_INDEX_NAMESPACE || 'production').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'production';
const token = () => process.env.HIDDEN_STOCK_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;

export function emptyHiddenIndex() {
  return { version: 1, products: {}, scan: { page: 1, offset: 0, processed: 0, complete: false }, updatedAt: null };
}

export function hiddenIndexShardId(goodsNo) {
  if (!/^[AB]\d{6,20}$/.test(String(goodsNo || ''))) throw new Error('invalid_goods_no');
  return crypto.createHash('sha256').update(goodsNo).digest().readUInt16BE(0) % HIDDEN_INDEX_SHARD_COUNT;
}

export function hiddenIndexDocumentPath(shard, selectedNamespace = namespace()) {
  const safeNamespace = String(selectedNamespace).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'production';
  const base = `oliveyoung/hidden-stock/v2/${safeNamespace}/`;
  if (shard === 'scan') return `${base}scan.json`;
  if (!Number.isInteger(shard) || shard < 0 || shard >= HIDDEN_INDEX_SHARD_COUNT) throw new Error('hidden_index_invalid_shard');
  return `${base}shards/${shard.toString(16).padStart(2, '0')}.json`;
}

function conflictError(error) {
  return [409, 412].includes(Number(error?.statusCode || error?.status)) ||
    /precondition|conflict|already exists|overwrite/i.test(String(error?.message));
}

function serializedDocument(value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_HIDDEN_INDEX_DOCUMENT_BYTES) throw new Error('hidden_index_size_limit');
  return json;
}

async function readBlobDocument(path, { ifNoneMatch } = {}) {
  if (!token()) throw new Error('hidden_index_not_configured');
  // Gzip delivery weakens the HTTP ETag (W/), which Blob correctly rejects for
  // conditional writes. Request the identity representation, not a stripped tag.
  const result = await get(path, { access: 'private', useCache: false, token: token(),
    headers: { 'Accept-Encoding': 'identity' }, abortSignal: AbortSignal.timeout(8000), ...(ifNoneMatch ? { ifNoneMatch } : {}) });
  if (!result || result.statusCode === 404) return { value: null, etag: null };
  if (result.statusCode === 304) return { notModified: true, etag: result.blob.etag };
  if (result.statusCode !== 200 || !result.stream) throw new Error('hidden_index_unavailable');
  let size = 0;
  const chunks = [];
  for await (const part of result.stream) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > MAX_HIDDEN_INDEX_DOCUMENT_BYTES) throw new Error('hidden_index_size_limit');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return { value, etag: result.blob.etag };
}

async function writeBlobDocument(path, value, etag) {
  if (!token()) throw new Error('hidden_index_not_configured');
  return put(path, serializedDocument(value), {
    access: 'private', token: token(), addRandomSuffix: false, abortSignal: AbortSignal.timeout(8000),
    allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {}),
    contentType: 'application/json', cacheControlMaxAge: 60
  });
}

// Keep reducer injection for existing in-memory fixtures. Production intentionally
// exposes targeted mutations instead, never a read/overwrite of the entire catalog.
function createLegacyHiddenIndexStore({ read, write, now = Date.now }) {
  if (typeof read !== 'function' || typeof write !== 'function') throw new Error('hidden_index_adapter_required');
  let cached = null;
  let loadedAt = 0;
  return {
    async read({ fresh = false } = {}) {
      if (!fresh && cached && now() - loadedAt < HIDDEN_INDEX_CACHE_MS) return structuredClone(cached);
      const result = await read();
      cached = result.value;
      loadedAt = now();
      return structuredClone(cached);
    },
    async mutate(change) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const loaded = await read();
        const value = structuredClone(loaded.value);
        await change(value);
        value.updatedAt = new Date(now()).toISOString();
        try {
          await write(value, loaded.etag);
          cached = value;
          loadedAt = now();
          return structuredClone(value);
        } catch (error) {
          if (attempt === 4 || !conflictError(error)) throw error;
        }
      }
      throw new Error('hidden_index_conflict');
    }
  };
}

function emptyDocument(shard) {
  return shard === 'scan'
    ? { version: 2, scan: emptyHiddenIndex().scan, updatedAt: null }
    : { version: 2, shard, products: {}, updatedAt: null };
}

function validateDocument(value, shard) {
  if (!value || value.version !== 2) throw new Error('hidden_index_invalid');
  if (shard === 'scan') {
    if (!value.scan || typeof value.scan !== 'object' || Array.isArray(value.scan)) throw new Error('hidden_index_invalid');
  } else {
    if (value.shard !== shard || !value.products || typeof value.products !== 'object' || Array.isArray(value.products)) throw new Error('hidden_index_invalid');
    for (const [goodsNo, product] of Object.entries(value.products)) {
      if (hiddenIndexShardId(goodsNo) !== shard || !product || product.goodsNo !== goodsNo || !Array.isArray(product.options)) throw new Error('hidden_index_invalid');
    }
  }
  return value;
}

async function concurrentMap(values, callback) {
  let next = 0;
  const result = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await callback(values[index]);
    }
  }));
  return result;
}

export function createHiddenIndexStore(options = {}) {
  if (options.read || options.write) return createLegacyHiddenIndexStore(options);
  const readDocument = options.readDocument || readBlobDocument;
  const writeDocument = options.writeDocument || writeBlobDocument;
  const now = options.now || Date.now;
  const selectedNamespace = options.namespace || namespace();
  const cache = new Map();
  const pending = new Map();
  const epochs = new Map();
  const pathFor = shard => hiddenIndexDocumentPath(shard, selectedNamespace);

  async function load(shard, { fresh = false, independent = false } = {}) {
    const current = cache.get(shard);
    if (!fresh && current && now() - current.loadedAt < HIDDEN_INDEX_CACHE_MS) return current;
    if (!independent && pending.has(shard)) return pending.get(shard);
    const epoch = epochs.get(shard) || 0;
    const operation = (async () => {
      const result = await readDocument(pathFor(shard), { ...(current?.etag ? { ifNoneMatch: current.etag } : {}) });
      let value;
      if (result?.notModified) {
        // The private Blob origin can omit ETag on HTTP 304. That response is
        // conditional on the tag we sent; retain it for the next CAS write.
        if (!current || !current.etag || (result.etag && result.etag !== current.etag)) throw new Error('hidden_index_invalid');
        value = current.value;
      } else {
        value = result?.value == null ? emptyDocument(shard) : validateDocument(result.value, shard);
      }
      // A slow read cannot overwrite a newer successful local CAS write.
      if ((epochs.get(shard) || 0) !== epoch && cache.has(shard)) return cache.get(shard);
      const loaded = { value: structuredClone(value), etag: result?.notModified ? current.etag : result?.etag || null, loadedAt: now() };
      cache.set(shard, loaded);
      return loaded;
    })();
    if (!independent) pending.set(shard, operation);
    try { return await operation; } finally {
      if (pending.get(shard) === operation) pending.delete(shard);
    }
  }

  async function mutateDocument(shard, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const loaded = await load(shard, { fresh: true, independent: true });
      const value = structuredClone(loaded.value);
      await change(value);
      value.updatedAt = new Date(now()).toISOString();
      validateDocument(value, shard);
      serializedDocument(value);
      try {
        const saved = await writeDocument(pathFor(shard), value, loaded.etag);
        epochs.set(shard, (epochs.get(shard) || 0) + 1);
        cache.set(shard, { value: structuredClone(value), etag: saved?.etag || null, loadedAt: now() });
        return structuredClone(value);
      } catch (error) {
        if (attempt === 4 || !conflictError(error)) throw error;
        cache.delete(shard);
      }
    }
    throw new Error('hidden_index_conflict');
  }

  return {
    async read({ fresh = false } = {}) {
      const documents = await concurrentMap([...Array(HIDDEN_INDEX_SHARD_COUNT).keys(), 'scan'], shard => load(shard, { fresh }));
      const products = {};
      let latest = null;
      for (const { value } of documents) {
        if (value.products) Object.assign(products, value.products);
        if (value.updatedAt && (!latest || Date.parse(value.updatedAt) > Date.parse(latest))) latest = value.updatedAt;
      }
      return structuredClone({ version: 2, products, scan: documents[HIDDEN_INDEX_SHARD_COUNT].value.scan, updatedAt: latest });
    },
    async readProduct(goodsNo, { fresh = false } = {}) {
      const document = await load(hiddenIndexShardId(goodsNo), { fresh });
      return structuredClone(document.value.products[goodsNo] || null);
    },
    async saveDiscovery(goodsNo, result, timestamp = now()) {
      const shard = hiddenIndexShardId(goodsNo);
      const saved = await mutateDocument(shard, value => mergeDiscovery(value, goodsNo, result, timestamp));
      return structuredClone(saved.products[goodsNo]);
    },
    async readScan({ fresh = false } = {}) {
      return structuredClone((await load('scan', { fresh })).value.scan);
    },
    async mutateScan(change) {
      if (typeof change !== 'function') throw new Error('hidden_index_mutation_required');
      const saved = await mutateDocument('scan', value => change(value.scan));
      return structuredClone(saved.scan);
    }
  };
}

export function mergeDiscovery(index, goodsNo, result, now = Date.now()) {
  const previous = index.products[goodsNo];
  const byKey = new Map();
  const complete = result.coverage?.complete === true;
  const observedAt = new Date(now).toISOString();
  const hasSku = value => typeof value === 'string' && /^\d{6,20}$/.test(value);
  const skuEvidence = option => (option?.evidence || []).filter(entry => hasSku(entry?.productId));
  const conflictReported = String(result.coverage?.reason || '').split(',').includes('conflicting_sku_evidence');
  // A partial observation cannot erase old verified identities. Their freshness is explicit.
  if (!complete) {
    for (const option of previous?.options || []) byKey.set(`${option.goodsNo}:${option.optionNumber}`, { ...option, stale: true });
  }
  for (const option of result.options || []) {
    if (!option.goodsNo || !option.optionNumber) continue;
    const key = `${option.goodsNo}:${option.optionNumber}`;
    const old = byKey.get(key);
    const currentEvidence = skuEvidence(option);
    // A review-count response can prove the option still exists without yielding
    // its SKU when a later review request fails. That is not a SKU revocation.
    // Never carry an identity through conflicting evidence or a complete refresh.
    const retainIdentity = !complete && option.productId == null && hasSku(old?.productId) && !conflictReported &&
      [...currentEvidence, ...skuEvidence(old)].every(entry => entry.productId === old.productId);
    const next = { ...option, discoveredAt: observedAt, stale: false };
    if (retainIdentity) {
      next.productId = old.productId;
      next.stale = true;
      next.identityVerifiedAt = old.identityVerifiedAt || old.discoveredAt || previous.checkedAt || null;
      next.image = option.image || old.image || '';
      // Preserve only the old identity proof, not an old online/hidden decision.
      const evidence = [...skuEvidence(old), ...(option.evidence || [])];
      next.evidence = [...new Map(evidence.map(entry => [JSON.stringify(entry), entry])).values()];
    } else if (hasSku(option.productId)) {
      next.identityVerifiedAt = observedAt;
    }
    byKey.set(key, next);
  }
  index.products[goodsNo] = {
    goodsNo, options: [...byKey.values()], relatedGoodsNos: result.relatedGoodsNos || [],
    coverage: result.coverage, checkedAt: new Date(now).toISOString()
  };
}

// Status is an attribute of the option identity, not of a particular cached root
// or SKU. Resolve competing observations before filtering hidden rows; otherwise
// an older related-product copy could resurrect an option already online again.
export function canonicalHiddenOptions(index) {
  const candidates = new Map();
  for (const product of Object.values(index.products || {})) {
    for (const option of product.options || []) {
      if (!option?.goodsNo || !option.optionNumber) continue;
      const key = `${option.goodsNo}:${option.optionNumber}`;
      const ownSource = product.goodsNo === option.goodsNo;
      const parsed = Date.parse(option.discoveredAt || product.checkedAt || '');
      const observedAt = Number.isFinite(parsed) ? parsed : 0;
      const previous = candidates.get(key);
      // Related-root discovery also fetches this option's own official active
      // list. Therefore newer evidence wins, regardless of which root found it.
      if (!previous || observedAt > previous.observedAt ||
        (observedAt === previous.observedAt && ownSource && !previous.ownSource) ||
        (observedAt === previous.observedAt && ownSource === previous.ownSource &&
          previous.option.hidden === true && option.hidden !== true)) {
        candidates.set(key, { option, ownSource, observedAt });
      }
    }
  }
  return [...candidates.values()].map(entry => entry.option)
    .sort((a, b) => `${a.goodsNo}:${a.optionNumber}`.localeCompare(`${b.goodsNo}:${b.optionNumber}`));
}

export function searchHiddenIndex(index, keyword) {
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const tokens = String(keyword || '').trim().split(/\s+/).map(normalize).filter(Boolean);
  return canonicalHiddenOptions(index).filter(option => {
    if (option.hidden !== true || !option.productId) return false;
    const names = [option.name, option.goodsName, ...(option.aliases || []), ...(option.sourceGoodsNos || []), option.goodsNo, option.productId].join(' ');
    const haystack = normalize(names);
    return tokens.every(word => haystack.includes(word));
  });
}
