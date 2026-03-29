import http from 'http';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT) || 8080;
const OY = 'https://www.oliveyoung.co.kr';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let page = null;
let sessionReady = false;
let sessionCreatedAt = 0;
let initPromise = null;

const SESSION_MAX_AGE = 10 * 60 * 1000;

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

async function ensureSession() {
  if (initPromise) return initPromise;

  if (sessionReady && page && Date.now() - sessionCreatedAt < SESSION_MAX_AGE) {
    try {
      const test = await page.evaluate(() => document.title);
      if (test) return;
    } catch {
      console.log('세션 만료, 재생성');
    }
  }

  initPromise = _createSession();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function _createSession() {
  console.log('🔄 브라우저 세션 생성 중...');
  const start = Date.now();

  if (page) {
    try {
      await page.close();
    } catch {}
    page = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
  }

  sessionReady = false;

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ko-KR'
  });

  page = await ctx.newPage();
  await page.goto(OY + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  const body = await page.locator('body').innerText();
  if (body.includes('Just a moment') || body.includes('Enable JavaScript')) {
    throw new Error('Cloudflare 챌린지 통과 실패');
  }

  sessionReady = true;
  sessionCreatedAt = Date.now();
  console.log(`✅ 세션 준비 완료 (${((Date.now() - start) / 1000).toFixed(1)}초)`);
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
      const t = await r.text();
      try {
        return { ok: r.ok, status: r.status, data: JSON.parse(t) };
      } catch {
        return { ok: false, status: r.status, data: t };
      }
    },
    { url: OY + '/oystore/api' + apiPath, payload: body }
  );
}

async function getStockDetail(goodsNo, lat, lng) {
  const infoRes = await oyPost('/stock/stock-goods-info-v3', { goodsNo });
  if (!infoRes.ok || !infoRes.data || infoRes.data.status !== 'SUCCESS') {
    return { success: false, error: '상품 조회 실패 (단종 가능성)' };
  }

  const infoInner = unwrapPayload(infoRes.data);
  const gi = infoInner.goodsInfo;
  if (!gi) {
    return { success: false, error: '상품 정보 없음' };
  }

  const uploadUrl = infoInner.goodsUploadUrl || '';
  let optionUploadUrl = '';

  let options = [];
  let rawAvailableItems = [];
  if (Number(gi.itemCount) > 1) {
    const optRes = await oyPost('/stock/stock-goods-info-option', { goodsNo });
    if (optRes.ok && optRes.data && optRes.data.status === 'SUCCESS') {
      const optInner = unwrapPayload(optRes.data);
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
        imagePath: gi.goodsThumbnailPath
      }
    ];
  }

  const onlineMap = {};
  for (const rawOpt of rawAvailableItems) {
    if (rawOpt.legacyItemNumber) {
      onlineMap[String(rawOpt.legacyItemNumber)] = {
        onlineQty: rawOpt.quantity ?? 0,
        maxOrderQty: rawOpt.orderableMaximumQuantity ?? 0,
        deliveredToday: !!rawOpt.deliveredToday,
        presentable: !!rawOpt.presentable
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

    const stRes = await oyPost('/stock/stock-stores', {
      productId: String(pid),
      lat,
      lon: lng,
      pageIdx: 1,
      searchWords: '',
      mapLat: lat,
      mapLon: lng
    });

    const stInner =
      stRes.ok && stRes.data && stRes.data.status === 'SUCCESS' ? unwrapPayload(stRes.data) : {};
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
    const onlineQty =
      onlineInfo.onlineQty != null
        ? onlineInfo.onlineQty
        : opt.quantity != null
          ? opt.quantity
          : gi.quantity ?? 0;

    optionResults.push({
      name: opt.itemName,
      productId: pid,
      image: optImage,
      totalStores: stores.length,
      inStock: stores.filter((s) => s.qty > 0).length,
      totalQty: stores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
      onlineQty,
      maxOrderQty: onlineInfo.maxOrderQty || opt.orderableMaximumQuantity || 0,
      deliveredToday: onlineInfo.deliveredToday || !!opt.deliveredToday,
      presentable: onlineInfo.presentable || !!opt.presentable,
      stores: stores.slice(0, 30)
    });

    await sleep(400);
  }

  if (optionResults.length === 0 && (gi.masterGoodsNumber || gi.goodsNumber)) {
    const pid = String(gi.masterGoodsNumber || gi.goodsNumber);
    const stRes = await oyPost('/stock/stock-stores', {
      productId: pid,
      lat,
      lon: lng,
      pageIdx: 1,
      searchWords: '',
      mapLat: lat,
      mapLon: lng
    });
    const stInner =
      stRes.ok && stRes.data && stRes.data.status === 'SUCCESS' ? unwrapPayload(stRes.data) : {};
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
      name: gi.goodsName,
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
  const gName = gi.goodsName || '';

  return {
    success: true,
    source: 'live',
    goodsNo,
    goodsName: gName,
    price: gi.priceToPay,
    originalPrice: gi.originalPrice,
    discountRate: gi.discountRate,
    thumbnail: uploadUrl + (gi.goodsThumbnailPath || ''),
    itemCount: gi.itemCount,
    status: totalInStock > 0 ? 'active' : 'soldout',
    statusLabel: totalInStock > 0 ? '✅ 재고있음' : '🔴 주변품절',
    options: optionResults,
    updatedAt: new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        session: sessionReady,
        uptime: process.uptime(),
        age: sessionCreatedAt ? Math.floor((Date.now() - sessionCreatedAt) / 1000) : 0
      })
    );
    return;
  }

  if (url.pathname === '/api/stock') {
    const goodsNo = url.searchParams.get('goodsNo');
    const lat = parseFloat(url.searchParams.get('lat')) || 37.6152;
    const lng = parseFloat(url.searchParams.get('lng')) || 126.7156;

    if (!goodsNo) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'goodsNo 필요' }));
      return;
    }

    try {
      await ensureSession();
      const result = await getStockDetail(goodsNo, lat, lng);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('에러:', e.message);
      sessionReady = false;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message || String(e) }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, async () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
  try {
    await ensureSession();
  } catch (e) {
    console.error('초기 세션 실패:', e.message);
  }
});

process.on('SIGTERM', async () => {
  console.log('종료 중...');
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  process.exit(0);
});
