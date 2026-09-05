import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateCuratorBatchFailure,
  isReadyCuratorShortUrl,
  isSystemicLandingHardFailure,
  isTransientLandingHardFailure,
  runCuratorRequestWithRetry,
  shouldReplaceCuratorEntry,
  shouldRetryCuratorError
} from './curator-request-policy.mjs';

test('accepts only non-root HTTPS oy.run curator links as ready', () => {
  assert.equal(isReadyCuratorShortUrl('https://oy.run/ready'), true);
  assert.equal(isReadyCuratorShortUrl('http://oy.run/ready'), false);
  assert.equal(isReadyCuratorShortUrl('https://example.com/ready'), false);
  assert.equal(isReadyCuratorShortUrl('https://oy.run/'), false);
});

function hard(status) {
  return { ok: false, hardFailure: true, detail: { status } };
}

test('retries a transient first 403 and returns the following success', async () => {
  const results = [hard(403), { ok: true, shortenedUrl: 'https://oy.run/recovered' }];
  const retries = [];
  const waits = [];
  const outcome = await runCuratorRequestWithRetry({
    runAttempt: async () => results.shift(),
    prepareRetry: async (context) => retries.push(context.status),
    sleep: async (ms) => waits.push(ms),
    retryDelayMs: 10,
    maxAttempts: 3
  });

  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.attempts, 2);
  assert.deepEqual(retries, [403]);
  assert.deepEqual(waits, [10]);
});

test('does not retry a 401 authentication failure', async () => {
  let calls = 0;
  const outcome = await runCuratorRequestWithRetry({
    runAttempt: async () => {
      calls += 1;
      return hard(401);
    },
    maxAttempts: 3,
    retryDelayMs: 0
  });

  assert.equal(calls, 1);
  assert.equal(outcome.result.detail.status, 401);
  assert.equal(isTransientLandingHardFailure(outcome.result), false);
});

test('stops cleanly when retry preparation fails', async () => {
  let retryCalls = 0;
  const preparationError = new Error('warmup failed');
  const outcome = await runCuratorRequestWithRetry({
    runAttempt: async () => hard(403),
    prepareRetry: async () => {
      retryCalls += 1;
      throw preparationError;
    },
    maxAttempts: 3,
    retryDelayMs: 0
  });

  assert.equal(retryCalls, 1);
  assert.equal(outcome.result, null);
  assert.equal(outcome.lastError, preparationError);
  assert.equal(outcome.attempts, 1);
});

test('retries network, rate-limit, and server hard failures', () => {
  assert.equal(isTransientLandingHardFailure(hard(0)), true);
  assert.equal(isTransientLandingHardFailure(hard(403)), true);
  assert.equal(isTransientLandingHardFailure(hard(429)), true);
  assert.equal(isTransientLandingHardFailure(hard(503)), true);
  assert.equal(isTransientLandingHardFailure({ ok: false, hardFailure: false, detail: { status: 403 } }), false);
});

test('keeps one isolated hard failure nonfatal when healthy results exist', () => {
  assert.equal(
    isSystemicLandingHardFailure({
      hardFailureCount: 1,
      landingFailureCount: 1,
      generatedCount: 4,
      affiliateUnavailableCount: 6,
      maxConsecutiveHardFailures: 1
    }),
    false
  );
});

test('treats one hard failure as fatal when every actual landing attempt failed', () => {
  assert.equal(
    isSystemicLandingHardFailure({
      hardFailureCount: 1,
      landingFailureCount: 1,
      generatedCount: 0,
      affiliateUnavailableCount: 0,
      maxConsecutiveHardFailures: 1
    }),
    true
  );
});

test('treats repeated majority hard failures as fatal', () => {
  assert.equal(
    isSystemicLandingHardFailure({
      hardFailureCount: 2,
      landingFailureCount: 2,
      generatedCount: 1,
      affiliateUnavailableCount: 0,
      maxConsecutiveHardFailures: 2
    }),
    true
  );
});

