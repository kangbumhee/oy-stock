import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  collectorConfig,
  formatCollectorSummary,
  runCollector,
  safeCollectorProgress
} from '../scripts/collect-hidden-stock.mjs';

const SECRET = 'fixture-hidden-collector-secret-1234567890';
const NOW = Date.parse('2026-09-13T06:00:00.000Z');
const env = { HIDDEN_STOCK_SERVICE_SECRET: SECRET };
const config = (...args) => collectorConfig(args, env);
function payload(overrides = {}) {
  return {
    success: true,
    collection: { enabled: true },
    progress: { phase: 'catalog', processed: 12, discovered: 3, failed: 1, queueRemaining: 8 },
    ...overrides
  };
}
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}
function runtime(fetchImpl) {
  let clock = NOW;
  const reports = [];
  const delays = [];
  return {
    reports, delays,
    advance(ms) { clock += ms; },
    deps: {
      now: () => clock,
      fetchImpl,
      pause: async ms => { delays.push(ms); clock += ms; },
      report: text => reports.push(text)
    }
  };
}

test('collector defaults are bounded and only fixed Cloud Run collect/status endpoints are allowed', () => {
  const settings = config();
  assert.equal(settings.steps, 100);
  assert.equal(settings.maxSeconds, 480);
  assert.equal(settings.delayMs, 1000);
  assert.equal(settings.statusOnly, false);
  assert.equal(settings.url.href, 'https://oy-stock-api-3596046881.asia-northeast3.run.app/api/hidden-stock?action=collect');
  assert.equal(config('--status').url.searchParams.get('action'), 'status');
  assert.equal(config('--steps', '500', '--max-seconds', '1200', '--delay-ms', '500').steps, 500);
  for (const args of [
    ['--steps', '0'], ['--steps', '501'], ['--steps', '1.5'], ['--steps'],
    ['--max-seconds', '0'], ['--max-seconds', '1201'], ['--max-seconds', 'NaN'],
    ['--delay-ms', '499'], ['--delay-ms', '60001'], ['--unknown', SECRET]
  ]) assert.throws(() => config(...args), /collector_invalid_/);
  for (const url of [
    'http://localhost', 'https://169.254.169.254', 'https://evil.example',
    'https://valid.run.app@evil.example', 'https://valid.run.app/path',
    'https://valid.run.app?secret=' + SECRET, 'https://valid.run.app#hash',
    'https://user:password@valid.run.app', 'https://valid.run.app:1234'
  ]) assert.throws(() => collectorConfig([], { ...env, HIDDEN_STOCK_SERVICE_URL: url }), /^Error: collector_service_not_configured$/);
  for (const secret of ['', 'short', SECRET + '\r\nInjected: bad']) {
    assert.throws(() => collectorConfig([], { HIDDEN_STOCK_SERVICE_SECRET: secret }), /collector_service_not_configured/);
  }
});

test('collection is sequential, uses service-only headers, refuses redirects and stops at step cap', async () => {
  const calls = [];
  let concurrent = 0;
  let maximum = 0;
  const run = runtime(async (url, options) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    calls.push({ url, options });
    await Promise.resolve();
    concurrent--;
    return jsonResponse(payload());
  });
  const result = await runCollector(config('--steps', '3'), run.deps);
  assert.equal(maximum, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(run.delays, [1000, 1000]);
  assert.equal(result.outcome, 'step_limit');
  assert.equal(result.ok, true);
  assert.equal(result.steps, 3);
  assert.equal(result.progress.failed, 1);
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('action'), 'collect');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.cache, 'no-store');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.deepEqual(call.options.headers, { Authorization: `Bearer ${SECRET}`, Accept: 'application/json' });
  }
  assert.equal(JSON.stringify(run.reports).includes(SECRET), false);
  assert.equal(formatCollectorSummary(result).includes('전체 오프라인 재고 확인 완료를 뜻하지 않습니다'), true);
});

test('--status makes exactly one read-only GET and never collects, sleeps or posts', async () => {
  const calls = [];
  const run = runtime(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ success: true, collection: { phase: 'idle', enabled: true }, scan: { processed: 34 } });
  });
  const result = await runCollector(config('--status'), run.deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].url.searchParams.get('action'), 'status');
  assert.equal(result.outcome, 'status');
  assert.equal(result.progress.processed, 34);
  assert.equal(result.statusOnly, true);
  assert.deepEqual(run.delays, []);
  assert.match(formatCollectorSummary(result), /수집 실행 안 함/);
});

