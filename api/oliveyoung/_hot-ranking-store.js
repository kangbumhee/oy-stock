const { get, put } = require('@vercel/blob');

const VIEW_RANK_URL = 'https://rts.ai.oliveyoung.co.kr/api/stats';
const STOCK_API =
  process.env.HOT_RANK_STOCK_API ||
  'https://oy-stock-api-3596046881.asia-northeast3.run.app/api/stock';
const IMAGE_BASE =
  'https://image.oliveyoung.co.kr/cfimages/cf-goods/uploads/images/thumbnails/';
const BLOB_PATH = process.env.HOT_RANK_BLOB_PATH || 'oliveyoung/hot-ranking-history.json';
const DEFAULT_BUSY_WINDOWS = '10-14,18-24';
const DEFAULT_LAT = process.env.HOT_RANK_LAT || '37.6152';
const DEFAULT_LNG = process.env.HOT_RANK_LNG || '126.7156';
const DEFAULT_TOP_TRACK_LIMIT = 128;
const DEFAULT_HOURLY_ACTIVE_WINDOW_KST = '08-01';
const DEFAULT_HOURLY_COLLECTION_GRACE_MINUTES = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const COLLECTION_STALE_GRACE_MS = 5 * MINUTE_MS;
const DEFAULT_BUSY_INTERVAL_MINUTES = 30;
const DEFAULT_QUIET_INTERVAL_MINUTES = 60;
const DEFAULT_DAILY_COLLECTION_TIME_KST = '03:00';
const DEFAULT_DAILY_COLLECTION_GRACE_MINUTES = 30;
const DEFAULT_STOCK_COLLECTION_TIMES_KST = '03:00,09:00,15:00,21:00';
const DEFAULT_STOCK_CANDIDATE_LIMIT = 250;
const DEFAULT_CATEGORY_STOCK_RANK_LIMIT = 10;
const DEFAULT_PRIORITY_SALES_LIMIT = 20;
const DEFAULT_PRIORITY_REVENUE_LIMIT = 20;
const DEFAULT_RETRY_PER_RUN_LIMIT = 12;
const DEFAULT_CATEGORY_IDS = [
  '10000010001',
  '10000010009',
  '10000010010',
  '10000010011',
  '10000010002',
  '10000010012',
  '10000010006',
  '10000010008',
  '10000010007',
  '10000010005',
  '10000010004',
  '10000010003',
  '10000020001',
  '10000020002',
  '10000020003',
  '10000020005',
  '10000020004',
  '10000030007',
  '10000030005',
  '10000030006'
];

