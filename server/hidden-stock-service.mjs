import crypto from 'node:crypto';
import { createHiddenOptionDiscovery } from './hidden-option-discovery.mjs';
import { canonicalHiddenOptions, createHiddenIndexStore, mergeDiscovery, searchHiddenIndex } from './hidden-stock-index.mjs';
import { decodeHiddenCursor, encodeHiddenCursor, readHiddenStoreBatch } from './hidden-store-pages.mjs';
import { createHiddenCollection } from './hidden-collection.mjs';

const goodId = value => /^[AB]\d{6,20}$/.test(String(value || ''));
const stockId = value => /^\d{6,20}$/.test(String(value || ''));
const TTL = 12 * 60 * 60 * 1000;

export function authorizedHiddenService(req, secret) {
  if (!/^[\x21-\x7e]{32,256}$/.test(String(secret || ''))) return false;
  const supplied = String(req.headers?.authorization || '');
  const expected = `Bearer ${secret}`;
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function publicOption(option) {
  return {
    goodsNo: option.goodsNo, optionNumber: option.optionNumber, productId: option.productId,
    name: option.name, goodsName: option.goodsName, hidden: option.hidden,
    image: option.image || '', stale: option.stale === true, discoveredAt: option.discoveredAt || null,
    onlineStatus: option.hidden === true ? 'not_listed' : 'not_checked'
  };
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader?.('Access-Control-Allow-Origin');
  res.end(JSON.stringify(data));
}

export function createHiddenStockService({ request, index = createHiddenIndexStore(), now = Date.now, secret = () => process.env.HIDDEN_STOCK_SERVICE_SECRET, discoveryFactory = createHiddenOptionDiscovery } = {}) {
  let busy = false;
  let collector;
  function collection() {
    if (!collector) collector = createHiddenCollection({
      index, request, now, shouldYield: () => busy,
      discover: async (goodsNo, work = {}) => {
        const deadline = Math.min(now() + 22000, work.deadline || Infinity);
        const result = await discoveryFactory({ now, maxRelatedDepth: 0, maxReviewPages: 4,
          request: async input => {
            if (busy) throw new Error('background_yield');
            if (now() >= deadline || work.signal?.aborted) throw new Error('request_timeout');
            return request(input);
          }
        })(goodsNo);
        // Discovery converts upstream errors into partial evidence. A foreground
        // interruption is not a provider failure and must leave this root queued.
        if (busy) throw new Error('background_yield');
        if (work.signal?.aborted) throw new Error('hidden_collection_deadline');
        return result;
      }
    });
    return collector;
  }
  async function readScanSnapshot() {
    return index.readScan ? { scan: await index.readScan({ fresh: true }) } : index.read({ fresh: true });
  }
  async function changeScan(change) {
    if (!index.mutateScan) return index.mutate(change);
    const scan = await index.mutateScan(current => {
      const holder = { scan: current };
      change(holder);
      if (holder.scan !== current) {
        for (const key of Object.keys(current)) delete current[key];
        Object.assign(current, holder.scan);
      }
    });
    return { scan };
  }
  async function catalogPage(keyword, page, requestFn) {
    const result = await requestFn({ method: 'POST', path: '/oystore/api/stock/product-search-v3', body: {
      includeSoldOut: true, keyword, page, sort: '01', size: 20
    } });
    if (result?.status !== 'SUCCESS' || !Array.isArray(result.data?.serachList) || typeof result.data.nextPage !== 'boolean') throw new Error('catalog_unavailable');
    return result.data;
  }

  async function discoverAndSave(goodsNo, requestFn, fresh = false, graphRequired = true) {
    const saved = index.readProduct ? await index.readProduct(goodsNo) : (await index.read()).products[goodsNo];
    const cacheTtl = saved?.coverage?.complete === true ? TTL : 60000;
    // An incomplete observation is still cached briefly. Otherwise a long
    // nationwide browse would repeat the entire review graph on every store page.
    const graphAvailable = !graphRequired || saved?.coverage?.scope !== 'official-public-product-option-and-review-evidence';
    if (!fresh && saved && graphAvailable && now() - Date.parse(saved.checkedAt) < cacheTtl) return saved;
    const discover = discoveryFactory({ request: requestFn, now, maxReviewPages: 12 });
    const result = await discover(goodsNo);
    if (index.saveDiscovery) return index.saveDiscovery(goodsNo, result, now());
    const updated = await index.mutate(value => mergeDiscovery(value, goodsNo, result, now()));
    return updated.products[goodsNo];
  }

  async function process(query, requestFn, method) {
    const action = query.get('action');
    const serviceSecret = secret();
    if (action === 'status') {
      if (method !== 'GET') throw new Error('method_not_allowed');
      return collection().status();
    }
    if (action === 'collect') {
      if (method !== 'POST') throw new Error('method_not_allowed');
      return collection().step();
    }
    if (action === 'scan') {
      if (method !== 'POST') throw new Error('method_not_allowed');
      let snapshot = await readScanSnapshot();
      if (query.get('refresh') === '1') {
        snapshot = await changeScan(value => {
          value.scan = { page: 1, offset: 0, processed: 0, complete: false, startedAt: new Date(now()).toISOString(),
            ...(value.scan.collection ? { collection: value.scan.collection } : {}) };
        });
      }
      if (snapshot.scan.enumerationComplete) {
        const failed = Object.keys(snapshot.scan.failures || {}).sort();
        if (failed.length) {
          // Retry every unresolved product in turn, not the same failure forever.
          const next = failed.find(id => id > (snapshot.scan.lastRetryGoodsNo || '')) || failed[0];
          const result = await discoverAndSave(next, requestFn, true);
          snapshot = await changeScan(value => {
            if (result.coverage?.complete === true) delete value.scan.failures[next];
            else value.scan.failures[next] = result.coverage?.reason || 'incomplete';
            value.scan.lastRetryGoodsNo = next;
            value.scan.retryAttempts = (value.scan.retryAttempts || 0) + 1;
            value.scan.complete = Object.keys(value.scan.failures || {}).length === 0 &&
              (value.scan.uniqueProducts || 0) >= (value.scan.officialTotal || Infinity);
          });
        }
        return { success: true, scan: snapshot.scan, coverage: indexCoverage(snapshot) };
      }
      const checkpoint = { ...snapshot.scan };
      const page = await catalogPage('', checkpoint.page, requestFn);
      if (!page.serachList.length && page.nextPage) throw new Error('catalog_inconsistent_page');
      const pageKey = crypto.createHash('sha256').update(page.serachList.map(r => r.goodsNumber).join('|')).digest('hex');
      if (checkpoint.offset === 0 && checkpoint.lastPageKey === pageKey) throw new Error('catalog_repeated_page');
      const row = page.serachList[checkpoint.offset];
      let result = null;
      if (row) {
        if (!goodId(row.goodsNumber)) throw new Error('catalog_invalid_product');
        result = await discoverAndSave(row.goodsNumber, requestFn, true);
      }
      snapshot = await changeScan(value => {
        // Another instance can work concurrently; never regress a shared checkpoint.
        if (value.scan.page !== checkpoint.page || value.scan.offset !== checkpoint.offset) return;
        value.scan.failures ||= {};
        value.scan.seen ||= {};
        if (row) {
          if (result.coverage?.complete !== true) value.scan.failures[row.goodsNumber] = result.coverage?.reason || 'incomplete';
          else delete value.scan.failures[row.goodsNumber];
          value.scan.processed = (value.scan.processed || 0) + 1;
          value.scan.seen[row.goodsNumber] = true;
          value.scan.uniqueProducts = Object.keys(value.scan.seen).length;
          value.scan.offset++;
        }
        value.scan.officialTotal = Number(page.totalCount) || null;
        if (!row || value.scan.offset >= page.serachList.length) {
          value.scan.offset = 0;
          value.scan.page++;
          value.scan.lastPageKey = pageKey;
          if (!page.nextPage) {
            value.scan.enumerationComplete = true;
            value.scan.finishedAt = new Date(now()).toISOString();
          }
        }
        value.scan.complete = value.scan.enumerationComplete === true && Object.keys(value.scan.failures).length === 0 &&
          (value.scan.uniqueProducts || 0) >= (value.scan.officialTotal || Infinity);
        value.scan.countMismatch = value.scan.enumerationComplete === true &&
          (value.scan.uniqueProducts || 0) < (value.scan.officialTotal || Infinity);
      });
      return { success: true, scan: snapshot.scan, coverage: indexCoverage(snapshot) };
    }
    if (method !== 'GET') throw new Error('method_not_allowed');
    if (action === 'search') {
      const keyword = String(query.get('keyword') || '').normalize('NFKC').trim();
      if (!keyword || keyword.length > 120 || /[\u0000-\u001f]/.test(keyword)) throw new Error('invalid_keyword');
      const context = `search:${keyword}`;
      const state = decodeHiddenCursor(query.get('cursor'), serviceSecret, context, now()) || { context, page: 1, offset: 0, indexOffset: 0, catalogDone: false, expires: now() + 30 * 60 * 1000 };
      if (![state.page, state.offset, state.indexOffset].every(Number.isInteger) || state.page < 1 || state.page > 2000 || state.offset < 0 || state.offset > 20 || state.indexOffset < 0 || typeof state.catalogDone !== 'boolean') throw new Error('invalid_cursor');
      let reason = '';
      if (!state.catalogDone) {
        try {
          const page = await catalogPage(keyword, state.page, requestFn);
          if (!page.serachList.length && page.nextPage) throw new Error('catalog_inconsistent_page');
          // One parent per request. Follow-up pages advance discovery without a request storm.
          const row = page.serachList[state.offset];
          if (row) {
            if (!goodId(row.goodsNumber)) throw new Error('catalog_invalid_product');
            await discoverAndSave(row.goodsNumber, requestFn);
            state.offset++;
          }
          if (!row || state.offset >= page.serachList.length) {
            state.page++; state.offset = 0;
            if (!page.nextPage) state.catalogDone = true;
          }
        } catch { reason = 'catalog_discovery_unavailable'; }
      }
      const snapshot = await index.read();
      const matches = searchHiddenIndex(snapshot, keyword);
      // Restart paging when discoveries change the index. This may repeat rows but
      // cannot skip a newly inserted key before the previous offset; UI deduplicates.
      if (state.indexVersion !== snapshot.updatedAt) state.indexOffset = 0;
      state.indexVersion = snapshot.updatedAt;
      const options = matches.slice(state.indexOffset, state.indexOffset + 30).map(publicOption);
      state.indexOffset += options.length;
      const more = !state.catalogDone || state.indexOffset < matches.length;
      return {
        success: true, options,
        nextCursor: more ? encodeHiddenCursor(state, serviceSecret) : null,
        coverage: { ...indexCoverage(snapshot), complete: !more && !reason && indexCoverage(snapshot).catalogComplete, reason: reason || (more ? 'more_discovery_pages' : 'indexed_public_options'), queryDiscoveryComplete: state.catalogDone }
      };
    }
    const goodsNo = String(query.get('goodsNo') || '');
    if (!goodId(goodsNo)) throw new Error('invalid_goods_no');
    if (action === 'options') {
      const result = await discoverAndSave(goodsNo, requestFn);
      return { success: true, options: result.options.filter(o => o.hidden === true && o.productId).map(publicOption), nextCursor: null, coverage: result.coverage };
    }
    if (action === 'stores') {
      const productId = String(query.get('productId') || '');
      if (!stockId(productId)) throw new Error('invalid_product_id');
      // Read only the product shard, refreshing its own evidence if needed. A
      // store page must not download the nationwide search catalog on every call.
      const own = await discoverAndSave(goodsNo, requestFn, false, false);
      const matches = canonicalHiddenOptions({ products: { [goodsNo]: own } })
        .filter(o => o.goodsNo === goodsNo && o.productId === productId);
      const option = matches.find(o => o.hidden !== null);
      if (!option) throw new Error('option_not_found');
      // Only verified evidence can address a SKU; no arbitrary SKU enumeration route.
      return { ...await readHiddenStoreBatch({ request: requestFn, goodsNo, productId, cursor: query.get('cursor'), secret: serviceSecret, now }), option: publicOption(option) };
    }
    throw new Error('invalid_action');
  }

  function indexCoverage(snapshot) {
    const collected = snapshot.scan.collection;
    if (collected) {
      const known = Object.values(collected.known || {});
      const queued = Object.keys(collected.queued || {}).length;
      const failed = known.filter(entry => entry.attempts > 0).length;
      const partial = known.filter(entry => entry.partial === true).length;
      const complete = collected.catalog?.enumerationComplete === true && queued === 0 && failed === 0 && partial === 0 && collected.capacityReached !== true;
      return {
        scope: 'indexed-official-public-catalog', indexedProducts: snapshot.products ? Object.keys(snapshot.products).length : null,
        catalogComplete: complete, catalogEnumerationComplete: collected.catalog?.enumerationComplete === true,
        processedProducts: collected.processed || 0, officialTotal: collected.catalog?.officialTotal ?? null,
        uniqueProducts: known.length, catalogCountMismatch: false, failedProducts: failed,
        queuedProducts: queued, partialProducts: partial, allPhysicalInventoryGuaranteed: false
      };
    }
    return {
      scope: 'indexed-official-public-catalog', indexedProducts: snapshot.products ? Object.keys(snapshot.products).length : null,
      catalogComplete: snapshot.scan.complete === true, catalogEnumerationComplete: snapshot.scan.enumerationComplete === true,
      processedProducts: snapshot.scan.processed || 0, officialTotal: snapshot.scan.officialTotal || null,
      uniqueProducts: snapshot.scan.uniqueProducts || 0, catalogCountMismatch: snapshot.scan.countMismatch === true,
      failedProducts: Object.keys(snapshot.scan.failures || {}).length, allPhysicalInventoryGuaranteed: false
    };
  }

  return async function handle(req, res) {
    if (!authorizedHiddenService(req, secret())) return send(res, 401, { success: false, error: 'service_auth_required' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, { success: false, error: 'invalid_query' }); }
    if (url.search.length > 3000) return send(res, 400, { success: false, error: 'invalid_query' });
    const background = ['collect', 'status'].includes(url.searchParams.get('action'));
    if (!background && busy) { res.setHeader('Retry-After', '3'); return send(res, 429, { success: false, error: 'rate_limit_exceeded' }); }
    if (!background) busy = true;
    const deadline = now() + 38000;
    const requestFn = async input => {
      if (now() >= deadline) throw new Error('request_timeout');
      return request(input);
    };
    try { return send(res, 200, await process(url.searchParams, requestFn, req.method)); }
    catch (error) {
      const code = String(error?.message || 'hidden_stock_unavailable');
      const invalid = code.startsWith('invalid_');
      const status = invalid ? 400 : code === 'option_not_found' ? 404 : code === 'method_not_allowed' ? 405 : 503;
      const safe = invalid || ['option_not_found', 'method_not_allowed', 'catalog_unavailable', 'request_timeout'].includes(code);
      return send(res, status, { success: false, error: safe ? code : 'hidden_stock_unavailable' });
    } finally { if (!background) busy = false; }
  };
}
