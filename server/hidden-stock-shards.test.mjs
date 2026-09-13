import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDDEN_INDEX_SHARD_COUNT,
  MAX_HIDDEN_INDEX_DOCUMENT_BYTES,
  createHiddenIndexStore,
  hiddenIndexDocumentPath,
  hiddenIndexShardId,
  searchHiddenIndex
} from './hidden-stock-index.mjs';
import { createHiddenStockService } from './hidden-stock-service.mjs';

const NOW = Date.parse('2026-09-13T01:00:00.000Z');
const GOODS = 'A000000255680';
const RELATED = 'A000000255681';
const SKU = '8800289469145';

function discovery(goodsNo = GOODS, overrides = {}) {
  return {
    options: [{ goodsNo, optionNumber: '001', productId: SKU, name: '한교동 더블기획', hidden: true, ...overrides }],
    coverage: { complete: true }, relatedGoodsNos: []
  };
}

function memoryDocuments(overrides = {}) {
  const documents = new Map();
  const reads = [];
  const writes = [];
  let revision = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  let clock = NOW;
  const adapters = {
    namespace: 'test',
    now: () => clock,
    async readDocument(path, options = {}) {
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      reads.push({ path, options });
      try {
        await Promise.resolve();
        const current = documents.get(path);
        if (!current) return { value: null, etag: null };
        if (options.ifNoneMatch && current.etag === options.ifNoneMatch) return { notModified: true, etag: current.etag };
        return structuredClone(current);
      } finally { activeReads--; }
    },
    async writeDocument(path, value, expected) {
      const current = documents.get(path);
      if ((current?.etag || null) !== expected) throw Object.assign(new Error('CAS rejected'), { statusCode: 412 });
      const etag = `revision-${++revision}`;
      writes.push({ path, value: structuredClone(value), expected });
      documents.set(path, { value: structuredClone(value), etag });
      return { etag };
    },
    ...overrides
  };
  return {
    adapters, documents, reads, writes,
    get maxActiveReads() { return maxActiveReads; },
    advance(ms) { clock += ms; }
  };
}

function anotherGoods(sameShard) {
  for (let number = 100000000; number < 100000100; number++) {
    const goodsNo = `A${number}`;
    if ((hiddenIndexShardId(goodsNo) === hiddenIndexShardId(GOODS)) === sameShard) return goodsNo;
  }
  throw new Error('test candidate unavailable');
}

test('production store uses stable 64 shards and private version2 namespace paths', () => {
  assert.equal(HIDDEN_INDEX_SHARD_COUNT, 64);
  assert.equal(hiddenIndexShardId(GOODS), hiddenIndexShardId(GOODS));
  assert.ok(hiddenIndexShardId(GOODS) >= 0 && hiddenIndexShardId(GOODS) < 64);
  assert.match(hiddenIndexDocumentPath(hiddenIndexShardId(GOODS), 'production'), /^oliveyoung\/hidden-stock\/v2\/production\/shards\/[a-f0-9]{2}\.json$/);
  assert.equal(hiddenIndexDocumentPath('scan', '../unsafe'), 'oliveyoung/hidden-stock/v2/unsafe/scan.json');
  assert.equal(hiddenIndexDocumentPath('scan', ''), 'oliveyoung/hidden-stock/v2/production/scan.json');
  assert.throws(() => hiddenIndexShardId('../secret'), /invalid_goods_no/);
  assert.throws(() => hiddenIndexDocumentPath(64), /hidden_index_invalid_shard/);
  const store = createHiddenIndexStore(memoryDocuments().adapters);
  assert.equal(typeof store.readProduct, 'function');
  assert.equal(typeof store.saveDiscovery, 'function');
  assert.equal(typeof store.readScan, 'function');
  assert.equal(typeof store.mutateScan, 'function');
  assert.equal(store.mutate, undefined, 'production cannot accidentally overwrite the entire catalog');
});

test('saving one product reads/writes only its shard, not the whole catalog or scan metadata', async () => {
  const memory = memoryDocuments();
  const store = createHiddenIndexStore(memory.adapters);
  const result = await store.saveDiscovery(GOODS, discovery(), NOW);
  const shardPath = hiddenIndexDocumentPath(hiddenIndexShardId(GOODS), 'test');
  assert.deepEqual(memory.reads.map(item => item.path), [shardPath]);
  assert.deepEqual(memory.writes.map(item => item.path), [shardPath]);
  assert.equal(result.goodsNo, GOODS);
  assert.equal(result.options[0].discoveredAt, new Date(NOW).toISOString());
  assert.equal(memory.writes[0].value.version, 2);
  assert.equal(memory.writes[0].value.shard, hiddenIndexShardId(GOODS));
  assert.deepEqual(Object.keys(memory.writes[0].value.products), [GOODS]);
  assert.equal(memory.writes[0].value.scan, undefined);
  const copy = await store.readProduct(GOODS);
  copy.options[0].name = 'client mutation';
  assert.equal((await store.readProduct(GOODS)).options[0].name, '한교동 더블기획');
  assert.equal(memory.reads.length, 1, 'own-save cached shard is reused');
});