function parseIntBounded(value, fallback, min, max) {
  const n = Number.parseInt(String(value == null ? fallback : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function configuredTopTrackLimit(value) {
  return parseIntBounded(
    value == null ? process.env.HOT_RANK_TOP_TRACK_LIMIT : value,
    DEFAULT_TOP_TRACK_LIMIT,
    1,
    200
  );
}

function parseCategoryId(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'all') return '';
  return /^\d{8,}$/.test(raw) ? raw : '';
}

function configuredCategoryIds() {
  const raw = String(process.env.HOT_RANK_CATEGORY_IDS || DEFAULT_CATEGORY_IDS.join(','));
  const ids = raw
    .split(',')
    .map((value) => parseCategoryId(value))
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function parseMoney(value) {
  if (value == null) return 0;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function latestPriceForItem(item, obs) {
  const latestWithPrice = (obs || [])
    .slice()
    .reverse()
    .find((o) => parseMoney(o && o.price) > 0);
  return (
    parseMoney(latestWithPrice && latestWithPrice.price) ||
    parseMoney(item && item.price) ||
    parseMoney(item && item.latestPrice) ||
    0
  );
}

function goodsNoFromItem(item) {
  const raw = String((item && item.itemUrl) || '').trim();
  const match = raw.match(/goodsNo=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : raw;
}

function imageUrlFromItem(item) {
  const raw = String((item && item.imageUrl) || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return IMAGE_BASE + raw.replace(/^\/+/, '');
}

function normalizeRankItem(item, idx) {
  const goodsNo = goodsNoFromItem(item);
  return {
    rank: idx + 1,
    sourceRank: Number(item && item.rank) || idx + 1,
    goodsNo,
    goodsNumber: goodsNo,
    goodsName: String((item && item.itemName) || goodsNo),
    imageUrl: imageUrlFromItem(item),
    categoryNumber: String((item && item.categoryId) || ''),
    brandId: String((item && item.brandId) || ''),
    viewCount: Number((item && item.count) || 0),
    itemId: String((item && item.itemId) || ''),
    source: 'oliveyoung-view-rank'
  };
}

function streamToText(stream) {
  if (!stream) return Promise.resolve('');
  if (typeof Response !== 'undefined') {
    return new Response(stream).text();
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      }
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(tid);
  }
}

async function fetchViewRanking(size, opts) {
  opts = opts || {};
  const requested = parseIntBounded(size, configuredTopTrackLimit(), 1, 200);
  const categoryId = parseCategoryId(opts.categoryId || opts.category || opts.categoryid);
  const upstreamSize = categoryId
    ? requested
    : Math.min(200, Math.max(requested, Math.ceil(requested * 1.6)));
  const url = new URL(VIEW_RANK_URL);
  url.searchParams.set('type', 'view');
  url.searchParams.set('size', String(upstreamSize));
  if (categoryId) url.searchParams.set('categoryid', categoryId);
  const res = await fetchJsonWithTimeout(url.toString(), 5000);
  if (!res.ok || !res.json || !Array.isArray(res.json.items)) {
    throw new Error('view ranking fetch failed: ' + (res.status || 'no-status'));
  }
  return {
    updatedAt: res.json.dateTime || new Date().toISOString(),
    categoryId,
    products: res.json.items.map(normalizeRankItem).filter((p) => p.goodsNo).slice(0, requested)
  };
}

function compactRankingProduct(product) {
  return {
    rank: product.rank || 9999,
    sourceRank: product.sourceRank || product.rank || 9999,
    goodsNo: product.goodsNo,
    goodsNumber: product.goodsNumber || product.goodsNo,
    goodsName: product.goodsName || product.goodsNo,
    imageUrl: product.imageUrl || '',
    categoryNumber: product.categoryNumber || '',
    brandId: product.brandId || '',
    itemId: product.itemId || '',
    viewCount: Number(product.viewCount) || 0,
    source: product.source || 'oliveyoung-view-rank'
  };
}

async function fetchCategoryRankings(size, opts) {
  opts = opts || {};
  const categoryIds = Array.isArray(opts.categoryIds) && opts.categoryIds.length
    ? opts.categoryIds.map(parseCategoryId).filter(Boolean)
    : configuredCategoryIds();
  const batchSize = parseIntBounded(
    opts.batchSize == null ? process.env.HOT_RANK_CATEGORY_FETCH_BATCH_SIZE : opts.batchSize,
    4,
    1,
    8
  );
  const categories = {};
  const errors = [];

  for (let i = 0; i < categoryIds.length; i += batchSize) {
    const batch = categoryIds.slice(i, i + batchSize);
    const settled = await Promise.all(
      batch.map((categoryId) =>
        fetchViewRanking(size, { categoryId })
          .then((ranking) => ({ ok: true, categoryId, ranking }))
          .catch((e) => ({
            ok: false,
            categoryId,
            message: e && e.message ? e.message : String(e)
          }))
      )
    );
    settled.forEach((result) => {
      if (result.ok) {
        categories[result.categoryId] = {
          categoryId: result.categoryId,
          updatedAt: result.ranking.updatedAt,
          products: (result.ranking.products || []).map(compactRankingProduct)
        };
      } else {
        errors.push({
          categoryId: result.categoryId,
          message: result.message
        });
      }
    });
  }

  return {
    updatedAt: new Date().toISOString(),
    requestedCount: categoryIds.length,
    okCount: Object.keys(categories).length,
    categories,
    errors
  };
}

async function fetchStockSnapshot(product, opts) {
  opts = opts || {};
  const url = new URL(STOCK_API);
  url.searchParams.set('goodsNo', product.goodsNo);
  url.searchParams.set('lat', String(opts.lat || DEFAULT_LAT));
  url.searchParams.set('lng', String(opts.lng || DEFAULT_LNG));
  url.searchParams.set('onlineOnly', 'true');
  url.searchParams.set('fresh', 'true');
  const started = Date.now();
  try {
    const res = await fetchJsonWithTimeout(url.toString(), opts.timeoutMs || 45000);
    const data = res.json || {};
    const options = Array.isArray(data.options) ? data.options : [];
    const total = options.reduce((sum, o) => sum + (Number(o.onlineQty) || 0), 0);
    const purchaseLimit = getPurchaseLimitInfo(options);
    return {
      goodsNo: product.goodsNo,
      ok: res.ok && !!data.success && options.length > 0,
      status: res.status,
      total,
      optionCount: options.length,
      hasToday: options.some((o) => !!o.deliveredToday),
      purchaseLimit,
      goodsName: data.goodsName || product.goodsName || '',
      imageUrl: data.thumbnail || product.imageUrl || '',
      price: parseMoney(data.price),
      originalPrice: parseMoney(data.originalPrice),
      discountRate: Number(data.discountRate) || 0,
      ms: Date.now() - started,
      message: data.message || data.error || '',
      rank: product.rank || 9999,
      collectionTier: product.collectionTier || '',
      collectionReason: product.collectionReason || '',
      collectionEveryRuns: product.collectionEveryRuns || 0,
      collectionDate: product.collectionDate || ''
    };
  } catch (e) {
    return {
      goodsNo: product.goodsNo,
      ok: false,
      total: 0,
      optionCount: 0,
      ms: Date.now() - started,
      message: e && e.message ? e.message : String(e),
      rank: product.rank || 9999,
      collectionTier: product.collectionTier || '',
      collectionReason: product.collectionReason || '',
      collectionEveryRuns: product.collectionEveryRuns || 0,
      collectionDate: product.collectionDate || ''
    };
  }
}

function getPurchaseLimitInfo(options) {
  const values = (Array.isArray(options) ? options : [])
    .map((o) => Number(o && o.maxOrderQty) || 0)
    .filter((n) => n > 0 && n < 999);
  if (!values.length) {
    return {
      checked: Array.isArray(options) && options.length > 0,
      limited: false,
      label: '제한없음',
      min: 0,
      max: 0,
      optionCount: 0
    };
  }
  const unique = Array.from(new Set(values)).sort((a, b) => a - b);
  const min = unique[0];
  const max = unique[unique.length - 1];
  return {
    checked: true,
    limited: true,
    label: min === max ? '구매제한 ' + min + '개' : '구매제한 ' + min + '~' + max + '개',
    min,
    max,
    optionCount: values.length,
    values: unique.slice(0, 8)
  };
}

async function fetchStockSnapshots(products, opts) {
  opts = opts || {};
  const limit = parseIntBounded(opts.limit, products.length, 1, 250);
  const batchSize = parseIntBounded(opts.batchSize, 3, 1, 8);
  const delayMs = Number(opts.delayMs == null ? 120 : opts.delayMs);
  const deadlineMs = Number(opts.deadlineMs || 240000);
  const started = Date.now();
  const offset = parseIntBounded(opts.offset, 0, 0, Math.max(0, products.length - 1));
  const selected =
    products.length <= limit
      ? products.slice()
      : products.slice(offset).concat(products.slice(0, offset)).slice(0, limit);
  const results = [];

  for (let i = 0; i < selected.length; i += batchSize) {
    if (Date.now() - started > deadlineMs) break;
    const batch = selected.slice(i, i + batchSize);
    const settled = await Promise.all(batch.map((p) => fetchStockSnapshot(p, opts)));
    results.push(...settled);
    if (i + batchSize < selected.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

function rankCollectionPlan(rank, slotIndex, priority) {
  if (priority && priority.due) {
    return {
      due: true,
      tier: priority.tier || 'priority-sales-revenue',
      everyRuns: 1,
      reason: priority.reason || 'sales/revenue top item: every run'
    };
  }
  const r = Number(rank) || 9999;
  if (r <= 30) {
    return { due: true, tier: 'rank-1-30', everyRuns: 1, reason: 'top 30: every run' };
  }
  if (r <= 60) {
    return {
      due: slotIndex % 2 === 0,
      tier: 'rank-31-60',
      everyRuns: 2,
      reason: 'rank 31-60: every 2 runs'
    };
  }
  if (r <= 90) {
    return {
      due: slotIndex % 3 === 0,
      tier: 'rank-61-90',
      everyRuns: 3,
      reason: 'rank 61-90: every 3 runs'
    };
  }
  if (r <= 100) {
    return {
      due: slotIndex % 4 === 0,
      tier: 'rank-91-100',
      everyRuns: 4,
      reason: 'rank 91-100: every 4 runs'
    };
  }
  return { due: false, tier: 'out-100', everyRuns: 0, reason: 'out of top 100' };
}

function dailyRankCollectionPlan(rank) {
  const limit = configuredTopTrackLimit();
  const r = Number(rank) || 9999;
  if (r <= limit) {
    return {
      due: true,
      tier: 'daily-top-' + limit,
      everyRuns: 1,
      reason: 'top ' + limit + ': once per KST day'
    };
  }
  return { due: false, tier: 'out-' + limit, everyRuns: 0, reason: 'out of top ' + limit };
}

function markPriority(map, row, type, rank) {
  if (!row || !row.goodsNo) return;
  const current = map[row.goodsNo] || {
    due: true,
    tier: 'priority-sales-revenue',
    labels: []
  };
  current[type + 'Rank'] = rank;
  current.labels.push((type === 'sales' ? 'sales' : 'revenue') + ' top ' + rank);
  current.reason = current.labels.join(' + ') + ': every run';
  map[row.goodsNo] = current;
}

function buildCollectionPriorityMap(store) {
  const map = {};
  const rows = computeEstimates(store, { windowMs: DAY_MS, maxChartPoints: 12 });
  const salesLimit = parseIntBounded(
    process.env.HOT_RANK_PRIORITY_SALES_LIMIT,
    DEFAULT_PRIORITY_SALES_LIMIT,
    0,
    100
  );
  const revenueLimit = parseIntBounded(
    process.env.HOT_RANK_PRIORITY_REVENUE_LIMIT,
    DEFAULT_PRIORITY_REVENUE_LIMIT,
    0,
    100
  );

  rows
    .filter((row) => Number(row.dailyEstimatedSales) > 0)
    .slice()
    .sort((a, b) => {
      if (b.dailyEstimatedSales !== a.dailyEstimatedSales) {
        return b.dailyEstimatedSales - a.dailyEstimatedSales;
      }
      return (a.rank || 9999) - (b.rank || 9999);
    })
    .slice(0, salesLimit)
    .forEach((row, idx) => markPriority(map, row, 'sales', idx + 1));

  rows
    .filter((row) => Number(row.dailyEstimatedRevenue) > 0)
    .slice()
    .sort((a, b) => {
      if (b.dailyEstimatedRevenue !== a.dailyEstimatedRevenue) {
        return b.dailyEstimatedRevenue - a.dailyEstimatedRevenue;
      }
      if (b.dailyEstimatedSales !== a.dailyEstimatedSales) {
        return b.dailyEstimatedSales - a.dailyEstimatedSales;
      }
      return (a.rank || 9999) - (b.rank || 9999);
    })
    .slice(0, revenueLimit)
    .forEach((row, idx) => markPriority(map, row, 'revenue', idx + 1));

  return map;
}

function isStaleForPlan(item, plan, decision, nowMs) {
  if (!item || !plan || plan.due || !plan.everyRuns) return false;
  const intervalMs = Math.max(1, Number((decision && decision.intervalMinutes) || 15)) * MINUTE_MS;
  const maxAgeMs = Math.max(1, Number(plan.everyRuns)) * intervalMs + COLLECTION_STALE_GRACE_MS;
  const lastStockedMs = Date.parse(item.lastStockedAt || 0) || 0;
  const lastAttemptMs = Date.parse(item.lastStockAttemptAt || 0) || 0;

  if (!lastStockedMs) return true;
  if (nowMs - lastStockedMs > maxAgeMs) return true;
  if (item.lastStockOk === false && (!lastAttemptMs || nowMs - lastAttemptMs > COLLECTION_STALE_GRACE_MS)) {
    return true;
  }
  return false;
}

function staleRetryPlan(plan) {
  return Object.assign({}, plan, {
    due: true,
    tier: plan.tier + '-retry',
    reason: plan.reason + '; stale or failed previous stock snapshot retry'
  });
}

function collectionSlotIndex(decision) {
  const kst = decision && decision.kst ? decision.kst : kstParts(new Date());
  const interval = Math.max(1, Number((decision && decision.intervalMinutes) || 15));
  return Math.floor(((Number(kst.hour) || 0) * 60 + (Number(kst.minute) || 0)) / interval);
}

function successfulDailyRun(run) {
  const minimumOk = parseIntBounded(process.env.HOT_RANK_DAILY_MIN_STOCK_OK, 10, 1, 100);
  const stockCount = Number(run && run.stockCount) || 0;
  const stockOkCount = Number(run && run.stockOkCount) || 0;
  return stockCount > 0 && stockOkCount >= Math.min(minimumOk, stockCount);
}

function hasRunForCollectionSlot(store, decision, slotIndex) {
  const dailyKey = decision && decision.kst && decision.kst.isoDate;
  const mode = decision && decision.mode;
  const dailyMode = isDailyScheduleMode(decision);
  const runs = Array.isArray(store && store.runs) ? store.runs : [];
  return runs.some((run) => {
    if (!run) return false;
    if (dailyMode) {
      if (!successfulDailyRun(run)) return false;
      const runDay = run.dailyKey || kstDateKey(run.ts);
      return runDay && dailyKey && runDay === dailyKey;
    } else if (run.mode !== mode) return false;
    if (Number(run.collectionSlot) !== Number(slotIndex)) return false;
    const runDay = run.dailyKey || kstDateKey(run.ts);
    return runDay && dailyKey && runDay === dailyKey;
  });
}

function runDayMatches(run, dailyKey) {
  const runDay = run && (run.dailyKey || kstDateKey(run.ts));
  return !!(runDay && dailyKey && runDay === dailyKey);
}

function runHasType(run, type) {
  const raw = String(run && run.collectionType || '');
  if (raw) return raw.split('+').indexOf(type) >= 0;
  if (type === 'stock' && run && run.stockCount > 0 && run.stockSlotIndex != null) return true;
  if (type === 'discovery' && run && Number(run.categoryRankingOkCount) > 0) return true;
  return false;
}

function successfulStockRun(run) {
  const minimumOk = parseIntBounded(process.env.HOT_RANK_DAILY_MIN_STOCK_OK, 10, 1, 100);
  const stockCount = Number(run && run.stockCount) || 0;
  const stockOkCount = Number(run && run.stockOkCount) || 0;
  return (
    runHasType(run, 'stock') &&
    stockCount > 0 &&
    stockOkCount >= Math.min(minimumOk, stockCount)
  );
}

function successfulDiscoveryRun(run) {
  const requested = Number(run && run.categoryRankingRequestedCount) || configuredCategoryIds().length;
  const minimumOk = parseIntBounded(
    process.env.HOT_RANK_MIN_CATEGORY_OK,
    requested,
    1,
    Math.max(1, requested)
  );
  return (
    runHasType(run, 'discovery') &&
    Number(run && run.rankingCount) > 0 &&
    Number(run && run.categoryRankingOkCount) >= Math.min(minimumOk, requested)
  );
}

function hasSuccessfulDiscoveryForDay(store, dailyKey) {
  const runs = Array.isArray(store && store.runs) ? store.runs : [];
  return runs.some((run) => runDayMatches(run, dailyKey) && successfulDiscoveryRun(run));
}

function hasSuccessfulStockForSlot(store, dailyKey, stockSlot) {
  if (!stockSlot) return false;
  const runs = Array.isArray(store && store.runs) ? store.runs : [];
  return runs.some(
    (run) =>
      runDayMatches(run, dailyKey) &&
      successfulStockRun(run) &&
      Number(run.stockSlotIndex) === Number(stockSlot.index)
  );
}

function hasSuccessfulHourlyCollectionForSlot(store, decision, stockSlot) {
  if (!stockSlot) return false;
  const dailyKey = decision && decision.kst && decision.kst.isoDate;
  const mode = decision && decision.mode;
  const runs = Array.isArray(store && store.runs) ? store.runs : [];
  return runs.some((run) => {
    if (!run || run.mode !== mode) return false;
    if (!runDayMatches(run, dailyKey)) return false;
    const runSlot =
      run.collectionSlot != null ? Number(run.collectionSlot) : Number(run.stockSlotIndex);
    if (runSlot !== Number(stockSlot.index)) return false;
    return runHasType(run, 'discovery') && Number(run.rankingCount) > 0 && successfulStockRun(run);
  });
}

function buildCollectorRunPlan(store, decision, now, opts) {
  opts = opts || {};
  const force = !!opts.force;
  const dailyKey = (decision && decision.kst && decision.kst.isoDate) || kstParts(now || new Date()).isoDate;
  if (isHourlyTopOnlyMode(decision)) {
    const stockSlot =
      (decision && decision.stockSlot) ||
      hourlyCollectionSlot((decision && decision.kst) || kstParts(now || new Date()));
    const slotDone = hasSuccessfulHourlyCollectionForSlot(store, decision, stockSlot);
    const discoveryDue = force || (!!(decision && decision.shouldRun) && !slotDone);
    const stockDue = !opts.skipStock && discoveryDue;
    const types = [];
    if (discoveryDue) types.push('discovery');
    if (stockDue) types.push('stock');
    return {
      shouldRun: force || discoveryDue || stockDue,
      collectionType: types.join('+') || 'none',
      discoveryDue,
      stockDue,
      dailyKey,
      stockSlot,
      stockTimesKst: (decision && decision.stockTimesKst) || [],
      discoveryDone: slotDone,
      stockDone: slotDone,
      hourlyDone: slotDone,
      topRankLimit: configuredTopTrackLimit(decision && decision.topRankLimit),
      activeWindowKst: decision && decision.activeWindowKst
    };
  }
  const stockTimes = parseStockCollectionTimes(process.env.HOT_RANK_STOCK_TIMES_KST);
  const stockSlot = latestDueStockSlot((decision && decision.kst) || kstParts(now || new Date()), stockTimes);
  const discoveryDone = hasSuccessfulDiscoveryForDay(store, dailyKey);
  const stockDone = hasSuccessfulStockForSlot(store, dailyKey, stockSlot);
  const discoveryDue = force || (!!(decision && decision.catchUpEligible) && !discoveryDone);
  const stockDue = !opts.skipStock && (force || (!!stockSlot && !stockDone));
  const types = [];
  if (discoveryDue) types.push('discovery');
  if (stockDue) types.push('stock');
  return {
    shouldRun: force || discoveryDue || stockDue,
    collectionType: types.join('+') || 'none',
    discoveryDue,
    stockDue,
    dailyKey,
    stockSlot: stockSlot || null,
    stockTimesKst: stockTimes.map((time) => time.label),
    discoveryDone,
    stockDone
  };
}

function storedProductToStockCandidate(item, dailyKey) {
  const limit = configuredTopTrackLimit();
  return {
    rank: 9999,
    sourceRank: item.previousRank || item.latestRank || 9999,
    goodsNo: item.goodsNo,
    goodsNumber: item.goodsNo,
    goodsName: item.goodsName || item.goodsNo,
    imageUrl: item.imageUrl || '',
    categoryNumber: item.categoryNumber || '',
    brandId: item.brandId || '',
    itemId: item.itemId || '',
    viewCount: item.latestViewCount || 0,
    source: 'hot-ranking-history',
    collectionTier: 'out-' + limit,
    collectionReason: 'out of top ' + limit + ': not tracked by hourly top mode',
    collectionEveryRuns: 0,
    collectionDate: dailyKey
  };
}

function selectAdaptiveStockProducts(rankingProducts, store, decision, now, opts) {
  opts = opts || {};
  const rawProducts = Array.isArray(rankingProducts) ? rankingProducts : [];
  const topRankLimit = configuredTopTrackLimit(decision && decision.topRankLimit);
  const slotIndex = collectionSlotIndex(decision);
  const dailyKey = ((decision && decision.kst && decision.kst.isoDate) || kstParts(now || new Date()).isoDate);
  if (isHourlyTopOnlyMode(decision)) {
    const tier = 'global-top-' + topRankLimit;
    const selected = rawProducts
      .slice(0, topRankLimit)
      .map((product, idx) => {
        const rank = Number(product && product.rank) || idx + 1;
        if (!product || !product.goodsNo || rank > topRankLimit) return null;
        return Object.assign({}, product, {
          rank,
          sourceRank: product.sourceRank || rank,
          collectionTier: tier,
          collectionReason:
            'overall top ' +
            topRankLimit +
            ': hourly stock snapshot during ' +
            ((decision && decision.activeWindowKst) || DEFAULT_HOURLY_ACTIVE_WINDOW_KST) +
            ' KST',
          collectionEveryRuns: 1,
          collectionDate: dailyKey,
          collectionSources: [tier],
          globalRank: rank
        });
      })
      .filter(Boolean);
    return {
      mode: 'hourly-top-' + topRankLimit + '-only',
      slotIndex,
      dailyKey,
      products: selected,
      selectedCount: selected.length,
      skippedRankingCount: Math.max(0, rawProducts.length - selected.length),
      outOfTopSelectedCount: 0,
      retrySelectedCount: 0,
      retrySkippedCount: 0,
      retryLimit: 0,
      maxCandidates: topRankLimit,
      topRankLimit,
      tierCounts: selected.length ? { [tier]: selected.length } : {},
      rules: [
        'overall view ranking top ' + topRankLimit + ' collected once per hour',
        'collection runs only during ' + ((decision && decision.activeWindowKst) || '08:00-01:00') + ' KST',
        'products outside top ' + topRankLimit + ' are not stock-tracked',
        'category and previous sales/revenue boosts are disabled in hourly top mode'
      ]
    };
  }
  const products = rawProducts.slice(0, 100);
  const maxCandidates = parseIntBounded(
    opts.stockCandidateLimit == null ? process.env.HOT_RANK_STOCK_CANDIDATE_LIMIT : opts.stockCandidateLimit,
    DEFAULT_STOCK_CANDIDATE_LIMIT,
    1,
    250
  );
  const categoryRankLimit = parseIntBounded(
    opts.categoryStockRankLimit == null
      ? process.env.HOT_RANK_CATEGORY_STOCK_RANK_LIMIT
      : opts.categoryStockRankLimit,
    DEFAULT_CATEGORY_STOCK_RANK_LIMIT,
    1,
    100
  );
  const tierCounts = {};
  const candidateMap = {};
  const rankingCache = (store && store.rankings) || {};
  const categoryRankings = rankingCache.categories || {};
  const priorityMap = buildCollectionPriorityMap(store);
  const retryLimit = parseIntBounded(
    opts.retryLimit == null ? process.env.HOT_RANK_RETRY_PER_RUN_LIMIT : opts.retryLimit,
    DEFAULT_RETRY_PER_RUN_LIMIT,
    0,
    50
  );
  let retrySelectedCount = 0;
  let retrySkippedCount = 0;

  function addCandidate(product, plan) {
    if (!product || !product.goodsNo) return;
    const gn = product.goodsNo;
    const current = candidateMap[gn];
    const base = current ? current.product : Object.assign({}, product);
    if (!current || plan.priority < current.priority) {
      base.rank = product.rank || base.rank || 9999;
      base.sourceRank = product.sourceRank || base.sourceRank || base.rank;
      base.goodsName = product.goodsName || base.goodsName || gn;
      base.imageUrl = product.imageUrl || base.imageUrl || '';
      base.categoryNumber = product.categoryNumber || base.categoryNumber || '';
      base.brandId = product.brandId || base.brandId || '';
      base.itemId = product.itemId || base.itemId || '';
      base.viewCount = Number(product.viewCount) || Number(base.viewCount) || 0;
      base.source = product.source || base.source || 'oliveyoung-view-rank';
    }
    base.collectionTier = !current || plan.priority < current.priority ? plan.tier : base.collectionTier;
    base.collectionReason = !current || plan.priority < current.priority ? plan.reason : base.collectionReason;
    base.collectionEveryRuns = plan.everyRuns || 1;
    base.collectionDate = dailyKey;
    base.collectionSources = Array.from(
      new Set((base.collectionSources || []).concat(plan.tier))
    ).slice(0, 8);
    if (plan.globalRank) base.globalRank = plan.globalRank;
    if (plan.categoryId) {
      base.categoryRanks = base.categoryRanks || {};
      base.categoryRanks[plan.categoryId] = plan.categoryRank || product.rank || 9999;
      base.bestCategoryRank = Math.min(
        Number(base.bestCategoryRank) || 9999,
        Number(plan.categoryRank || product.rank) || 9999
      );
    }
    candidateMap[gn] = {
      product: base,
      priority: current ? Math.min(current.priority, plan.priority) : plan.priority,
      firstPriority: current ? current.firstPriority : plan.priority
    };
  }

  products.forEach((product, idx) => {
    const rank = Number(product.rank) || idx + 1;
    if (rank > 100) return;
    addCandidate(product, {
      tier: 'global-top-100',
      everyRuns: 1,
      reason: 'overall top 100: stock snapshot up to 4 times per day',
      priority: rank,
      globalRank: rank
    });
  });

  Object.keys(categoryRankings).forEach((categoryId, categoryIdx) => {
    const ranking = categoryRankings[categoryId] || {};
    (Array.isArray(ranking.products) ? ranking.products : [])
      .slice(0, categoryRankLimit)
      .forEach((product, idx) => {
        const rank = Number(product.rank) || idx + 1;
        addCandidate(product, {
          tier: 'category-top-' + categoryRankLimit,
          everyRuns: 1,
          reason:
            'category top ' +
            categoryRankLimit +
            ': stock snapshot up to 4 times per day; lower category ranks skipped',
          priority: 1000 + rank * 10 + categoryIdx,
          categoryId,
          categoryRank: rank
        });
      });
  });

  Object.keys(priorityMap).forEach((goodsNo) => {
    const current = candidateMap[goodsNo];
    if (!current) return;
    const priority = priorityMap[goodsNo] || {};
    const boostRank = Math.min(
      Number(priority.salesRank) || 9999,
      Number(priority.revenueRank) || 9999
    );
    const boosted = Math.min(current.priority, 100 + boostRank);
    current.priority = boosted;
    current.product.collectionTier = current.product.collectionTier || 'priority-sales-revenue';
    current.product.collectionReason =
      (current.product.collectionReason || '') +
      '; previous 24h sales/revenue winner kept inside eligible top ranks';
    current.product.collectionSources = Array.from(
      new Set((current.product.collectionSources || []).concat('priority-sales-revenue'))
    ).slice(0, 8);
  });

  const candidates = Object.keys(candidateMap)
    .map((goodsNo) => candidateMap[goodsNo])
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a.product.goodsNo).localeCompare(String(b.product.goodsNo));
    });
  const selected = candidates.slice(0, maxCandidates).map((entry) => {
    const row = Object.assign({}, entry.product, {
      collectionDate: dailyKey
    });
    const tier = row.collectionTier || 'selected';
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    return row;
  });

  return {
    mode: 'daily-categories-selected-250',
    slotIndex,
    dailyKey,
    products: selected,
    selectedCount: selected.length,
    skippedRankingCount: Math.max(0, candidates.length - selected.length),
    outOfTopSelectedCount: 0,
    retrySelectedCount,
    retrySkippedCount,
    retryLimit,
    maxCandidates,
    categoryRankLimit,
    tierCounts,
    rules: [
      'category top 100 lists collected once per KST day',
      'stock snapshots run up to 4 times per KST day',
      'stock snapshot candidates capped at ' + maxCandidates,
      'overall top 100 is eligible',
      'category ranks 1-' + categoryRankLimit + ' are eligible',
      'out of top 100 and lower category ranks are not stock-measured'
    ]
  };
}

function emptyStore() {
  return {
    version: 1,
    updatedAt: null,
    lastRunAt: null,
    products: {},
    runs: []
  };
}

async function readStore() {
  const result = await get(BLOB_PATH, { access: 'private', useCache: false }).catch((e) => {
    if (e && (e.name === 'BlobNotFoundError' || /not found/i.test(e.message || ''))) {
      return null;
    }
    throw e;
  });
  if (!result || !result.stream) return emptyStore();
  if (result.statusCode && result.statusCode !== 200) return emptyStore();
  const text = await streamToText(result.stream);
  if (!text) return emptyStore();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : emptyStore();
  } catch (_) {
    return emptyStore();
  }
}

async function writeStore(store) {
  return put(BLOB_PATH, JSON.stringify(store), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

function normalizeRankingCacheEntry(ranking, fallbackCategoryId) {
  const limit = configuredTopTrackLimit();
  return {
    categoryId: fallbackCategoryId || (ranking && ranking.categoryId) || '',
    updatedAt: (ranking && ranking.updatedAt) || new Date().toISOString(),
    products: (Array.isArray(ranking && ranking.products) ? ranking.products : [])
      .map(compactRankingProduct)
      .filter((product) => product.goodsNo)
      .slice(0, limit)
  };
}

function mergeRankingCache(store, ranking, categoryRankings, nowIso) {
  store.rankings = store.rankings || {};
  store.rankings.updatedAt = nowIso || new Date().toISOString();
  store.rankings.global = normalizeRankingCacheEntry(ranking, '');
  store.rankings.categories = store.rankings.categories || {};
  const cats = categoryRankings && categoryRankings.categories ? categoryRankings.categories : {};
  Object.keys(cats).forEach((categoryId) => {
    store.rankings.categories[categoryId] = normalizeRankingCacheEntry(cats[categoryId], categoryId);
  });
  store.rankings.categoryRequestedCount =
    categoryRankings && categoryRankings.requestedCount != null
      ? categoryRankings.requestedCount
      : store.rankings.categoryRequestedCount || configuredCategoryIds().length;
  store.rankings.categoryOkCount =
    categoryRankings && categoryRankings.okCount != null
      ? categoryRankings.okCount
      : store.rankings.categoryOkCount || Object.keys(store.rankings.categories).length;
  store.rankings.categoryErrors =
    categoryRankings && Array.isArray(categoryRankings.errors)
      ? categoryRankings.errors.slice(0, 20)
      : store.rankings.categoryErrors || [];
  return store;
}

function rankingFromStore(store, size) {
  const cached = store && store.rankings && store.rankings.global;
  const products = cached && Array.isArray(cached.products) ? cached.products : [];
  return {
    updatedAt: (cached && cached.updatedAt) || (store && (store.updatedAt || store.lastRunAt)) || new Date().toISOString(),
    categoryId: '',
    products: products.slice(0, size || configuredTopTrackLimit()).map(compactRankingProduct)
  };
}

function cloneStoreWithRankingCache(store, ranking, categoryRankings, nowIso) {
  const cloned = JSON.parse(JSON.stringify(store || emptyStore()));
  return mergeRankingCache(cloned, ranking, categoryRankings, nowIso);
}

function pruneStore(store, nowMs) {
  const keepObsMs = parseIntBounded(process.env.HOT_RANK_HISTORY_DAYS, 35, 1, 35) * DAY_MS;
  const keepProductMs = parseIntBounded(process.env.HOT_RANK_PRODUCT_KEEP_DAYS, 35, 7, 370) * DAY_MS;
  const keepRunsMs = parseIntBounded(process.env.HOT_RANK_RUN_HISTORY_DAYS, 30, 1, 370) * DAY_MS;
  const products = store.products || {};
  Object.keys(products).forEach((gn) => {
    const item = products[gn];
    item.observations = (Array.isArray(item.observations) ? item.observations : []).filter(
      (o) => o && nowMs - Date.parse(o.ts) <= keepObsMs
    );
    item.rankObservations = (Array.isArray(item.rankObservations) ? item.rankObservations : []).filter(
      (o) => o && nowMs - Date.parse(o.ts) <= keepObsMs && rankObservationMatchesAdaptiveCadence(o)
    );
    const outOfTopMs = Date.parse(item.outOfTopSince || 0) || 0;
    if (item.currentlyRanked === false && outOfTopMs && nowMs - outOfTopMs > keepProductMs) {
      delete products[gn];
      return;
    }
    if (!item.observations.length && nowMs - Date.parse(item.lastSeenAt || 0) > keepProductMs) {
      delete products[gn];
    }
  });
  store.runs = (Array.isArray(store.runs) ? store.runs : [])
    .filter((r) => r && nowMs - Date.parse(r.ts) <= keepRunsMs)
    .slice(-3000);
  store.products = products;
}

function getSalesStats(obs) {
  let sold = 0;
  let dropEvents = 0;
  let restocked = 0;
  let restockEvents = 0;
  for (let i = 1; i < obs.length; i++) {
    const prev = Number(obs[i - 1].total) || 0;
    const curr = Number(obs[i].total) || 0;
    const delta = curr - prev;
    if (delta < 0) {
      sold += Math.abs(delta);
      dropEvents += 1;
    } else if (delta > 0) {
      restocked += delta;
      restockEvents += 1;
    }
  }
  return { sold, dropEvents, restocked, restockEvents };
}

function dropLeadingZeroStockObservations(obs) {
  const rows = Array.isArray(obs) ? obs : [];
  const firstPositiveIndex = rows.findIndex((o) => Number(o && o.total) > 0);
  if (firstPositiveIndex > 0) return rows.slice(firstPositiveIndex);
  return rows;
}

function windowObservationsWithBaseline(obs, startMs, endMs) {
  const rows = (Array.isArray(obs) ? obs : [])
    .filter((o) => o && o.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  let baseline = null;
  const inside = [];
  rows.forEach((o) => {
    const ts = Date.parse(o.ts);
    if (!Number.isFinite(ts) || ts > endMs) return;
    if (ts < startMs) {
      baseline = o;
      return;
    }
    inside.push(o);
  });
  if (!baseline) return inside;
  const alignedBaseline = Object.assign({}, baseline, {
    ts: new Date(startMs).toISOString(),
    originalTs: baseline.ts,
    windowBaseline: true
  });
  return [alignedBaseline].concat(inside);
}

function rankObservationMatchesAdaptiveCadence(observation) {
  if (!observation || !observation.ts) return false;
  const ts = new Date(observation.ts);
  if (Number.isNaN(ts.getTime())) return false;
  const decision = getScheduleDecision(ts);
  if (isHourlyTopOnlyMode(decision) || isDailyScheduleMode(decision)) {
    return (Number(observation.rank) || 9999) <= configuredTopTrackLimit(decision.topRankLimit);
  }
  const slotIndex = collectionSlotIndex(decision);
  const rank = Number(observation.rank) || 9999;
  return rankCollectionPlan(rank, slotIndex).due;
}

function compactChartPoints(points, maxPoints) {
  const clean = (points || [])
    .filter((p) => p && p.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (clean.length <= maxPoints) return clean;
  const firstMs = Date.parse(clean[0].ts);
  const lastMs = Date.parse(clean[clean.length - 1].ts);
  const span = Math.max(1, lastMs - firstMs);
  const buckets = [];
  clean.forEach((p) => {
    const idx = Math.min(maxPoints - 1, Math.floor(((Date.parse(p.ts) - firstMs) / span) * maxPoints));
    buckets[idx] = p;
  });
  return buckets.filter(Boolean);
}

function kstDateKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return kstParts(d).isoDate;
}

function buildChartSeries(obs, opts) {
  opts = opts || {};
  const maxPoints = parseIntBounded(opts.maxPoints, 72, 12, 160);
  const stock = (obs || [])
    .filter((o) => o && o.ts)
    .map((o) => ({
      ts: o.ts,
      total: Number(o.total) || 0,
      stockTotal: Number(o.total) || 0,
      price: parseMoney(o.price) || parseMoney(opts.price),
      viewCount: Number(o.viewCount) || 0,
      rank: Number(o.rank) || 9999
    }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const viewByTs = {};
  stock.forEach((o) => {
    if (o && o.ts && Number(o.viewCount) > 0) {
      viewByTs[o.ts] = {
        ts: o.ts,
        viewCount: Number(o.viewCount) || 0,
        rank: Number(o.rank) || 9999
      };
    }
  });
  (Array.isArray(opts.viewObs) ? opts.viewObs : []).forEach((o) => {
    if (o && o.ts && Number(o.viewCount) > 0) {
      viewByTs[o.ts] = {
        ts: o.ts,
        viewCount: Number(o.viewCount) || 0,
        rank: Number(o.rank) || 9999
      };
    }
  });
  const viewSource = Object.keys(viewByTs)
    .map((ts) => viewByTs[ts])
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const stockSeries = stock.map((p, idx) => {
    const delta = idx ? p.total - stock[idx - 1].total : 0;
    return {
      ts: p.ts,
      total: p.total,
      stockTotal: p.total,
      delta,
      stockDelta: delta
    };
  });

  let cumulativeSales = 0;
  let cumulativeRevenue = 0;
  const salesRevenue = stock.map((p, idx) => {
    const stockDelta = idx ? p.total - stock[idx - 1].total : 0;
    const salesDelta = stockDelta < 0 ? Math.abs(stockDelta) : 0;
    const revenueDelta = salesDelta * (p.price || parseMoney(opts.price));
    cumulativeSales += salesDelta;
    cumulativeRevenue += revenueDelta;
    return {
      ts: p.ts,
      sales: cumulativeSales,
      salesDelta,
      revenue: cumulativeRevenue,
      revenueDelta,
      stockTotal: p.total,
      stockDelta
    };
  });

  const viewSeries = viewSource.map((p, idx) => ({
    ts: p.ts,
    viewCount: p.viewCount,
    rank: p.rank,
    prevRank: idx ? viewSource[idx - 1].rank : p.rank,
    rankDelta: idx ? p.rank - viewSource[idx - 1].rank : 0
  }));

  return {
    stock: compactChartPoints(stockSeries, maxPoints),
    view: compactChartPoints(viewSeries, maxPoints),
    sales: compactChartPoints(salesRevenue.map((p) => Object.assign({}, p)), maxPoints),
    revenue: compactChartPoints(salesRevenue.map((p) => Object.assign({}, p)), maxPoints)
  };
}

function latestChartValueAt(points, tsMs, valueKey) {
  let value = 0;
  const list = Array.isArray(points) ? points : [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !p.ts) continue;
    if (Date.parse(p.ts) <= tsMs) {
      value = Number(p[valueKey]) || 0;
    } else {
      break;
    }
  }
  return value;
}

function latestChartPointAt(points, tsMs) {
  let latest = null;
  const list = Array.isArray(points) ? points : [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !p.ts) continue;
    if (Date.parse(p.ts) <= tsMs) {
      latest = p;
    } else {
      break;
    }
  }
  return latest;
}

function buildRankTrend(currentRank, previousRank, previousTs) {
  const current = Number(currentRank) || 9999;
  const previous = Number(previousRank) || 0;
  if (current >= 9999) return null;
  if (!previous || previous >= 9999) {
    return {
      status: 'entry',
      direction: 'entry',
      label: '진입',
      currentRank: current,
      previousRank: null,
      delta: null,
      absDelta: null,
      isBig: true,
      basisMinutes: 60,
      previousTs: previousTs || null
    };
  }

  const delta = previous - current;
  const absDelta = Math.abs(delta);
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return {
    status: direction,
    direction,
    label: direction === 'up' ? '▲' + absDelta : direction === 'down' ? '▼' + absDelta : '보합',
    currentRank: current,
    previousRank: previous,
    delta,
    absDelta,
    isBig: absDelta >= 10,
    basisMinutes: 60,
    previousTs: previousTs || null
  };
}

function assignRankTrends(rows, nowMs) {
  const cutoffMs = nowMs - 60 * 60 * 1000;
  const previousSales = [];
  const previousRevenue = [];

  rows.forEach((row) => {
    const viewPoint = latestChartPointAt(row.viewChart, cutoffMs);
    row.rankTrends = {
      view: buildRankTrend(row.rank, viewPoint && viewPoint.rank, viewPoint && viewPoint.ts)
    };

    const salesPoint = latestChartPointAt(row.salesChart, cutoffMs);
    const sales = salesPoint ? Number(salesPoint.sales) || 0 : 0;
    if (sales > 0) {
      previousSales.push({
        goodsNo: row.goodsNo,
        value: sales,
        rank: row.rank || 9999,
        ts: salesPoint.ts
      });
    }

    const revenuePoint = latestChartPointAt(row.revenueChart, cutoffMs);
    const revenue = revenuePoint ? Number(revenuePoint.revenue) || 0 : 0;
    if (revenue > 0) {
      previousRevenue.push({
        goodsNo: row.goodsNo,
        value: revenue,
        sales,
        rank: row.rank || 9999,
        ts: revenuePoint.ts
      });
    }
  });

  const previousSalesRank = {};
  previousSales
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return (a.rank || 9999) - (b.rank || 9999);
    })
    .forEach((row, idx) => {
      previousSalesRank[row.goodsNo] = { rank: idx + 1, ts: row.ts };
    });

  const previousRevenueRank = {};
  previousRevenue
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      if (b.sales !== a.sales) return b.sales - a.sales;
      return (a.rank || 9999) - (b.rank || 9999);
    })
    .forEach((row, idx) => {
      previousRevenueRank[row.goodsNo] = { rank: idx + 1, ts: row.ts };
    });

  rows.forEach((row) => {
    const salesPrev = previousSalesRank[row.goodsNo];
    const revenuePrev = previousRevenueRank[row.goodsNo];
    row.rankTrends.sales =
      Number(row.dailyEstimatedSales || 0) > 0
        ? buildRankTrend(row.salesRank, salesPrev && salesPrev.rank, salesPrev && salesPrev.ts)
        : null;
    row.rankTrends.revenue =
      Number(row.dailyEstimatedRevenue || 0) > 0
        ? buildRankTrend(row.revenueRank, revenuePrev && revenuePrev.rank, revenuePrev && revenuePrev.ts)
        : null;
  });
}

function rankRowsAt(rows, tsMs, chartKey, valueKey) {
  return rows
    .map((row) => ({
      goodsNo: row.goodsNo,
      value: latestChartValueAt(row[chartKey], tsMs, valueKey),
      rank: row.rank || 9999
    }))
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return (a.rank || 9999) - (b.rank || 9999);
    })
    .reduce((map, row, idx) => {
      map[row.goodsNo] = idx + 1;
      return map;
    }, {});
}

function enrichChartRanks(rows) {
  rows.forEach((row) => {
    const viewChart = Array.isArray(row.viewChart) ? row.viewChart : [];
    viewChart.forEach((point, idx) => {
      const prevRank = idx ? Number(viewChart[idx - 1].rank) || Number(point.rank) || 9999 : Number(point.prevRank || point.rank) || 9999;
      point.prevRank = prevRank;
      point.rankLabel = '조회순';
    });
  });

  rows.forEach((row) => {
    const salesChart = Array.isArray(row.salesChart) ? row.salesChart : [];
    salesChart.forEach((point, idx) => {
      const rankMap = rankRowsAt(rows, Date.parse(point.ts), 'salesChart', 'sales');
      point.rank = rankMap[row.goodsNo] || row.salesRank || 9999;
      point.prevRank =
        idx && salesChart[idx - 1]
          ? Number(salesChart[idx - 1].rank) || Number(point.rank) || 9999
          : Number(point.rank) || 9999;
      point.rankLabel = '판매순';
    });

    const revenueChart = Array.isArray(row.revenueChart) ? row.revenueChart : [];
    revenueChart.forEach((point, idx) => {
      const rankMap = rankRowsAt(rows, Date.parse(point.ts), 'revenueChart', 'revenue');
      point.rank = rankMap[row.goodsNo] || row.revenueRank || 9999;
      point.prevRank =
        idx && revenueChart[idx - 1]
          ? Number(revenueChart[idx - 1].rank) || Number(point.rank) || 9999
          : Number(point.rank) || 9999;
      point.rankLabel = '매출순';
    });
  });
}

function shouldRecordRankObservation(product, idx, meta) {
  if (meta && /^hourly-top-\d+-only$/.test(String(meta.collectionMode || ''))) {
    const limit = configuredTopTrackLimit();
    const rank = Number(product && product.rank) || idx + 1;
    return rank <= limit;
  }
  if (!meta || meta.collectionMode !== 'adaptive-rank-tier') return true;
  const slotIndex = Number(meta.collectionSlot);
  if (!Number.isFinite(slotIndex)) return true;
  const rank = Number(product && product.rank) || idx + 1;
  return rankCollectionPlan(rank, slotIndex).due;
}

function recordRankObservation(item, product, nowIso) {
  item.rankObservations = Array.isArray(item.rankObservations) ? item.rankObservations : [];
  const rank = Number(product && product.rank) || 9999;
  const viewCount = Number(product && product.viewCount) || 0;
  const last = item.rankObservations[item.rankObservations.length - 1];
  if (
    !last ||
    last.rank !== rank ||
    last.viewCount !== viewCount ||
    Date.parse(nowIso) - Date.parse(last.ts) > 60 * 1000
  ) {
    item.rankObservations.push({ ts: nowIso, rank, viewCount });
  } else {
    last.rank = rank;
    last.viewCount = viewCount;
  }
}

function applyStockSnapshotToItem(item, stock, product, meta) {
  if (!stock) return;
  const nowIso = meta.nowIso;
  const rank = Number((product && product.rank) || stock.rank || item.latestRank || 9999);
  const viewCount = Number((product && product.viewCount) || item.latestViewCount || 0);
  item.lastStockAttemptAt = nowIso;
  item.lastCollectionTier = stock.collectionTier || (product && product.collectionTier) || '';
  item.lastCollectionReason = stock.collectionReason || (product && product.collectionReason) || '';
  if (String(stock.collectionTier || '').indexOf('out-') === 0) {
    item.lastOutOfTopStockDate = stock.collectionDate || meta.dailyKey || '';
  }

  if (!stock.ok) {
    item.lastStockOk = false;
    item.lastStockMessage = stock.message || '';
    return;
  }

  item.goodsName = stock.goodsName || (product && product.goodsName) || item.goodsName || item.goodsNo;
  item.imageUrl = stock.imageUrl || (product && product.imageUrl) || item.imageUrl || '';
  item.latestTotal = stock.total;
  item.optionCount = stock.optionCount || item.optionCount || 0;
  item.hasToday = !!stock.hasToday;
  item.purchaseLimit = stock.purchaseLimit || item.purchaseLimit || null;
  item.price = stock.price || item.price || 0;
  item.originalPrice = stock.originalPrice || item.originalPrice || 0;
  item.discountRate = stock.discountRate || item.discountRate || 0;
  item.lastStockOk = !!stock.ok;
  item.lastStockedAt = nowIso;
  item.observations = Array.isArray(item.observations) ? item.observations : [];
  const last = item.observations[item.observations.length - 1];
  if (!last || last.total !== stock.total || Date.parse(nowIso) - Date.parse(last.ts) > 60 * 1000) {
    item.observations.push({
      ts: nowIso,
      total: stock.total,
      rank,
      viewCount,
      price: stock.price || item.price || 0,
      ok: !!stock.ok,
      optionCount: stock.optionCount || 0,
      collectionTier: stock.collectionTier || ''
    });
  } else {
    last.rank = rank;
    last.viewCount = viewCount;
    last.price = stock.price || last.price || item.price || 0;
    last.collectionTier = stock.collectionTier || last.collectionTier || '';
  }
}

function mergeRunIntoStore(store, ranking, stocks, meta) {
  const nowIso = (meta && meta.ts) || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const dailyKey = meta && meta.dailyKey ? meta.dailyKey : kstParts(new Date(nowIso)).isoDate;
  mergeRankingCache(store, ranking, meta && meta.categoryRankings, nowIso);
  const products = store.products || {};
  const stockByGoodsNo = {};
  (stocks || []).forEach((s) => {
    stockByGoodsNo[s.goodsNo] = s;
  });
  const stockProductByGoodsNo = {};
  (Array.isArray(meta && meta.stockProducts) ? meta.stockProducts : []).forEach((product) => {
    if (product && product.goodsNo) stockProductByGoodsNo[product.goodsNo] = product;
  });
  const rankingGoods = new Set((ranking.products || []).map((p) => p.goodsNo).filter(Boolean));
  const handledStocks = new Set();

  Object.keys(products).forEach((gn) => {
    const item = products[gn];
    if (!rankingGoods.has(gn)) {
      if (item.currentlyRanked !== false) {
        item.previousRank = item.latestRank || item.previousRank || 9999;
        item.outOfTopSince = item.outOfTopSince || nowIso;
      }
      item.latestRank = 9999;
      item.currentlyRanked = false;
    }
  });

  (ranking.products || []).forEach((product, idx) => {
    const stock = stockByGoodsNo[product.goodsNo];
    const item = products[product.goodsNo] || {
      goodsNo: product.goodsNo,
      observations: []
    };
    item.goodsName = (stock && stock.goodsName) || product.goodsName || item.goodsName || product.goodsNo;
    item.imageUrl = (stock && stock.imageUrl) || product.imageUrl || item.imageUrl || '';
    item.categoryNumber = product.categoryNumber || item.categoryNumber || '';
    item.brandId = product.brandId || item.brandId || '';
    item.itemId = product.itemId || item.itemId || '';
    item.latestRank = product.rank;
    item.latestViewCount = product.viewCount || 0;
    item.firstSeenAt = item.firstSeenAt || nowIso;
    item.lastSeenAt = nowIso;
    item.lastRankedAt = nowIso;
    item.currentlyRanked = true;
    item.outOfTopSince = null;
    if (shouldRecordRankObservation(product, idx, meta)) {
      recordRankObservation(item, product, nowIso);
    }

    applyStockSnapshotToItem(item, stock, product, { nowIso, dailyKey });
    if (stock) handledStocks.add(product.goodsNo);
    products[product.goodsNo] = item;
  });

  (stocks || []).forEach((stock) => {
    if (!stock || !stock.goodsNo || handledStocks.has(stock.goodsNo)) return;
    const item = products[stock.goodsNo] || {
      goodsNo: stock.goodsNo,
      observations: []
    };
    const candidate = stockProductByGoodsNo[stock.goodsNo] || storedProductToStockCandidate(item, dailyKey);
    item.goodsName = stock.goodsName || (candidate && candidate.goodsName) || item.goodsName || stock.goodsNo;
    item.imageUrl = stock.imageUrl || (candidate && candidate.imageUrl) || item.imageUrl || '';
    item.categoryNumber = (candidate && candidate.categoryNumber) || item.categoryNumber || '';
    item.brandId = (candidate && candidate.brandId) || item.brandId || '';
    item.itemId = (candidate && candidate.itemId) || item.itemId || '';
    if (candidate && candidate.categoryRanks) {
      item.categoryRanks = Object.assign({}, item.categoryRanks || {}, candidate.categoryRanks);
      item.bestCategoryRank = Math.min(
        Number(item.bestCategoryRank) || 9999,
        Number(candidate.bestCategoryRank) || 9999
      );
    }
    item.latestRank = 9999;
    item.currentlyRanked = false;
    item.outOfTopSince = item.outOfTopSince || nowIso;
    item.lastSeenAt = item.lastSeenAt || nowIso;
    applyStockSnapshotToItem(item, stock, candidate, {
      nowIso,
      dailyKey
    });
    products[stock.goodsNo] = item;
  });

  store.products = products;
  const stockOkCount = stocks.filter((s) => s.ok).length;
  store.updatedAt = nowIso;
  store.lastRunAt = nowIso;
  if (stockOkCount > 0) {
    store.lastStockRunAt = nowIso;
  }
  store.runs = (Array.isArray(store.runs) ? store.runs : []).concat({
    ts: nowIso,
    mode: meta && meta.mode,
    collectionType: meta && meta.collectionType,
    rankingCount: ranking.products.length,
    stockCount: stocks.length,
    stockOkCount,
    stockLimit: meta && meta.stockLimit,
    stockOffset: meta && meta.stockOffset,
    dailyKey,
    collectionMode: meta && meta.collectionMode,
    collectionSlot: meta && meta.collectionSlot,
    stockSlotIndex: meta && meta.stockSlotIndex,
    stockSlotLabel: meta && meta.stockSlotLabel,
    stockTimesKst: meta && meta.stockTimesKst,
    categoryRankingRequestedCount: meta && meta.categoryRankingRequestedCount,
    categoryRankingOkCount: meta && meta.categoryRankingOkCount,
    categoryRankingErrorCount: meta && meta.categoryRankingErrorCount,
    tierCounts: meta && meta.tierCounts,
    skippedRankingCount: meta && meta.skippedRankingCount,
    outOfTopSelectedCount: meta && meta.outOfTopSelectedCount,
    retrySelectedCount: meta && meta.retrySelectedCount,
    retrySkippedCount: meta && meta.retrySkippedCount,
    durationMs: meta && meta.durationMs
  });
  pruneStore(store, nowMs);
  return store;
}

function computeEstimates(store, opts) {
  opts = opts || {};
  const nowMs = Date.now();
  const windowMs = Number(opts.windowMs || 24 * 60 * 60 * 1000);
  const windowStartMs = nowMs - windowMs;
  const maxChartPoints = parseIntBounded(opts.maxChartPoints, 72, 12, 160);
  const products = (store && store.products) || {};
  const rows = [];

  Object.keys(products).forEach((gn) => {
    const item = products[gn];
    const rawObs = windowObservationsWithBaseline((Array.isArray(item.observations) ? item.observations : [])
      .filter(
        (o) =>
          o &&
          o.ok !== false &&
          (o.optionCount == null || Number(o.optionCount) > 0)
      )
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)), windowStartMs, nowMs);
    const obs = dropLeadingZeroStockObservations(rawObs);
    const viewObs = windowObservationsWithBaseline(
      (Array.isArray(item.rankObservations) ? item.rankObservations : [])
        .filter((o) => o && o.ts)
        .filter(rankObservationMatchesAdaptiveCadence)
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
      windowStartMs,
      nowMs
    );
    const stats = getSalesStats(obs);
    const first = obs[0] || null;
    const latest = obs[obs.length - 1] || null;
    const elapsedMs =
      first && latest ? Math.max(1, Date.parse(latest.ts) - Date.parse(first.ts)) : 0;
    const price = latestPriceForItem(item, obs);
    const perHour = elapsedMs > 0 ? stats.sold / (elapsedMs / 3600000) : 0;
    const estimatedRevenue = stats.sold * price;
    const charts = buildChartSeries(obs, { viewObs, maxPoints: maxChartPoints, price });
    const windowEstimatedSales = stats.sold;
    const windowEstimatedRevenue = estimatedRevenue;
    const confidence = stats.restockEvents > 0 ? 'low' : obs.length >= 2 ? 'normal' : 'pending';
    rows.push({
      goodsNo: gn,
      goodsName: item.goodsName || gn,
      imageUrl: item.imageUrl || '',
      categoryNumber: item.categoryNumber || '',
      brandId: item.brandId || '',
      itemId: item.itemId || '',
      rank: item.latestRank || 9999,
      viewCount: item.latestViewCount || 0,
      price,
      originalPrice: parseMoney(item.originalPrice),
      discountRate: Number(item.discountRate) || 0,
      estimatedSales: stats.sold,
      estimatedRevenue,
      windowEstimatedSales,
      windowEstimatedRevenue,
      dailyEstimatedSales: windowEstimatedSales,
      dailyEstimatedRevenue: windowEstimatedRevenue,
      fromTotal: first ? Number(first.total) || 0 : Number(item.latestTotal) || 0,
      toTotal: latest ? Number(latest.total) || 0 : Number(item.latestTotal) || 0,
      perHour,
      observationCount: obs.length,
      dropEvents: stats.dropEvents,
      restockUnits: stats.restocked,
      restockEvents: stats.restockEvents,
      restockAdjusted: stats.restockEvents > 0,
      confidence,
      confidenceLabel:
        confidence === 'low'
          ? '신뢰도 낮음'
          : confidence === 'pending'
            ? '측정 대기'
            : '신뢰도 보통',
      fromTs: first && first.ts,
      toTs: latest && latest.ts,
      optionCount: item.optionCount || 0,
      hasToday: !!item.hasToday,
      purchaseLimit: item.purchaseLimit || null,
      chart: charts.stock,
      viewChart: charts.view,
      salesChart: charts.sales,
      revenueChart: charts.revenue,
      score: stats.sold * 100000 + perHour * 1000 + Math.max(0, 1000 - (item.latestRank || 999))
    });
  });

  rows
    .slice()
    .sort((a, b) => {
      if (b.dailyEstimatedSales !== a.dailyEstimatedSales) {
        return b.dailyEstimatedSales - a.dailyEstimatedSales;
      }
      return (a.rank || 9999) - (b.rank || 9999);
    })
    .forEach((row, idx) => {
      row.salesRank = idx + 1;
    });

  rows
    .slice()
    .sort((a, b) => {
      if (b.dailyEstimatedRevenue !== a.dailyEstimatedRevenue) {
        return b.dailyEstimatedRevenue - a.dailyEstimatedRevenue;
      }
      if (b.dailyEstimatedSales !== a.dailyEstimatedSales) {
        return b.dailyEstimatedSales - a.dailyEstimatedSales;
      }
      return (a.rank || 9999) - (b.rank || 9999);
    })
    .forEach((row, idx) => {
      row.revenueRank = idx + 1;
    });

  enrichChartRanks(rows);
  assignRankTrends(rows, nowMs);

  return rows.sort((a, b) => {
    if (b.dailyEstimatedSales !== a.dailyEstimatedSales) {
      return b.dailyEstimatedSales - a.dailyEstimatedSales;
    }
    return (a.rank || 9999) - (b.rank || 9999);
  });
}

