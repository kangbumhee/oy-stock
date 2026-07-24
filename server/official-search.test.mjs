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

test('loads additional pages, deduplicates products, and caches the result', async () => {
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
          55
        )
      };
    }
    return {
      status: 200,
      data: payload(
        [
          { GOODS_NO: 'A2', GOODS_NM: '중복 상품', SALE_PRC: '2000' },
          { GOODS_NO: 'A3', GOODS_NM: '셋째 상품', SALE_PRC: '3000' }
        ],
        55
      )
    };
  };

  const first = await searchOfficialProducts('쏘내추럴', 55, { fetchPage });
  const second = await searchOfficialProducts('쏘내추럴', 55, { fetchPage });

  assert.deepEqual(requests, [
    { startCount: 0, listnum: 48 },
    { startCount: 48, listnum: 7 }
  ]);
  assert.equal(first.data.inventory.products.length, 3);
  assert.equal(first.data.totalCount, 55);
  assert.equal(first.cache, 'MISS');
  assert.equal(second.cache, 'HIT');
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

test('returns a valid empty result without turning it into a server error', async () => {
  clearOfficialSearchCache();
  const result = await searchOfficialProducts('정말없는검색어', 50, {
    fetchPage: async () => ({ status: 200, data: payload([], 0) })
  });

  assert.equal(result.success, true);
  assert.equal(result.data.totalCount, 0);
  assert.deepEqual(result.data.inventory.products, []);
});
