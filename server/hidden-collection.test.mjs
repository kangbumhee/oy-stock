import test from 'node:test';
import assert from 'node:assert/strict';
import { createHiddenCollection } from './hidden-collection.mjs';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = DAY / 24;
const GOODS = 'A000000255680';
const OTHER = 'A000000270000';
const THIRD = 'A000000270001';
const ids = count => Array.from({ length: count }, (_, index) => 'A' + String(270000 + index).padStart(12, '0'));
const catalog = (goodsNos = [], nextPage = false, totalCount = goodsNos.length) => ({ status: 'SUCCESS', data: {
  serachList: goodsNos.map(goodsNumber => ({ goodsNumber, goodsName: '상품 ' + goodsNumber })), nextPage, totalCount
} });
const result = (goodsNo, { hidden = true, complete = true, related = [], options } = {}) => ({
  options: options || [{ goodsNo, optionNumber: '001', productId: '8800289469145', name: '한교동', hidden }],
  relatedGoodsNos: related, coverage: { complete, scope: 'official-public-product-option-and-review-evidence', reason: complete ? 'resolved' : 'review_partial' }
});

function setup({ request, discover, shouldYield = () => false } = {}) {
  let clock = Date.parse('2026-09-13T02:00:00Z');
  let scan = { page: 1, offset: 0, processed: 0, enumerationComplete: false };
  const products = {};
  const calls = [];
  let failCheckpoint = false;
  let sequence = Promise.resolve();
  const index = {
    readScan: async () => structuredClone(scan),
    mutateScan: change => {
      const operation = sequence.then(async () => {
        const next = structuredClone(scan);
        await change(next);
        if (failCheckpoint && scan.collection?.lease && !next.collection?.lease) throw new Error('private storage failure');
        scan = next;
        return structuredClone(scan);
      });
      sequence = operation.catch(() => {});
      return operation;
    },
    readProduct: async goodsNo => structuredClone(products[goodsNo] || null),
    saveDiscovery: async (goodsNo, value, timestamp) => {
      calls.push({ type: 'save', goodsNo, value: structuredClone(value) });
      products[goodsNo] = { ...structuredClone(value), checkedAt: new Date(timestamp).toISOString() };
      return structuredClone(products[goodsNo]);
    }
  };
  const config = {
    index, now: () => clock, shouldYield,
    request: async (...args) => { calls.push({ type: 'catalog', input: args[0] }); return request ? request(...args) : catalog(); },
    discover: async (...args) => { calls.push({ type: 'discover', goodsNo: args[0] }); return discover ? discover(...args) : result(args[0]); }
  };
  return {
    collector: createHiddenCollection(config), config, index, calls, products,
    advance: value => { clock += value; }, now: () => clock,
    snapshot: () => structuredClone(scan),
    failCheckpoint: value => { failCheckpoint = value; },
    seedCatalogComplete: async () => {
      await index.mutateScan(value => {
        value.collection.catalog.enumerationComplete = true;
        value.collection.catalog.lastCompletedAt = new Date(clock).toISOString();
        value.collection.catalog.refreshAt = new Date(clock + DAY).toISOString();
      });
    }
  };
}

test('one catalog page queues many parents, deduplicates, checkpoints and processes at most five units', async () => {
  const goods = ids(20);
  const f = setup({ request: async () => catalog(goods) });
  const first = await f.collector.step();
  assert.equal(first.progress.workUnits, 5);
  assert.equal(first.progress.processed, 4);
  assert.equal(f.calls.filter(call => call.type === 'catalog').length, 1);
  assert.equal(first.collection.queueRemaining, 16);
  assert.equal(first.collection.catalog.enumerationComplete, true);
  const second = await createHiddenCollection(f.config).step();
  assert.equal(second.progress.processed, 5);
  assert.equal(f.calls.filter(call => call.type === 'catalog').length, 1);
  assert.equal(second.collection.queueRemaining, 11);
});

test('stores only owned root options and queues related identities separately', async () => {
  const f = setup({ discover: async id => id === GOODS ? result(id, { related: [OTHER, OTHER], options: [
    ...result(id).options, { goodsNo: OTHER, optionNumber: '001', productId: null, hidden: null }
  ] }) : result(id) });
  await f.collector.enqueue([GOODS, GOODS]);
  await f.seedCatalogComplete();
  const response = await f.collector.step();
  assert.equal(response.progress.processed, 2);
  assert.deepEqual(f.products[GOODS].options.map(option => option.goodsNo), [GOODS]);
  assert.equal(f.calls.filter(call => call.type === 'discover' && call.goodsNo === OTHER).length, 1);
  assert.equal(response.collection.knownProducts, 2);
});