function kstParts(date) {
  const k = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: k.getUTCFullYear(),
    month: k.getUTCMonth() + 1,
    day: k.getUTCDate(),
    hour: k.getUTCHours(),
    minute: k.getUTCMinutes(),
    isoDate: k.toISOString().slice(0, 10)
  };
}

function parseBusyWindows(value) {
  return String(value || DEFAULT_BUSY_WINDOWS)
    .split(',')
    .map((part) => {
      const m = part.trim().match(/^(\d{1,2})-(\d{1,2})$/);
      if (!m) return null;
      return { start: Number(m[1]), end: Number(m[2]) };
    })
    .filter(Boolean);
}

function isBusyHour(hour, windows) {
  return windows.some((w) => {
    if (w.start === w.end) return true;
    if (w.start < w.end) return hour >= w.start && hour < w.end;
    return hour >= w.start || hour < w.end;
  });
}

function hourlyTopOnlyEnabled() {
  const raw = String(process.env.HOT_RANK_HOURLY_TOP_ONLY == null ? '1' : process.env.HOT_RANK_HOURLY_TOP_ONLY)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function dailyScheduleEnabled() {
  const raw = String(process.env.HOT_RANK_DAILY_ONLY == null ? '1' : process.env.HOT_RANK_DAILY_ONLY)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function hourLabel(hour) {
  return String(Math.max(0, Math.min(23, Number(hour) || 0))).padStart(2, '0') + ':00';
}

function parseHourlyActiveWindow(value) {
  const raw = String(value || DEFAULT_HOURLY_ACTIVE_WINDOW_KST).trim();
  const match = raw.match(/^(\d{1,2})(?::\d{1,2})?\s*-\s*(\d{1,2})(?::\d{1,2})?$/);
  const startHour = match ? Math.max(0, Math.min(23, Number(match[1]))) : 8;
  const endHour = match ? Math.max(0, Math.min(23, Number(match[2]))) : 1;
  return {
    startHour,
    endHour,
    label: hourLabel(startHour) + '-' + hourLabel(endHour)
  };
}

function isInHourlyActiveWindow(kst, activeWindow) {
  const hour = Number(kst && kst.hour) || 0;
  const start = Number(activeWindow && activeWindow.startHour) || 0;
  const end = Number(activeWindow && activeWindow.endHour) || 0;
  if (start === end) return true;
  if (start < end) return hour >= start && hour <= end;
  return hour >= start || hour <= end;
}

function hourlyCollectionSlot(kst) {
  const hour = Number(kst && kst.hour) || 0;
  return {
    hour,
    minute: 0,
    label: hourLabel(hour),
    minuteOfDay: hour * 60,
    index: hour
  };
}

function parseDailyCollectionTime(value) {
  const raw = String(value || DEFAULT_DAILY_COLLECTION_TIME_KST).trim();
  const match = raw.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  const hour = match ? Math.max(0, Math.min(23, Number(match[1]))) : 3;
  const minute = match ? Math.max(0, Math.min(59, Number(match[2] || 0))) : 0;
  return {
    hour,
    minute,
    label: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
  };
}

function parseStockCollectionTimes(value) {
  const rows = String(value || DEFAULT_STOCK_COLLECTION_TIMES_KST)
    .split(',')
    .map(parseDailyCollectionTime)
    .map((time) => ({
      hour: time.hour,
      minute: time.minute,
      label: time.label,
      minuteOfDay: time.hour * 60 + time.minute
    }))
    .sort((a, b) => a.minuteOfDay - b.minuteOfDay);
  const seen = {};
  return rows.filter((time) => {
    if (seen[time.label]) return false;
    seen[time.label] = true;
    return true;
  });
}

function latestDueStockSlot(kst, stockTimes) {
  const current = kst.hour * 60 + kst.minute;
  const due = (Array.isArray(stockTimes) ? stockTimes : [])
    .filter((time) => time.minuteOfDay <= current)
    .slice()
    .pop();
  if (!due) return null;
  return Object.assign({}, due, {
    index: stockTimes.findIndex((time) => time.label === due.label)
  });
}

function isInDailyCollectionWindow(kst, dailyTime, graceMinutes) {
  const current = kst.hour * 60 + kst.minute;
  const target = dailyTime.hour * 60 + dailyTime.minute;
  const delta = (current - target + 24 * 60) % (24 * 60);
  return delta < graceMinutes;
}

function isAtOrAfterDailyCollectionTime(kst, dailyTime) {
  const current = kst.hour * 60 + kst.minute;
  const target = dailyTime.hour * 60 + dailyTime.minute;
  return current >= target;
}

function isDailyScheduleMode(decision) {
  return !!(decision && typeof decision.mode === 'string' && decision.mode.indexOf('daily-') === 0);
}

function isHourlyTopOnlyMode(decision) {
  return !!(decision && typeof decision.mode === 'string' && decision.mode.indexOf('hourly-top-') === 0);
}

function scheduleSkipReason(decision) {
  if (isHourlyTopOnlyMode(decision)) {
    if (!decision.inActiveWindow) {
      return 'outside hourly TOP collection window';
    }
    return 'waiting for hourly collection minute';
  }
  return isDailyScheduleMode(decision)
    ? 'waiting for daily collection time'
    : 'waiting for scheduled collection interval';
}

function getScheduleDecision(date) {
  const kst = kstParts(date || new Date());
  const windows = parseBusyWindows(process.env.HOT_RANK_BUSY_WINDOWS_KST);
  if (hourlyTopOnlyEnabled()) {
    const topRankLimit = configuredTopTrackLimit();
    const activeWindow = parseHourlyActiveWindow(process.env.HOT_RANK_ACTIVE_WINDOW_KST);
    const graceMinutes = parseIntBounded(
      process.env.HOT_RANK_HOURLY_GRACE_MINUTES,
      DEFAULT_HOURLY_COLLECTION_GRACE_MINUTES,
      1,
      30
    );
    const inActiveWindow = isInHourlyActiveWindow(kst, activeWindow);
    const inCollectionMinute = kst.minute < graceMinutes;
    const stockSlot = hourlyCollectionSlot(kst);
    return {
      shouldRun: inActiveWindow && inCollectionMinute,
      mode:
        'hourly-top-' +
        topRankLimit +
        '-' +
        activeWindow.label.replace(/:/g, '').replace('-', '-') +
        '-kst',
      intervalMinutes: 60,
      kst,
      topRankLimit,
      activeWindowKst: activeWindow.label,
      graceMinutes,
      inActiveWindow,
      inCollectionMinute,
      catchUpEligible: inActiveWindow && inCollectionMinute,
      stockSlot,
      stockTimesKst: [activeWindow.label + ' 매시'],
      busyWindows: windows
        .map((w) => String(w.start).padStart(2, '0') + '-' + String(w.end).padStart(2, '0'))
        .join(',')
    };
  }
  if (dailyScheduleEnabled()) {
    const dailyTime = parseDailyCollectionTime(process.env.HOT_RANK_DAILY_TIME_KST);
    const stockTimes = parseStockCollectionTimes(process.env.HOT_RANK_STOCK_TIMES_KST);
    const latestStockSlot = latestDueStockSlot(kst, stockTimes);
    const graceMinutes = parseIntBounded(
      process.env.HOT_RANK_DAILY_GRACE_MINUTES,
      DEFAULT_DAILY_COLLECTION_GRACE_MINUTES,
      1,
      60
    );
    const inPreferredWindow = isInDailyCollectionWindow(kst, dailyTime, graceMinutes);
    const catchUpEligible = isAtOrAfterDailyCollectionTime(kst, dailyTime);
    return {
      shouldRun: catchUpEligible,
      mode: 'daily-' + dailyTime.label + '-kst',
      intervalMinutes: 24 * 60,
      kst,
      dailyTimeKst: dailyTime.label,
      graceMinutes,
      inPreferredWindow,
      catchUpEligible,
      stockTimesKst: stockTimes.map((time) => time.label),
      stockSlot: latestStockSlot,
      busyWindows: windows
        .map((w) => String(w.start).padStart(2, '0') + '-' + String(w.end).padStart(2, '0'))
        .join(',')
    };
  }
  const busy = isBusyHour(kst.hour, windows);
  const busyInterval = parseIntBounded(
    process.env.HOT_RANK_BUSY_INTERVAL_MINUTES,
    DEFAULT_BUSY_INTERVAL_MINUTES,
    15,
    60
  );
  const quietInterval = parseIntBounded(
    process.env.HOT_RANK_QUIET_INTERVAL_MINUTES,
    DEFAULT_QUIET_INTERVAL_MINUTES,
    30,
    180
  );
  const intervalMinutes = busy ? busyInterval : quietInterval;
  const shouldRun = kst.minute % intervalMinutes === 0;
  return {
    shouldRun,
    mode: busy ? 'busy-' + busyInterval + 'm' : 'quiet-' + quietInterval + 'm',
    intervalMinutes,
    kst,
    busyWindows: windows
      .map((w) => String(w.start).padStart(2, '0') + '-' + String(w.end).padStart(2, '0'))
      .join(',')
  };
}

async function runCollector(opts) {
  opts = opts || {};
  const started = Date.now();
  const now = new Date();
  const decision = getScheduleDecision(now);
  const force = !!opts.force;
  const dryRun = !!opts.dryRun;

  if (!force && !decision.shouldRun) {
    return {
      success: true,
      skipped: true,
      reason: scheduleSkipReason(decision),
      schedule: decision
    };
  }

  if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN) {
    return {
      success: true,
      skipped: true,
      reason: 'BLOB_READ_WRITE_TOKEN missing: persistent collection is disabled',
      schedule: decision
    };
  }

  const size = parseIntBounded(opts.size, configuredTopTrackLimit(), 1, 200);
  let store = emptyStore();
  let blob = null;
  if (!dryRun) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN is required for persistent hot ranking history');
    }
    store = await readStore();
  }

  let runPlan = buildCollectorRunPlan(store, decision, now, opts);
  if (!force && !runPlan.shouldRun) {
    return {
      success: true,
      skipped: true,
      reason: 'category list and stock snapshot slots are already current',
      schedule: decision,
      runPlan,
      collectionPlan: {
        mode: 'up-to-date',
        slotIndex: runPlan.stockSlot ? runPlan.stockSlot.index : null,
        dailyKey: runPlan.dailyKey,
        selectedCount: 0,
        tierCounts: {}
      },
      updatedAt: store.updatedAt || store.lastRunAt || null,
      lastRunAt: store.lastRunAt || null,
      lastStockRunAt: store.lastStockRunAt || null,
      durationMs: Date.now() - started
    };
  }

  let ranking;
  let categoryRankings = null;
  const nowIso = now.toISOString();
  if (runPlan.discoveryDue) {
    ranking = await fetchViewRanking(size);
    if (!isHourlyTopOnlyMode(decision)) {
      categoryRankings = await fetchCategoryRankings(100, {
        categoryIds: opts.categoryIds,
        batchSize: opts.categoryBatchSize
      });
    }
  } else {
    ranking = rankingFromStore(store, size);
    if (!ranking.products.length) {
      ranking = await fetchViewRanking(size);
    }
  }
  const selectionStore = categoryRankings
    ? cloneStoreWithRankingCache(store, ranking, categoryRankings, nowIso)
    : store;

  const batchSize = parseIntBounded(
    opts.batchSize == null ? process.env.HOT_RANK_STOCK_BATCH_SIZE : opts.batchSize,
    5,
    1,
    8
  );
  const delayMs = Number(
    opts.delayMs == null ? process.env.HOT_RANK_STOCK_BATCH_DELAY_MS || 60 : opts.delayMs
  );
  const legacyOverride =
    opts.stockLimit != null ||
    opts.stockOffset != null ||
    String(process.env.HOT_RANK_ADAPTIVE || '').toLowerCase() === '0';
  let stockLimit = 0;
  let stockOffset = 0;
  let collectionPlan = {
    mode: opts.skipStock || !runPlan.stockDue
      ? 'skip-stock'
      : isHourlyTopOnlyMode(decision)
        ? 'hourly-top-' + configuredTopTrackLimit(decision.topRankLimit) + '-only'
        : 'daily-categories-selected-250',
    dailyKey: runPlan.dailyKey,
    slotIndex: runPlan.stockSlot ? runPlan.stockSlot.index : null,
    products: [],
    selectedCount: 0,
    tierCounts: {}
  };
  let stocks = [];
  const busyMode = decision.mode && decision.mode.indexOf('busy-') === 0;

  if (runPlan.stockDue && !opts.skipStock && legacyOverride) {
    const defaultStockLimit =
      busyMode
        ? parseIntBounded(process.env.HOT_RANK_BUSY_STOCK_LIMIT, size, 1, size)
        : parseIntBounded(process.env.HOT_RANK_QUIET_STOCK_LIMIT, size, 1, size);
    stockLimit =
      opts.stockLimit == null
        ? defaultStockLimit
        : parseIntBounded(opts.stockLimit, defaultStockLimit, 1, size);
    const slot =
      busyMode
        ? Math.floor(decision.kst.minute / Math.max(1, decision.intervalMinutes || 30))
        : decision.kst.hour % Math.max(1, Math.ceil(size / stockLimit));
    stockOffset =
      opts.stockOffset == null
        ? (slot * stockLimit) % size
        : parseIntBounded(opts.stockOffset, 0, 0, Math.max(0, size - 1));
    collectionPlan = {
      mode: 'legacy-window',
      products: ranking.products,
      selectedCount: stockLimit,
      stockLimit,
      stockOffset,
      dailyKey: runPlan.dailyKey,
      slotIndex: runPlan.stockSlot ? runPlan.stockSlot.index : null,
      tierCounts: { legacy: Math.min(stockLimit, ranking.products.length) }
    };
    stocks = await fetchStockSnapshots(ranking.products, {
      limit: stockLimit,
      offset: stockOffset,
      batchSize,
      delayMs,
      deadlineMs: Number(opts.deadlineMs || 240000),
      timeoutMs: Number(opts.timeoutMs || process.env.HOT_RANK_STOCK_TIMEOUT_MS || 15000),
      lat: opts.lat,
      lng: opts.lng
    });
  } else if (runPlan.stockDue && !opts.skipStock) {
    collectionPlan = selectAdaptiveStockProducts(ranking.products, selectionStore, decision, now, opts);
    stockLimit = collectionPlan.products.length;
    stocks = stockLimit
      ? await fetchStockSnapshots(collectionPlan.products, {
          limit: stockLimit,
          offset: 0,
          batchSize,
          delayMs,
          deadlineMs: Number(opts.deadlineMs || 240000),
          timeoutMs: Number(opts.timeoutMs || process.env.HOT_RANK_STOCK_TIMEOUT_MS || 15000),
          lat: opts.lat,
          lng: opts.lng
        })
      : [];
  }

  if (!dryRun) {
    const latestStore = await readStore();
    const latestRunPlan = buildCollectorRunPlan(latestStore, decision, now, opts);
    if (!force && !latestRunPlan.shouldRun) {
      return {
        success: true,
        skipped: true,
        reason: 'already collected after concurrent run',
        schedule: decision,
        runPlan: latestRunPlan,
        collectionPlan: {
          mode: 'duplicate-write-guard',
          slotIndex: latestRunPlan.stockSlot ? latestRunPlan.stockSlot.index : null,
          dailyKey: latestRunPlan.dailyKey,
          selectedCount: 0,
          tierCounts: {}
        },
        discardedStockCount: stocks.length,
        discardedStockOkCount: stocks.filter((s) => s.ok).length,
        updatedAt: latestStore.updatedAt || latestStore.lastRunAt || null,
        lastRunAt: latestStore.lastRunAt || null,
        lastStockRunAt: latestStore.lastStockRunAt || null,
        durationMs: Date.now() - started
      };
    }
    if (!force && runPlan.stockDue && !latestRunPlan.stockDue) {
      stocks = [];
      stockLimit = 0;
      collectionPlan.products = [];
      collectionPlan.selectedCount = 0;
      collectionPlan.mode = 'skip-stock-concurrent';
      collectionPlan.tierCounts = {};
    }
    if (!force && runPlan.discoveryDue && !latestRunPlan.discoveryDue) {
      categoryRankings = null;
      ranking = rankingFromStore(latestStore, size);
    }
    runPlan = latestRunPlan;
    store = latestStore;
  }

  store = mergeRunIntoStore(store, ranking, stocks, {
    ts: now.toISOString(),
    mode: decision.mode,
    dailyKey: runPlan.dailyKey || collectionPlan.dailyKey,
    collectionType: runPlan.collectionType,
    stockLimit,
    stockOffset,
    collectionMode: collectionPlan.mode,
    collectionSlot: collectionPlan.slotIndex,
    stockSlotIndex: runPlan.stockSlot ? runPlan.stockSlot.index : null,
    stockSlotLabel: runPlan.stockSlot ? runPlan.stockSlot.label : null,
    stockTimesKst: runPlan.stockTimesKst,
    categoryRankings,
    stockProducts: collectionPlan.products,
    categoryRankingRequestedCount: categoryRankings ? categoryRankings.requestedCount : 0,
    categoryRankingOkCount: categoryRankings ? categoryRankings.okCount : 0,
    categoryRankingErrorCount: categoryRankings ? categoryRankings.errors.length : 0,
    tierCounts: collectionPlan.tierCounts,
    skippedRankingCount: collectionPlan.skippedRankingCount,
    outOfTopSelectedCount: collectionPlan.outOfTopSelectedCount,
    retrySelectedCount: collectionPlan.retrySelectedCount,
    retrySkippedCount: collectionPlan.retrySkippedCount,
    durationMs: Date.now() - started
  });

  if (!dryRun) {
    blob = await writeStore(store);
  }

  const estimates = computeEstimates(store);
  return {
    success: true,
    dryRun,
    skipped: false,
    schedule: decision,
    runPlan,
    collectionPlan: {
      mode: collectionPlan.mode,
      slotIndex: collectionPlan.slotIndex,
      dailyKey: collectionPlan.dailyKey,
      selectedCount: collectionPlan.selectedCount,
      skippedRankingCount: collectionPlan.skippedRankingCount,
      outOfTopSelectedCount: collectionPlan.outOfTopSelectedCount,
      retrySelectedCount: collectionPlan.retrySelectedCount,
      retrySkippedCount: collectionPlan.retrySkippedCount,
      retryLimit: collectionPlan.retryLimit,
      maxCandidates: collectionPlan.maxCandidates,
      categoryRankLimit: collectionPlan.categoryRankLimit,
      tierCounts: collectionPlan.tierCounts,
      rules: collectionPlan.rules
    },
    rankingCount: ranking.products.length,
    categoryRankingRequestedCount: categoryRankings ? categoryRankings.requestedCount : 0,
    categoryRankingOkCount: categoryRankings ? categoryRankings.okCount : 0,
    categoryRankingErrorCount: categoryRankings ? categoryRankings.errors.length : 0,
    stockSlotIndex: runPlan.stockSlot ? runPlan.stockSlot.index : null,
    stockSlotLabel: runPlan.stockSlot ? runPlan.stockSlot.label : null,
    stockOffset,
    stockCount: stocks.length,
    stockOkCount: stocks.filter((s) => s.ok).length,
    durationMs: Date.now() - started,
    updatedAt: store.updatedAt,
    estimateCount: estimates.filter((r) => r.dailyEstimatedSales > 0).length,
    topSales: estimates.filter((r) => r.dailyEstimatedSales > 0).slice(0, 10),
    topRevenue: estimates
      .filter((r) => r.dailyEstimatedRevenue > 0)
      .slice()
      .sort((a, b) => b.dailyEstimatedRevenue - a.dailyEstimatedRevenue)
      .slice(0, 10),
    blob: blob ? { pathname: blob.pathname, url: blob.url } : null
  };
}

module.exports = {
  buildCollectorRunPlan,
  computeEstimates,
  emptyStore,
  fetchCategoryRankings,
  fetchViewRanking,
  getSalesStats,
  getPurchaseLimitInfo,
  rankCollectionPlan,
  getScheduleDecision,
  readStore,
  runCollector,
  selectAdaptiveStockProducts
};
