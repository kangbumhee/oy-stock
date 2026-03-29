import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/watchlist.json'), 'utf8'));

/** GitHub Actions 수집 대상(공개 캐시). 사용자 즐겨찾기는 앱에서 실시간 API로 조회 */
const POPULAR_PRODUCTS = [
  'A000000207822', // 망곰 딥클린마스터
  'A000000154189' // 어노브 볼륨업 컬링에센스
];

const DATA_DIR = path.join(ROOT, 'public/data');
const DETAIL_FILE = path.join(DATA_DIR, 'stock-detail.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const OY = 'https://www.oliveyoung.co.kr';
const LAT = CONFIG.location.lat;
const LNG = CONFIG.location.lng;
const MAX = Math.min(50, Math.max(1, Number(CONFIG.maxPerRun) || 50));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPrev() {
  try {
    return JSON.parse(fs.readFileSync(DETAIL_FILE, 'utf8'));
  } catch {
    return { products: {} };
  }
}
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { events: [] };
  }
}

/** OY JSON: { status, data: { goodsInfo, ... } } 또는 data 중첩 변형 */
function unwrapPayload(json) {
  if (!json || typeof json !== 'object') return {};
  const d = json.data;
  if (d && typeof d === 'object' && d.goodsInfo != null) return d;
  if (d && typeof d === 'object' && d.data && d.data.goodsInfo != null) return d.data;
  if (json.goodsInfo != null) return json;
  return d && typeof d === 'object' ? d : {};
}

function yn(v) {
  return v === true || v === 'Y' || v === 'y';
}

