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
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const COLLECTION_STALE_GRACE_MS = 5 * MINUTE_MS;
const DEFAULT_BUSY_INTERVAL_MINUTES = 30;
const DEFAULT_QUIET_INTERVAL_MINUTES = 60;
const DEFAULT_DAILY_COLLECTION_TIME_KST = '03:00';
const DEFAULT_DAILY_COLLECTION_GRACE_MINUTES = 30;
const DEFAULT_PRIORITY_SALES_LIMIT = 20;
const DEFAULT_PRIORITY_REVENUE_LIMIT = 20;
const DEFAULT_RETRY_PER_RUN_LIMIT = 12;

function parseIntBounded(value, fallback, min, max) {
  const n = Number.parseInt(String(value == null ? fallback : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseCategoryId(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'all') return '';
  return /^\d{8,}$/.test(raw) ? raw : '';
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
  const requested = parseIntBounded(size, 100, 1, 200);
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
  const limit = parseIntBounded(opts.limit, products.length, 1, 200);
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
  const r = Number(rank) || 9999;
  if (r <= 100) {
    return {
      due: true,
      tier: 'daily-top-100',
      everyRuns: 1,
      reason: 'top 100: once per KST day'
    };
  }
  return { due: false, tier: 'out-100', everyRuns: 0, reason: 'out of top 100' };
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

function hasRunForCollectionSlot(store, decision, slotIndex) {
  const dailyKey = decision && decision.kst && decision.kst.isoDate;
  const mode = decision && decision.mode;
  const runs = Array.isArray(store && store.runs) ? store.runs : [];
  return runs.some((run) => {
    if (!run || run.mode !== mode) return false;
    if (Number(run.collectionSlot) !== Number(slotIndex)) return false;
    const runDay = run.dailyKey || kstDateKey(run.ts);
    return runDay && dailyKey && runDay === dailyKey;
  });
}

function storedProductToStockCandidate(item, dailyKey) {
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
    collectionTier: 'out-100',
    collectionReason: 'out of top 100: once per day',
    collectionEveryRuns: 0,
    collectionDate: dailyKey
  };
}

function selectAdaptiveStockProducts(rankingProducts, store, decision, now, opts) {
  opts = opts || {};
  const products = Array.isArray(rankingProducts) ? rankingProducts : [];
  const slotIndex = collectionSlotIndex(decision);
  const dailyKey = ((decision && decision.kst && decision.kst.isoDate) || kstParts(now || new Date()).isoDate);
  const dailyMode = isDailyScheduleMode(decision);
  const selected = [];
  const skipped = [];
  const currentGoods = new Set();
  const tierCounts = {};
  const storeProducts = (store && store.products) || {};
  const priorityMap = dailyMode ? {} : buildCollectionPriorityMap(store);
  const nowMs = (now instanceof Date ? now : new Date()).getTime();
  const retryLimit = parseIntBounded(
    opts.retryLimit == null ? process.env.HOT_RANK_RETRY_PER_RUN_LIMIT : opts.retryLimit,
    DEFAULT_RETRY_PER_RUN_LIMIT,
    0,
    50
  );
  let retrySelectedCount = 0;
  let retrySkippedCount = 0;

  function add(product, plan) {
    const row = Object.assign({}, product, {
      collectionTier: plan.tier,
      collectionReason: plan.reason,
      collectionEveryRuns: plan.everyRuns,
      collectionDate: dailyKey
    });
    selected.push(row);
    tierCounts[plan.tier] = (tierCounts[plan.tier] || 0) + 1;
  }

  products.forEach((product, idx) => {
    const rank = Number(product.rank) || idx + 1;
    if (product.goodsNo) currentGoods.add(product.goodsNo);
    const priority = product.goodsNo ? priorityMap[product.goodsNo] : null;
    let plan = dailyMode ? dailyRankCollectionPlan(rank) : rankCollectionPlan(rank, slotIndex, priority);
    const staleRetryDue =
      !dailyMode && !plan.due && isStaleForPlan(storeProducts[product.goodsNo], plan, decision, nowMs);
    if (staleRetryDue) {
      if (retrySelectedCount < retryLimit) {
        plan = staleRetryPlan(plan);
        retrySelectedCount += 1;
      } else {
        retrySkippedCount += 1;
      }
    }
    if (plan.due) add(product, plan);
    else {
      skipped.push({
        goodsNo: product.goodsNo,
        rank,
        tier: plan.tier,
        everyRuns: plan.everyRuns,
        staleRetryCapped: !!staleRetryDue
      });
    }
  });

  const outOfTopLimitValue =
    dailyMode && opts.outOfTopLimit == null
      ? 0
      : opts.outOfTopLimit == null
        ? process.env.HOT_RANK_OUT_OF_TOP_PER_RUN_LIMIT
        : opts.outOfTopLimit;
  const outOfTopLimit = parseIntBounded(
    outOfTopLimitValue,
    dailyMode ? 0 : 10,
    0,
    200
  );
  const outOfTop = Object.keys(storeProducts)
    .map((gn) => storeProducts[gn])
    .filter((item) => item && item.goodsNo && !currentGoods.has(item.goodsNo))
    .filter((item) => item.lastOutOfTopStockDate !== dailyKey)
    .sort((a, b) => {
      const as = Date.parse(a.lastStockedAt || a.lastSeenAt || 0) || 0;
      const bs = Date.parse(b.lastStockedAt || b.lastSeenAt || 0) || 0;
      if (as !== bs) return as - bs;
      return String(a.goodsNo).localeCompare(String(b.goodsNo));
    })
    .slice(0, outOfTopLimit);

  outOfTop.forEach((item) => add(storedProductToStockCandidate(item, dailyKey), {
    tier: 'out-100',
    everyRuns: 0,
    reason: 'out of top 100: once per day'
  }));

  return {
    mode: dailyMode ? 'daily-top-100' : 'adaptive-rank-tier',
    slotIndex,
    dailyKey,
    products: selected,
    selectedCount: selected.length,
    skippedRankingCount: skipped.length,
    outOfTopSelectedCount: outOfTop.length,
    retrySelectedCount,
    retrySkippedCount,
    retryLimit,
    tierCounts,
    rules: dailyMode
      ? [
          'rank 1-100 once per KST day',
          'out of top 100 skipped by default to reduce Vercel usage'
        ]
      : [
          '1-30 every scheduled run',
          'sales/revenue top ' +
            parseIntBounded(process.env.HOT_RANK_PRIORITY_SALES_LIMIT, DEFAULT_PRIORITY_SALES_LIMIT, 0, 100) +
            '/' +
            parseIntBounded(process.env.HOT_RANK_PRIORITY_REVENUE_LIMIT, DEFAULT_PRIORITY_REVENUE_LIMIT, 0, 100) +
            ' every scheduled run',
          '31-60 every 2 runs',
          '61-90 every 3 runs',
          '91-100 every 4 runs',
          'stale or failed stock snapshots retry up to ' + retryLimit + ' products per run',
          'out of top 100 once per KST day'
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
  if (stock.collectionTier === 'out-100') {
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
  const products = store.products || {};
  const stockByGoodsNo = {};
  (stocks || []).forEach((s) => {
    stockByGoodsNo[s.goodsNo] = s;
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
    item.goodsName = stock.goodsName || item.goodsName || stock.goodsNo;
    item.imageUrl = stock.imageUrl || item.imageUrl || '';
    item.latestRank = 9999;
    item.currentlyRanked = false;
    item.outOfTopSince = item.outOfTopSince || nowIso;
    item.lastSeenAt = item.lastSeenAt || nowIso;
    applyStockSnapshotToItem(item, stock, storedProductToStockCandidate(item, dailyKey), {
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
    rankingCount: ranking.products.length,
    stockCount: stocks.length,
    stockOkCount,
    stockLimit: meta && meta.stockLimit,
    stockOffset: meta && meta.stockOffset,
    dailyKey,
    collectionMode: meta && meta.collectionMode,
    collectionSlot: meta && meta.collectionSlot,
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

function dailyScheduleEnabled() {
  const raw = String(process.env.HOT_RANK_DAILY_ONLY == null ? '1' : process.env.HOT_RANK_DAILY_ONLY)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
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

function isInDailyCollectionWindow(kst, dailyTime, graceMinutes) {
  const current = kst.hour * 60 + kst.minute;
  const target = dailyTime.hour * 60 + dailyTime.minute;
  const delta = (current - target + 24 * 60) % (24 * 60);
  return delta < graceMinutes;
}

function isDailyScheduleMode(decision) {
  return !!(decision && typeof decision.mode === 'string' && decision.mode.indexOf('daily-') === 0);
}

function getScheduleDecision(date) {
  const kst = kstParts(date || new Date());
  const windows = parseBusyWindows(process.env.HOT_RANK_BUSY_WINDOWS_KST);
  if (dailyScheduleEnabled()) {
    const dailyTime = parseDailyCollectionTime(process.env.HOT_RANK_DAILY_TIME_KST);
    const graceMinutes = parseIntBounded(
      process.env.HOT_RANK_DAILY_GRACE_MINUTES,
      DEFAULT_DAILY_COLLECTION_GRACE_MINUTES,
      1,
      60
    );
    return {
      shouldRun: isInDailyCollectionWindow(kst, dailyTime, graceMinutes),
      mode: 'daily-' + dailyTime.label + '-kst',
      intervalMinutes: 24 * 60,
      kst,
      dailyTimeKst: dailyTime.label,
      graceMinutes,
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
      reason: isDailyScheduleMode(decision)
        ? 'waiting for daily collection window'
        : 'waiting for scheduled collection interval',
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

  const size = parseIntBounded(opts.size, 100, 1, 200);
  let store = emptyStore();
  let blob = null;
  if (!dryRun) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN is required for persistent hot ranking history');
    }
    store = await readStore();
  }

  const plannedSlot = collectionSlotIndex(decision);
  const plannedDailyKey = decision && decision.kst && decision.kst.isoDate;
  if (!force && !dryRun && hasRunForCollectionSlot(store, decision, plannedSlot)) {
    return {
      success: true,
      skipped: true,
      reason: 'already collected for this schedule slot',
      schedule: decision,
      collectionPlan: {
        mode: 'duplicate-slot-guard',
        slotIndex: plannedSlot,
        dailyKey: plannedDailyKey,
        selectedCount: 0,
        tierCounts: {}
      },
      updatedAt: store.updatedAt || store.lastRunAt || null,
      lastRunAt: store.lastRunAt || null,
      lastStockRunAt: store.lastStockRunAt || null,
      durationMs: Date.now() - started
    };
  }

  const ranking = await fetchViewRanking(size);

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
    mode: opts.skipStock ? 'skip-stock' : 'adaptive-rank-tier',
    products: [],
    selectedCount: 0,
    tierCounts: {}
  };
  let stocks = [];
  const busyMode = decision.mode && decision.mode.indexOf('busy-') === 0;

  if (!opts.skipStock && legacyOverride) {
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
  } else if (!opts.skipStock) {
    collectionPlan = selectAdaptiveStockProducts(ranking.products, store, decision, now, opts);
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
    if (!force && hasRunForCollectionSlot(latestStore, decision, plannedSlot)) {
      return {
        success: true,
        skipped: true,
        reason: 'already collected for this schedule slot after concurrent run',
        schedule: decision,
        collectionPlan: {
          mode: 'duplicate-slot-write-guard',
          slotIndex: plannedSlot,
          dailyKey: plannedDailyKey,
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
    store = latestStore;
  }

  store = mergeRunIntoStore(store, ranking, stocks, {
    ts: now.toISOString(),
    mode: decision.mode,
    dailyKey: collectionPlan.dailyKey,
    stockLimit,
    stockOffset,
    collectionMode: collectionPlan.mode,
    collectionSlot: collectionPlan.slotIndex,
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
      tierCounts: collectionPlan.tierCounts,
      rules: collectionPlan.rules
    },
    rankingCount: ranking.products.length,
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
  computeEstimates,
  emptyStore,
  fetchViewRanking,
  getSalesStats,
  getPurchaseLimitInfo,
  rankCollectionPlan,
  getScheduleDecision,
  readStore,
  runCollector,
  selectAdaptiveStockProducts
};