test('CAS lease prevents concurrent collector instances from calling the provider', async () => {
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = setup({ discover: async id => { entered(); await new Promise(resolve => { release = resolve; }); return result(id); } });
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  const first = f.collector.step();
  await enteredPromise;
  const second = await createHiddenCollection(f.config).step();
  assert.equal(second.idle, true);
  assert.equal(second.progress.phase, 'leased');
  assert.equal(f.calls.filter(call => call.type === 'discover').length, 1);
  release();
  await first;
  assert.equal(f.snapshot().collection.lease, null);
});

test('a product saved before checkpoint failure is reused after the expired lease, not rediscovered', async () => {
  const f = setup();
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  f.failCheckpoint(true);
  await assert.rejects(f.collector.step(), /hidden_collection_checkpoint_unavailable/);
  assert.ok(f.products[GOODS]);
  f.failCheckpoint(false);
  f.advance(150001);
  const next = await createHiddenCollection(f.config).step();
  assert.equal(next.collection.queueRemaining, 0);
  assert.equal(f.calls.filter(call => call.type === 'discover').length, 1);
});

test('concurrent enqueue is not overwritten by a leased worker checkpoint', async () => {
  let f;
  f = setup({ discover: async id => { await f.collector.enqueue([OTHER]); return result(id); } });
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  const first = await f.collector.step();
  assert.equal(first.collection.queueRemaining, 1);
  assert.ok(f.snapshot().collection.queued[OTHER]);
  assert.ok(f.snapshot().collection.known[OTHER]);
});

test('three consecutive root failures back off globally and preserve deduplicated retry queues', async () => {
  const f = setup({ discover: async () => { throw new Error('private provider failure'); } });
  await f.collector.enqueue([GOODS, OTHER, THIRD]);
  await f.seedCatalogComplete();
  const first = await f.collector.step();
  assert.equal(first.progress.failed, 3);
  assert.equal(first.collection.queueRemaining, 3);
  assert.equal(first.collection.pauseReason, 'consecutive_root_failures');
  assert.equal(first.retryAfterSeconds, 3600);
  assert.ok(Object.values(f.snapshot().collection.known).every(entry => entry.attempts === 1));
  const second = await f.collector.step();
  assert.equal(second.idle, true);
  assert.equal(f.calls.filter(call => call.type === 'discover').length, 3);
  assert.equal(JSON.stringify(first).includes('private provider'), false);
});

test('useful partial data is kept and scheduled daily without declaring complete or failing globally', async () => {
  const f = setup({ discover: async id => result(id, { complete: false }) });
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  const response = await f.collector.step();
  assert.equal(response.progress.processed, 1);
  assert.equal(response.progress.failed, 0);
  const known = f.snapshot().collection.known[GOODS];
  assert.equal(Date.parse(known.nextCheckAt) - Date.parse(known.lastCheckedAt), DAY);
  const status = await f.collector.status();
  assert.equal(status.coverage.complete, false);
  assert.equal(status.collection.partialProducts, 1);
});

test('catalog failure backs off without erasing queued products or claiming empty completed catalog', async () => {
  const f = setup({ request: async () => ({ status: 'ERROR' }) });
  await f.collector.enqueue([GOODS]);
  const response = await f.collector.step();
  assert.equal(response.collection.queueRemaining, 1);
  assert.equal(response.collection.catalog.enumerationComplete, false);
  assert.equal(response.collection.pauseReason, 'catalog_unavailable');
  assert.equal(response.retryAfterSeconds, 3600);
});

test('hidden and partial roots refresh daily; normal roots refresh after seven days even with unchanged metadata', async () => {
  const f = setup({ request: async () => catalog([GOODS, OTHER]), discover: async id => result(id, { hidden: id === GOODS }) });
  await f.collector.step();
  let state = f.snapshot().collection;
  assert.equal(Date.parse(state.known[GOODS].nextCheckAt) - Date.parse(state.known[GOODS].lastCheckedAt), DAY);
  assert.equal(Date.parse(state.known[OTHER].nextCheckAt) - Date.parse(state.known[OTHER].lastCheckedAt), 7 * DAY);
  f.advance(DAY + 1);
  await f.collector.step();
  assert.equal(f.calls.filter(call => call.type === 'catalog').length, 2);
  assert.equal(f.calls.filter(call => call.type === 'discover' && call.goodsNo === GOODS).length, 2);
  assert.equal(f.calls.filter(call => call.type === 'discover' && call.goodsNo === OTHER).length, 1);
});

test('foreground interruption preserves queue and does not count a provider failure', async () => {
  let foreground = false;
  const f = setup({ shouldYield: () => foreground, discover: async () => { foreground = true; throw new Error('background_yield'); } });
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  const response = await f.collector.step();
  assert.equal(response.progress.phase, 'foreground_priority');
  assert.equal(response.progress.failed, 0);
  assert.equal(response.collection.queueRemaining, 1);
  assert.equal(response.collection.consecutiveFailures, 0);
  assert.equal(f.snapshot().collection.known[GOODS].attempts, 0);
  const calls = f.calls.length;
  const idle = await f.collector.step();
  assert.equal(idle.idle, true);
  assert.equal(f.calls.length, calls);
});

