import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalHiddenOptions,
  createHiddenIndexStore,
  emptyHiddenIndex,
  mergeDiscovery,
  searchHiddenIndex
} from './hidden-stock-index.mjs';
import {
  OFFLINE_REGIONS,
  decodeHiddenCursor,
  encodeHiddenCursor,
  readHiddenStoreBatch
} from './hidden-store-pages.mjs';

const NOW = Date.parse('2026-09-13T01:00:00.000Z');
const SECRET = 'fixture-hidden-stock-cursor-1234567890';
const GOODS = 'A000000255680';
const RELATED = 'A000000255681';
const OTHER = 'A000000255682';
const SKU = '8800289469145';
const CONTEXT = `stores:${GOODS}:${SKU}`;

function option(overrides = {}) {
  return {
    goodsNo: GOODS, optionNumber: '001', productId: SKU,
    name: '[한교동 콜라보] 본품2EA+공병키링', goodsName: 'PDRN 핑크 콜라겐 글로우 젤리 미스트',
    aliases: ['한교동에디션', '100ml 더블기획'], sourceGoodsNos: [GOODS],
    hidden: true, ...overrides
  };
}

function discovery(options = [option()], complete = true) {
  return { options, relatedGoodsNos: [], coverage: { complete, reason: complete ? 'complete' : 'provider_unavailable' } };
}

function storePage(rows, extra = {}) {
  return { status: 'SUCCESS', code: 200, data: { storeList: rows, stockDisplayYn: true, ...extra } };
}

function storeRow(code, quantity = 1, overrides = {}) {
  return { storeCode: code, storeName: `매장 ${code}`, address: '서울 종로구', remainQuantity: quantity, ...overrides };
}

function cursorState(overrides = {}) {
  return { context: CONTEXT, region: 0, page: 1, rows: 0, last: '', expires: NOW + 60000, ...overrides };
}

function batchOptions(request, extra = {}) {
  return { request, goodsNo: GOODS, productId: SKU, secret: SECRET, now: () => NOW, ...extra };
}

test('partial index merge keeps old verified identities stale while complete merge replaces them', () => {
  const index = emptyHiddenIndex();
  mergeDiscovery(index, GOODS, discovery([option(), option({ optionNumber: '002', productId: '8800289469146' })]), NOW);
  mergeDiscovery(index, GOODS, discovery([option({ hidden: false })], false), NOW + 1000);
  const saved = index.products[GOODS];
  assert.equal(saved.options.length, 2);
  assert.equal(saved.options.find(row => row.optionNumber === '001').hidden, false);
  assert.equal(saved.options.find(row => row.optionNumber === '001').stale, false);
  assert.equal(saved.options.find(row => row.optionNumber === '002').stale, true);
  assert.equal(saved.options.find(row => row.optionNumber === '002').discoveredAt, new Date(NOW).toISOString());
  assert.equal(saved.coverage.complete, false);
  mergeDiscovery(index, GOODS, discovery([option({ hidden: false })]), NOW + 2000);
  assert.equal(index.products[GOODS].options.length, 1);
  assert.equal(searchHiddenIndex(index, '한교동').length, 0);
});

test('unresolved partial refresh retains only the same verified SKU as stale without resetting identity time or hidden classification', () => {
  const index = emptyHiddenIndex();
  const verified = option({ image: 'https://image.oliveyoung.co.kr/fixture.jpg', evidence: [
    { type: 'review-goods-sku', goodsNo: GOODS, optionNumber: '001', productId: SKU }
  ] });
  mergeDiscovery(index, GOODS, discovery([verified]), NOW);
  const observed = discovery([option({ productId: null, hidden: null, evidence: [
    { type: 'review-option', goodsNo: GOODS, optionNumber: '001' }
  ] })], false);
  observed.coverage.reason = 'review_page_unavailable,unresolved_option_skus';
  for (const at of [NOW + 60001, NOW + 120002]) {
    mergeDiscovery(index, GOODS, observed, at);
    const saved = index.products[GOODS].options[0];
    assert.equal(saved.productId, SKU);
    assert.equal(saved.stale, true);
    assert.equal(saved.hidden, null);
    assert.equal(saved.identityVerifiedAt, new Date(NOW).toISOString());
    assert.equal(saved.discoveredAt, new Date(at).toISOString());
    assert.equal(saved.image, verified.image);
    assert.equal(saved.evidence.filter(entry => entry.productId === SKU).length, 1);
    assert.equal(index.products[GOODS].coverage.complete, false);
    // Unknown online classification is not silently restored to hidden=true.
    assert.equal(searchHiddenIndex(index, '한교동').length, 0);
  }
});