test('a related option remains inside its root product shard until directly discovered', async () => {
  const memory = memoryDocuments();
  const store = createHiddenIndexStore(memory.adapters);
  await store.saveDiscovery(GOODS, discovery(RELATED), NOW);
  assert.equal((await store.readProduct(GOODS)).options[0].goodsNo, RELATED);
  assert.equal(await store.readProduct(RELATED), null);
  assert.equal(memory.writes.length, 1);
  assert.deepEqual(Object.keys(memory.writes[0].value.products), [GOODS]);
});

test('scan checkpoint has separate private CAS document and does not write product shards', async () => {
  const memory = memoryDocuments();
  const store = createHiddenIndexStore(memory.adapters);
  assert.deepEqual(await store.readScan(), { page: 1, offset: 0, processed: 0, complete: false });
  const saved = await store.mutateScan(scan => {
    scan.page = 3; scan.offset = 4; scan.processed = 44;
    scan.failures = { [GOODS]: 'provider_unavailable' };
  });
  assert.equal(saved.page, 3);
  assert.equal(saved.processed, 44);
  assert.equal(memory.writes.length, 1);
  assert.equal(memory.writes[0].path, hiddenIndexDocumentPath('scan', 'test'));
  assert.equal(memory.writes[0].value.products, undefined);
  saved.page = 99;
  assert.equal((await store.readScan()).page, 3);
  assert.equal(memory.reads.every(item => item.path.endsWith('/scan.json')), true);
});

test('cold fullsnapshot reads 64 shards plus scan with at most8 parallel reads and then reuses cache', async () => {
  const memory = memoryDocuments();
  const store = createHiddenIndexStore(memory.adapters);
  const empty = await store.read();
  assert.equal(memory.reads.length, 65);
  assert.equal(new Set(memory.reads.map(item => item.path)).size, 65);
  assert.ok(memory.maxActiveReads >= 2 && memory.maxActiveReads <= 8);
  assert.deepEqual(empty.products, {});
  assert.equal(empty.version, 2);
  await store.read();
  assert.equal(memory.reads.length, 65);
  await store.saveDiscovery(GOODS, discovery(), NOW);
  const afterSave = memory.reads.length;
  const assembled = await store.read();
  assert.equal(memory.reads.length, afterSave);
  assert.equal(assembled.products[GOODS].options[0].name, '한교동 더블기획');
  assert.equal(assembled.updatedAt, new Date(NOW).toISOString());
  assert.equal(searchHiddenIndex(assembled, '한교동').length, 1);
});

test('expired cache revalidates ETags and fresh targeted reads do not fetch other shards', async () => {
  const memory = memoryDocuments();
  const store = createHiddenIndexStore(memory.adapters);
  await store.saveDiscovery(GOODS, discovery(), NOW);
  const path = memory.writes[0].path;
  const etag = memory.documents.get(path).etag;
  await store.readProduct(GOODS, { fresh: true });
  assert.deepEqual(memory.reads.at(-1).options, { ifNoneMatch: etag });
  assert.equal(memory.reads.at(-1).path, path);
  const before = memory.reads.length;
  memory.advance(30001);
  assert.equal((await store.readProduct(GOODS)).goodsNo, GOODS);
  assert.equal(memory.reads.length, before + 1);
  assert.deepEqual(memory.reads.at(-1).options, { ifNoneMatch: etag });
  assert.equal(memory.writes.length, 1);
});

