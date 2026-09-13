import test from 'node:test';
import assert from 'node:assert/strict';
import { createHiddenOptionDiscovery } from './hidden-option-discovery.mjs';

const CURRENT = 'A000000270000';
const HISTORICAL = 'A000000255680';
const now = () => Date.parse('2026-09-13T02:00:00Z');
// Explicit test-provider contract, not a claim about the live cursor API.
const verifiedContinuation = ({ nextCursorId }) => ({ fixtureCursor: nextCursorId });

function success(data) {
  return { status: 'SUCCESS', code: 200, data };
}

function stock(items = [], goodsName = 'PDRN 핑크 콜라겐 글로우 젤리 미스트') {
  return success({ goodsInfo: { goodsName, availableItems: items }, optionUploadUrl: 'https://image.oliveyoung.co.kr/uploads/images/goods/' });
}

function counts(goodsNo, items = [], related = []) {
  return success({
    productItemReviewCountList: items.map((item) => ({ goodsNumber: goodsNo, reviewCount: 1, ...item })),
    relatedProductReviewCountList: related,
    hasZeroReviewOption: false
  });
}

function reviews(goods = [], overrides = {}) {
  return success({
    goodsReviewList: goods.map((goodsDto, index) => ({ reviewId: String(100 + index), goodsDto })),
    hasNext: false,
    loginRequired: false,
    nextCursorId: null,
    nextCursorScore: null,
    nextCursorCount: null,
    ...overrides
  });
}

function mockRequest({ active = {}, history = {}, review = () => reviews(), fallback = {} } = {}) {
  const calls = [];
  const request = async (input) => {
    calls.push(structuredClone(input));
    if (input.path.endsWith('stock-goods-info-option')) {
      return active[input.body.goodsNo] || stock();
    }
    if (input.path.endsWith('stock-goods-info-v3')) {
      return fallback[input.body.goodsNo] || { status: 'ERROR' };
    }
    const match = input.path.match(/^\/review\/api\/v2\/reviews\/options\/([AB]\d+)\/count$/);
    if (match) return history[match[1]] || counts(match[1]);
    if (input.path === '/review/api/v2/reviews/cursor') return review(input.body);
    throw new Error('Unexpected fixture request');
  };
  return { request, calls };
}

test('finds a historical Hangyodon SKU through official related products, not a hardcoded mapping', async () => {
  const fixture = mockRequest({
    active: {
      [CURRENT]: stock([{ itemNumber: '001', itemName: '퍼프 증정 기획', legacyItemNumber: '8800000001111' }]),
      [HISTORICAL]: stock([{ itemNumber: '002', itemName: '본품2EA+곰돌이 공병키링', legacyItemNumber: '8800000002222' }])
    },
    history: {
      [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '퍼프 증정 기획' }], [
        { goodsNumber: HISTORICAL, itemNumber: '001', optionName: '[한교동 콜라보] 본품2EA+공병키링', reviewCount: 1761 }
      ]),
      [HISTORICAL]: counts(HISTORICAL, [
        { itemNumber: '002', optionName: '본품2EA+곰돌이 공병키링' },
        { itemNumber: '001', optionName: '[한교동 콜라보] 본품2EA+공병키링' }
      ])
    },
    review: (body) => {
      assert.equal(body.goodsNumber, HISTORICAL);
      assert.deepEqual(body.itemNumberList, ['001']);
      return reviews([{ goodsNumber: HISTORICAL, itemNumber: '001', legacyGoodsNumber: '8800289469145', goodsName: '젤리 미스트 100ml 더블기획', optionName: '[한교동 콜라보] 본품2EA+공병키링' }]);
    }
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  const hidden = result.options.filter((row) => row.hidden === true);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].goodsNo, HISTORICAL);
  assert.equal(hidden[0].optionNumber, '001');
  assert.equal(hidden[0].productId, '8800289469145');
  assert.equal(hidden[0].goodsName, '젤리 미스트 100ml 더블기획');
  assert.deepEqual(result.relatedGoodsNos, [HISTORICAL]);
  assert.ok(hidden[0].evidence.some((item) => item.type === 'related-review-option' && item.goodsNo === CURRENT));
  assert.ok(hidden[0].evidence.some((item) => item.type === 'review-goods-sku' && item.goodsNo === HISTORICAL));
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.scannedReviewPages, 1);
});

