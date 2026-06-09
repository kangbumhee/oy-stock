const { computeEstimates, fetchViewRanking, readStore } = require('./_hot-ranking-store');

const RANGE_HOURS = {
  '1d': 24,
  '7d': 24 * 7,
  '30d': 24 * 30
};
const MAX_RANGE_HOURS = 24 * 30;
const HOT_RANK_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=3600';
const DEFAULT_HOT_RANK_SIZE = 128;
const DEFAULT_OVERALL_MEASURED_LIMIT = 128;

function defaultHotRankSize() {
  const n = Number.parseInt(String(process.env.HOT_RANK_TOP_TRACK_LIMIT || DEFAULT_HOT_RANK_SIZE), 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : DEFAULT_HOT_RANK_SIZE;
}

function parseCategory(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'all') return '';
  return /^\d{8,}$/.test(raw) ? raw : '';
}

function rangeHours(q) {
  const key = String((q && q.range) || '').toLowerCase();
  if (RANGE_HOURS[key]) return { range: key, hours: RANGE_HOURS[key] };
  if (key) return { range: '30d', hours: MAX_RANGE_HOURS };
  const hours = Math.max(
    1,
    Math.min(MAX_RANGE_HOURS, Number.parseInt(String((q && q.hours) || '24'), 10) || 24)
  );
  const match = Object.keys(RANGE_HOURS).find((k) => RANGE_HOURS[k] === hours);
  return { range: match || 'custom', hours };
}

function chartPointLimit(range) {
  if (range === '1d') return 36;
  if (range === '7d') return 48;
  return 60;
}

function compactChartPoints(points, mode) {
  return (Array.isArray(points) ? points : []).map((p) => {
    const row = {
      ts: p.ts,
      rank: p.rank,
      prevRank: p.prevRank,
      rankLabel: p.rankLabel
    };
    if (mode === 'view') {
      row.rankDelta = p.rankDelta;
    } else if (mode === 'sales') {
      row.sales = p.sales;
      row.salesDelta = p.salesDelta;
    } else if (mode === 'revenue') {
      row.revenue = p.revenue;
      row.revenueDelta = p.revenueDelta;
    }
    return row;
  });
}

function compactEstimate(row, dayRow) {
  const metric = dayRow || row;
  return {
    goodsNo: row.goodsNo,
    price: metric.price || row.price || 0,
    originalPrice: metric.originalPrice || row.originalPrice || 0,
    discountRate: metric.discountRate || row.discountRate || 0,
    estimatedSales: row.estimatedSales || 0,
    estimatedRevenue: row.estimatedRevenue || 0,
    windowEstimatedSales: row.windowEstimatedSales || 0,
    windowEstimatedRevenue: row.windowEstimatedRevenue || 0,
    dailyEstimatedSales: metric.dailyEstimatedSales || 0,
    dailyEstimatedRevenue: metric.dailyEstimatedRevenue || 0,
    fromTotal: metric.fromTotal || row.fromTotal || 0,
    toTotal: metric.toTotal || row.toTotal || 0,
    perHour: metric.perHour || 0,
    observationCount: metric.observationCount || 0,
    dropEvents: metric.dropEvents || 0,
    restockUnits: metric.restockUnits || 0,
    restockEvents: metric.restockEvents || 0,
    restockAdjusted: !!metric.restockAdjusted,
    confidence: metric.confidence || 'pending',
    confidenceLabel: metric.confidenceLabel || '',
    fromTs: metric.fromTs || row.fromTs || null,
    toTs: metric.toTs || row.toTs || null,
    optionCount: metric.optionCount || row.optionCount || 0,
    hasToday: !!(metric.hasToday || row.hasToday),
    purchaseLimit: metric.purchaseLimit || row.purchaseLimit || null,
    salesRank: metric.salesRank,
    revenueRank: metric.revenueRank,
    rankTrends: metric.rankTrends || row.rankTrends || {},
    viewChart: compactChartPoints(row.viewChart, 'view'),
    salesChart: compactChartPoints(row.salesChart, 'sales'),
    revenueChart: compactChartPoints(row.revenueChart, 'revenue')
  };
}