test('partial identity carry-forward never crosses option keys, conflicts, changed SKU or complete removal', () => {
  const cases = [
    { options: [option({ productId: null })], complete: true, expected: null },
    { options: [option({ productId: null })], complete: false, reason: 'conflicting_sku_evidence,unresolved_option_skus', expected: null },
    { options: [option({ productId: null, evidence: [{ productId: SKU }, { productId: '8800289469146' }] })], complete: false, expected: null },
    { options: [option({ productId: null, evidence: [{ productId: '8800289469146' }] })], complete: false, expected: null },
    { options: [option({ productId: '8800289469146' })], complete: false, expected: '8800289469146' },
    { options: [], complete: true, expected: undefined }
  ];
  for (const entry of cases) {
    const index = emptyHiddenIndex();
    mergeDiscovery(index, GOODS, discovery(), NOW);
    const latest = discovery(entry.options, entry.complete);
    if (entry.reason) latest.coverage.reason = entry.reason;
    mergeDiscovery(index, GOODS, latest, NOW + 60001);
    assert.equal(index.products[GOODS].options[0]?.productId, entry.expected);
    assert.equal(index.products[GOODS].options.some(row => row.productId === SKU), false);
  }
  const index = emptyHiddenIndex();
  mergeDiscovery(index, GOODS, discovery(), NOW);
  mergeDiscovery(index, GOODS, discovery([option({ goodsNo: RELATED, productId: null }),
    option({ optionNumber: '002', productId: null })], false), NOW + 60001);
  assert.equal(index.products[GOODS].options.find(row => row.goodsNo === RELATED).productId, null);
  assert.equal(index.products[GOODS].options.find(row => row.optionNumber === '002').productId, null);
});

test('canonical option status removes stale related hidden copies before keyword/SKU filtering', () => {
  const index = emptyHiddenIndex();
  mergeDiscovery(index, RELATED, discovery([option({ name: '예전 한교동 숨김', productId: '8800000000001' })]), NOW);
  mergeDiscovery(index, GOODS, discovery([option({ hidden: false, name: '현재 판매중' })]), NOW + 1000);
  assert.equal(searchHiddenIndex(index, '예전').length, 0);
  assert.equal(searchHiddenIndex(index, '8800000000001').length, 0);
  assert.equal(searchHiddenIndex(index, '한교동').length, 0);
  assert.equal(canonicalHiddenOptions(index).length, 1);
  assert.equal(canonicalHiddenOptions(index)[0].hidden, false);
  assert.equal(canonicalHiddenOptions(index)[0].productId, SKU);
  // A related-root discovery fetches this product's own active list too.
  // Newer direct evidence must not lose to an older root record.
  mergeDiscovery(index, OTHER, discovery([option({ hidden: true })]), NOW + 2000);
  assert.equal(searchHiddenIndex(index, '한교동').length, 1);
  mergeDiscovery(index, GOODS, discovery([option({ hidden: true, productId: '8800000000002' })]), NOW + 3000);
  assert.deepEqual(searchHiddenIndex(index, '한교동').map(row => row.productId), ['8800000000002']);
});

test('without an own-product record newest related observation wins, with conservative equal-time status', () => {
  const index = emptyHiddenIndex();
  mergeDiscovery(index, RELATED, discovery([option()]), NOW);
  mergeDiscovery(index, OTHER, discovery([option({ hidden: false })]), NOW + 1000);
  assert.equal(searchHiddenIndex(index, '한교동').length, 0);
  mergeDiscovery(index, RELATED, discovery([option()]), NOW + 1000);
  assert.equal(searchHiddenIndex(index, '한교동').length, 0);
  mergeDiscovery(index, RELATED, discovery([option({ hidden: null })]), NOW + 2000);
  assert.equal(searchHiddenIndex(index, '한교동').length, 0);
});