test('304 without an echoed ETag reuses cached data and preserves the previous ETag for the next CAS write', async () => {
  for (const missingTag of [undefined, null, '']) {
    const memory = memoryDocuments();
    const originalRead = memory.adapters.readDocument;
    const store = createHiddenIndexStore({ ...memory.adapters,
      readDocument: async (path, options) => {
        const response = await originalRead(path, options);
        return response.notModified ? { notModified: true, ...(missingTag === undefined ? {} : { etag: missingTag }) } : response;
      }
    });
    await store.saveDiscovery(GOODS, discovery(), NOW);
    const path = hiddenIndexDocumentPath(hiddenIndexShardId(GOODS), 'test');
    const originalEtag = memory.documents.get(path).etag;
    memory.advance(30001);
    const revalidated = await store.readProduct(GOODS);
    assert.equal(revalidated.options[0].name, '한교동 더블기획');
    assert.deepEqual(memory.reads.at(-1).options, { ifNoneMatch: originalEtag });
    await store.saveDiscovery(GOODS, discovery(GOODS, { name: '갱신된 옵션명' }), NOW + 30002);
    assert.equal(memory.writes.at(-1).expected, originalEtag);
    const replacementEtag = memory.documents.get(path).etag;
    assert.notEqual(replacementEtag, originalEtag);
    assert.equal((await store.readProduct(GOODS, { fresh: true })).options[0].name, '갱신된 옵션명');
    assert.deepEqual(memory.reads.at(-1).options, { ifNoneMatch: replacementEtag });
  }
});

test('304 still rejects a conflicting echoed ETag or an uncached response with no ETag', async () => {
  const memory = memoryDocuments();
  const originalRead = memory.adapters.readDocument;
  const store = createHiddenIndexStore({ ...memory.adapters,
    readDocument: async (path, options) => {
      const response = await originalRead(path, options);
      return response.notModified ? { notModified: true, etag: 'different-present-tag' } : response;
    }
  });
  await store.saveDiscovery(GOODS, discovery(), NOW);
  await assert.rejects(store.readProduct(GOODS, { fresh: true }), /hidden_index_invalid/);
  const cold = createHiddenIndexStore({ readDocument: async () => ({ notModified: true }), writeDocument: async () => {} });
  await assert.rejects(cold.readProduct(GOODS), /hidden_index_invalid/);
});

test('external shard changes become visible after TTL and own updates do not erase other roots', async () => {
  const memory = memoryDocuments();
  const first = createHiddenIndexStore(memory.adapters);
  const second = createHiddenIndexStore(memory.adapters);
  const sameShardGoods = anotherGoods(true);
  await first.saveDiscovery(GOODS, discovery(), NOW);
  await second.saveDiscovery(sameShardGoods, discovery(sameShardGoods), NOW + 1000);
  assert.equal(await first.readProduct(sameShardGoods), null, 'document cache may lag another instance within30seconds');
  memory.advance(30001);
  assert.ok(await first.readProduct(sameShardGoods));
  await first.saveDiscovery(GOODS, discovery(GOODS, { hidden: false }), NOW + 2000);
  const stored = memory.documents.get(hiddenIndexDocumentPath(hiddenIndexShardId(GOODS), 'test')).value;
  assert.equal(stored.products[GOODS].options[0].hidden, false);
  assert.ok(stored.products[sameShardGoods]);
});

test('parallel saves in same shard retry CAS and different shards never overwrite each other', async () => {
  for (const sameShard of [true, false]) {
    const memory = memoryDocuments();
    const first = createHiddenIndexStore(memory.adapters);
    const second = createHiddenIndexStore(memory.adapters);
    const other = anotherGoods(sameShard);
    await Promise.all([
      first.saveDiscovery(GOODS, discovery(), NOW),
      second.saveDiscovery(other, discovery(other), NOW)
    ]);
    const snapshot = await first.read({ fresh: true });
    assert.ok(snapshot.products[GOODS]);
    assert.ok(snapshot.products[other]);
    assert.equal(memory.writes.length, 2);
    assert.equal(new Set(memory.writes.map(item => item.path)).size, sameShard ? 1 : 2);
    assert.equal(memory.writes.some(item => item.path.endsWith('/scan.json')), false);
  }
});

test('parallel checkpoint updates are idempotent when reducer checks its expected checkpoint', async () => {
  const memory = memoryDocuments();
  const first = createHiddenIndexStore(memory.adapters);
  const second = createHiddenIndexStore(memory.adapters);
  const update = scan => {
    if (scan.page !== 1 || scan.offset !== 0) return;
    scan.offset++; scan.processed++;
  };
  await Promise.all([first.mutateScan(update), second.mutateScan(update)]);
  const scan = await first.readScan({ fresh: true });
  assert.equal(scan.offset, 1);
  assert.equal(scan.processed, 1);
  assert.equal(memory.writes.every(item => item.path.endsWith('/scan.json')), true);
});

