const { computeEstimates, fetchViewRanking, readStore } = require('./_hot-ranking-store');

const RANGE_HOURS = {
  '1d': 24,
  '7d': 24 * 7,
  '30d': 24 * 30
};
const MAX_RANGE_HOURS = 24 * 30;
const HOT_RANK_CACHE_CONTROL = 'public, s-maxage=45, stale-while-revalidate=120';

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

function compactEstimate(row) {
  return {
    goodsNo: row.goodsNo,
    price: row.price || 0,
    originalPrice: row.originalPrice || 0,
    discountRate: row.discountRate || 0,
    estimatedSales: row.estimatedSales || 0,
    estimatedRevenue: row.estimatedRevenue || 0,
    windowEstimatedSales: row.windowEstimatedSales || 0,
    windowEstimatedRevenue: row.windowEstimatedRevenue || 0,
    dailyEstimatedSales: row.dailyEstimatedSales || 0,
    dailyEstimatedRevenue: row.dailyEstimatedRevenue || 0,
    fromTotal: row.fromTotal || 0,
    toTotal: row.toTotal || 0,
    perHour: row.perHour || 0,
    observationCount: row.observationCount || 0,
    dropEvents: row.dropEvents || 0,
    restockUnits: row.restockUnits || 0,
    restockEvents: row.restockEvents || 0,
    restockAdjusted: !!row.restockAdjusted,
    fromTs: row.fromTs || null,
    toTs: row.toTs || null,
    optionCount: row.optionCount || 0,
    hasToday: !!row.hasToday,
    purchaseLimit: row.purchaseLimit || null,
    salesRank: row.salesRank,
    revenueRank: row.revenueRank,
    rankTrends: row.rankTrends || {},
    viewChart: compactChartPoints(row.viewChart, 'view'),
    salesChart: compactChartPoints(row.salesChart, 'sales'),
    revenueChart: compactChartPoints(row.revenueChart, 'revenue')
  };
}

module.exports = async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ success: false, error: 'method not allowed' });
    return;
  }

  const q = req.query || {};
  const size = Math.max(1, Math.min(200, Number.parseInt(String(q.size || '100'), 10) || 100));
  const range = rangeHours(q);
  const windowMs = range.hours * 60 * 60 * 1000;

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      const ranking = await fetchViewRanking(size);
      res.setHeader('Cache-Control', HOT_RANK_CACHE_CONTROL);
      res.status(200).json({
        success: true,
        fallback: true,
        data: {
          source: 'oliveyoung-view-rank',
          updatedAt: ranking.updatedAt,
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
    const products = Object.values((store && store.products) || {})
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
        source: 'hot-ranking-history'
      }));
    const productGoods = new Set(products.map((item) => item.goodsNo).filter(Boolean));
    const estimateMap = {};
    estimates.forEach((row) => {
      if (productGoods.has(row.goodsNo)) estimateMap[row.goodsNo] = compactEstimate(row);
    });

    if (!products.length) {
      const ranking = await fetchViewRanking(size);
      res.setHeader('Cache-Control', HOT_RANK_CACHE_CONTROL);
      res.status(200).json({
        success: true,
        fallback: true,
        data: {
          source: 'oliveyoung-view-rank',
          updatedAt: ranking.updatedAt,
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
        source: 'hot-ranking-history',
        updatedAt: store.updatedAt || store.lastRunAt,
        lastRunAt: store.lastRunAt,
        lastStockRunAt: store.lastStockRunAt || null,
        range: range.range,
        windowHours: range.hours,
        products,
        estimates: estimateMap,
        estimateCount: estimates.filter((r) => r.dailyEstimatedSales > 0).length,
        revenueEstimateCount: estimates.filter((r) => r.dailyEstimatedRevenue > 0).length,
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
