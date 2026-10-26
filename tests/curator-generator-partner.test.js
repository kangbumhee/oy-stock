const test = require('node:test');
const assert = require('node:assert/strict');

test('generator never skips fresh links or deferred failures from another account', async () => {
  const { isFreshCuratorEntry, hasReadyCuratorShortLink, isDeferredCuratorEntry } =
    await import('../scripts/generate-curator-links.mjs');
  const previous = process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID;
  const current = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID = current;
  try {
    const row = { shortenedUrl: 'https://oy.run/test-only', generatedAt: new Date().toISOString(),
      error: 'landing_failed', retryAfter: new Date(Date.now() + 60000).toISOString() };
    for (const partner of [undefined, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', current]) {
      const entry = { ...row, affiliatePartnerId: partner };
      assert.equal(isFreshCuratorEntry(entry), partner === current);
      assert.equal(hasReadyCuratorShortLink(entry), partner === current);
      assert.equal(isDeferredCuratorEntry(entry), partner === current);
    }
  } finally {
    if (previous == null) delete process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID;
    else process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID = previous;
  }
});
