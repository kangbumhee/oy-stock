import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearOfficialSearchCache,
  normalizeOfficialProduct,
  normalizeSearchKeyword,
  searchOfficialProducts
} from './official-search.mjs';

function payload(rows, totalCount) {
  return {
    Data: [
      {
        CollName: 'OLIVE_GOODS',
        TotalCount: String(totalCount),
        Result: rows
      }
    ]
  };
}

test('normalizes an OliveYoung search row', () => {
  const product = normalizeOfficialProduct({
    GOODS_NO: 'A000000123456',
    GOODS_NM: '쏘내추럴 픽스 미 업 미스트',
    ONL_BRND_NM: '쏘내추럴',
    IMG_PATH_NM: '10/0000/0123/thumb.jpg',
    SALE_PRC: '12,000',
    NORM_PRC: '15,000',
    QUICK_YN: 'Y'
  });

  assert.equal(product.goodsNo, 'A000000123456');
  assert.equal(product.priceToPay, 12000);
  assert.equal(product.originalPrice, 15000);
  assert.equal(product.discountRate, 20);
  assert.equal(product.todayDelivery, true);
  assert.match(product.imageUrl, /^https:\/\/image\.oliveyoung\.co\.kr\//);
});

test('normalizes decomposed Korean and invisible characters in search keywords', () => {
  const decomposed = '어노브'.normalize('NFD');
  assert.equal(normalizeSearchKeyword('\u200B ' + decomposed + ' \uFEFF'), '어노브');
});

test('loads all expected pages and caches only the complete result', async () => {
  clearOfficialSearchCache();
  const requests = [];
  const fetchPage = async ({ startCount, listnum }) => {
    requests.push({ startCount, listnum });
    if (startCount === 0) {
      return {
        status: 200,
        data: payload(
          [
            { GOODS_NO: 'A1', GOODS_NM: '첫 상품', SALE_PRC: '1000' },
            { GOODS_NO: 'A2', GOODS_NM: '둘째 상품', SALE_PRC: '2000' }
          ],
          3
        )
      };
    }
    return {
      status: 200,
      data: payload(
        [{ GOODS_NO: 'A3', GOODS_NM: '셋째 상품', SALE_PRC: '3000' }],
        3
      )
    };
  };

  const first = await searchOfficialProducts('쏘내추럴', 3, { fetchPage, pageSize: 2 });
  const second = await searchOfficialProducts('쏘내추럴', 3, { fetchPage, pageSize: 2 });

  assert.deepEqual(requests, [
    { startCount: 0, listnum: 2 },
    { startCount: 2, listnum: 1 }
  ]);
  assert.equal(first.data.inventory.products.length, 3);
  assert.equal(first.data.totalCount, 3);
  assert.equal(first.complete, true);
  assert.equal(first.incomplete, false);
  assert.equal(first.cache, 'MISS');
  assert.equal(second.cache, 'HIT');
});

test('rejects a failed later page and does not cache the partial result', async () => {
  clearOfficialSearchCache();
  const requests = [];
  let failLaterPage = true;
  const fetchPage = async ({ startCount, listnum }) => {
    requests.push({ startCount, listnum });
    if (startCount === 0) {
      return {
        status: 200,
        data: payload(
          [
            { GOODS_NO: 'A1', GOODS_NM: '첫 상품', SALE_PRC: '1000' },
            { GOODS_NO: 'A2', GOODS_NM: '둘째 상품', SALE_PRC: '2000' }
          ],
          3
        )
      };
    }
    if (failLaterPage) return { status: 403, data: null };
    return {
      status: 200,
      data: payload(
        [{ GOODS_NO: 'A3', GOODS_NM: '셋째 상품', SALE_PRC: '3000' }],
        3
      )
    };
  };

  await assert.rejects(
    searchOfficialProducts('부분실패', 3, { fetchPage, pageSize: 2 }),
    /official_search_page_failed_2_403/
  );

  failLaterPage = false;
  const recovered = await searchOfficialProducts('부분실패', 3, {
    fetchPage,
    pageSize: 2
  });

  assert.deepEqual(requests, [
    { startCount: 0, listnum: 2 },
    { startCount: 2, listnum: 1 },
    { startCount: 0, listnum: 2 },
    { startCount: 2, listnum: 1 }
  ]);
  assert.equal(recovered.cache, 'MISS');
  assert.equal(recovered.complete, true);
  assert.equal(recovered.data.inventory.products.length, 3);
});

test('rejects an invalid official response', async () => {
  clearOfficialSearchCache();
  await assert.rejects(
    searchOfficialProducts('없는검색어', 50, {
      fetchPage: async () => ({ status: 403, data: null })
    }),
    /official_search_failed_403/
  );
});

test('does not cache empty rows when TotalCount is missing', async () => {
  clearOfficialSearchCache();
  let requestCount = 0;
  let omitTotalCount = true;
  const fetchPage = async () => {
    requestCount += 1;
    if (omitTotalCount) {
      return {
        status: 200,
        data: {
          Data: [
            {
              CollName: 'OLIVE_GOODS',
              Result: []
            }
          ]
        }
      };
    }
    return { status: 200, data: payload([], 0) };
  };

  await assert.rejects(
    searchOfficialProducts('누락합계', 50, { fetchPage }),
    /official_search_total_missing_or_invalid/
  );

  omitTotalCount = false;
  const recovered = await searchOfficialProducts('누락합계', 50, { fetchPage });

  assert.equal(requestCount, 2);
  assert.equal(recovered.cache, 'MISS');
  assert.equal(recovered.complete, true);
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.data.totalCount, 0);
  assert.deepEqual(recovered.data.inventory.products, []);
});

test('returns a valid empty result without turning it into a server error', async () => {
  clearOfficialSearchCache();
  const result = await searchOfficialProducts('정말없는검색어', 50, {
    fetchPage: async () => ({ status: 200, data: payload([], 0) })
  });

  assert.equal(result.success, true);
  assert.equal(result.complete, true);
  assert.equal(result.incomplete, false);
  assert.equal(result.data.totalCount, 0);
  assert.deepEqual(result.data.inventory.products, []);
});
