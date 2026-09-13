const STOCK_ORIGIN = 'https://www.oliveyoung.co.kr';
const REVIEW_ORIGIN = 'https://m.oliveyoung.co.kr';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_TIMEOUT_MS = 5000;
const goodId = (value) => typeof value === 'string' && /^[AB]\d{6,20}$/.test(value);
const itemId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const coordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const safeText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function allowedKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}

function validateRequest(input) {
  if (!allowedKeys(input, ['method', 'path', 'body'])) throw new Error('hidden_official_request_not_allowed');
  const { method, path, body } = input;
  let allowed = false;
  let surface = 'stock';
  if (method === 'POST' && [
    '/oystore/api/stock/stock-goods-info-option',
    '/oystore/api/stock/stock-goods-info-v3'
  ].includes(path)) {
    allowed = allowedKeys(body, ['goodsNo']) && goodId(body.goodsNo);
  } else if (method === 'POST' && path === '/oystore/api/stock/product-search-v3') {
    allowed = allowedKeys(body, ['includeSoldOut', 'keyword', 'page', 'sort', 'size']) &&
      body.includeSoldOut === true && safeText(body.keyword, 120) &&
      integer(body.page, 1, 2000) && body.sort === '01' && integer(body.size, 1, 20);
  } else if (method === 'POST' && path === '/oystore/api/stock/stock-stores') {
    allowed = allowedKeys(body, ['productId', 'lat', 'lon', 'pageIdx', 'searchWords', 'mapLat', 'mapLon']) &&
      typeof body.productId === 'string' && /^\d{6,20}$/.test(body.productId) &&
      coordinate(body.lat, 90) && coordinate(body.lon, 180) &&
      coordinate(body.mapLat, 90) && coordinate(body.mapLon, 180) &&
      integer(body.pageIdx, 1, 200) && safeText(body.searchWords, 40);
  } else if (method === 'GET' && typeof path === 'string' &&
    /^\/review\/api\/v2\/reviews\/options\/[AB]\d{6,20}\/count$/.test(path)) {
    surface = 'review';
    allowed = body === undefined;
  } else if (method === 'POST' && path === '/review/api/v2/reviews/cursor') {
    surface = 'review';
    // Only the confirmed public first-page filter is allowed. Continuation must
    // be separately verified before this whitelist is deliberately expanded.
    allowed = allowedKeys(body, ['goodsNumber', 'page', 'size', 'sortType', 'reviewType', 'itemNumberList']) &&
      goodId(body.goodsNumber) && body.page === 0 && integer(body.size, 1, 10) &&
      body.sortType === 'USEFUL_SCORE_DESC' && body.reviewType === 'ALL' &&
      Array.isArray(body.itemNumberList) && body.itemNumberList.length === 1 && body.itemNumberList.every(itemId);
  }
  if (!allowed) throw new Error('hidden_official_request_not_allowed');
  return { method, path, body, surface, origin: surface === 'stock' ? STOCK_ORIGIN : REVIEW_ORIGIN };
}

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('hidden_official_timeout')), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

// This function executes in the dedicated browser page. It has no access to
// Node credentials and never returns response headers, raw error bodies or logs.
async function fetchOfficialInPage({ origin, path, method, body, timeoutMs, maxBytes }) {
  if (globalThis.location.origin !== origin) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch(origin + path, {
      method,
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: method === 'POST'
        ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
        : { Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok || new URL(response.url).origin !== origin || !response.body) return { ok: false };
    const advertisedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
      controller.abort();
      return { ok: false };
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        controller.abort();
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.status !== 'SUCCESS' || (payload.code != null && Number(payload.code) !== 200)) return { ok: false };
    return { ok: true, payload };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch {}
  }
}

/** Read-only, fixed-origin transport for paid hidden-stock discovery. */
export function createHiddenOfficialTransport({
  stockPage,
  reviewPage,
  isCurrent,
  timeoutMs = 4500,
  pageAcquireTimeoutMs = 12000,
  maxBytes = MAX_RESPONSE_BYTES
} = {}) {
  if (typeof stockPage !== 'function' || typeof isCurrent !== 'function') throw new Error('hidden_official_page_provider_required');
  const fetchTimeout = Math.max(1, Math.min(MAX_FETCH_TIMEOUT_MS, Number(timeoutMs) || 4500));
  const acquireTimeout = Math.max(1, Math.min(15000, Number(pageAcquireTimeoutMs) || 12000));
  const responseLimit = Math.max(1, Math.min(MAX_RESPONSE_BYTES, Number(maxBytes) || MAX_RESPONSE_BYTES));

  return async function request(input) {
    const target = validateRequest(input);
    const acquire = target.surface === 'stock' ? stockPage : reviewPage;
    if (typeof acquire !== 'function') throw new Error('hidden_official_page_unavailable');
    try {
      const work = await bounded(Promise.resolve().then(acquire), acquireTimeout);
      if (!work?.page || work.page.isClosed() || !Number.isInteger(work.generation) ||
        !isCurrent(work, target.surface) || new URL(work.page.url()).origin !== target.origin) {
        throw new Error('hidden_official_session_changed');
      }
      const result = await bounded(work.page.evaluate(fetchOfficialInPage, {
        origin: target.origin,
        path: target.path,
        method: target.method,
        body: target.body,
        timeoutMs: fetchTimeout,
        maxBytes: responseLimit
      }), fetchTimeout);
      if (!isCurrent(work, target.surface)) throw new Error('hidden_official_session_changed');
      if (!result || result.ok !== true || !result.payload) throw new Error('hidden_official_unavailable');
      return result.payload;
    } catch {
      throw new Error('hidden_official_unavailable');
    }
  };
}
