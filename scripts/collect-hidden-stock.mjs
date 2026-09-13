import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_SERVICE_URL = 'https://oy-stock-api-3596046881.asia-northeast3.run.app';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_MS = 55000;
const PHASES = {
  catalog: '전체 상품 목록 확인', catalog_scan: '전체 상품 목록 확인', scan: '전체 상품 목록 확인',
  discovery: '숨겨진 옵션 확인', discover: '숨겨진 옵션 확인', options: '숨겨진 옵션 확인',
  retry: '미해결 상품 다시 확인', refresh: '기존 상품 갱신', queue: '대기 상품 확인',
  collect: '상품 수집', idle: '다음 갱신 대기', waiting: '다음 갱신 대기',
  complete: '이번 수집 주기 완료', done: '이번 수집 주기 완료', paused: '잠시 대기',
  products: '상품별 숨겨진 옵션 확인', enumerating: '전체 상품 목록 확인',
  collecting: '대기 상품 수집', running: '다른 수집 실행 진행 중',
  foreground_priority: '이용자 조회 우선 처리로 양보', time_budget: '단계별 시간 한도 도달',
  leased: '다른 수집 실행 종료 대기', lease_changed: '작업 담당 변경으로 대기',
  backoff: '제공처 오류로 재시도 대기', catalog_backoff: '상품 목록 조회 오류로 대기',
  provider_backoff: '연속 상품 조회 오류로 대기'
};
const HELP = '사용법: node scripts/collect-hidden-stock.mjs [--steps 100] [--max-seconds 480] [--delay-ms 1000] [--status]\nHIDDEN_STOCK_SERVICE_SECRET 필요. --status는 현재 상태만 읽으며 수집을 시작하지 않습니다.';

