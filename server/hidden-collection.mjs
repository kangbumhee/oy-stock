import crypto from 'node:crypto';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LEASE_MS = 150000;
const STEP_MS = 30000;
const MAX_WORK = 5;
const MAX_KNOWN = 50000;
const goodId = value => typeof value === 'string' && /^[AB]\d{6,20}$/.test(value);
const iso = value => new Date(value).toISOString();
const millis = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const clone = value => structuredClone(value);
const dueAt = (entry, time) => !millis(entry?.dueAt) || millis(entry.dueAt) <= time;
const useful = (result, goodsNo) => result?.options?.some(option => option.goodsNo === goodsNo &&
  /^\d{6,20}$/.test(String(option.productId || '')) && typeof option.hidden === 'boolean');
const interval = result => result?.coverage?.complete !== true || result?.options?.some(option => option.hidden === true) ? DAY : 7 * DAY;

function initialCollection() {
  return {
    version: 1, known: {}, knownCount: 0, queued: {}, lease: null, pausedUntil: null, pauseReason: '',
    consecutiveFailures: 0, processed: 0, failed: 0, workSinceCatalog: 25,
    lastRunAt: null, capacityReached: false,
    catalog: { page: 1, enumerationComplete: false, officialTotal: null, cycle: 1,
      seen: 0, lastPageKey: '', lastCompletedAt: null, refreshAt: null, attempts: 0 }
  };
}

function stateFrom(scan) {
  if (!scan?.collection) return initialCollection();
  const value = clone(scan.collection);
  if (value.version !== 1 || !value.known || !value.queued || !value.catalog ||
    Array.isArray(value.known) || Array.isArray(value.queued) ||
    Object.keys(value.known).length > MAX_KNOWN || Object.keys(value.queued).length > MAX_KNOWN ||
    Object.keys(value.known).some(id => !goodId(id)) || Object.keys(value.queued).some(id => !goodId(id))) {
    throw new Error('hidden_collection_checkpoint_invalid');
  }
  value.knownCount = Object.keys(value.known).length;
  return value;
}

function addKnown(state, goodsNo) {
  if (state.known[goodsNo]) return state.known[goodsNo];
  if (state.knownCount >= MAX_KNOWN) { state.capacityReached = true; return null; }
  const entry = { fingerprint: '', lastCheckedAt: null, nextCheckAt: null, attempts: 0 };
  state.known[goodsNo] = entry;
  state.knownCount++;
  return entry;
}

function queueProduct(state, goodsNo, time, reason, force = false) {
  const known = addKnown(state, goodsNo);
  if (!known) return false;
  if (!force && millis(known.nextCheckAt) > time) return false;
  if (state.queued[goodsNo]) return false;
  state.queued[goodsNo] = { dueAt: iso(time), reason, token: crypto.randomUUID() };
  return true;
}

function metadataFingerprint(row) {
  // Price/stock/rank changes are intentionally excluded: they are not option
  // identity metadata. Even unchanged metadata gets periodic review discovery.
  return crypto.createHash('sha256').update(JSON.stringify([
    row.goodsNumber, row.goodsName || '', row.brandName || '', row.itemCount ?? null,
    row.goodsThumbnailPath || row.imagePath || row.imageUrl || '', row.masterGoodsNumber || ''
  ])).digest('hex').slice(0, 24);
}

function nextTime(state, time) {
  if (millis(state.pausedUntil) > time) return millis(state.pausedUntil);
  if (state.lease && millis(state.lease.expiresAt) > time) return millis(state.lease.expiresAt);
  const times = [];
  for (const entry of Object.values(state.queued)) times.push(millis(entry.dueAt) || time);
  for (const entry of Object.values(state.known)) if (entry.nextCheckAt) times.push(millis(entry.nextCheckAt));
  if (!state.catalog.enumerationComplete) times.push(time);
  else if (state.catalog.refreshAt) times.push(millis(state.catalog.refreshAt));
  return Math.max(time + 60000, times.length ? times.reduce((minimum, value) => Math.min(minimum, value), Infinity) : time + 10 * 60000);
}

