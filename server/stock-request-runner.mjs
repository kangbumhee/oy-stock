const clone = (value) => structuredClone(value);

export function stockFailure(error = 'stock_unavailable', status = 503, retryAfterSeconds = 5) {
  return { ok: false, status, error, retryAfterSeconds, retryAfterMs: retryAfterSeconds * 1000 };
}

export function stockResponseState(response) {
  const payload = response?.data;
  if (response?.status === 429 || Number(payload?.code) === 429) {
    return { ok: false, error: 'stock_rate_limited', status: 429 };
  }
  const inner = payload?.data?.data?.storeList !== undefined ? payload.data.data : payload?.data;
  const valid = response?.ok === true && response.status >= 200 && response.status < 300 &&
    payload?.status === 'SUCCESS' && (payload.code == null || Number(payload.code) === 200) &&
    inner && Array.isArray(inner.storeList) &&
    (inner.stockDisplayYn !== false || (inner.storeList.length === 0 && Number(inner.totalCount) === 0));
  return valid
    ? { ok: true, stores: inner.storeList }
    : { ok: false, error: response?.error || 'stock_unavailable', status: response?.status === 429 ? 429 : 503 };
}

export function stockRetryDelay(value, now = Date.now(), fallbackSeconds = 60) {
  const numeric = Number(value);
  if (value != null && String(value).trim() !== '' && Number.isFinite(numeric) && numeric >= 0) {
    return Math.max(1, Math.ceil(numeric));
  }
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : fallbackSeconds;
}

export function stockRequestKey(body) {
  return JSON.stringify([
    String(body.productId), Number(body.lat), Number(body.lon), Number(body.pageIdx || 1),
    String(body.searchWords || ''), Number(body.mapLat), Number(body.mapLon)
  ]);
}

/** One per instance, shared by nearby, national and paid hidden-store reads.
 * A throttle response is never retried with a fresh identity/session. Queued
 * work stops, successful observations are reused, and callers retry after the
 * upstream's cooldown. This limits demand; it cannot override availability.
 */
export function createStockRequestRunner(fetchRequest, {
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = 1000,
  maxQueue = 20,
  maxWaitMs = 12000,
  requestTimeoutMs = 4500,
  cacheTtlMs = 180000,
  cacheMax = 500,
  cooldownSeconds = 60
} = {}) {
  const cache = new Map();
  const flights = new Map();
  const queue = [];
  let draining = false;
  let nextStartAt = 0;
  let cooldownUntil = 0;

  function cooldownFailure() {
    return stockFailure('stock_rate_limited', 429, Math.max(1, Math.ceil((cooldownUntil - now()) / 1000)));
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const entry = queue.shift();
        let result;
        if (cooldownUntil > now()) result = cooldownFailure();
        else if (now() > entry.deadline || Math.max(now(), nextStartAt) > entry.deadline) {
          result = stockFailure('stock_queue_busy', 503, 5);
        } else {
          if (nextStartAt > now()) await sleep(nextStartAt - now());
          if (cooldownUntil > now()) result = cooldownFailure();
          else {
            nextStartAt = now() + minIntervalMs;
            try { result = await fetchRequest(entry.body); }
            catch { result = stockFailure(); }
            const state = stockResponseState(result);
            if (state.status === 429) {
              const seconds = stockRetryDelay(result.retryAfterSeconds ?? result.retryAfter, now(), cooldownSeconds);
              cooldownUntil = Math.max(cooldownUntil, now() + seconds * 1000);
              result = cooldownFailure();
            } else if (state.ok) {
              for (const [key, cached] of cache) if (now() - cached.at >= cacheTtlMs) cache.delete(key);
              cache.set(entry.key, { at: now(), result: clone(result) });
              while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
            } else {
              result = { ...stockFailure(state.error, state.status), ...result, ok: false, error: state.error };
            }
          }
        }
        entry.resolve(result);
      }
    } finally { draining = false; }
  }

  return function request(body, { deadlineAt = Infinity } = {}) {
    const key = stockRequestKey(body);
    const cached = cache.get(key);
    if (cached && now() - cached.at < cacheTtlMs) return Promise.resolve(clone(cached.result));
    if (cached) cache.delete(key);
    const existing = flights.get(key);
    if (existing) return existing.then(clone);
    if (cooldownUntil > now()) return Promise.resolve(cooldownFailure());
    if (now() + requestTimeoutMs > deadlineAt) return Promise.resolve(stockFailure('stock_lookup_timeout', 503, 5));
    if (queue.length >= maxQueue) return Promise.resolve(stockFailure('stock_queue_busy', 503, 5));
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    flights.set(key, result);
    queue.push({ key, body: clone(body), resolve, deadline: Math.min(now() + maxWaitMs, deadlineAt - requestTimeoutMs) });
    void drain();
    return result.finally(() => { if (flights.get(key) === result) flights.delete(key); }).then(clone);
  };
}

export function stockLookupHttpStatus(result) {
  if (result?.success && result.storeLookupStatus !== 'unavailable') return 200;
  return result?.storeLookupError === 'stock_rate_limited' ? 429 : 503;
}

export function isCompleteStockResult(result, onlineOnly = false) {
  return !!result?.success && (onlineOnly || result.storeLookupStatus === 'ok');
}
