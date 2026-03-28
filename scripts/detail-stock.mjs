import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/watchlist.json'), 'utf8'));
const STOCK_FILE = path.join(ROOT, 'public/data/stock.json');
const DETAIL_FILE = path.join(ROOT, 'public/data/stock-detail.json');

const OY = 'https://www.oliveyoung.co.kr';
const LAT = CONFIG.location.lat;
const LNG = CONFIG.location.lng;
const MAX_DETAIL = Math.min(50, Math.max(1, Number(CONFIG.maxDetailPerRun) || 30));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadStock() {
  try {
    return JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
  } catch {
    return { detailTargets: [], products: [] };
  }
}
function loadDetail() {
  try {
    return JSON.parse(fs.readFileSync(DETAIL_FILE, 'utf8'));
  } catch {
    return { products: {} };
  }
}

async function main() {
  const stock = loadStock();
  const prevDetail = loadDetail();
  const targets = stock.detailTargets || [];

  if (targets.length === 0) {
    console.log('상세 조회 대상 없음, 스킵');
    return;
  }

  const batch = targets.slice(0, MAX_DETAIL);
  console.log(`상세 조회: ${batch.length}개 (전체 ${targets.length}개 중, 최대 ${MAX_DETAIL}개)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ko-KR'
  });
  const page = await ctx.newPage();

  try {
    await page.goto(OY + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const txt = await page.locator('body').innerText();
    if (txt.includes('Just a moment')) {
      console.error('❌ Cloudflare 실패');
      process.exit(1);
    }

    async function oyPost(apiPath, body) {
      return page.evaluate(
        async ({ url, payload }) => {
          const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify(payload)
          });
          const text = await r.text();
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        },
        { url: OY + '/oystore/api' + apiPath, payload: body }
      );
    }

    const now = new Date().toISOString();
    const details = { ...(prevDetail.products || {}) };

    for (const goodsNo of batch) {
      const key = String(goodsNo);
      console.log(`  📦 ${key}`);
      try {
        const infoRes = await oyPost('/stock/stock-goods-info-v3', { goodsNo: key });
        if (!infoRes || infoRes.status !== 'SUCCESS') {
          console.log('    ⚠️ info 실패');
          continue;
        }

        const infoData = infoRes.data || {};
        const gi = infoData.goodsInfo;
        if (!gi) {
          console.log('    ⚠️ goodsInfo 없음');
          continue;
        }

        let options = [];
        if (Number(gi.itemCount) > 1) {
          const optRes = await oyPost('/stock/stock-goods-info-option', { goodsNo: key });
          if (optRes && optRes.status === 'SUCCESS') {
            const od = optRes.data || {};
            options = od.goodsInfo?.availableItems || [];
          }
        }
        if (!options.length) {
          options = [{ itemName: gi.goodsName, legacyItemNumber: gi.masterGoodsNumber }];
        }

        const optResults = [];
        for (const opt of options) {
          const pid = opt.legacyItemNumber;
          if (!pid) continue;
          const stRes = await oyPost('/stock/stock-stores', {
            productId: String(pid),
            lat: LAT,
            lon: LNG,
            pageIdx: 1,
            searchWords: '',
            mapLat: LAT,
            mapLon: LNG
          });
          const stData = stRes && stRes.status === 'SUCCESS' ? stRes.data || {} : {};
          const storeList = stData.storeList || [];
          const stores = storeList.map((s) => ({
            name: s.storeName,
            code: s.storeCode,
            dist: s.distance,
            qty: s.remainQuantity || 0,
            o2o: s.o2oRemainQuantity || 0,
            pickup: s.pickupYn,
            open: s.openYn
          }));

          optResults.push({
            name: opt.itemName,
            productId: pid,
            totalStores: stores.length,
            inStock: stores.filter((s) => s.qty > 0).length,
            totalQty: stores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
            stores: stores.filter((s) => s.qty > 0).slice(0, 20)
          });
          await sleep(500);
        }

        const uploadUrl = infoData.goodsUploadUrl || '';
        details[key] = {
          goodsName: gi.goodsName,
          price: gi.priceToPay,
          originalPrice: gi.originalPrice,
          discountRate: gi.discountRate,
          thumbnail: uploadUrl + (gi.goodsThumbnailPath || ''),
          itemCount: gi.itemCount,
          options: optResults,
          updatedAt: now
        };
        console.log(`    ✅ ${optResults.length}옵션`);
        await sleep(1000);
      } catch (e) {
        console.log(`    ❌ ${e.message}`);
      }
    }

    const dataDir = path.dirname(DETAIL_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(
      DETAIL_FILE,
      JSON.stringify(
        {
          updatedAt: now,
          location: CONFIG.location,
          products: details
        },
        null,
        2
      )
    );

    console.log(`\n✅ ${batch.length}개 상세 완료`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