test('hidden index search matches normalized names, aliases, identifiers and all query tokens', () => {
  const index = emptyHiddenIndex();
  mergeDiscovery(index, GOODS, discovery([
    option(),
    option({ optionNumber: '002', productId: null }),
    option({ optionNumber: '003', hidden: false }),
    option({ optionNumber: '004', hidden: null })
  ]), NOW);
  for (const query of ['한교동에디션', '한교동 100ml', 'ｐｄｒｎ 핑크', '본품2ea', SKU, GOODS.toLowerCase()]) {
    const found = searchHiddenIndex(index, query);
    assert.equal(found.length, 1, query);
    assert.equal(found[0].optionNumber, '001');
  }
  assert.equal(searchHiddenIndex(index, '한교동 샴푸').length, 0);
});

test('index CAS retries typed conflicts and preserves another writer discoveries and checkpoints', async () => {
  let saved = emptyHiddenIndex();
  let etag = 'initial';
  let writes = 0;
  const store = createHiddenIndexStore({
    now: () => NOW,
    read: async () => ({ value: structuredClone(saved), etag }),
    write: async (next, expected) => {
      writes += 1;
      if (writes === 1) {
        mergeDiscovery(saved, RELATED, discovery([option({ goodsNo: RELATED })]), NOW - 1000);
        saved.scan = { ...saved.scan, page: 4, offset: 7, processed: 67 };
        etag = 'external-writer';
        const conflict = new Error('write rejected');
        conflict.statusCode = 412;
        throw conflict;
      }
      assert.equal(expected, 'external-writer');
      saved = structuredClone(next);
      etag = 'new';
    }
  });
  const result = await store.mutate(index => mergeDiscovery(index, GOODS, discovery(), NOW));
  assert.equal(writes, 2);
  assert.ok(result.products[GOODS]);
  assert.ok(result.products[RELATED]);
  assert.equal(result.scan.page, 4);
  assert.equal(result.scan.offset, 7);
  assert.equal(result.updatedAt, new Date(NOW).toISOString());
});

test('simultaneous index mutations merge, cache clones are isolated and fresh reads bypass TTL', async () => {
  let saved = emptyHiddenIndex();
  let revision = 0;
  let readCount = 0;
  let clock = NOW;
  const store = createHiddenIndexStore({
    now: () => clock,
    read: async () => { readCount++; return { value: structuredClone(saved), etag: revision }; },
    write: async (next, expected) => {
      if (expected !== revision) throw Object.assign(new Error('write rejected'), { status: 409 });
      saved = structuredClone(next);
      revision++;
    }
  });
  await Promise.all([
    store.mutate(index => mergeDiscovery(index, GOODS, discovery(), NOW)),
    store.mutate(index => mergeDiscovery(index, RELATED, discovery([option({ goodsNo: RELATED })]), NOW))
  ]);
  const cached = await store.read();
  assert.equal(Object.keys(cached.products).length, 2);
  const before = readCount;
  delete cached.products[GOODS];
  assert.ok((await store.read()).products[GOODS]);
  assert.equal(readCount, before);
  await store.read({ fresh: true });
  assert.equal(readCount, before + 1);
  clock += 30001;
  await store.read();
  assert.equal(readCount, before + 2);
});

test('index mutation stops after five conflicts and does not retry ordinary storage failures', async () => {
  for (const [makeError, expected] of [
    [() => Object.assign(new Error('rejected'), { statusCode: 412 }), 5],
    [() => new Error('storage token unavailable'), 1]
  ]) {
    let writes = 0;
    const store = createHiddenIndexStore({
      read: async () => ({ value: emptyHiddenIndex(), etag: null }),
      write: async () => { writes++; throw makeError(); }, now: () => NOW
    });
    await assert.rejects(() => store.mutate(value => mergeDiscovery(value, GOODS, discovery(), NOW)));
    assert.equal(writes, expected);
  }
});