test('keeps a review-only option unresolved without borrowing a current SKU or online price', async () => {
  const fixture = mockRequest({
    active: { [CURRENT]: stock([{ itemNumber: '002', itemName: '현재 옵션', legacyItemNumber: '8800000002222', finalPrice: 1000, quantity: 20 }]) },
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '리뷰 없는 옛 옵션', reviewCount: 0 }]) },
    review: () => reviews([{ goodsNumber: CURRENT, itemNumber: '001', goodsName: '미스트', optionName: '옛 옵션' }])
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  const hidden = result.options.find((row) => row.optionNumber === '001');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.productId, null);
  for (const key of ['onlineQty', 'priceToPay', 'finalPrice', 'quantity', 'soldOut']) assert.equal(key in hidden, false);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.unresolvedOptions, 1);
  assert.deepEqual(result.coverage.unresolvedOptionKeys, [CURRENT + ':001']);
});

test('merges current options by goodsNo/itemNumber and never marks a related current option hidden', async () => {
  const fixture = mockRequest({
    active: {
      [CURRENT]: stock([{ itemNumber: '001', itemName: '현재 판매명', legacyItemNumber: '8800000001111' }]),
      [HISTORICAL]: stock([{ itemNumber: '001', itemName: '다른 상품 현재 옵션', legacyItemNumber: '8800000003333' }])
    },
    history: {
      [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '과거 이름' }], [{ goodsNumber: HISTORICAL, itemNumber: '001', optionName: '다른 상품 현재 옵션' }])
    },
    review: () => { throw new Error('Already resolved options should not request reviews'); }
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.options.length, 2);
  assert.ok(result.options.every((row) => row.hidden === false));
  assert.equal(result.options[0].name, '현재 판매명');
  assert.deepEqual(result.options[0].aliases, ['과거 이름']);
  assert.equal(result.coverage.scannedReviewPages, 0);
});

test('upstream errors never turn an unknown active list into a hidden/no-stock claim', async () => {
  const fixture = mockRequest({
    active: { [CURRENT]: { status: 'ERROR', message: 'sensitive error must not escape' } },
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '옵션' }]) },
    review: () => reviews([{ goodsNumber: CURRENT, itemNumber: '001', legacyGoodsNumber: '8800000001111' }])
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.options[0].hidden, null);
  assert.equal(result.options[0].productId, '8800000001111');
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason, /active_options_unavailable/);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('a successful v3 explicit active list recovers the unavailable option endpoint', async () => {
  const fixture = mockRequest({
    active: { [CURRENT]: { status: 'ERROR' } },
    fallback: { [CURRENT]: stock([{ itemNumber: '001', itemName: '현재 옵션', legacyItemNumber: '8800000001111' }]) },
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '현재 옵션' }]) }
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.options[0].hidden, false);
  assert.equal(result.coverage.complete, true);
});

test('stops a repeated cursor and reports partial evidence rather than looping', async () => {
  const fixture = mockRequest({
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '숨겨진 옵션' }]) },
    review: () => reviews([], { hasNext: true, nextCursorId: 42, nextCursorScore: 9 })
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now, maxReviewPages: 20, verifiedContinuation })(CURRENT);
  assert.equal(result.coverage.scannedReviewPages, 2);
  assert.match(result.coverage.reason, /review_cursor_stalled/);
  assert.equal(result.options[0].productId, null);
});

test('can resolve on a later targeted page and ignores other goods/options returned in a review response', async () => {
  const fixture = mockRequest({
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '003', optionName: '숨겨진 색상' }]) },
    review: (body) => body.page === 0
      ? reviews([
        { goodsNumber: HISTORICAL, itemNumber: '003', legacyGoodsNumber: '8800000009999' },
        { goodsNumber: CURRENT, itemNumber: '002', legacyGoodsNumber: '8800000008888' }
      ], { hasNext: true, nextCursorId: 101, nextCursorScore: 50, nextCursorCount: 2 })
      : reviews([{ goodsNumber: CURRENT, itemNumber: '003', legacyGoodsNumber: '8800000003333', optionName: '숨겨진 색상' }])
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now, verifiedContinuation })(CURRENT);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].productId, '8800000003333');
  assert.equal(result.coverage.scannedReviewPages, 2);
  const requests = fixture.calls.filter((call) => call.path.endsWith('/cursor'));
  assert.deepEqual(requests.map((call) => call.body.page), [0, 1]);
  assert.equal(requests[1].body.fixtureCursor, 101);
  assert.ok(requests.every((call) => call.body.itemNumberList[0] === '003'));
});