function compact(state, time) {
  const known = Object.values(state.known);
  const queued = Object.values(state.queued);
  const paused = millis(state.pausedUntil) > time;
  return {
    version: 1,
    phase: paused ? 'backoff' : state.lease && millis(state.lease.expiresAt) > time ? 'running'
      : !state.catalog.enumerationComplete ? 'enumerating' : queued.some(entry => dueAt(entry, time)) ? 'collecting' : 'waiting',
    knownProducts: known.length, queueRemaining: queued.length,
    dueProducts: queued.filter(entry => dueAt(entry, time)).length,
    checkedProducts: known.filter(entry => entry.lastCheckedAt).length,
    failedProducts: known.filter(entry => entry.attempts > 0).length,
    partialProducts: known.filter(entry => entry.partial === true).length,
    hiddenOptions: known.reduce((count, entry) => count + (entry.hiddenOptions || 0), 0),
    processed: state.processed, failed: state.failed,
    consecutiveFailures: state.consecutiveFailures,
    pausedUntil: paused ? state.pausedUntil : null,
    pauseReason: paused ? state.pauseReason : '',
    capacityReached: state.capacityReached === true,
    lastRunAt: state.lastRunAt,
    nextRunAt: iso(nextTime(state, time)),
    catalog: {
      page: state.catalog.page, enumerationComplete: state.catalog.enumerationComplete,
      officialTotal: state.catalog.officialTotal, observedProducts: state.catalog.seen,
      lastCompletedAt: state.catalog.lastCompletedAt, refreshAt: state.catalog.refreshAt
    }
  };
}

function report(state, time) {
  const collection = compact(state, time);
  return {
    success: true,
    collection,
    scan: { page: state.catalog.page, offset: 0, processed: state.processed, enumerationComplete: state.catalog.enumerationComplete },
    coverage: {
      scope: 'scheduled-official-public-product-evidence',
      complete: state.catalog.enumerationComplete === true && collection.queueRemaining === 0 &&
        collection.failedProducts === 0 && collection.partialProducts === 0 && !state.capacityReached,
      catalogEnumerationComplete: state.catalog.enumerationComplete === true,
      indexedProducts: collection.checkedProducts,
      deferredProducts: collection.queueRemaining,
      allPhysicalInventoryGuaranteed: false
    }
  };
}

async function boundedWork(fn, remainingMs) {
  if (remainingMs <= 0) throw new Error('hidden_collection_deadline');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('hidden_collection_deadline')); }, remainingMs); })
    ]);
  } finally { clearTimeout(timer); }
}

/** Resumable public-catalog discovery. This does not collect private catalog data
 * or assume that an unchanged online option list means unchanged review history. */
