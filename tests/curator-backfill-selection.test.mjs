import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCuratorBackfillGoods } from '../scripts/collect-curator-backfill.mjs';

const partnerId = '4ee076cc92da4447a1b4b42c590e4495';
const oldPartner = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const now = Date.parse('2026-10-26T00:00:00Z');

test('backfill regenerates old and unknown partner links, including recent failed rows', () => {
  const ready = { shortenedUrl: 'https://oy.run/ready', affiliatePartnerId: partnerId };
  const failed = {
    error: 'affiliate_link_unavailable', affiliatePartnerId: partnerId,
    generatedAt: '2026-10-25T23:59:00Z', retryAfter: '2026-10-27T00:00:00Z'
  };
  const links = {
    current: ready,
    old: { ...ready, affiliatePartnerId: oldPartner },
    unknown: { shortenedUrl: ready.shortenedUrl },
    failedCurrent: failed,
    failedOld: { ...failed, affiliatePartnerId: oldPartner },
    failedUnknown: { ...failed, affiliatePartnerId: undefined },
    failedExpired: { ...failed, retryAfter: '2026-10-25T00:00:00Z' },
    originalOnly: { affiliatePartnerId: partnerId, originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1&utm_content=OY_a' },
    invalidShort: { ...ready, shortenedUrl: 'https://example.com/old' }
  };
  const selected = selectCuratorBackfillGoods([...Object.keys(links), 'missing'], links, { partnerId, now });
  assert.deepEqual(selected, ['old', 'unknown', 'failedOld', 'failedUnknown', 'failedExpired', 'originalOnly', 'invalidShort', 'missing']);
});

test('backfill defaults to the active partner and accepts an explicit next account override', () => {
  const previous = process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID;
  delete process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID;
  const links = {
    active: { affiliatePartnerId: partnerId, shortenedUrl: 'https://oy.run/active' },
    next: { affiliatePartnerId: oldPartner, shortenedUrl: 'https://oy.run/next' }
  };
  try {
    assert.deepEqual(selectCuratorBackfillGoods(['active', 'next'], links), ['next']);
    process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID = oldPartner;
    assert.deepEqual(selectCuratorBackfillGoods(['active', 'next'], links), ['active']);
  } finally {
    if (previous == null) delete process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID;
    else process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID = previous;
  }
});