test('treats three consecutive hard failures as fatal even below half overall', () => {
  assert.equal(
    isSystemicLandingHardFailure({
      hardFailureCount: 3,
      landingFailureCount: 6,
      generatedCount: 5,
      affiliateUnavailableCount: 3,
      maxConsecutiveHardFailures: 3
    }),
    true
  );
});

test('honors an absolute retryAfter before the generatedAt fallback window', () => {
  const now = Date.parse('2026-08-22T08:00:00.000Z');
  const entry = {
    error: 'landing_failed',
    generatedAt: '2026-08-22T00:00:00.000Z',
    retryAfter: '2026-08-22T08:15:00.000Z'
  };

  assert.equal(
    shouldRetryCuratorError(entry, {
      now,
      retryErrorAfterMs: 6 * 60 * 60 * 1000
    }),
    false
  );
  assert.equal(
    shouldRetryCuratorError(entry, {
      now: Date.parse('2026-08-22T08:15:00.000Z'),
      retryErrorAfterMs: 6 * 60 * 60 * 1000
    }),
    true
  );
});

test('falls back to generatedAt when retryAfter is absent or invalid', () => {
  const entry = {
    error: 'request_exception',
    generatedAt: '2026-08-22T00:00:00.000Z',
    retryAfter: 'invalid'
  };

  assert.equal(
    shouldRetryCuratorError(entry, {
      now: Date.parse('2026-08-22T05:59:59.000Z'),
      retryErrorAfterMs: 6 * 60 * 60 * 1000
    }),
    false
  );
  assert.equal(
    shouldRetryCuratorError(entry, {
      now: Date.parse('2026-08-22T06:00:00.000Z'),
      retryErrorAfterMs: 6 * 60 * 60 * 1000
    }),
    true
  );
});

test('keeps partial successes when one final 403 is isolated', () => {
  const result = evaluateCuratorBatchFailure({
    generatedCount: 4,
    landingFailureCount: 7,
    affiliateUnavailableCount: 6,
    exceptionFailureCount: 0,
    hardFailureCount: 1,
    maxConsecutiveHardFailures: 1
  });

  assert.equal(result.systemicHardFailure, false);
  assert.equal(result.criticalFailureCount, 0);
});

test('fails a one-product on-demand batch when shortening never produced oy.run', () => {
  const result = evaluateCuratorBatchFailure({
    generatedCount: 0,
    shortenFailureCount: 1,
    landingFailureCount: 0,
    affiliateUnavailableCount: 0,
    exceptionFailureCount: 0,
    hardFailureCount: 0,
    maxConsecutiveHardFailures: 0
  });

  assert.equal(result.shortenFailureCount, 1);
  assert.equal(result.noUsableResultFailureCount, 1);
  assert.equal(result.criticalFailureCount, 1);
});

test('fails a batch when every attempted item returns non-usable 7016', () => {
  const result = evaluateCuratorBatchFailure({
    generatedCount: 0,
    landingFailureCount: 8,
    affiliateUnavailableCount: 0,
    exceptionFailureCount: 0,
    hardFailureCount: 0,
    maxConsecutiveHardFailures: 0
  });

  assert.equal(result.systemicHardFailure, false);
  assert.equal(result.noUsableResultFailureCount, 8);
  assert.equal(result.criticalFailureCount, 8);
});

test('fails a batch when every attempted item remains a hard failure', () => {
  const result = evaluateCuratorBatchFailure({
    generatedCount: 0,
    landingFailureCount: 3,
    affiliateUnavailableCount: 0,
    exceptionFailureCount: 0,
    hardFailureCount: 3,
    maxConsecutiveHardFailures: 3
  });

  assert.equal(result.systemicHardFailure, true);
  assert.equal(result.criticalFailureCount, 3);
});

test('keeps a single HTTP 401 fatal even when other products succeed', () => {
  const result = evaluateCuratorBatchFailure({
    generatedCount: 4,
    landingFailureCount: 2,
    affiliateUnavailableCount: 1,
    exceptionFailureCount: 0,
    hardFailureCount: 1,
    authFailureCount: 1,
    maxConsecutiveHardFailures: 1
  });

  assert.equal(result.systemicHardFailure, false);
  assert.equal(result.criticalFailureCount, 1);
});