test('signed cursor round-trips but rejects tamper, wrong secret/context, expiry and malformed values', () => {
  const cursor = encodeHiddenCursor(cursorState(), SECRET);
  assert.deepEqual(decodeHiddenCursor(cursor, SECRET, CONTEXT, NOW), cursorState());
  assert.equal(decodeHiddenCursor(null, SECRET, CONTEXT, NOW), null);
  const [payload, signature] = cursor.split('.');
  const tampered = `${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  for (const [value, secret, context, clock] of [
    [tampered, SECRET, CONTEXT, NOW],
    [cursor, SECRET + 'wrong', CONTEXT, NOW],
    [cursor, SECRET, `stores:${OTHER}:${SKU}`, NOW],
    [cursor, SECRET, CONTEXT, NOW + 60000],
    [cursor, SECRET, CONTEXT, NOW + 60001],
    ['x'.repeat(1801), SECRET, CONTEXT, NOW],
    [cursor + '.extra', SECRET, CONTEXT, NOW],
    [encodeHiddenCursor(null, SECRET), SECRET, CONTEXT, NOW],
    [encodeHiddenCursor([], SECRET), SECRET, CONTEXT, NOW],
    [encodeHiddenCursor({ ...cursorState(), expires: 'not-a-number' }, SECRET), SECRET, CONTEXT, NOW],
    [false, SECRET, CONTEXT, NOW]
  ]) {
    assert.throws(() => decodeHiddenCursor(value, secret, context, clock), /invalid_cursor/);
  }
});

test('store cursor state bounds and identifiers are checked before any upstream request', async () => {
  let calls = 0;
  const request = async () => { calls++; return storePage([]); };
  for (const overrides of [{ region: -1 }, { region: 17 }, { page: 0 }, { page: 201 }, { page: 1.5 },
    { rows: -1 }, { rows: '0' }, { last: '<script>' }, { last: null }]) {
    await assert.rejects(() => readHiddenStoreBatch(batchOptions(request, {
      cursor: encodeHiddenCursor(cursorState(overrides), SECRET)
    })), /invalid_cursor/);
  }
  await assert.rejects(() => readHiddenStoreBatch(batchOptions(request, { goodsNo: '../secret' })), /invalid_goods_no/);
  await assert.rejects(() => readHiddenStoreBatch(batchOptions(request, { productId: 'http://127.0.0.1' })), /invalid_product_id/);
  assert.equal(calls, 0);
});

test('nationwide pages continue past short count, totalCount and nextPage until every region has an EMPTY page', async () => {
  const calls = [];
  const request = async input => {
    assert.equal(input.method, 'POST');
    assert.equal(input.path, '/oystore/api/stock/stock-stores');
    const { pageIdx, searchWords } = input.body;
    calls.push([searchWords, pageIdx]);
    if (searchWords === '서울' && pageIdx < 3) return storePage([storeRow(`seoul-${pageIdx}`)], { totalCount: 1, nextPage: false });
    return storePage([], { totalCount: 10000, nextPage: true });
  };
  let result = await readHiddenStoreBatch(batchOptions(request));
  const stores = [...result.stores];
  assert.deepEqual(calls, [['서울', 1], ['서울', 2], ['서울', 3]]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.scannedRegions, 1);
  assert.ok(result.nextCursor);
  for (let attempt = 0; result.nextCursor && attempt < 10; attempt++) {
    result = await readHiddenStoreBatch(batchOptions(request, { cursor: result.nextCursor }));
    stores.push(...result.stores);
  }
  assert.equal(result.coverage.complete, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.coverage.scannedRegions, OFFLINE_REGIONS.length);
  assert.equal(result.coverage.observedRows, 2);
  assert.equal(result.coverage.reason, 'public_pages_exhausted');
  assert.equal(result.coverage.allPhysicalInventoryGuaranteed, false);
  assert.equal(calls.length, OFFLINE_REGIONS.length + 2);
  assert.deepEqual(stores.map(row => row.code), ['seoul-1', 'seoul-2']);
});

test('province address queries use verified full Chungcheong/Gyeongsang names without obsolete Jeolla names', () => {
  for (const region of ['충청북도', '충청남도', '경상북도', '경상남도', '전북', '전남']) {
    assert.ok(OFFLINE_REGIONS.includes(region), region);
  }
  for (const region of ['충북', '충남', '경북', '경남', '전라북도', '전라남도']) {
    assert.equal(OFFLINE_REGIONS.includes(region), false, region);
  }
  assert.equal(OFFLINE_REGIONS.length, 17);
});

test('store pagination retains repeat detection across batches and reports incomplete instead of looping', async () => {
  let calls = 0;
  const request = async () => { calls++; return storePage([storeRow('repeated-store')]); };
  const first = await readHiddenStoreBatch(batchOptions(request, { pagesPerBatch: 1 }));
  assert.ok(first.nextCursor);
  const second = await readHiddenStoreBatch(batchOptions(request, { cursor: first.nextCursor }));
  assert.equal(calls, 2);
  assert.equal(second.stores.length, 0);
  assert.equal(second.nextCursor, null);
  assert.equal(second.coverage.complete, false);
  assert.equal(second.coverage.reason, 'repeated_store_page');
  assert.equal(second.coverage.observedRows, 1);
});

test('a failed store page preserves earlier data and a resumable cursor for the failed page', async () => {
  const first = await readHiddenStoreBatch(batchOptions(async ({ body }) => {
    if (body.pageIdx === 1) return storePage([storeRow('before-failure', 6)]);
    throw new Error('provider headers and secret must not escape');
  }));
  assert.equal(first.stores.length, 1);
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.reason, 'store_page_unavailable');
  const checkpoint = decodeHiddenCursor(first.nextCursor, SECRET, CONTEXT, NOW);
  assert.equal(checkpoint.page, 2);
  assert.equal(checkpoint.region, 0);
  const requested = [];
  const resumed = await readHiddenStoreBatch(batchOptions(async ({ body }) => {
    requested.push(body.pageIdx);
    return storePage([storeRow(`resumed-${body.pageIdx}`)]);
  }, { cursor: first.nextCursor, pagesPerBatch: 1 }));
  assert.deepEqual(requested, [2]);
  assert.equal(resumed.stores[0].code, 'resumed-2');
  assert.equal(JSON.stringify(first).includes('provider headers'), false);
});

test('provider failure/missing schema/non-display is incomplete, not empty stock or completed coverage', async () => {
  for (const response of [
    null, { status: 'ERROR', data: { storeList: [] } },
    storePage([], { stockDisplayYn: false }),
    { status: 'SUCCESS', code: 503, data: { storeList: [] } },
    { status: 'SUCCESS', data: { totalCount: 0 } }
  ]) {
    const result = await readHiddenStoreBatch(batchOptions(async () => response));
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.reason, 'store_page_unavailable');
    assert.equal(result.coverage.scannedRegions, 0);
    assert.ok(result.nextCursor);
  }
});

test('verified SUCCESS empty total-zero non-display page ends the province and resumes at the next region', async () => {
  const calls = [];
  const first = await readHiddenStoreBatch(batchOptions(async ({ body }) => {
    calls.push([body.searchWords, body.pageIdx]);
    return storePage([], { pageIdx: 9, totalCount: 0, stockDisplayYn: false });
  }, { cursor: encodeHiddenCursor(cursorState({ page: 9, rows: 369 }), SECRET), pagesPerBatch: 1 }));
  assert.deepEqual(calls, [['서울', 9]]);
  assert.equal(first.coverage.reason, 'more_pages');
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.scannedRegions, 1);
  assert.equal(first.coverage.observedRows, 369);
  assert.deepEqual(first.stores, []);
  const continuation = decodeHiddenCursor(first.nextCursor, SECRET, CONTEXT, NOW);
  assert.equal(continuation.region, 1);
  assert.equal(continuation.page, 1);
  const next = await readHiddenStoreBatch(batchOptions(async ({ body }) => {
    assert.equal(body.searchWords, '부산');
    assert.equal(body.pageIdx, 1);
    return storePage([storeRow('busan-first', 2)]);
  }, { cursor: first.nextCursor, pagesPerBatch: 1 }));
  assert.equal(next.stores[0].code, 'busan-first');
  const last = await readHiddenStoreBatch(batchOptions(async () => storePage([], { totalCount: 0, stockDisplayYn: false }), {
    cursor: encodeHiddenCursor(cursorState({ region: OFFLINE_REGIONS.length - 1, page: 9 }), SECRET), pagesPerBatch: 1
  }));
  assert.equal(last.coverage.complete, true);
  assert.equal(last.coverage.reason, 'public_pages_exhausted');
  assert.equal(last.nextCursor, null);
});

test('non-display pages with rows or a missing/nonzero/non-numeric-zero total still fail closed', async () => {
  for (const response of [
    storePage([storeRow('withheld-stock')], { stockDisplayYn: false, totalCount: 0 }),
    storePage([storeRow('withheld-stock')], { stockDisplayYn: false, totalCount: 1 }),
    ...[undefined, null, 1, '0'].map(totalCount => storePage([], { stockDisplayYn: false, totalCount }))
  ]) {
    const result = await readHiddenStoreBatch(batchOptions(async () => response, {
      cursor: encodeHiddenCursor(cursorState({ page: 9, rows: 369 }), SECRET), pagesPerBatch: 1
    }));
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.reason, 'store_page_unavailable');
    assert.equal(result.coverage.scannedRegions, 0);
    assert.equal(result.coverage.observedRows, 369);
    assert.deepEqual(result.stores, []);
    const unchanged = decodeHiddenCursor(result.nextCursor, SECRET, CONTEXT, NOW);
    assert.equal(unchanged.region, 0);
    assert.equal(unchanged.page, 9);
  }
});

test('unknown quantities stay null, true zero remains zero, invalid store codes never render', async () => {
  const values = [null, undefined, '', '   ', false, true, {}, [], 'unknown', -1, Infinity, 0, '0', 6, '51'];
  const result = await readHiddenStoreBatch(batchOptions(async () => storePage([
    ...values.map((value, index) => storeRow(`store-${index}`, value, { remainQuantity: value, o2oRemainQuantity: value })),
    storeRow('<script>', 1)
  ]), { pagesPerBatch: 1 }));
  assert.equal(result.stores.length, values.length);
  assert.deepEqual(result.stores.map(row => row.qty), [null, null, null, null, null, null, null, null, null, null, null, 0, 0, 6, 51]);
  assert.deepEqual(result.stores.map(row => row.o2o), result.stores.map(row => row.qty));
  assert.equal(result.stores[0].salesStore, null);
  assert.equal(result.stores[0].checkedAt, new Date(NOW).toISOString());
});

test('store page limit ends incomplete without issuing an unusable continuation', async () => {
  const result = await readHiddenStoreBatch(batchOptions(async () => storePage([storeRow('last-page', 1)]), {
    cursor: encodeHiddenCursor(cursorState({ page: 200 }), SECRET)
  }));
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'store_page_limit');
  assert.equal(result.nextCursor, null);
  assert.equal(result.stores.length, 1);
});

test('invalid internal batch size cannot create an unbounded request loop', async () => {
  for (const pagesPerBatch of [Infinity, 100000, -1, 0, 'invalid']) {
    let calls = 0;
    const result = await readHiddenStoreBatch(batchOptions(async ({ body }) => {
      calls++;
      return storePage([storeRow(`page-${body.pageIdx}`)]);
    }, { pagesPerBatch }));
    assert.ok(calls >= 1 && calls <= 10);
    assert.equal(result.coverage.complete, false);
    assert.ok(result.nextCursor);
  }
});

test('nearby uses the supplied location with blank official search and sorts known km distances before unknown', async () => {
  const calls = [];
  const result = await readHiddenStoreBatch(batchOptions(async ({ body }) => {
    calls.push(body);
    if (body.pageIdx === 2) return storePage([], { totalCount: 0, stockDisplayYn: false });
    return storePage([
      storeRow('far', 1, { distance: '4.2' }),
      storeRow('unknown', null, { distance: null, latitude: 37, longitude: 127 }),
      storeRow('near', 0, { distance: 0.37 }),
      storeRow('same-place', 1, { distance: 0 }),
      storeRow('invalid-distance', 1, { distance: -3 })
    ]);
  }, { scope: 'nearby', lat: 37.6152, lng: 126.7156 }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { productId: SKU, lat: 37.6152, lon: 126.7156,
    pageIdx: 1, searchWords: '', mapLat: 37.6152, mapLon: 126.7156 });
  assert.ok(calls.every(body => body.searchWords === ''));
  assert.equal(result.scope, 'nearby');
  assert.equal(result.coverage.scope, 'official-nearby-search');
  assert.deepEqual(result.coverage.origin, { lat: 37.6152, lng: 126.7156 });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.allPhysicalInventoryGuaranteed, false);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.stores.map(row => row.code), ['same-place', 'near', 'far', 'unknown', 'invalid-distance']);
  assert.deepEqual(result.stores.map(row => row.dist), [0, 0.37, 4.2, null, null]);
  assert.equal(result.stores.find(row => row.code === 'near').qty, 0);
  assert.equal(result.stores.find(row => row.code === 'unknown').qty, null);
  assert.ok(result.stores.every(row => row.lat === undefined && row.lng === undefined && row.latitude === undefined));
});

test('nearby calls are bounded to three pages and remain partial until a verified empty page', async () => {
  let calls = 0;
  const result = await readHiddenStoreBatch(batchOptions(async ({ body }) => {
    calls++;
    return storePage([storeRow(`nearby-${body.pageIdx}`)], { totalCount: 1, nextPage: false });
  }, { scope: 'nearby', lat: 37, lng: 127, pagesPerBatch: 100 }));
  assert.equal(calls, 3);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'more_pages');
  assert.ok(result.nextCursor);
});

test('nearby cursor cannot continue as national or at a different location; equivalent numbers normalize', async () => {
  let calls = 0;
  const request = async ({ body }) => { calls++; return storePage([storeRow(`page-${body.pageIdx}`)]); };
  const first = await readHiddenStoreBatch(batchOptions(request, { scope: 'nearby', lat: '37.00', lng: '127.000', pagesPerBatch: 1 }));
  assert.equal(calls, 1);
  for (const extra of [
    {}, { scope: 'national', lat: 37, lng: 127 },
    { scope: 'nearby', lat: 37.01, lng: 127 }, { scope: 'nearby', lat: 37, lng: 126.99 }
  ]) {
    await assert.rejects(() => readHiddenStoreBatch(batchOptions(request, { ...extra, cursor: first.nextCursor })), /invalid_cursor/);
  }
  assert.equal(calls, 1);
  const next = await readHiddenStoreBatch(batchOptions(request, { scope: 'nearby', lat: 37, lng: 127,
    pagesPerBatch: 1, cursor: first.nextCursor }));
  assert.equal(next.stores[0].code, 'page-2');
});

test('national location is optional and preserves old cursors while explicit origins are independently bound', async () => {
  const calls = [];
  const request = async ({ body }) => { calls.push(body); return storePage([storeRow(`page-${body.pageIdx}`)]); };
  const old = encodeHiddenCursor(cursorState({ page: 2 }), SECRET);
  await readHiddenStoreBatch(batchOptions(request, { scope: 'national', cursor: old, pagesPerBatch: 1 }));
  assert.equal(calls[0].lat, 37.5665);
  assert.equal(calls[0].searchWords, '서울');
  assert.equal(calls[0].pageIdx, 2);
  const located = await readHiddenStoreBatch(batchOptions(request, { scope: 'national', lat: 35.2, lng: 129.1, pagesPerBatch: 1 }));
  assert.equal(calls[1].lat, 35.2);
  assert.equal(calls[1].lon, 129.1);
  assert.equal(calls[1].searchWords, '서울');
  await assert.rejects(() => readHiddenStoreBatch(batchOptions(request, { scope: 'national', cursor: located.nextCursor })), /invalid_cursor/);
  assert.equal(calls.length, 2);
});

test('invalid nearby scope, location or state fails before issuing official requests', async () => {
  let calls = 0;
  const request = async () => { calls++; return storePage([]); };
  for (const [extra, error] of [
    [{ scope: 'all' }, 'invalid_scope'], [{ scope: '' }, 'invalid_scope'],
    [{ scope: 'nearby' }, 'invalid_location'], [{ scope: 'nearby', lat: 37 }, 'invalid_location'],
    [{ lat: 37 }, 'invalid_location'], [{ lng: 127 }, 'invalid_location'],
    ...['', ' ', 'NaN', Infinity, false, [], {}, '0x25', 91, -91].map(lat => [{ scope: 'nearby', lat, lng: 127 }, 'invalid_location']),
    ...[181, -181, null, undefined].map(lng => [{ scope: 'nearby', lat: 37, lng }, 'invalid_location'])
  ]) {
    await assert.rejects(() => readHiddenStoreBatch(batchOptions(request, extra)), new RegExp(error));
  }
  const context = `stores:${GOODS}:${SKU}:nearby:37:127`;
  await assert.rejects(() => readHiddenStoreBatch(batchOptions(request, { scope: 'nearby', lat: 37, lng: 127,
    cursor: encodeHiddenCursor(cursorState({ context, region: 1 }), SECRET) })), /invalid_cursor/);
  assert.equal(calls, 0);
});