test('idle and explicit server retry delay stop immediately without reporting catalog completion', async () => {
  for (const [extra, outcome] of [[{ idle: true, retryAfterSeconds: 1800 }, 'idle'], [{ retryAfterSeconds: 90 }, 'waiting']]) {
    let calls = 0;
    const run = runtime(async () => { calls++; return jsonResponse(payload(extra)); });
    const result = await runCollector(config(), run.deps);
    assert.equal(calls, 1);
    assert.equal(result.outcome, outcome);
    assert.equal(result.retryAfterSeconds, extra.retryAfterSeconds);
    assert.equal(result.ok, true);
    assert.equal(run.delays.length, 0);
    assert.equal(Object.hasOwn(result, 'complete'), false);
  }
});

test('max time stops before starting work or sleep beyond the wall-clock budget', async () => {
  let calls = 0;
  const run = runtime(async () => { calls++; run.advance(1200); return jsonResponse(payload()); });
  const result = await runCollector(config('--steps', '500', '--max-seconds', '2'), run.deps);
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'time_limit');
  assert.equal(result.steps, 1);
  assert.equal(run.delays.length, 0);
  const before = runtime(async () => { throw new Error('not called'); });
  let times = 0;
  before.deps.now = () => times++ ? NOW + 3000 : NOW;
  const exhausted = await runCollector(config('--max-seconds', '2'), before.deps);
  assert.equal(exhausted.outcome, 'time_limit');
  assert.equal(exhausted.steps, 0);
});

test('service authentication errors fail red with sanitized output and no retry storm', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const run = runtime(async () => { calls++; return jsonResponse({ success: false, secret: SECRET }, status); });
    const result = await runCollector(config(), run.deps);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, 'service_auth_failed');
    assert.equal(result.httpStatus, status);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(formatCollectorSummary(result).includes(SECRET), false);
    assert.match(formatCollectorSummary(result), /수집 실패/);
  }
});

test('429 and503 preserve last progress then stop as non-success backoff with a visible warning summary', async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const run = runtime(async () => {
      calls++;
      return calls === 1 ? jsonResponse(payload()) : jsonResponse({ error: SECRET, retryAfterSeconds: 120 }, status, { 'retry-after': '45' });
    });
    const result = await runCollector(config(), run.deps);
    assert.equal(calls, 2);
    assert.equal(result.steps, 1);
    assert.equal(result.progress.processed, 12);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'backoff');
    assert.equal(result.exitCode, 0, 'expected transient pause avoids misleading authentication-failure emails');
    assert.equal(result.retryAfterSeconds, 120);
    assert.equal(result.httpStatus, status);
    assert.match(formatCollectorSummary(result), /일시 오류로 수집 중단/);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('backoff falls back to safe Retry-After headers, bounded date delay or default even if body is invalid', async () => {
  for (const [header, expected] of [['45', 45], [new Date(NOW + 90000).toUTCString(), 90], ['99999999', 86400], ['garbage', 300]]) {
    const run = runtime(async () => new Response('not-json-secret=' + SECRET, { status: 503, headers: { 'retry-after': header } }));
    const result = await runCollector(config(), run.deps);
    assert.equal(result.outcome, 'backoff');
    assert.equal(result.retryAfterSeconds, expected);
    assert.equal(formatCollectorSummary(result).includes(SECRET), false);
  }
});