function parseLimit(value, fallback, min, max) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function includeMeasuredOutsideTop(q) {
  const raw = String(
    (q && (q.includeMeasured || q.includeMeasuredOutsideTop)) ||
      process.env.HOT_RANK_INCLUDE_MEASURED_OUTSIDE_TOP ||
      ''
  )
    .trim()
    .toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function productFromRanking(product, stored, source, categoryFallback) {
  const row = product || {};
  const saved = stored || {};
  return {
    rank: row.rank,
    goodsNo: row.goodsNo,
    goodsNumber: row.goodsNo,
    goodsName: saved.goodsName || row.goodsName || row.goodsNo,
    imageUrl: saved.imageUrl || row.imageUrl || '',
    categoryNumber: row.categoryNumber || saved.categoryNumber || categoryFallback || '',
    brandId: row.brandId || saved.brandId || '',
    itemId: row.itemId || saved.itemId || '',
    price: saved.price || row.price || 0,
    originalPrice: saved.originalPrice || 0,
    discountRate: saved.discountRate || 0,
    viewCount: row.viewCount || saved.latestViewCount || 0,
    purchaseLimit: saved.purchaseLimit || null,
    lastStockedAt: saved.lastStockedAt || null,
    source
  };
}

function productFromEstimate(row, stored, source) {
  const saved = stored || {};
  return {
    rank: row.rank || saved.latestRank || 9999,
    goodsNo: row.goodsNo,
    goodsNumber: row.goodsNo,
    goodsName: saved.goodsName || row.goodsName || row.goodsNo,
    imageUrl: saved.imageUrl || row.imageUrl || '',
    categoryNumber: saved.categoryNumber || row.categoryNumber || '',
    brandId: saved.brandId || row.brandId || '',
    itemId: saved.itemId || row.itemId || '',
    price: saved.price || row.price || 0,
    originalPrice: saved.originalPrice || row.originalPrice || 0,
    discountRate: saved.discountRate || row.discountRate || 0,
    viewCount: saved.latestViewCount || row.viewCount || 0,
    purchaseLimit: saved.purchaseLimit || row.purchaseLimit || null,
    lastStockedAt: saved.lastStockedAt || null,
    source
  };
}

function mergeMeasuredOverallProducts(products, dayEstimates, storeProducts, limit) {
  const merged = Array.isArray(products) ? products.slice() : [];
  const seen = new Set(merged.map((item) => item && item.goodsNo).filter(Boolean));
  const candidates = (Array.isArray(dayEstimates) ? dayEstimates : [])
    .filter((row) => {
      if (!row || !row.goodsNo || seen.has(row.goodsNo)) return false;
      return Number(row.dailyEstimatedSales || 0) > 0 || Number(row.dailyEstimatedRevenue || 0) > 0;
    })
    .sort((a, b) => {
      const salesDiff = Number(b.dailyEstimatedSales || 0) - Number(a.dailyEstimatedSales || 0);
      if (salesDiff) return salesDiff;
      const revenueDiff = Number(b.dailyEstimatedRevenue || 0) - Number(a.dailyEstimatedRevenue || 0);
      if (revenueDiff) return revenueDiff;
      return (Number(a.rank) || 9999) - (Number(b.rank) || 9999);
    });
  let added = 0;
  for (const row of candidates) {
    if (merged.length >= limit) break;
    merged.push(productFromEstimate(row, storeProducts[row.goodsNo], 'hot-ranking-history-measured'));
    seen.add(row.goodsNo);
    added += 1;
  }
  return {
    products: merged,
    added
  };
}

module.exports = async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ success: false, error: 'method not allowed' });
    return;
  }

  const q = req.query || {};
  const defaultSize = defaultHotRankSize();
  const size = Math.max(1, Math.min(200, Number.parseInt(String(q.size || defaultSize), 10) || defaultSize));
  const mergeMeasuredOutsideTop = includeMeasuredOutsideTop(q);
  const overallMeasuredLimit = parseLimit(
    q.measuredSize || process.env.HOT_RANK_OVERALL_MEASURED_LIMIT,
    DEFAULT_OVERALL_MEASURED_LIMIT,
    size,
    250
  );
  const range = rangeHours(q);
  const windowMs = range.hours * 60 * 60 * 1000;
  const categoryId = parseCategory(q.category || q.categoryid || q.categoryId || q.fltDispCatNo);

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      const ranking = await fetchViewRanking(size, { categoryId });
      res.setHeader('Cache-Control', HOT_RANK_CACHE_CONTROL);
      res.status(200).json({
        success: true,
        fallback: true,
        data: {
          source: 'oliveyoung-view-rank',
          updatedAt: ranking.updatedAt,
          categoryId,
          range: range.range,
          windowHours: range.hours,
          products: ranking.products,
          estimates: {},
          estimateCount: 0
        }
      });
      return;
    }

    const store = await readStore();
    const estimates = computeEstimates(store, {
      windowMs,
      maxChartPoints: chartPointLimit(range.range)
    });
    const dayEstimates =
      range.hours === 24
        ? estimates
        : computeEstimates(store, {
            windowMs: 24 * 60 * 60 * 1000,
            maxChartPoints: chartPointLimit('1d')
          });
    const dayEstimateByGoods = {};
    dayEstimates.forEach((row) => {
      if (row && row.goodsNo) dayEstimateByGoods[row.goodsNo] = row;
    });
    const storeProducts = (store && store.products) || {};
    let products = [];
    let source = 'hot-ranking-history';
    let categoryUpdatedAt = null;
    let measuredAddedCount = 0;

    if (categoryId) {
      const cachedCategory =
        store.rankings &&
        store.rankings.categories &&
        store.rankings.categories[categoryId];
      let ranking;
      if (cachedCategory && Array.isArray(cachedCategory.products) && cachedCategory.products.length) {
        ranking = {
          updatedAt: cachedCategory.updatedAt,
          products: cachedCategory.products.slice(0, size)
        };
        source = 'hot-ranking-history-category';
      } else {
        ranking = await fetchViewRanking(size, { categoryId });
        source = 'oliveyoung-view-rank-category';
      }
      categoryUpdatedAt = ranking.updatedAt;
      products = (ranking.products || []).map((product) => {
        const stored = storeProducts[product.goodsNo] || {};
        return productFromRanking(product, stored, source, categoryId);
      });
    } else {
      source = 'hot-ranking-history';
      const cachedGlobal = store.rankings && store.rankings.global;
      if (cachedGlobal && Array.isArray(cachedGlobal.products) && cachedGlobal.products.length) {
        products = cachedGlobal.products.slice(0, size).map((product) => {
          const stored = storeProducts[product.goodsNo] || {};
          return productFromRanking(product, stored, source, '');
        });
      } else {
        products = Object.values(storeProducts)
          .filter((item) => item && item.currentlyRanked !== false && Number(item.latestRank || 9999) < 9999)
          .sort((a, b) => (a.latestRank || 9999) - (b.latestRank || 9999))
          .slice(0, size)
          .map((item, idx) => ({
            rank: item.latestRank || idx + 1,
            goodsNo: item.goodsNo,
            goodsNumber: item.goodsNo,
            goodsName: item.goodsName || item.goodsNo,
            imageUrl: item.imageUrl || '',
            categoryNumber: item.categoryNumber || '',
            brandId: item.brandId || '',
            itemId: item.itemId || '',
            price: item.price || 0,
            originalPrice: item.originalPrice || 0,
            discountRate: item.discountRate || 0,
            viewCount: item.latestViewCount || 0,
            purchaseLimit: item.purchaseLimit || null,
            lastStockedAt: item.lastStockedAt || null,
            source
          }));
      }
      if (mergeMeasuredOutsideTop) {
        const merged = mergeMeasuredOverallProducts(
          products,
          dayEstimates,
          storeProducts,
          overallMeasuredLimit
        );
        products = merged.products;
        measuredAddedCount = merged.added;
        if (measuredAddedCount > 0 && source === 'hot-ranking-history') {
          source = 'hot-ranking-history-plus-measured';
        }
      }
    }
    const productGoods = new Set(products.map((item) => item.goodsNo).filter(Boolean));
    const estimateMap = {};
    estimates.forEach((row) => {
      if (productGoods.has(row.goodsNo)) {
        estimateMap[row.goodsNo] = compactEstimate(row, dayEstimateByGoods[row.goodsNo]);
      }
    });

    if (!products.length) {
      const ranking = await fetchViewRanking(size, { categoryId });
      res.setHeader('Cache-Control', HOT_RANK_CACHE_CONTROL);
      res.status(200).json({
        success: true,
        fallback: true,
        data: {
          source: 'oliveyoung-view-rank',
          updatedAt: ranking.updatedAt,
          categoryId,
          range: range.range,
          windowHours: range.hours,
          products: ranking.products,
          estimates: {},
          estimateCount: 0
        }
      });
      return;
    }

    res.setHeader('Cache-Control', HOT_RANK_CACHE_CONTROL);
    res.status(200).json({
      success: true,
      data: {
        source,
        updatedAt: categoryUpdatedAt || store.updatedAt || store.lastRunAt,
        lastRunAt: store.lastRunAt,
        lastStockRunAt: store.lastStockRunAt || null,
        categoryId,
        range: range.range,
        windowHours: range.hours,
        products,
        estimates: estimateMap,
        includedMeasuredCount: measuredAddedCount,
        estimateCount: Object.values(estimateMap).filter((r) => r.dailyEstimatedSales > 0).length,
        revenueEstimateCount: Object.values(estimateMap).filter((r) => r.dailyEstimatedRevenue > 0).length,
        rankingCache: store.rankings
          ? {
              updatedAt: store.rankings.updatedAt || null,
              categoryRequestedCount: store.rankings.categoryRequestedCount || 0,
              categoryOkCount: store.rankings.categoryOkCount || 0
            }
          : null,
        runCount: Array.isArray(store.runs) ? store.runs.length : 0,
        recentRuns: Array.isArray(store.runs) ? store.runs.slice(-8) : []
      }
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      success: false,
      error: 'hot ranking history failed',
      message: e && e.message ? e.message : String(e)
    });
  }
};