export function collectorConfig(args = process.argv.slice(2), env = process.env) {
  const config = { steps: 100, maxSeconds: 480, delayMs: 1000, statusOnly: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--status') config.statusOnly = true;
    else if (argument === '--steps') config.steps = Number(args[++index]);
    else if (argument === '--max-seconds') config.maxSeconds = Number(args[++index]);
    else if (argument === '--delay-ms') config.delayMs = Number(args[++index]);
    else throw new Error('collector_invalid_arguments');
  }
  if (!Number.isInteger(config.steps) || config.steps < 1 || config.steps > 500 ||
    !Number.isInteger(config.maxSeconds) || config.maxSeconds < 1 || config.maxSeconds > 1200 ||
    !Number.isInteger(config.delayMs) || config.delayMs < 500 || config.delayMs > 60000) {
    throw new Error('collector_invalid_limits');
  }
  const secret = String(env.HIDDEN_STOCK_SERVICE_SECRET || '');
  if (!/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('collector_service_not_configured');
  let url;
  try { url = new URL(env.HIDDEN_STOCK_SERVICE_URL || DEFAULT_SERVICE_URL); }
  catch { throw new Error('collector_service_not_configured'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/.test(url.hostname) ||
    url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('collector_service_not_configured');
  }
  url.pathname = '/api/hidden-stock';
  url.searchParams.set('action', config.statusOnly ? 'status' : 'collect');
  return { ...config, url, secret };
}

function count(...values) {
  for (const value of values) {
    if (value == null || value === '' || !['number', 'string'].includes(typeof value)) continue;
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1000000000000) return numeric;
  }
  return null;
}

function iso(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function safeCollectorProgress(data) {
  const progress = data?.progress || {};
  const collection = data?.collection || {};
  const scan = data?.scan || {};
  const rawPhase = progress.phase || collection.phase;
  return {
    phase: Object.hasOwn(PHASES, rawPhase) ? rawPhase : 'unknown',
    metricScope: count(collection.processed) != null ? 'cumulative' : 'last_step',
    processed: count(collection.processed, scan.processed, progress.processed),
    discovered: count(collection.hiddenOptions, collection.discovered, progress.discovered),
    failed: count(collection.failedProducts, collection.failed, progress.failed),
    partialProducts: count(collection.partialProducts),
    checkedProducts: count(collection.checkedProducts),
    queueRemaining: count(progress.queueRemaining, collection.queueRemaining),
    nextRunAt: iso(progress.nextRunAt || collection.nextRunAt),
    enabled: typeof collection.enabled === 'boolean' ? collection.enabled : null
  };
}

async function readBoundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared != null && (!Number.isFinite(Number(declared)) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel?.();
    throw new Error('collector_invalid_response');
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw new Error('collector_invalid_response');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('collector_invalid_response');
    chunks.push(bytes);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('collector_invalid_response'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('collector_invalid_response');
  return data;
}

function retrySeconds(response, data, now) {
  const header = response?.headers?.get('retry-after');
  const numeric = Number(header);
  const dateSeconds = header && !Number.isFinite(numeric) ? Math.ceil((Date.parse(header) - now) / 1000) : null;
  const pausedUntil = iso(data?.collection?.pausedUntil);
  const pausedSeconds = pausedUntil ? Math.ceil((Date.parse(pausedUntil) - now) / 1000) : null;
  const candidate = count(data?.retryAfterSeconds, pausedSeconds, header ? numeric : null, dateSeconds);
  return Math.max(1, Math.min(86400, candidate == null ? 300 : candidate));
}

export async function runCollector(config, {
  fetchImpl = globalThis.fetch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  report = message => console.log(message)
} = {}) {
  const startedAt = now();
  const deadline = startedAt + config.maxSeconds * 1000;
  let steps = 0;
  let progress = safeCollectorProgress(null);
  function result(outcome, extra = {}) {
    return {
      ok: !['backoff', 'error'].includes(outcome), outcome,
      exitCode: outcome === 'error' ? 1 : 0,
      statusOnly: config.statusOnly, steps,
      elapsedSeconds: Math.max(0, Math.ceil((now() - startedAt) / 1000)),
      progress, ...extra
    };
  }
  while (steps < (config.statusOnly ? 1 : config.steps)) {
    const remaining = deadline - now();
    if (remaining <= 0) return result('time_limit');
    let response;
    let data;
    try {
      response = await fetchImpl(new URL(config.url), {
        method: config.statusOnly ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { Authorization: `Bearer ${config.secret}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(MAX_REQUEST_MS, remaining)))
      });
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel?.();
        return result('error', { error: 'service_auth_failed', httpStatus: response.status });
      }
      if ([429, 503].includes(response.status)) {
        // Never echo an upstream error body. A transient outage is a paused run,
        // not a successful collection and not a reason to restart its checkpoint.
        let backoff = null;
        try { backoff = await readBoundedJson(response); } catch { /* sanitized below */ }
        return result('backoff', { error: 'service_temporarily_unavailable', httpStatus: response.status,
          retryAfterSeconds: retrySeconds(response, backoff, now()) });
      }
      if (!response.ok) {
        await response.body?.cancel?.();
        return result('error', { error: 'service_http_error', httpStatus: response.status });
      }
      data = await readBoundedJson(response);
      if (data.success !== true) return result('error', { error: 'collector_invalid_response', httpStatus: response.status });
    } catch (error) {
      const invalid = error?.message === 'collector_invalid_response';
      return result(invalid ? 'error' : 'backoff', { error: invalid ? 'collector_invalid_response' : 'connection_interrupted',
        ...(!invalid ? { retryAfterSeconds: 300 } : {}) });
    }
    steps++;
    progress = safeCollectorProgress(data);
    report(JSON.stringify({ event: config.statusOnly ? 'collection_status' : 'collection_progress', step: steps, ...progress }));
    const pausedUntil = iso(data.collection?.pausedUntil);
    const serverBackoff = data.collection?.phase === 'backoff' ||
      ['backoff', 'catalog_backoff', 'provider_backoff'].includes(data.progress?.phase) ||
      (pausedUntil && Date.parse(pausedUntil) > now());
    if (serverBackoff) return result('backoff', { error: 'server_collection_paused',
      retryAfterSeconds: retrySeconds(response, data, now()) });
    if (config.statusOnly) return result('status');
    if (data.idle === true) {
      const yielding = ['foreground_priority', 'leased', 'lease_changed'].includes(data.progress?.phase) || data.collection?.phase === 'running';
      return result(yielding ? 'waiting' : 'idle', { retryAfterSeconds: retrySeconds(response, data, now()) });
    }
    if (data.retryAfterSeconds != null && Number(data.retryAfterSeconds) > 0) {
      return result('waiting', { retryAfterSeconds: retrySeconds(response, data, now()) });
    }
    if (steps >= config.steps) return result('step_limit');
    if (deadline - now() <= config.delayMs) return result('time_limit');
    await pause(config.delayMs);
  }
  return result('step_limit');
}

export function formatCollectorSummary(result) {
  const titles = {
    status: '상태 확인만 완료 (수집 실행 안 함)', idle: '지금 처리할 작업 없음 · 다음 갱신 대기',
    waiting: '서버가 지정한 재시도 시각까지 대기', step_limit: '이번 실행의 단계 한도 도달 · 진행 저장됨',
    time_limit: '이번 실행의 시간 한도 도달 · 진행 저장됨',
    backoff: '⚠ 일시 오류로 수집 중단 · 다음 실행에서 재시도 필요',
    error: '❌ 수집 실패 · 설정 또는 응답 확인 필요'
  };
  const progress = result.progress || safeCollectorProgress(null);
  const display = value => value == null ? '확인 안 됨' : String(value);
  const lines = [
    '## 숨겨진 옵션 정기 수집', '',
    `상태: ${titles[result.outcome] || titles.error}`, '',
    `- 이번 실행: ${display(result.steps)}단계 / ${display(result.elapsedSeconds)}초`,
    `- 현재 단계: ${PHASES[progress.phase] || '확인 중'}`,
    `- ${progress.metricScope === 'cumulative' ? '누적 처리 횟수' : '마지막 단계 처리'}: ${display(progress.processed)}건`,
    `- ${progress.metricScope === 'cumulative' ? '현재 확인된 숨겨진 옵션' : '마지막 단계 발견 옵션'}: ${display(progress.discovered)}개`,
    `- ${progress.metricScope === 'cumulative' ? '재시도 필요한 상품' : '마지막 단계 실패'}: ${display(progress.failed)}개`,
    `- 대기 작업: ${display(progress.queueRemaining)}개`
  ];
  if (progress.checkedProducts != null) lines.push(`- 확인 기록이 있는 상품: ${progress.checkedProducts}개`);
  if (progress.partialProducts != null) lines.push(`- 일부만 확인된 상품: ${progress.partialProducts}개`);
  if (result.statusOnly) lines.push('- 상태만 조회했습니다. 이번 실행에서 수집은 시작하지 않았습니다.');
  if (progress.nextRunAt) lines.push(`- 서버 다음 갱신 시각: ${progress.nextRunAt}`);
  if (result.retryAfterSeconds) lines.push(`- 권장 재시도 대기: ${result.retryAfterSeconds}초 이상`);
  if (result.httpStatus) lines.push(`- 응답 상태: HTTP ${result.httpStatus}`);
  lines.push('', '공개된 공식 자료에서 확인 가능한 옵션을 순차 수집합니다. 이번 실행 종료는 전체 오프라인 재고 확인 완료를 뜻하지 않습니다.',
    '시간·단계 한도나 일시 오류로 멈춰도 저장된 진행 위치에서 이어집니다. 예약 실행은 GitHub 대기열에 따라 늦어질 수 있습니다.', '');
  return lines.join('\n');
}

async function main() {
  if (process.argv.includes('--help')) { console.log(HELP); return; }
  let result;
  try { result = await runCollector(collectorConfig()); }
  catch { result = { ok: false, outcome: 'error', exitCode: 1, steps: 0, elapsedSeconds: 0, progress: safeCollectorProgress(null) }; }
  const summary = formatCollectorSummary(result);
  console.log(summary);
  if (result.outcome === 'backoff') console.warn('::warning::숨겨진 옵션 수집이 일시 오류로 중단되었습니다. 완료 상태가 아니며 다음 예약 실행에서 재시도합니다.');
  if (result.outcome === 'error') console.error('::error::숨겨진 옵션 수집에 실패했습니다. 서비스 인증 또는 응답 상태를 확인하세요.');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8'); }
    catch { console.error('::error::수집 결과 요약을 기록하지 못했습니다.'); result.exitCode = 1; }
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