test('slow prior reads cannot poison the shard cache after a successful local save', async () => {
  const memory = memoryDocuments();
  let releaseRead;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let held = false;
  const originalRead = memory.adapters.readDocument;
  memory.adapters.readDocument = async (path, options) => {
    const result = await originalRead(path, options);
    if (!held) {
      held = true;
      signalStarted();
      await new Promise(resolve => { releaseRead = resolve; });
    }
    return result;
  };
  const store = createHiddenIndexStore(memory.adapters);
  const oldRead = store.readProduct(GOODS);
  await started;
  await store.saveDiscovery(GOODS, discovery(), NOW);
  releaseRead();
  assert.ok(await oldRead);
  assert.equal((await store.readProduct(GOODS)).options[0].name, '한교동 더블기획');
});

test('shard CAS failures are bounded and ordinary failures do not retry or expose a partial local write', async () => {
  for (const [makeError, attempts] of [
    [() => Object.assign(new Error('rejected'), { statusCode: 412 }), 5],
    [() => new Error('storage unavailable'), 1]
  ]) {
    const memory = memoryDocuments();
    let writes = 0;
    memory.adapters.writeDocument = async () => { writes++; throw makeError(); };
    const store = createHiddenIndexStore(memory.adapters);
    await assert.rejects(() => store.saveDiscovery(GOODS, discovery(), NOW));
    assert.equal(writes, attempts);
    assert.equal(await store.readProduct(GOODS), null);
  }
});

test('wrong shard/version/key records and invalid304 cannot be used as a catalog', async () => {
  for (const value of [
    { version: 1, products: {} },
    { version: 2, shard: -1, products: {} },
    { version: 2, shard: hiddenIndexShardId(GOODS), products: [] },
    { version: 2, shard: hiddenIndexShardId(GOODS), products: { [GOODS]: { goodsNo: 'wrong', options: [] } } }
  ]) {
    const store = createHiddenIndexStore({ readDocument: async () => ({ value, etag: 'bad' }), writeDocument: async () => {}, now: () => NOW });
    await assert.rejects(() => store.readProduct(GOODS), /hidden_index_invalid/);
  }
  const invalid304 = createHiddenIndexStore({ readDocument: async () => ({ notModified: true, etag: 'unknown' }), writeDocument: async () => {} });
  await assert.rejects(() => invalid304.readProduct(GOODS), /hidden_index_invalid/);
});

test('each individual shard is bounded to32MiB before the Blob write starts', async () => {
  const memory = memoryDocuments();
  const store = createHiddenIndexStore(memory.adapters);
  const result = discovery(GOODS, { name: 'x'.repeat(MAX_HIDDEN_INDEX_DOCUMENT_BYTES) });
  await assert.rejects(() => store.saveDiscovery(GOODS, result, NOW), /hidden_index_size_limit/);
  assert.equal(memory.writes.length, 0);
});

test('integrated service scan/options/stores use targeted sharded methods, not a fullsnapshot per page', async () => {
  const memory = memoryDocuments();
  const index = createHiddenIndexStore(memory.adapters);
  const secret = 'fixture-hidden-service-integration-1234567890';
  let discoveries = 0;
  const requests = [];
  const handler = createHiddenStockService({
    index, secret: () => secret, now: () => NOW,
    discoveryFactory: () => async goodsNo => { discoveries++; return discovery(goodsNo); },
    request: async input => {
      requests.push(input);
      if (input.path === '/oystore/api/stock/product-search-v3') {
        return { status: 'SUCCESS', data: { serachList: [{ goodsNumber: GOODS }], nextPage: false, totalCount: 1 } };
      }
      return { status: 'SUCCESS', code: 200, data: { storeList: [], stockDisplayYn: true } };
    }
  });
  async function invoke(action, method = 'GET') {
    const res = { setHeader() {}, removeHeader() {}, end(raw) { this.body = JSON.parse(raw); } };
    await handler({ method, url: '/api/hidden-stock?' + action, headers: { authorization: `Bearer ${secret}` } }, res);
    assert.equal(res.statusCode, 200);
    return res.body;
  }
  const scan = await invoke('action=scan', 'POST');
  assert.equal(scan.scan.processed, 1);
  assert.equal(scan.scan.complete, true);
  assert.equal(discoveries, 1);
  assert.equal(new Set(memory.reads.map(item => item.path)).size, 2);
  assert.equal(memory.writes.length, 2);
  const reads = memory.reads.length;
  const options = await invoke(`action=options&goodsNo=${GOODS}`);
  assert.equal(options.options.length, 1);
  const stores = await invoke(`action=stores&goodsNo=${GOODS}&productId=${SKU}`);
  assert.equal(stores.coverage.complete, false);
  assert.ok(stores.nextCursor);
  assert.equal(memory.reads.length, reads);
  assert.equal(discoveries, 1);
  assert.equal(requests.filter(item => item.path.endsWith('/stock-stores')).length, 3);
});
