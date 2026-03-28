import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/watchlist.json'), 'utf8'));
const DATA_DIR = path.join(ROOT, 'public/data');
const STOCK_FILE = path.join(DATA_DIR, 'stock.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const LAT = CONFIG.location.lat;
const LNG = CONFIG.location.lng;
const OY = 'https://www.oliveyoung.co.kr';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPrev() {
  try {
    return JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
  } catch {
    return { products: [] };
  }
}
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { events: [] };
  }
}

async function main() {
  const prev = loadPrev();
  const history = loadHistory();
  const prevMap = {};
  for (const p of prev.products || []) {
    if (p.goodsNo) prevMap[p.goodsNo] = p;
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ko-KR'
  });
  const page = await ctx.newPage();

  console.log('접속 중...');
  await page.goto(OY + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  const txt = await page.locator('body').innerText();
  if (txt.includes('Just a moment')) {
    console.error('❌ Cloudflare 실패');
    await browser.close();
    process.exit(1);
  }
  console.log('✅ 통과\n');

  async function searchProducts(keyword, pageNum) {
    return page.evaluate(
      async ({ base, kw, pg, sz }) => {
        const r = await fetch(base + '/oystore/api/stock/product-search-v3', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: JSON.stringify({
            keyword: kw,
            page: pg,
            size: sz,
            sort: '01',
            includeSoldOut: true
          })
        });
        const t = await r.text();
        try {
          return JSON.parse(t);
        } catch {
          return null;
        }
      },
      { base: OY, kw: keyword, pg: pageNum, sz: CONFIG.sizePerKeyword || 50 }
    );
  }

  const now = new Date().toISOString();
  const allProducts = new Map();
  const events = [];

  try {
    for (const kw of CONFIG.keywords || []) {
      console.log(`🔍 "${kw}" 검색...`);
      const res = await searchProducts(kw, 1);
      if (!res || res.status !== 'SUCCESS') {
        console.log('  ⚠️ 실패');
        await sleep(1000);
        continue;
      }

      const data = res.data || {};
      const products =
        data.serachList || data.searchList || data.searchlist || data.productList || [];
      console.log(`  → ${products.length}개`);

      for (const p of products) {
        const gn = p.goodsNumber;
        if (!gn || allProducts.has(gn)) continue;

        const inStock = p.o2oStockFlag === true;
        const product = {
          goodsNo: gn,
          goodsName: p.goodsName || '',
          price: p.priceToPay || 0,
          originalPrice: p.originalPrice || 0,
          discountRate: p.discountRate || 0,
          imageUrl: p.imageUrl || '',
          inStock,
          o2oRemainQty: p.o2oRemainQuantity || 0,
          keyword: kw,
          timestamp: now
        };

        const old = prevMap[gn];

        if (!old) {
          product.status = 'new';
          product.statusLabel = '🆕 신규발견';
          product.firstSeenAt = now;
          events.push({ type: 'new', goodsNo: gn, goodsName: product.goodsName, keyword: kw, date: now });
        } else if (old.status === 'discontinued') {
          product.status = 'restocked';
          product.statusLabel = '🔄 재등록';
          product.firstSeenAt = old.firstSeenAt || now;
          events.push({ type: 'restocked', goodsNo: gn, goodsName: product.goodsName, date: now });
        } else {
          product.status = inStock ? 'active' : 'soldout';
          product.statusLabel = inStock ? '✅ 재고있음' : '🔴 품절';
          product.firstSeenAt = old.firstSeenAt || now;

          if (old.price && old.price !== product.price) {
            product.priceChanged = true;
            product.prevPrice = old.price;
            events.push({
              type: product.price < old.price ? 'price_down' : 'price_up',
              goodsNo: gn,
              goodsName: product.goodsName,
              from: old.price,
              to: product.price,
              date: now
            });
          }
          if (old.inStock && !inStock) {
            events.push({ type: 'soldout', goodsNo: gn, goodsName: product.goodsName, date: now });
          }
          if (!old.inStock && inStock) {
            events.push({ type: 'back_in_stock', goodsNo: gn, goodsName: product.goodsName, date: now });
          }
        }

        allProducts.set(gn, product);
      }

      await sleep(1500);
    }

    for (const gn of CONFIG.pinnedGoods || []) {
      if (!allProducts.has(gn) && prevMap[gn] && prevMap[gn].status !== 'discontinued') {
        const old = prevMap[gn];
        allProducts.set(gn, {
          ...old,
          status: 'discontinued',
          statusLabel: '⛔ 단종/삭제',
          timestamp: now
        });
        events.push({ type: 'discontinued', goodsNo: gn, goodsName: old.goodsName, date: now });
      }
    }

    for (const gn of Object.keys(prevMap)) {
      if (!allProducts.has(gn)) {
        const old = prevMap[gn];
        allProducts.set(gn, {
          ...old,
          status: old.status === 'new' ? 'active' : old.status,
          _notInThisScan: true,
          timestamp: old.timestamp
        });
      }
    }
  } finally {
    await browser.close();
  }

  const changedGoods = events
    .filter((e) => ['new', 'back_in_stock', 'restocked', 'price_down'].includes(e.type))
    .map((e) => e.goodsNo);
  const pinnedForDetail = CONFIG.pinnedGoods || [];
  const detailTargets = [...new Set([...changedGoods, ...pinnedForDetail])];

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const products = [...allProducts.values()];
  const output = {
    updatedAt: now,
    location: CONFIG.location,
    summary: {
      total: products.length,
      active: products.filter((p) => p.status === 'active').length,
      new: products.filter((p) => p.status === 'new').length,
      soldout: products.filter((p) => p.status === 'soldout').length,
      discontinued: products.filter((p) => p.status === 'discontinued').length,
      priceChanged: products.filter((p) => p.priceChanged).length
    },
    recentEvents: events.slice(0, 100),
    detailTargets,
    products
  };

  fs.writeFileSync(STOCK_FILE, JSON.stringify(output, null, 2));

  history.events = [...events, ...(history.events || [])].slice(0, 500);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  console.log(`\n✅ ${products.length}개 상품 | ${events.length}개 이벤트`);
  console.log(
    `   ${output.summary.active}재고 ${output.summary.soldout}품절 ${output.summary.new}신규 ${output.summary.discontinued}단종 ${output.summary.priceChanged}가격변동`
  );
  console.log(`   상세조회 대상: ${detailTargets.length}개`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