test('thirty-second budget yields between work units and compact status never leaks queue IDs', async () => {
  let f;
  f = setup({ discover: async id => { f.advance(16000); return result(id); } });
  await f.collector.enqueue([GOODS, OTHER, THIRD]);
  await f.seedCatalogComplete();
  const response = await f.collector.step();
  assert.equal(response.progress.phase, 'time_budget');
  assert.ok(response.progress.workUnits <= 2);
  assert.equal(response.progress.failed, 0);
  const status = await f.collector.status();
  assert.equal(JSON.stringify(status).includes(GOODS), false);
  assert.equal(JSON.stringify(status).includes(OTHER), false);
  assert.equal(status.coverage.allPhysicalInventoryGuaranteed, false);
  assert.ok(Date.parse(status.collection.nextRunAt) > f.now());
});

test('catalog gets another page after twenty-five product units despite a growing related graph', async () => {
  const first = ids(20);
  let relatedIndex = 100;
  const f = setup({
    request: async input => catalog(input.body.page === 1 ? first : [GOODS], input.body.page === 1, 21),
    discover: async id => result(id, { related: ids(relatedIndex + 2).slice(relatedIndex, relatedIndex += 2) })
  });
  for (let index = 0; index < 7; index++) await f.collector.step();
  assert.ok(f.calls.filter(call => call.type === 'catalog').length >= 2);
  assert.equal(f.snapshot().collection.catalog.enumerationComplete, true);
});

test('catalog shortfall is partial instead of a false completed enumeration', async () => {
  const f = setup({ request: async () => catalog([GOODS], false, 100) });
  const response = await f.collector.step();
  assert.equal(response.collection.catalog.enumerationComplete, false);
  assert.equal(response.collection.queueRemaining, 1);
  assert.equal(response.collection.pauseReason, 'catalog_unavailable');
});

test('simultaneous lease acquisition is owner-guarded, not only protected by an initial read', async () => {
  const f = setup();
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  const responses = await Promise.all([f.collector.step(), createHiddenCollection(f.config).step()]);
  assert.equal(f.calls.filter(call => call.type === 'discover').length, 1);
  assert.ok(responses.some(response => response.progress.phase === 'leased'));
});

test('a pause published after the pre-read is rechecked inside lease acquisition and cannot be cleared', async () => {
  const f = setup();
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  const originalRead = f.index.readScan;
  let raced = false;
  f.index.readScan = async (...args) => {
    const previous = await originalRead(...args);
    if (!raced) {
      raced = true;
      await f.index.mutateScan(scan => {
        scan.collection.pausedUntil = new Date(f.now() + HOUR).toISOString();
        scan.collection.pauseReason = 'consecutive_root_failures';
        scan.collection.consecutiveFailures = 3;
      });
    }
    return previous;
  };
  const response = await f.collector.step();
  assert.equal(response.idle, true);
  assert.equal(response.progress.phase, 'backoff');
  assert.equal(response.retryAfterSeconds, 3600);
  assert.equal(f.calls.length, 0);
  assert.equal(f.snapshot().collection.lease, null);
  assert.equal(f.snapshot().collection.consecutiveFailures, 3);
  assert.equal(f.snapshot().collection.pauseReason, 'consecutive_root_failures');
});

test('product retry delay escalates to one day without exceeding that maximum', async () => {
  const f = setup({ discover: async () => { throw new Error('unavailable'); } });
  await f.collector.enqueue([GOODS]);
  await f.seedCatalogComplete();
  const delays = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    await f.collector.step();
    const next = Date.parse(f.snapshot().collection.known[GOODS].nextCheckAt);
    delays.push((next - f.now()) / HOUR);
    f.advance(next - f.now() + 1);
  }
  assert.deepEqual(delays, [1, 2, 4, 8, 16, 24, 24]);
});

test('known product capacity is explicit and does not silently evict earlier catalog identities', async () => {
  const f = setup();
  await f.collector.enqueue([GOODS]);
  await f.index.mutateScan(scan => {
    scan.collection.known = Object.fromEntries(ids(50000).map(id => [id, { fingerprint: '', attempts: 0 }]));
    scan.collection.queued = {};
  });
  const response = await f.collector.enqueue([GOODS]);
  assert.equal(response.added, 0);
  assert.equal(response.collection.knownProducts, 50000);
  assert.equal(response.collection.capacityReached, true);
  assert.equal(f.snapshot().collection.known[GOODS], undefined);
});
