import crypto from 'node:crypto';

// Province/address searches remove the nearest-stores radius implicit in a blank search.
// Read until an EMPTY page: totalCount is a page count, not the national total.
export const OFFLINE_REGIONS = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기',
  '강원', '충청북도', '충청남도', '전북', '전남', '경상북도', '경상남도', '제주'
];

export function encodeHiddenCursor(value, secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeHiddenCursor(cursor, secret, context, now = Date.now()) {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 1800) throw new Error('invalid_cursor');
  const [payload, sig, extra] = cursor.split('.');
  if (!payload || !sig || extra) throw new Error('invalid_cursor');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('invalid_cursor');
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('invalid_cursor'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.context !== context ||
    !Number.isFinite(value.expires) || value.expires <= now) throw new Error('invalid_cursor');
  return value;
}

function quantity(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
    !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  return Number(value);
}

function coordinate(value, limit) {
  if (!['number', 'string'].includes(typeof value) || String(value).length > 32 ||
    !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(String(value)) || !Number.isFinite(Number(value)) ||
    Math.abs(Number(value)) > limit) throw new Error('invalid_location');
  return Number(value);
}

// Validate before discovery/storage as well as before a stock request. Signed
// continuation must never be transferable to another scope or search origin.
export function validateHiddenStoreQuery({ productId, goodsNo, cursor, secret, scope, lat, lng, now = Date.now() }) {
  if (!/^[AB]\d{6,20}$/.test(String(goodsNo || ''))) throw new Error('invalid_goods_no');
  if (!/^\d{6,20}$/.test(String(productId || ''))) throw new Error('invalid_product_id');
  scope = scope == null ? 'national' : scope;
  if (!['nearby', 'national'].includes(scope)) throw new Error('invalid_scope');
  const locationProvided = lat != null || lng != null;
  if (scope === 'nearby' && !locationProvided) throw new Error('invalid_location');
  const origin = locationProvided ? { lat: coordinate(lat, 90), lng: coordinate(lng, 180) } : { lat: 37.5665, lng: 126.978 };
  const regions = scope === 'nearby' ? [''] : OFFLINE_REGIONS;
  // Keep the old no-location national cursor context compatible with deployed clients.
  const context = `stores:${goodsNo}:${productId}` + (locationProvided || scope === 'nearby' ? `:${scope}:${origin.lat}:${origin.lng}` : '');
  const state = decodeHiddenCursor(cursor, secret, context, now) || { region: 0, page: 1, rows: 0, last: '', context, expires: now + 30 * 60 * 1000 };
  if (!Number.isInteger(state.region) || state.region < 0 || state.region >= regions.length ||
    !Number.isInteger(state.page) || state.page < 1 || state.page > 200 ||
    !Number.isInteger(state.rows) || state.rows < 0 || typeof state.last !== 'string' ||
    (state.last !== '' && !/^[a-f0-9]{24}$/.test(state.last))) throw new Error('invalid_cursor');
  return { scope, origin, regions, state };
}

export async function readHiddenStoreBatch({ request, productId, goodsNo, cursor, secret, scope, lat, lng, now = Date.now, pagesPerBatch = 3 }) {
  const selected = validateHiddenStoreQuery({ productId, goodsNo, cursor, secret, scope, lat, lng, now: now() });
  const { origin, regions, state } = selected;
  const batchLimit = Math.max(1, Math.min(selected.scope === 'nearby' ? 3 : 10, Math.trunc(Number(pagesPerBatch)) || 3));
  const stores = new Map();
  let reason = '';
  let attempts = 0;
  while (state.region < regions.length && attempts < batchLimit) {
    attempts++;
    const region = regions[state.region];
    let response;
    try {
      response = await request({ method: 'POST', path: '/oystore/api/stock/stock-stores', body: {
        productId, lat: origin.lat, lon: origin.lng, pageIdx: state.page,
        searchWords: region, mapLat: origin.lat, mapLon: origin.lng
      } });
      if (response?.status !== 'SUCCESS' || (response.code != null && Number(response.code) !== 200) ||
        !Array.isArray(response.data?.storeList) ||
        (response.data.stockDisplayYn === false && !(response.data.storeList.length === 0 && response.data.totalCount === 0))) throw new Error('unavailable');
    } catch {
      reason = 'store_page_unavailable';
      break;
    }
    const rows = response.data.storeList;
    if (!rows.length) { state.region++; state.page = 1; state.last = ''; continue; }
    const signature = crypto.createHash('sha256').update(rows.map(s => s.storeCode).sort().join('|')).digest('hex').slice(0, 24);
    if (signature === state.last) { reason = 'repeated_store_page'; break; }
    for (const row of rows) {
      const code = String(row.storeCode || '');
      if (!/^[a-zA-Z0-9_-]{1,30}$/.test(code)) continue;
      stores.set(code, {
        code, name: String(row.storeName || ''), addr: String(row.address || row.storeAddr || ''), region,
        // `distance` is the same official km field used by the existing stock UI.
        // No store coordinates are inferred from an address or unknown upstream fields.
        dist: quantity(row.distance),
        qty: quantity(row.remainQuantity), o2o: quantity(row.o2oRemainQuantity),
        salesStore: typeof row.salesStoreYn === 'boolean' ? row.salesStoreYn : null,
        open: row.openYn === true || row.openYn === 'Y',
        pickup: row.pickupYn === true || row.pickupYn === 'Y', checkedAt: new Date(now()).toISOString()
      });
    }
    state.rows += rows.length;
    state.last = signature;
    state.page++;
    if (state.page > 200) { reason = 'store_page_limit'; break; }
  }
  const complete = state.region >= regions.length;
  return {
    success: true, scope: selected.scope,
    stores: [...stores.values()].sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity)),
    nextCursor: complete || ['repeated_store_page', 'store_page_limit'].includes(reason) ? null : encodeHiddenCursor(state, secret),
    coverage: {
      complete, scope: selected.scope === 'nearby' ? 'official-nearby-search' : 'official-province-search', origin,
      scannedRegions: state.region, totalRegions: regions.length,
      observedRows: state.rows, reason: reason || (complete ? 'public_pages_exhausted' : 'more_pages'),
      allPhysicalInventoryGuaranteed: false, checkedAt: new Date(now()).toISOString()
    }
  };
}