async function main() {
  const favorites = POPULAR_PRODUCTS.map((gn) => ({ goodsNo: gn }));
  if (favorites.length === 0) {
    console.log('POPULAR_PRODUCTS 비어 있음, 종료');
    return;
  }

  const prev = loadPrev();
  const history = loadHistory();
  const prevProducts = prev.products || {};
  const events = [];
  const now = new Date().toISOString();

  const batches = [];
  for (let i = 0; i < favorites.length; i += MAX) {
    batches.push(favorites.slice(i, i + MAX));
  }

  console.log(`인기상품 ${favorites.length}개 | ${batches.length}배치 (배치당 최대 ${MAX}개)\n`);

  const browser = await chromium.launch({ headless: true });
  const results = { ...prevProducts };

  try {
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      console.log(`\n── 배치 ${bi + 1}/${batches.length} (${batch.length}개) ──`);

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
      if (txt.includes('Just a moment') || txt.includes('Enable JavaScript')) {
        console.error('❌ Cloudflare 실패, 배치 스킵');
        await ctx.close();
        continue;
      }
      console.log('✅ 통과');

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
            const t = await r.text();
            try {
              return JSON.parse(t);
            } catch {
              return null;
            }
          },
          { url: OY + '/oystore/api' + apiPath, payload: body }
        );
      }

      for (const fav of batch) {
        const gn = String(fav.goodsNo);
        console.log(`\n📦 ${gn} ${fav.goodsName || ''}`);
        const old = prevProducts[gn];

        try {
          const infoRaw = await oyPost('/stock/stock-goods-info-v3', { goodsNo: gn });
          if (!infoRaw || infoRaw.status !== 'SUCCESS') {
            console.log('  ⚠️ 조회 실패 (단종 가능성)');
            if (old && old.status !== 'discontinued') {
              events.push({
                type: 'discontinued',
                goodsNo: gn,
                goodsName: old.goodsName || fav.goodsName,
                date: now
              });
            }
            results[gn] = {
              ...(old || {}),
              goodsNo: gn,
              goodsName: old?.goodsName || fav.goodsName,
              status: 'discontinued',
              statusLabel: '⛔ 단종/삭제',
              updatedAt: now
            };
            continue;
          }

          const infoInner = unwrapPayload(infoRaw);
          const gi = infoInner.goodsInfo;
          if (!gi) {
            console.log('  ⚠️ goodsInfo 없음');
            results[gn] = {
              ...(old || {}),
              goodsNo: gn,
              goodsName: old?.goodsName || fav.goodsName,
              status: 'error',
              statusLabel: '⚠️ 응답 오류',
              options: [],
              updatedAt: now
            };
            continue;
          }

          const uploadUrl = infoInner.goodsUploadUrl || '';

          let options = [];
          let rawAvailableItems = [];
          let optionUploadUrl = '';
          if (Number(gi.itemCount) > 1) {
            const optRaw = await oyPost('/stock/stock-goods-info-option', { goodsNo: gn });
            if (optRaw && optRaw.status === 'SUCCESS') {
              const optInner = unwrapPayload(optRaw);
              optionUploadUrl = optInner.optionUploadUrl || '';
              options = optInner.goodsInfo?.availableItems || [];
              rawAvailableItems = options.slice();
            }
          }
          if (options.length === 0) {
            options = [
              {
                itemName: gi.goodsName,
                legacyItemNumber: gi.masterGoodsNumber,
                imagePath: gi.goodsThumbnailPath,
                quantity: gi.quantity ?? 0,
                orderableMaximumQuantity: gi.orderableMaximumQuantity,
                deliveredToday: gi.deliveredToday
              }
            ];
          }

          // stock-goods-info-option → 온라인 재고(다옵션)
          const onlineMap = {};
          for (const rawOpt of rawAvailableItems) {
            if (rawOpt.legacyItemNumber) {
              onlineMap[String(rawOpt.legacyItemNumber)] = {
                onlineQty: rawOpt.quantity ?? 0,
                maxOrderQty: rawOpt.orderableMaximumQuantity ?? 0,
                deliveredToday: !!rawOpt.deliveredToday
              };
            }
          }

          const optionResults = [];
          for (const opt of options) {
            const pid = opt.legacyItemNumber;
            if (!pid) continue;

            const imgPath = opt.imagePath || opt.goodsImagePath || opt.goodsThumbnailPath || '';
            const baseUpload = optionUploadUrl || uploadUrl;
            const optImage = imgPath ? baseUpload + imgPath : uploadUrl + (gi.goodsThumbnailPath || '');

            const stRaw = await oyPost('/stock/stock-stores', {
              productId: String(pid),
              lat: LAT,
              lon: LNG,
              pageIdx: 1,
              searchWords: '',
              mapLat: LAT,
              mapLon: LNG
            });

            const stInner = stRaw && stRaw.status === 'SUCCESS' ? unwrapPayload(stRaw) : {};
            const storeList = stInner.storeList || [];
            const stores = storeList.map((s) => ({
              name: s.storeName,
              code: s.storeCode,
              dist: s.distance,
              qty: s.remainQuantity || 0,
              o2o: s.o2oRemainQuantity || 0,
              pickup: yn(s.pickupYn),
              open: yn(s.openYn),
              addr: s.address || s.storeAddr || ''
            }));

            const onlineInfo = onlineMap[String(pid)] || {};

            optionResults.push({
              name: opt.itemName,
              productId: pid,
              image: optImage,
              totalStores: stores.length,
              inStock: stores.filter((s) => s.qty > 0).length,
              totalQty: stores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
              onlineQty: onlineInfo.onlineQty ?? opt.quantity ?? gi.quantity ?? 0,
              maxOrderQty:
                onlineInfo.maxOrderQty ?? opt.orderableMaximumQuantity ?? gi.orderableMaximumQuantity ?? 0,
              deliveredToday: onlineInfo.deliveredToday ?? !!opt.deliveredToday,
              presentable: !!opt.presentable,
              stores: stores.slice(0, 30)
            });

            await sleep(500);
          }

          if (optionResults.length === 0 && (gi.masterGoodsNumber || gi.goodsNumber)) {
            const pid = String(gi.masterGoodsNumber || gi.goodsNumber);
            const stRaw = await oyPost('/stock/stock-stores', {
              productId: pid,
              lat: LAT,
              lon: LNG,
              pageIdx: 1,
              searchWords: '',
              mapLat: LAT,
              mapLon: LNG
            });
            const stInner = stRaw && stRaw.status === 'SUCCESS' ? unwrapPayload(stRaw) : {};
            const storeList = stInner.storeList || [];
            const stores = storeList.map((s) => ({
              name: s.storeName,
              code: s.storeCode,
              dist: s.distance,
              qty: s.remainQuantity || 0,
              o2o: s.o2oRemainQuantity || 0,
              pickup: yn(s.pickupYn),
              open: yn(s.openYn),
              addr: s.address || s.storeAddr || ''
            }));
            optionResults.push({
              name: gi.goodsName || fav.goodsName,
              productId: pid,
              image: uploadUrl + (gi.goodsThumbnailPath || ''),
              totalStores: stores.length,
              inStock: stores.filter((s) => s.qty > 0).length,
              totalQty: stores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
              onlineQty: gi.quantity ?? 0,
              maxOrderQty: gi.orderableMaximumQuantity || 0,
              deliveredToday: !!gi.deliveredToday,
              presentable: !!gi.presentable,
              stores: stores.slice(0, 30)
            });
          }

          const totalInStock = optionResults.reduce((a, o) => a + o.inStock, 0);
          const prevInStock = old?.options
            ? old.options.reduce((a, o) => a + (o.inStock || 0), 0)
            : -1;

          const status = totalInStock > 0 ? 'active' : 'soldout';
          const statusLabel = totalInStock > 0 ? '✅ 재고있음' : '🔴 주변품절';

          const gName = gi.goodsName || fav.goodsName || '';

          // ── 이벤트 기록 ──
          const totalQty = optionResults.reduce((a, o) => a + o.totalQty, 0);
          const prevTotalQty =
            old && old.options ? old.options.reduce((a, o) => a + (o.totalQty || 0), 0) : 0;

          if (!old) {
            events.push({
              type: 'new',
              goodsNo: gn,
              goodsName: gName,
              stores: totalInStock,
              qty: totalQty,
              date: now
            });
          } else if (old.status === 'discontinued') {
            events.push({
              type: 'restocked',
              goodsNo: gn,
              goodsName: gName,
              from: 0,
              to: totalInStock,
              fromQty: 0,
              toQty: totalQty,
              date: now
            });
          }
          if (prevInStock > 0 && totalInStock === 0) {
            events.push({
              type: 'soldout',
              goodsNo: gn,
              goodsName: gName,
              from: prevInStock,
              to: 0,
              fromQty: prevTotalQty,
              toQty: 0,
              date: now
            });
          }
          if (prevInStock === 0 && totalInStock > 0 && old && old.status !== 'discontinued') {
            events.push({
              type: 'back_in_stock',
              goodsNo: gn,
              goodsName: gName,
              from: 0,
              to: totalInStock,
              fromQty: 0,
              toQty: totalQty,
              date: now
            });
          }
          if (
            old &&
            old.status !== 'discontinued' &&
            prevInStock > 0 &&
            totalInStock > 0 &&
            (prevInStock !== totalInStock || prevTotalQty !== totalQty)
          ) {
            events.push({
              type: 'stock_changed',
              goodsNo: gn,
              goodsName: gName,
              from: prevInStock,
              to: totalInStock,
              fromQty: prevTotalQty,
              toQty: totalQty,
              date: now
            });
          }
          // 온라인 재고 변동
          const prevOnlineQty = old?.options
            ? old.options.reduce((a, o) => a + (o.onlineQty || 0), 0)
            : 0;
          const currentOnlineQty = optionResults.reduce((a, o) => a + (o.onlineQty || 0), 0);

          if (old && prevOnlineQty > 0 && currentOnlineQty === 0) {
            events.push({
              type: 'online_soldout',
              goodsNo: gn,
              goodsName: gName,
              from: prevOnlineQty,
              to: 0,
              date: now
            });
          }
          if (old && prevOnlineQty === 0 && currentOnlineQty > 0) {
            events.push({
              type: 'online_back',
              goodsNo: gn,
              goodsName: gName,
              from: 0,
              to: currentOnlineQty,
              date: now
            });
          }
          if (
            old &&
            prevOnlineQty > 0 &&
            currentOnlineQty > 0 &&
            prevOnlineQty !== currentOnlineQty
          ) {
            events.push({
              type: 'online_changed',
              goodsNo: gn,
              goodsName: gName,
              from: prevOnlineQty,
              to: currentOnlineQty,
              date: now
            });
          }
          if (old && old.price != null && old.price !== gi.priceToPay) {
            events.push({
              type: gi.priceToPay < old.price ? 'price_down' : 'price_up',
              goodsNo: gn,
              goodsName: gName,
              from: old.price,
              to: gi.priceToPay,
              date: now
            });
          }

          results[gn] = {
            goodsNo: gn,
            goodsName: gName,
            price: gi.priceToPay,
            originalPrice: gi.originalPrice,
            discountRate: gi.discountRate,
            thumbnail: uploadUrl + (gi.goodsThumbnailPath || ''),
            itemCount: gi.itemCount,
            status,
            statusLabel,
            options: optionResults,
            updatedAt: now
          };

          console.log(`  ✅ ${optionResults.length}옵션 | ${totalInStock}매장 재고 | ${status}`);
          await sleep(1000);
        } catch (e) {
          console.log(`  ❌ ${e.message}`);
          results[gn] = {
            ...(old || {}),
            goodsNo: gn,
            goodsName: old?.goodsName || fav.goodsName,
            status: 'error',
            statusLabel: '⚠️ 오류',
            error: e.message,
            updatedAt: now
          };
        }
      }

      await ctx.close();
      console.log(`\n배치 ${bi + 1} 완료`);
      if (bi < batches.length - 1) await sleep(3000);
    }
  } finally {
    await browser.close();
  }

  const favSet = new Set(favorites.map((f) => String(f.goodsNo)));
  for (const key of Object.keys(results)) {
    if (!favSet.has(key)) {
      if (results[key].status !== 'removed') {
        events.push({
          type: 'removed',
          goodsNo: key,
          goodsName: results[key].goodsName,
          date: now
        });
      }
      delete results[key];
    }
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const vals = Object.values(results);
  const output = {
    updatedAt: now,
    location: CONFIG.location,
    summary: {
      total: vals.length,
      active: vals.filter((p) => p.status === 'active').length,
      soldout: vals.filter((p) => p.status === 'soldout').length,
      discontinued: vals.filter((p) => p.status === 'discontinued').length,
      errors: vals.filter((p) => p.status === 'error').length
    },
    recentEvents: events.slice(0, 100),
    products: results
  };

  fs.writeFileSync(DETAIL_FILE, JSON.stringify(output, null, 2));

  history.events = [...events, ...(history.events || [])].slice(0, 500);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  if (events.length > 0) {
    console.log('\n📋 이벤트:');
    events.forEach((e) => console.log(`  ${e.type}: ${e.goodsName}`));
  }

  console.log(
    `\n✅ 완료: ${output.summary.active}재고 / ${output.summary.soldout}품절 / ${output.summary.discontinued}단종`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