test('network errors and aborted requests pause safely, without showing provider exception text', async () => {
  for (const error of [new Error('private connection ' + SECRET), new DOMException(SECRET, 'AbortError')]) {
    const run = runtime(async () => { throw error; });
    const result = await runCollector(config(), run.deps);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'backoff');
    assert.equal(result.error, 'connection_interrupted');
    assert.equal(result.steps, 0);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('unexpected status, invalidJSON and oversized responses are errors rather than successful collection', async () => {
  for (const makeResponse of [
    () => jsonResponse({ error: SECRET }, 500),
    () => new Response('not-json ' + SECRET),
    () => jsonResponse([]),
    () => jsonResponse({ success: false, error: SECRET }),
    () => jsonResponse(payload(), 200, { 'content-length': String(1024 * 1024 + 1) }),
    () => jsonResponse({ success: true, private: 'x'.repeat(1024 * 1024) })
  ]) {
    const run = runtime(async () => makeResponse());
    const result = await runCollector(config(), run.deps);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.equal(result.exitCode, 1);
    assert.equal(result.steps, 0);
    assert.equal(formatCollectorSummary(result).includes(SECRET), false);
  }
});

test('progress output accepts only bounded numeric counts, known phases and dates, never arbitrary server text', () => {
  const progress = safeCollectorProgress({
    progress: { phase: SECRET, processed: SECRET, discovered: -1, failed: Infinity, queueRemaining: 1e30, nextRunAt: SECRET },
    collection: { enabled: true, secret: SECRET }, scan: { processed: 3 }
  });
  assert.deepEqual(progress, { phase: 'unknown', metricScope: 'last_step', processed: 3, discovered: null,
    failed: null, partialProducts: null, checkedProducts: null, queueRemaining: null, nextRunAt: null, enabled: true });
  const status = safeCollectorProgress(payload({ progress: {
    phase: 'retry', processed: 10, discovered: '2', failed: 0, queueRemaining: 4, nextRunAt: '2026-09-14T00:00:00Z'
  } }));
  assert.equal(status.nextRunAt, '2026-09-14T00:00:00.000Z');
  assert.equal(status.discovered, 2);
  assert.equal(JSON.stringify(progress).includes(SECRET), false);
});

test('HTTP200 paused failures are non-success backoff even when idle, and status-only reads expose the warning', async () => {
  for (const statusOnly of [false, true]) {
    for (const data of [
      payload({ collection: { phase: 'backoff', processed: 100, pausedUntil: new Date(NOW + 3600000).toISOString() }, idle: true }),
      payload({ progress: { phase: 'catalog_backoff', processed: 0 }, retryAfterSeconds: 300 }),
      payload({ progress: { phase: 'provider_backoff', failed: 3 }, idle: true, retryAfterSeconds: 300 })
    ]) {
      let calls = 0;
      const run = runtime(async () => { calls++; return jsonResponse(data); });
      const result = await runCollector(config(...(statusOnly ? ['--status'] : [])), run.deps);
      assert.equal(result.ok, false);
      assert.equal(result.outcome, 'backoff');
      assert.equal(result.error, 'server_collection_paused');
      assert.equal(result.exitCode, 0);
      assert.equal(calls, 1);
      const summary = formatCollectorSummary(result);
      assert.match(summary, /일시 오류로 수집 중단/);
      assert.doesNotMatch(summary, /지금 처리할 작업 없음/);
      if (statusOnly) assert.match(summary, /수집은 시작하지 않았습니다/);
    }
  }
});

test('cumulative collection counts win over last-step deltas, including status hiddenOptions and unresolved count', () => {
  const data = payload({
    collection: { phase: 'collecting', processed: 1200, hiddenOptions: 220, failed: 300,
      failedProducts: 4, partialProducts: 16, checkedProducts: 950, queueRemaining: 100 },
    progress: { phase: 'products', processed: 3, discovered: 2, failed: 0 }
  });
  const progress = safeCollectorProgress(data);
  assert.equal(progress.metricScope, 'cumulative');
  assert.equal(progress.processed, 1200);
  assert.equal(progress.discovered, 220);
  assert.equal(progress.failed, 4);
  assert.equal(progress.checkedProducts, 950);
  assert.equal(progress.partialProducts, 16);
  const status = safeCollectorProgress({ success: true, collection: data.collection });
  assert.equal(status.discovered, 220);
  const summary = formatCollectorSummary({ outcome: 'step_limit', steps: 3, elapsedSeconds: 7, progress });
  assert.match(summary, /누적 처리 횟수: 1200건/);
  assert.match(summary, /현재 확인된 숨겨진 옵션: 220개/);
  assert.match(summary, /재시도 필요한 상품: 4개/);
  assert.match(summary, /일부만 확인된 상품: 16개/);
  assert.match(summary, /상품별 숨겨진 옵션 확인/);
});

test('all actual server collection phases map safely, and foreground/lease idle does not mean no queued work', async () => {
  for (const phase of ['products', 'enumerating', 'collecting', 'running', 'foreground_priority',
    'time_budget', 'catalog_backoff', 'provider_backoff', 'backoff', 'leased', 'lease_changed']) {
    assert.equal(safeCollectorProgress({ collection: { phase } }).phase, phase);
  }
  for (const phase of ['foreground_priority', 'leased', 'lease_changed']) {
    const run = runtime(async () => jsonResponse(payload({ idle: true, retryAfterSeconds: 5, progress: { phase }, collection: { queueRemaining: 30 } })));
    const result = await runCollector(config(), run.deps);
    assert.equal(result.outcome, 'waiting');
    assert.equal(result.ok, true);
    assert.doesNotMatch(formatCollectorSummary(result), /지금 처리할 작업 없음/);
  }
});

test('GitHub workflow is opt-in, hourly17, serialized, bounded and has no public commit or package install', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/hidden-stock-collect.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '17 \* \* \* \*'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /vars\.HIDDEN_STOCK_COLLECTION_ENABLED == 'true'/);
  assert.match(workflow, /secrets\.HIDDEN_STOCK_SERVICE_SECRET/);
  assert.match(workflow, /ready=false/);
  assert.match(workflow, /steps\.configured\.outputs\.ready == 'true'/);
  assert.match(workflow, /timeout-minutes: 12/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /--max-seconds 480 --delay-ms 1000/);
  assert.match(workflow, /COLLECT_STEPS: \$\{\{ inputs\.steps/);
  assert.match(workflow, /--steps "\$COLLECT_STEPS"/);
  assert.doesNotMatch(workflow, /contents: write|git push|git commit|public\/data|npm ci|OPENAI|GEMINI|LLM/);
});