test('global review page budget leaves explicit unresolved options', async () => {
  const fixture = mockRequest({
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '미확인 옵션' }, { itemNumber: '002', optionName: '다른 미확인 옵션' }]) },
    review: (body) => reviews([], { hasNext: true, nextCursorId: 100 + body.page, nextCursorScore: 5 - body.page })
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now, maxReviewPages: 2 })(CURRENT);
  assert.equal(result.coverage.scannedReviewPages, 2);
  assert.equal(result.coverage.unresolvedOptions, 2);
  assert.match(result.coverage.reason, /review_page_limit/);
});

test('unverified live cursor continuation never silently increments page', async () => {
  const fixture = mockRequest({
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '확인되지 않은 옵션' }]) },
    review: () => reviews([], { hasNext: true, nextCursorId: 101, nextCursorScore: 50 })
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.coverage.scannedReviewPages, 1);
  assert.equal(result.options[0].productId, null);
  assert.match(result.coverage.reason, /review_continuation_unverified/);
  assert.deepEqual(fixture.calls.filter((call) => call.path.endsWith('/cursor')).map((call) => call.body.page), [0]);
});

test('conflicting review SKU evidence is withheld instead of selecting one barcode', async () => {
  const fixture = mockRequest({
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '재사용 옵션번호' }]) },
    review: () => reviews([
      { goodsNumber: CURRENT, itemNumber: '001', legacyGoodsNumber: '8800000001111' },
      { goodsNumber: CURRENT, itemNumber: '001', legacyGoodsNumber: '8800000002222' }
    ])
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.options[0].productId, null);
  assert.match(result.coverage.reason, /conflicting_sku_evidence/);
});

test('malformed successful stock data is not an empty active-list assertion', async () => {
  const fixture = mockRequest({
    active: { [CURRENT]: stock([{ itemName: 'item number missing', legacyItemNumber: '8800000001111' }]) },
    fallback: { [CURRENT]: success({ goodsInfo: { goodsName: '상품', masterGoodsNumber: '8800000001111' } }) },
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '옵션' }]) }
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.options[0].hidden, null);
  assert.equal(result.options[0].productId, null);
});

test('a truncated v3 fallback cannot make every historical option appear hidden', async () => {
  const fixture = mockRequest({
    active: { [CURRENT]: { status: 'ERROR' } },
    fallback: { [CURRENT]: success({ goodsInfo: { goodsName: '상품', itemCount: 2, availableItems: [] } }) },
    history: { [CURRENT]: counts(CURRENT, [{ itemNumber: '001', optionName: '아직 판매 중일 수 있는 옵션' }]) }
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.options[0].hidden, null);
  assert.match(result.coverage.reason, /active_options_unavailable/);
});

test('related graph depth is bounded and unvisited options remain explicitly unknown', async () => {
  const ids = [CURRENT, 'A000000270001', 'A000000270002', 'A000000270003'];
  const history = Object.fromEntries(ids.map((id, index) => [id, counts(id, [], ids[index + 1]
    ? [{ goodsNumber: ids[index + 1], itemNumber: '001', optionName: '연결 옵션' }]
    : [])]));
  const fixture = mockRequest({ history });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now })(CURRENT);
  assert.equal(result.coverage.scannedProducts, 3);
  assert.match(result.coverage.reason, /related_product_limit/);
  assert.equal(result.options.find((row) => row.goodsNo === ids[3]).hidden, null);
  assert.deepEqual(result.coverage.deferredRelatedGoodsNos, [ids[3]]);
  assert.equal(result.coverage.relatedDiscoveryComplete, false);
});