test('fails a heavily degraded batch even when one product succeeds', () => {
  const result = evaluateCuratorBatchFailure({
    generatedCount: 1,
    landingFailureCount: 0,
    affiliateUnavailableCount: 0,
    exceptionFailureCount: 259,
    hardFailureCount: 0,
    authFailureCount: 0,
    maxConsecutiveHardFailures: 0
  });

  assert.equal(result.systemicUnresolvedFailure, true);
  assert.equal(result.criticalFailureCount, 259);
});

test('fails after three consecutive 7016 policy errors even after earlier successes', () => {
  const result = evaluateCuratorBatchFailure({
    generatedCount: 100,
    landingFailureCount: 3,
    affiliateUnavailableCount: 0,
    exceptionFailureCount: 0,
    hardFailureCount: 0,
    authFailureCount: 0,
    maxConsecutiveHardFailures: 0,
    maxConsecutivePolicyFailures: 3
  });

  assert.equal(result.systemicUnresolvedFailure, true);
  assert.equal(result.criticalFailureCount, 3);
});

test('never replaces a usable current link with a failed incoming entry', () => {
  const current = {
    shortenedUrl: 'https://oy.run/current',
    generatedAt: '2026-08-22T08:10:00.000Z'
  };
  const incoming = {
    error: 'landing_failed',
    generatedAt: '2026-08-22T08:15:00.000Z'
  };

  assert.equal(shouldReplaceCuratorEntry(current, incoming), false);
});

test('keeps the newer entry when both merge candidates have equal usability', () => {
  const current = {
    shortenedUrl: 'https://oy.run/newer',
    generatedAt: '2026-08-22T08:15:00.000Z'
  };
  const incoming = {
    shortenedUrl: 'https://oy.run/older',
    generatedAt: '2026-08-22T08:10:00.000Z'
  };

  assert.equal(shouldReplaceCuratorEntry(current, incoming), false);
  assert.equal(shouldReplaceCuratorEntry(incoming, current), true);
});

test('never replaces an oy.run link with a newer original-only entry', () => {
  const current = {
    shortenedUrl: 'https://oy.run/ready',
    originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    generatedAt: '2026-08-22T08:10:00.000Z'
  };
  const incoming = {
    shortenedUrl: null,
    originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    generatedAt: '2026-08-22T08:15:00.000Z'
  };

  assert.equal(shouldReplaceCuratorEntry(current, incoming), false);
});

test('an oy.run link replaces a newer original-only entry', () => {
  const current = {
    shortenedUrl: null,
    originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    generatedAt: '2026-08-22T08:15:00.000Z'
  };
  const incoming = {
    shortenedUrl: 'https://oy.run/ready',
    originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    generatedAt: '2026-08-22T08:10:00.000Z'
  };

  assert.equal(shouldReplaceCuratorEntry(current, incoming), true);
});

test('a newer affiliate-unavailable result replaces an original-only entry', () => {
  const current = {
    shortenedUrl: null,
    originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    generatedAt: '2026-08-22T08:10:00.000Z'
  };
  const incoming = {
    error: 'affiliate_link_unavailable',
    generatedAt: '2026-08-22T08:15:00.000Z',
    retryAfter: '2026-08-23T08:15:00.000Z'
  };

  assert.equal(shouldReplaceCuratorEntry(current, incoming), true);
  assert.equal(shouldReplaceCuratorEntry(incoming, current), false);
});

test('a transient error does not erase an attributed original URL', () => {
  const current = {
    originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    generatedAt: '2026-08-22T08:10:00.000Z'
  };
  const incoming = {
    error: 'landing_failed',
    generatedAt: '2026-08-22T08:15:00.000Z'
  };

  assert.equal(shouldReplaceCuratorEntry(current, incoming), false);
});

test('allows a usable incoming link to replace a newer error entry', () => {
  const current = {
    error: 'landing_failed',
    generatedAt: '2026-08-22T08:15:00.000Z'
  };
  const incoming = {
    originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    generatedAt: '2026-08-22T08:10:00.000Z'
  };

  assert.equal(shouldReplaceCuratorEntry(current, incoming), true);
});