export function createHiddenCollection({ index, request, discover, now = Date.now, shouldYield = () => false } = {}) {
  if (!index || !['readScan', 'mutateScan', 'readProduct', 'saveDiscovery'].every(key => typeof index[key] === 'function') ||
    typeof request !== 'function' || typeof discover !== 'function') throw new Error('hidden_collection_dependencies_required');

  async function status() {
    return report(stateFrom(await index.readScan({ fresh: true })), now());
  }

  async function enqueue(goodsNos) {
    if (!Array.isArray(goodsNos) || goodsNos.length > MAX_KNOWN || goodsNos.some(id => !goodId(id))) throw new Error('invalid_collection_goods_nos');
    let added = 0;
    const snapshot = await index.mutateScan(scan => {
      const state = stateFrom(scan);
      added = 0;
      for (const goodsNo of new Set(goodsNos)) if (queueProduct(state, goodsNo, now(), 'requested')) added++;
      scan.collection = state;
    });
    return { success: true, added, collection: compact(stateFrom(snapshot), now()) };
  }

  async function step() {
    const started = now();
    const deadline = started + STEP_MS;
    const before = stateFrom(await index.readScan({ fresh: true }));
    if (shouldYield()) return idleResult(before, 'foreground_priority', 5);
    if (millis(before.pausedUntil) > now()) return idleResult(before, 'backoff', Math.ceil((millis(before.pausedUntil) - now()) / 1000));
    if (before.lease && millis(before.lease.expiresAt) > now()) return idleResult(before, 'leased', Math.ceil((millis(before.lease.expiresAt) - now()) / 1000));
    const owner = crypto.randomUUID();
    const leasedScan = await index.mutateScan(scan => {
      const state = stateFrom(scan);
      // The pre-read can race with another worker publishing provider backoff.
      // Recheck the authoritative CAS snapshot before acquiring a new lease.
      if (millis(state.pausedUntil) > now()) return;
      if (state.lease && millis(state.lease.expiresAt) > now()) return;
      state.lease = { owner, expiresAt: iso(now() + LEASE_MS) };
      scan.collection = state;
    });
    const base = stateFrom(leasedScan);
    if (millis(base.pausedUntil) > now()) return idleResult(base, 'backoff', Math.ceil((millis(base.pausedUntil) - now()) / 1000));
    if (base.lease?.owner !== owner) return idleResult(base, 'leased', 150);
    const state = clone(base);
    state.pausedUntil = null;
    state.pauseReason = '';
    state.lastRunAt = iso(now());
    const progress = { phase: 'idle', processed: 0, discovered: 0, failed: 0, workUnits: 0 };
    if (state.catalog.enumerationComplete && millis(state.catalog.refreshAt) <= now()) {
      state.catalog = { ...state.catalog, page: 1, enumerationComplete: false, cycle: state.catalog.cycle + 1,
        seen: 0, lastPageKey: '', attempts: 0 };
      state.workSinceCatalog = 25;
    }
    for (const [goodsNo, entry] of Object.entries(state.known)) {
      if (!entry.nextCheckAt || millis(entry.nextCheckAt) <= now()) queueProduct(state, goodsNo, now(), 'scheduled');
    }

    while (progress.workUnits < MAX_WORK && now() < deadline && !shouldYield()) {
      if (millis(state.lease.expiresAt) <= now() || millis(state.pausedUntil) > now()) break;
      const available = Object.entries(state.queued).filter(([, entry]) => dueAt(entry, now()))
        .sort((a, b) => millis(a[1].dueAt) - millis(b[1].dueAt) || a[0].localeCompare(b[0]));
      const needCatalog = !state.catalog.enumerationComplete &&
        (available.length <= 3 || state.workSinceCatalog >= 25);
      if (needCatalog) {
        progress.phase = 'catalog';
        progress.workUnits++;
        try {
          const payload = await boundedWork(signal => request({ method: 'POST', path: '/oystore/api/stock/product-search-v3',
            body: { includeSoldOut: true, keyword: '', page: state.catalog.page, sort: '01', size: 20 } }, { signal }), deadline - now());
          const data = payload?.data;
          if (payload?.status !== 'SUCCESS' || !Array.isArray(data?.serachList) || data.serachList.length > 20 ||
            typeof data.nextPage !== 'boolean' || (!data.serachList.length && data.nextPage) ||
            data.serachList.some(row => !goodId(row?.goodsNumber))) throw new Error('catalog_unavailable');
          const pageKey = crypto.createHash('sha256').update(data.serachList.map(row => row.goodsNumber).join('|')).digest('hex');
          if (data.serachList.length && state.catalog.lastPageKey === pageKey) throw new Error('catalog_repeated_page');
          for (const row of data.serachList) {
            const entry = addKnown(state, row.goodsNumber);
            if (!entry) throw new Error('collection_capacity');
            const fingerprint = metadataFingerprint(row);
            const changed = entry.fingerprint !== fingerprint;
            entry.fingerprint = fingerprint;
            if (entry.catalogCycle !== state.catalog.cycle) { entry.catalogCycle = state.catalog.cycle; state.catalog.seen++; }
            if (changed) {
              entry.nextCheckAt = iso(now());
              if (state.queued[row.goodsNumber]) state.queued[row.goodsNumber].dueAt = iso(now());
            }
            queueProduct(state, row.goodsNumber, now(), changed ? 'metadata_changed' : 'scheduled', changed);
          }
          if (Number.isSafeInteger(Number(data.totalCount)) && Number(data.totalCount) >= 0) state.catalog.officialTotal = Number(data.totalCount);
          if (!data.nextPage && state.catalog.officialTotal > state.catalog.seen) throw new Error('catalog_incomplete');
          state.catalog.page++;
          state.catalog.lastPageKey = pageKey;
          state.catalog.attempts = 0;
          state.workSinceCatalog = 0;
          if (!data.nextPage) {
            state.catalog.enumerationComplete = true;
            state.catalog.lastCompletedAt = iso(now());
            state.catalog.refreshAt = iso(now() + DAY);
          }
        } catch (error) {
          if (shouldYield() || error?.message === 'background_yield' || error?.message === 'hidden_collection_deadline') {
            progress.phase = shouldYield() || error?.message === 'background_yield' ? 'foreground_priority' : 'time_budget';
            break;
          }
          state.catalog.attempts = (state.catalog.attempts || 0) + 1;
          state.pausedUntil = iso(now() + Math.min(DAY, HOUR * 2 ** Math.min(5, state.catalog.attempts - 1)));
          state.pauseReason = state.capacityReached ? 'known_product_limit' : 'catalog_unavailable';
          progress.phase = 'catalog_backoff';
          break;
        }
        continue;
      }
      if (!available.length) break;
      const [goodsNo] = available[0];
      const known = state.known[goodsNo];
      progress.phase = 'products';
      progress.workUnits++;
      state.workSinceCatalog++;
      try {
        const saved = await boundedWork(() => index.readProduct(goodsNo, { fresh: true }), deadline - now());
        const savedAt = millis(saved?.checkedAt);
        const reusable = saved && savedAt > millis(known.lastCheckedAt) && savedAt + interval(saved) > now() &&
          (!known.fingerprint || saved.coverage?.collectionFingerprint === known.fingerprint) &&
          (saved.coverage?.complete === true || useful(saved, goodsNo));
        let result = saved;
        if (!reusable) {
          result = await boundedWork(signal => discover(goodsNo, { signal, deadline, shouldYield }), deadline - now());
          if (!result || !Array.isArray(result.options) || !result.coverage || typeof result.coverage.complete !== 'boolean') throw new Error('root_unavailable');
          const previous = new Map((saved?.options || []).filter(option => option.goodsNo === goodsNo && option.productId)
            .map(option => [option.optionNumber, option]));
          result = { ...result, options: result.options.filter(option => option.goodsNo === goodsNo &&
            !(result.coverage.complete !== true && !option.productId && previous.has(option.optionNumber))),
          coverage: { ...result.coverage, scope: 'official-public-product-option-and-review-evidence', rootGoodsNo: goodsNo,
            collectionFingerprint: known.fingerprint } };
          if (result.coverage.complete !== true && !useful(result, goodsNo)) throw new Error('root_unavailable');
          // Only owned root rows are saved. Deferred related nulls must never
          // overwrite evidence already recorded under their own product shard.
          await boundedWork(() => index.saveDiscovery(goodsNo, result, now()), deadline - now());
        }
        const checkedAt = reusable ? savedAt : now();
        known.lastCheckedAt = iso(checkedAt);
        known.nextCheckAt = iso(checkedAt + interval(result));
        known.attempts = 0;
        known.partial = result.coverage.complete !== true;
        known.hiddenOptions = result.options.filter(option => option.goodsNo === goodsNo && option.hidden === true && option.productId).length;
        state.consecutiveFailures = 0;
        state.processed++;
        progress.processed++;
        progress.discovered += known.hiddenOptions;
        delete state.queued[goodsNo];
        for (const related of result.relatedGoodsNos || []) if (goodId(related) && related !== goodsNo) queueProduct(state, related, now(), 'related');
      } catch (error) {
        if (shouldYield() || error?.message === 'background_yield' || error?.message === 'hidden_collection_deadline') {
          progress.phase = shouldYield() || error?.message === 'background_yield' ? 'foreground_priority' : 'time_budget';
          break;
        }
        known.attempts = (known.attempts || 0) + 1;
        known.nextCheckAt = iso(now() + Math.min(DAY, HOUR * 2 ** Math.min(5, known.attempts - 1)));
        state.queued[goodsNo] = { dueAt: known.nextCheckAt, reason: 'retry', token: crypto.randomUUID() };
        state.consecutiveFailures++;
        state.failed++;
        progress.failed++;
        if (state.consecutiveFailures >= 3) {
          state.pausedUntil = iso(now() + HOUR);
          state.pauseReason = 'consecutive_root_failures';
          progress.phase = 'provider_backoff';
          break;
        }
      }
    }
    if (shouldYield()) progress.phase = 'foreground_priority';
    else if (now() >= deadline) progress.phase = 'time_budget';

    // enqueue() can run during this lease. Merge only our changed map entries
    // and remove only queue tokens actually consumed by this lease.
    let savedScan;
    let checkpointCommitted = false;
    try {
      savedScan = await index.mutateScan(scan => {
        checkpointCommitted = false;
        const current = stateFrom(scan);
        if (current.lease?.owner !== owner || millis(current.lease.expiresAt) <= now()) return;
        const mergedKnown = { ...current.known };
        const mergedQueue = { ...current.queued };
        for (const [id, entry] of Object.entries(state.known)) {
          if (JSON.stringify(entry) !== JSON.stringify(base.known[id]) && (mergedKnown[id] || Object.keys(mergedKnown).length < MAX_KNOWN)) mergedKnown[id] = entry;
        }
        for (const [id, entry] of Object.entries(base.queued)) {
          if (!state.queued[id] && mergedQueue[id]?.token === entry.token) delete mergedQueue[id];
        }
        for (const [id, entry] of Object.entries(state.queued)) {
          if (JSON.stringify(entry) === JSON.stringify(base.queued[id]) || !mergedKnown[id]) continue;
          const concurrent = mergedQueue[id] && mergedQueue[id].token !== base.queued[id]?.token;
          if (!concurrent || millis(entry.dueAt) < millis(mergedQueue[id].dueAt)) mergedQueue[id] = entry;
        }
        // Locally queued and consumed products had no base token to remove.
        for (const id of Object.keys(state.known)) {
          if (!state.queued[id] && !base.queued[id] && mergedQueue[id] &&
            millis(state.known[id].lastCheckedAt) >= millis(mergedQueue[id].dueAt)) delete mergedQueue[id];
        }
        scan.collection = { ...state, known: mergedKnown, queued: mergedQueue, lease: null };
        checkpointCommitted = true;
      });
    } catch { throw new Error('hidden_collection_checkpoint_unavailable'); }
    const finished = stateFrom(savedScan);
    if (!checkpointCommitted) return idleResult(finished, 'lease_changed', 150);
    const collection = compact(finished, now());
    return {
      success: true, collection,
      progress: { ...progress, queueRemaining: collection.queueRemaining, nextRunAt: collection.nextRunAt },
      idle: progress.workUnits === 0,
      ...(millis(finished.pausedUntil) > now() ? { retryAfterSeconds: Math.ceil((millis(finished.pausedUntil) - now()) / 1000) } : {})
    };
  }

  function idleResult(state, phase, retryAfterSeconds) {
    const collection = compact(state, now());
    return { success: true, collection, idle: true, retryAfterSeconds: Math.max(1, retryAfterSeconds),
      progress: { phase, processed: 0, discovered: 0, failed: 0, workUnits: 0,
        queueRemaining: collection.queueRemaining, nextRunAt: collection.nextRunAt } };
  }
  return { step, status, enqueue };
}
