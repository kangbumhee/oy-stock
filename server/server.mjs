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

  // 워밍업: 상품 상세 방문으로 쿠키·세션 강화 (stock-stores 차단 완화)
  try {
    await page.goto(
      OY + '/store/goods/getGoodsDetail.do?goodsNo=A000000207822',
      { waitUntil: 'domcontentloaded', timeout: 15000 }
    );
    await sleep(3000);
    await page.goto(OY + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
  } catch (e) {
    console.log('워밍업 스킵:', e.message);
  }

  sessionReady = true;
  sessionCreatedAt = Date.now();
  console.log(`✅ 세션 준비 완료 (${((Date.now() - start) / 1000).toFixed(1)}초)`);
}

async function oyPost(apiPath, body) {
  if (!page || !sessionReady) {
    await ensureSession();
  }
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

async function oyPostWithRetry(apiPath, body, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await oyPost(apiPath, body);

      if (apiPath.includes('stock-stores')) {
        const inner =
          res.ok && res.data && res.data.status === 'SUCCESS' ? unwrapPayload(res.data) : {};
        const stores = inner.storeList || [];

        if (stores.length === 0 && attempt < retries) {
          console.log(
            '⚠️ stock-stores 빈 응답, 세션 리셋 시도... (attempt ' + (attempt + 1) + ')'
          );
          sessionReady = false;
          try {
            await ensureSession();
          } catch (e) {
            console.error('세션 리셋 실패:', e.message);
          }
          continue;
        }
      }
      return res;
    } catch (e) {
      console.error('oyPostWithRetry 에러 (attempt ' + attempt + '):', e.message);
      if (attempt < retries) {
        sessionReady = false;
        try {
          await ensureSession();
        } catch (e2) {
          console.error('세션 리셋 실패:', e2.message);
        }
        continue;
      }
      return { ok: false, status: 500, data: { error: e.message } };
    }
  }
  return { ok: false, status: 500, data: { error: 'max retries' } };
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
    let optPage = null;
    try {
      optPage = await page.context().newPage();
      await optPage.goto(
        OY + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNo),
        { waitUntil: 'domcontentloaded', timeout: 15000 }
      );
      await sleep(2000);
      const optJson = await optPage.evaluate(async (gn) => {
        const res = await fetch('/oystore/api/stock/stock-goods-info-option', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: JSON.stringify({ goodsNo: gn })
        });
        const t = await res.text();
        try {
          return JSON.parse(t);
        } catch {
          return null;
        }
      }, goodsNo);
      if (optJson && optJson.status === 'SUCCESS') {
        const optInner = unwrapPayload(optJson);
        optionUploadUrl = optInner.optionUploadUrl || '';
        options = optInner.goodsInfo?.availableItems || [];
        rawAvailableItems = options.slice();
        console.log('[옵션] 새탭 성공, items:', rawAvailableItems.length);
      }
    } catch (e) {
      console.log('[옵션] 새탭 실패:', e.message);
    } finally {
      if (optPage) {
        try {
          await optPage.close();
        } catch {}
      }
    }
  }
  // option API가 ERROR/차단일 때 v3 goodsInfo.availableItems로 온라인 수량·오늘배송 복구
  if (
    Array.isArray(gi.availableItems) &&
    gi.availableItems.length > 0 &&
    rawAvailableItems.length === 0
  ) {
    rawAvailableItems = gi.availableItems.slice();
    console.log('[옵션] v3 availableItems fallback (onlineMap), items:', rawAvailableItems.length);
    if (options.length === 0 && Number(gi.itemCount) > 1) {
      options = gi.availableItems.slice();
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

  console.log(
    '[디버그] optionData:',
    JSON.stringify(
      (rawAvailableItems || []).map((i) => ({
        leg: i.legacyItemNumber,
        qty: i.quantity,
        today: i.deliveredToday
      }))
    )
  );

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

  console.log('[디버그] onlineMap keys:', Object.keys(onlineMap));

  const optionResults = [];
  for (const opt of options) {
    const pid = opt.legacyItemNumber;
    if (!pid) continue;

    const imgPath = opt.imagePath || opt.goodsImagePath || opt.goodsThumbnailPath || '';
    const baseUpload = optionUploadUrl || uploadUrl;
    const optImage = imgPath ? baseUpload + imgPath : uploadUrl + (gi.goodsThumbnailPath || '');

    const stRes = await oyPostWithRetry('/stock/stock-stores', {
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

    console.log(
      '[디버그] 매핑시도 key:',
      String(pid),
      '→ found:',
      !!onlineMap[String(pid)]
    );

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

const REGIONS = [
  { name: '서울', lat: 37.5665, lng: 126.978 },
  { name: '인천/김포', lat: 37.5075, lng: 126.7219 },
  { name: '경기 남부', lat: 37.2636, lng: 127.0286 },
  { name: '경기 북부', lat: 37.658, lng: 126.771 },
  { name: '부산', lat: 35.1576, lng: 129.0596 },
  { name: '대구', lat: 35.8691, lng: 128.595 },
  { name: '대전', lat: 36.3504, lng: 127.3845 },
  { name: '광주', lat: 35.1492, lng: 126.9173 },
  { name: '울산', lat: 35.5399, lng: 129.3379 },
  { name: '제주', lat: 33.489, lng: 126.4983 }
];

async function getStockAllRegions(goodsNo, targetProductId) {
  const infoRes = await oyPost('/stock/stock-goods-info-v3', { goodsNo });
  if (!infoRes.ok || !infoRes.data || infoRes.data.status !== 'SUCCESS') {
    return { success: false, error: '상품 조회 실패' };
  }
  const infoInner = unwrapPayload(infoRes.data);
  const gi = infoInner.goodsInfo;
  if (!gi) return { success: false, error: '상품 정보 없음' };

  const uploadUrl = infoInner.goodsUploadUrl || '';

  let options = [];
  let optionUploadUrl = '';
  if (Number(gi.itemCount) > 1) {
    const optRes = await oyPost('/stock/stock-goods-info-option', { goodsNo });
    if (optRes.ok && optRes.data && optRes.data.status === 'SUCCESS') {
      const optInner = unwrapPayload(optRes.data);
      optionUploadUrl = optInner.optionUploadUrl || '';
      options = optInner.goodsInfo?.availableItems || [];
    }
  }
  if (options.length === 0) {
    options = [
      {
        itemName: gi.goodsName,
        legacyItemNumber: gi.masterGoodsNumber,
        imagePath: gi.goodsThumbnailPath,
        quantity: gi.quantity ?? 0
      }
    ];
  }

  if (targetProductId) {
    const filtered = options.filter((o) => String(o.legacyItemNumber) === String(targetProductId));
    if (filtered.length === 0) {
      return { success: false, error: '해당 옵션을 찾을 수 없음' };
    }
    options = filtered;
  }

  const half = Math.ceil(REGIONS.length / 2);
  const batch1 = REGIONS.slice(0, half);
  const batch2 = REGIONS.slice(half);

  async function fetchStoresForRegions(pid, regions) {
    const promises = regions.map((region) =>
      oyPostWithRetry('/stock/stock-stores', {
        productId: String(pid),
        lat: region.lat,
        lon: region.lng,
        pageIdx: 1,
        searchWords: '',
        mapLat: region.lat,
        mapLon: region.lng
      })
        .then((stRes) => {
          const stInner =
            stRes.ok && stRes.data && stRes.data.status === 'SUCCESS'
              ? unwrapPayload(stRes.data)
              : {};
          return (stInner.storeList || []).map((s) => ({
            name: s.storeName,
            code: s.storeCode,
            region: region.name,
            qty: s.remainQuantity || 0,
            o2o: s.o2oRemainQuantity || 0,
            pickup: yn(s.pickupYn),
            open: yn(s.openYn),
            addr: s.address || s.storeAddr || ''
          }));
        })
        .catch(() => [])
    );
    const settled = await Promise.all(promises);
    return settled.flat();
  }

  async function fetchStoresAllRegions(pid) {
    const r1 = await fetchStoresForRegions(pid, batch1);
    await sleep(1000);
    const r2 = await fetchStoresForRegions(pid, batch2);
    return [...r1, ...r2];
  }

  const optionResults = [];

  for (const opt of options) {
    const pid = opt.legacyItemNumber;
    if (!pid) continue;

    const imgPath = opt.imagePath || opt.goodsImagePath || opt.goodsThumbnailPath || '';
    const baseUpload = optionUploadUrl || uploadUrl;
    const optImage = imgPath ? baseUpload + imgPath : uploadUrl + (gi.goodsThumbnailPath || '');

    const regionStores = await fetchStoresAllRegions(pid);

    const storeMap = {};
    regionStores.forEach((s) => {
      if (!s.code) return;
      if (!storeMap[s.code] || storeMap[s.code].qty < s.qty) {
        storeMap[s.code] = s;
      }
    });

    const allStores = Object.values(storeMap).sort((a, b) => b.qty - a.qty);

    optionResults.push({
      name: opt.itemName,
      productId: pid,
      image: optImage,
      onlineQty: opt.quantity ?? 0,
      totalStores: allStores.length,
      inStock: allStores.filter((s) => s.qty > 0).length,
      totalQty: allStores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
      stores: allStores.slice(0, 100)
    });

    await sleep(300);
  }

  if (
    optionResults.length === 0 &&
    !targetProductId &&
    (gi.masterGoodsNumber || gi.goodsNumber)
  ) {
    const pid = String(gi.masterGoodsNumber || gi.goodsNumber);
    const optImage = uploadUrl + (gi.goodsThumbnailPath || '');
    const regionStores = await fetchStoresAllRegions(pid);
    const storeMap = {};
    regionStores.forEach((s) => {
      if (!s.code) return;
      if (!storeMap[s.code] || storeMap[s.code].qty < s.qty) {
        storeMap[s.code] = s;
      }
    });
    const allStores = Object.values(storeMap).sort((a, b) => b.qty - a.qty);
    optionResults.push({
      name: gi.goodsName,
      productId: pid,
      image: optImage,
      onlineQty: gi.quantity ?? 0,
      totalStores: allStores.length,
      inStock: allStores.filter((s) => s.qty > 0).length,
      totalQty: allStores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
      stores: allStores.slice(0, 100)
    });
  }

  try {
    await page.goto(OY + '/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(2000);
  } catch (e) {
    console.log('세션 리프레시 스킵:', e.message);
  }

  return {
    success: true,
    source: 'live-all',
    goodsNo,
    goodsName: gi.goodsName || '',
    price: gi.priceToPay,
    originalPrice: gi.originalPrice,
    discountRate: gi.discountRate,
    thumbnail: uploadUrl + (gi.goodsThumbnailPath || ''),
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

  if (url.pathname === '/api/stock-all') {
    const goodsNo = url.searchParams.get('goodsNo');
    const productId = url.searchParams.get('productId');
    if (!goodsNo) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'goodsNo 필요' }));
      return;
    }

    try {
      await ensureSession();
      const result = await getStockAllRegions(goodsNo, productId || null);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('전국재고 에러:', e.message);
      sessionReady = false;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
