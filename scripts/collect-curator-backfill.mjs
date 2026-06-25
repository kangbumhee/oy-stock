import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CATEGORY_IDS = [
  '',
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

const DEFAULT_RANKING_BASE =
  'https://olivestock.co.kr/api/oliveyoung/hot-ranking-history';
const DEFAULT_BATCH_SIZE = 120;
const DEFAULT_RETRY_ERROR_AFTER_MS = 6 * 60 * 60 * 1000;

function readJson(relativePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
  } catch {
    return fallback;
  }
}

function addGoodsNo(out, value) {
  const goodsNo = String(value || '').trim().toUpperCase();
  if (/^[AB]\d+$/.test(goodsNo)) out.add(goodsNo);
}

function addKnownRepoGoods(out) {
  const stock = readJson('public/data/stock-detail.json', { products: {} });
  Object.keys(stock.products || {}).forEach((goodsNo) => addGoodsNo(out, goodsNo));

  const blog = readJson('public/data/blog-posts.json', { posts: [] });
  (blog.posts || []).forEach((post) => addGoodsNo(out, post && post.goodsNo));

  const vendor = readJson('public/data/vendor-products.json', { products: [] });
  (vendor.products || []).forEach((product) =>
    addGoodsNo(out, product && (product.goodsNo || product.goodsNumber))
  );

  const history = readJson('public/data/history.json', { events: [] });
  (history.events || []).forEach((event) =>
    addGoodsNo(out, event && (event.goodsNo || event.goodsNumber))
  );

  const watchlist = readJson('scripts/watchlist.json', { favorites: [] });
  (watchlist.favorites || []).forEach((product) =>
    addGoodsNo(out, product && (product.goodsNo || product.goodsNumber))
  );
}

async function addLiveRankingGoods(out) {
  if (String(process.env.CURATOR_INCLUDE_LIVE_CATEGORIES || '1') === '0') return;

  const baseUrl = String(process.env.CURATOR_RANKING_BASE_URL || DEFAULT_RANKING_BASE);
  const size = Number.parseInt(String(process.env.CURATOR_RANKING_SIZE || '128'), 10) || 128;
  const timeoutMs =
    Number.parseInt(String(process.env.CURATOR_RANKING_TIMEOUT_MS || '20000'), 10) || 20000;
  const batchSize =
    Number.parseInt(String(process.env.CURATOR_RANKING_BATCH_SIZE || '2'), 10) || 2;
  const categories = String(process.env.CURATOR_CATEGORY_IDS || '')
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const categoryIds = categories.length ? categories : CATEGORY_IDS;

  async function fetchCategory(categoryId) {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set('size', String(size));
      url.searchParams.set('period', '24h');
      url.searchParams.set('sort', 'view');
      if (categoryId) url.searchParams.set('category', categoryId);

      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'oy-stock-curator-backfill'
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        console.warn(`ranking ${categoryId || 'all'} HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      const products =
        (json && json.data && Array.isArray(json.data.products) && json.data.products) ||
        (Array.isArray(json.products) && json.products) ||
        [];
      products.forEach((product) => addGoodsNo(out, product && (product.goodsNo || product.goodsNumber)));
    } catch (e) {
      console.warn(`ranking ${categoryId || 'all'} failed: ${e.message || e}`);
    }
  }

  for (let i = 0; i < categoryIds.length; i += batchSize) {
    await Promise.all(categoryIds.slice(i, i + batchSize).map(fetchCategory));
  }
}

function hasUsableCuratorLink(entry) {
  return !!(entry && (entry.shortenedUrl || entry.originalUrl));
}

function shouldRetryError(entry) {
  if (!entry || !entry.error || !entry.generatedAt) return true;
  const retryAfter = Number.parseInt(
    String(process.env.CURATOR_RETRY_ERROR_AFTER_MS || DEFAULT_RETRY_ERROR_AFTER_MS),
    10
  );
  const ts = Date.parse(entry.generatedAt);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > retryAfter;
}

function githubOutput(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, ' ')}`);
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
}

async function main() {
  const known = new Set();
  await addLiveRankingGoods(known);
  addKnownRepoGoods(known);

  const curator = readJson('public/data/curator-links.json', { links: {} });
  const links = curator.links || {};
  const allGoods = Array.from(known);
  const missing = allGoods.filter((goodsNo) => {
    const entry = links[goodsNo];
    if (hasUsableCuratorLink(entry)) return false;
    return shouldRetryError(entry);
  });

  const batchSize = Math.max(
    1,
    Number.parseInt(String(process.env.CURATOR_BACKFILL_BATCH_SIZE || DEFAULT_BATCH_SIZE), 10) ||
      DEFAULT_BATCH_SIZE
  );
  const batch = missing.slice(0, batchSize);
  const goodsNos = batch.join(',');
  const hasGoods = batch.length > 0 ? 'true' : 'false';

  console.log(`known=${allGoods.length}`);
  console.log(`linked=${Object.keys(links).filter((key) => hasUsableCuratorLink(links[key])).length}`);
  console.log(`missing=${missing.length}`);
  console.log(`batch=${batch.length}`);
  if (batch.length) console.log(goodsNos);

  githubOutput({
    hasGoods,
    goodsNos,
    knownCount: allGoods.length,
    missingCount: missing.length,
    batchCount: batch.length
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