test('background depth zero resolves only root evidence and defers related products without a false failure', async () => {
  const fixture = mockRequest({
    active: { [CURRENT]: stock([{ itemNumber: '002', itemName: '현재 옵션', legacyItemNumber: '8800000002222' }]) },
    history: { [CURRENT]: counts(CURRENT,
      [{ itemNumber: '001', optionName: '현재 상품의 숨겨진 옵션' }],
      [{ goodsNumber: HISTORICAL, itemNumber: '001', optionName: '[한교동 콜라보] 본품2EA+공병키링' }]
    ) },
    review: (body) => {
      assert.equal(body.goodsNumber, CURRENT);
      return reviews([{ goodsNumber: CURRENT, itemNumber: '001', legacyGoodsNumber: '8800000001111', optionName: '현재 상품의 숨겨진 옵션' }]);
    }
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now, maxRelatedDepth: 0 })(CURRENT);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.scope, 'official-public-product-option-and-review-evidence');
  assert.equal(result.coverage.rootGoodsNo, CURRENT);
  assert.equal(result.coverage.scannedProducts, 1);
  assert.equal(result.coverage.scannedReviewPages, 1);
  assert.equal(result.coverage.unresolvedOptions, 0);
  assert.equal(result.coverage.deferredOptions, 1);
  assert.equal(result.coverage.relatedDiscoveryComplete, false);
  assert.deepEqual(result.relatedGoodsNos, [HISTORICAL]);
  assert.deepEqual(result.coverage.deferredRelatedGoodsNos, [HISTORICAL]);
  const deferred = result.options.find((row) => row.goodsNo === HISTORICAL);
  assert.equal(deferred.hidden, null);
  assert.equal(deferred.productId, null);
  assert.equal(fixture.calls.some((call) => call.body?.goodsNo === HISTORICAL || call.body?.goodsNumber === HISTORICAL || call.path.includes(HISTORICAL)), false);
});

test('depth-zero deferral does not hide a real root lookup failure', async () => {
  const fixture = mockRequest({
    active: { [CURRENT]: { status: 'ERROR' } },
    history: { [CURRENT]: counts(CURRENT,
      [{ itemNumber: '001', optionName: '확인되지 않은 옵션' }],
      [{ goodsNumber: HISTORICAL, itemNumber: '001', optionName: '관련 옵션' }]
    ) }
  });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now, maxRelatedDepth: 0 })(CURRENT);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason, /active_options_unavailable/);
  assert.match(result.coverage.reason, /unresolved_option_skus/);
  assert.doesNotMatch(result.coverage.reason, /related_product_limit/);
  assert.equal(result.coverage.unresolvedOptions, 1);
  assert.deepEqual(result.coverage.unresolvedOptionKeys, [CURRENT + ':001']);
  assert.equal(result.coverage.deferredOptions, 1);
});

test('configurable related product budget stops before querying additional roots and preserves unknown state', async () => {
  const extra = 'A000000270001';
  const fixture = mockRequest({ history: { [CURRENT]: counts(CURRENT, [], [
    { goodsNumber: HISTORICAL, itemNumber: '001', optionName: '첫 번째 연결 옵션' },
    { goodsNumber: extra, itemNumber: '001', optionName: '두 번째 연결 옵션' }
  ]) } });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now, maxRelatedProducts: 2 })(CURRENT);
  assert.equal(result.coverage.maxRelatedProducts, 2);
  assert.equal(result.coverage.scannedProducts, 2);
  assert.deepEqual(result.coverage.deferredRelatedGoodsNos, [extra]);
  assert.equal(result.options.find((row) => row.goodsNo === extra).hidden, null);
  assert.match(result.coverage.reason, /related_product_limit/);
});

test('configurable depth one visits direct relatives but defers their graph edges', async () => {
  const next = 'A000000270001';
  const fixture = mockRequest({ history: {
    [CURRENT]: counts(CURRENT, [], [{ goodsNumber: HISTORICAL, itemNumber: '001', optionName: '직접 관련 옵션' }]),
    [HISTORICAL]: counts(HISTORICAL, [], [{ goodsNumber: next, itemNumber: '001', optionName: '다음 관련 옵션' }])
  } });
  const result = await createHiddenOptionDiscovery({ request: fixture.request, now, maxRelatedDepth: 1 })(CURRENT);
  assert.equal(result.coverage.scannedProducts, 2);
  assert.equal(result.coverage.maxRelatedDepth, 1);
  assert.deepEqual(result.coverage.deferredRelatedGoodsNos, [next]);
});

test('request failure is partial, and invalid goods numbers never reach the provider', async () => {
  let called = 0;
  const discover = createHiddenOptionDiscovery({ request: async () => { called += 1; throw new Error('private provider contents'); }, now });
  await assert.rejects(discover('../../secret'), /goods_no_invalid/);
  assert.equal(called, 0);
  const result = await discover(CURRENT);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason, /review_options_unavailable/);
  assert.equal(JSON.stringify(result).includes('private provider'), false);
});
