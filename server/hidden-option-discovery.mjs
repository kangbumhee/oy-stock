const DEFAULT_MAX_REVIEW_PAGES = 12;
const DEFAULT_MAX_RELATED_PRODUCTS = 12;
const DEFAULT_MAX_RELATED_DEPTH = 2;
const REVIEW_PAGE_SIZE = 10;
const REVIEW_CURSOR_PATH = '/review/api/v2/reviews/cursor';

function text(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function goodsNumber(value) {
  const normalized = text(value).toUpperCase();
  return /^[AB]\d{6,20}$/.test(normalized) ? normalized : '';
}

function optionNumber(value) {
  const normalized = text(value);
  return /^[a-zA-Z0-9_-]{1,40}$/.test(normalized) ? normalized : '';
}

function productId(value) {
  const normalized = text(value);
  return /^\d{6,20}$/.test(normalized) ? normalized : '';
}

function officialData(payload) {
  if (!payload || payload.status !== 'SUCCESS') return null;
  if (payload.code != null && Number(payload.code) !== 200) return null;
  if (payload.data && typeof payload.data === 'object') return payload.data;
  return payload.goodsInfo ? payload : null;
}

function stockData(payload) {
  const data = officialData(payload);
  if (!data) return null;
  const inner = data.goodsInfo ? data : data.data;
  if (!inner || !inner.goodsInfo || !Array.isArray(inner.goodsInfo.availableItems)) return null;
  return inner;
}

function imageUrl(path, base = '') {
  const value = text(path);
  if (!value) return '';
  try {
    const url = new URL(value, base || 'https://image.oliveyoung.co.kr/uploads/images/goods/');
    return url.protocol === 'https:' && /(^|\.)oliveyoung\.co\.kr$/i.test(url.hostname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function keyFor(goodsNo, itemNumber) {
  return goodsNo + ':' + itemNumber;
}

/**
 * Discovers SKU mappings published in OliveYoung's public option/review APIs.
 * This is not an enumeration of OliveYoung's internal catalog: an option without
 * public review or option evidence cannot be inferred, and a review is not stock.
 * The caller must authenticate paid access and separately fetch inventory only
 * for rows with a non-null productId. No prices are inferred from another option.
 */
export function createHiddenOptionDiscovery({
  request,
  now = Date.now,
  maxReviewPages = DEFAULT_MAX_REVIEW_PAGES,
  maxRelatedDepth = DEFAULT_MAX_RELATED_DEPTH,
  maxRelatedProducts = DEFAULT_MAX_RELATED_PRODUCTS,
  verifiedContinuation = null
} = {}) {
  if (typeof request !== 'function') throw new Error('hidden_option_request_required');
  if (typeof now !== 'function') throw new Error('hidden_option_clock_required');
  if (verifiedContinuation != null && typeof verifiedContinuation !== 'function') throw new Error('hidden_option_continuation_invalid');
  const reviewPageLimit = Math.max(1, Math.min(100, Math.trunc(Number(maxReviewPages)) || DEFAULT_MAX_REVIEW_PAGES));
  const relatedDepthLimit = Number.isFinite(Number(maxRelatedDepth))
    ? Math.max(0, Math.min(4, Math.trunc(Number(maxRelatedDepth))))
    : DEFAULT_MAX_RELATED_DEPTH;
  const relatedProductLimit = Number.isFinite(Number(maxRelatedProducts))
    ? Math.max(1, Math.min(50, Math.trunc(Number(maxRelatedProducts))))
    : DEFAULT_MAX_RELATED_PRODUCTS;
  const productScoped = relatedDepthLimit === 0;

  return async function discover(rawGoodsNo) {
    const rootGoodsNo = goodsNumber(rawGoodsNo);
    if (!rootGoodsNo) throw new Error('hidden_option_goods_no_invalid');
    const observedAt = new Date(now()).toISOString();
    const records = new Map();
    const activeByGoods = new Map();
    const goodsMetadata = new Map();
    const reasons = new Set();
    const relatedGoodsNos = new Set();
    const deferredRelatedGoodsNos = new Set();
    const queued = new Set([rootGoodsNo]);
    const queue = [{ goodsNo: rootGoodsNo, depth: 0 }];
    let scannedReviewPages = 0;
    let hasZeroReviewOption = false;

    async function safeRequest(input) {
      try {
        return await request(input);
      } catch {
        // Provider bodies and errors can include cookies or request headers.
        // Return only deterministic coverage reasons to callers.
        return null;
      }
    }

    function remember({ goodsNo, itemNumber, name, goodsName, sku, image, sourceGoodsNo, evidence, active = false }) {
      const gn = goodsNumber(goodsNo);
      const item = optionNumber(itemNumber);
      if (!gn || !item) return null;
      const key = keyFor(gn, item);
      let row = records.get(key);
      if (!row) {
        row = {
          goodsNo: gn,
          optionNumber: item,
          name: '',
          goodsName: '',
          image: '',
          aliases: new Set(),
          skus: new Set(),
          sourceGoodsNos: new Set([rootGoodsNo]),
          evidence: [],
          active: false
        };
        records.set(key, row);
      }
      const normalizedName = text(name);
      if (normalizedName) {
        row.aliases.add(normalizedName);
        if (!row.name || active) row.name = normalizedName;
      }
      if (text(goodsName) && (!row.goodsName || active)) row.goodsName = text(goodsName);
      if (image && (!row.image || active)) row.image = image;
      const normalizedSku = productId(sku);
      if (normalizedSku) row.skus.add(normalizedSku);
      const source = goodsNumber(sourceGoodsNo);
      if (source) row.sourceGoodsNos.add(source);
      if (active) row.active = true;
      if (evidence && !row.evidence.some((entry) => JSON.stringify(entry) === JSON.stringify(evidence))) {
        row.evidence.push(evidence);
      }
      return row;
    }

    function queueRelated(raw, sourceGoodsNo, depth) {
      const gn = goodsNumber(raw);
      if (!gn || gn === rootGoodsNo) return;
      relatedGoodsNos.add(gn);
      if (queued.has(gn)) return;
      if (depth > relatedDepthLimit || queued.size >= relatedProductLimit) {
        deferredRelatedGoodsNos.add(gn);
        // Background enumeration processes each root separately. A depth-zero
        // call deliberately discovers relationships without recursively scanning
        // them; its completion claim is limited to this product, not its graph.
        if (!productScoped) reasons.add('related_product_limit');
        return;
      }
      deferredRelatedGoodsNos.delete(gn);
      queued.add(gn);
      queue.push({ goodsNo: gn, depth, sourceGoodsNo });
    }

    async function loadActive(goodsNo) {
      const paths = [
        '/oystore/api/stock/stock-goods-info-option',
        '/oystore/api/stock/stock-goods-info-v3'
      ];
      for (const path of paths) {
        const payload = await safeRequest({ method: 'POST', path, body: { goodsNo } });
        const data = stockData(payload);
        if (!data) continue;
        const info = data.goodsInfo;
        const rows = info.availableItems;
        // An invalid item key is not evidence that a historical option vanished.
        if (rows.some((row) => !row || !optionNumber(row.itemNumber))) continue;
        // v3 can include only a partial option subset; its own count must not
        // contradict treating that subset as the complete current option list.
        if (path.endsWith('stock-goods-info-v3') && Number(info.itemCount) > rows.length) continue;
        const active = new Set();
        const metadata = {
          goodsName: text(info.goodsName),
          image: imageUrl(info.goodsThumbnailPath, data.goodsUploadUrl || data.optionUploadUrl)
        };
        goodsMetadata.set(goodsNo, metadata);
        for (const item of rows) {
          const number = optionNumber(item.itemNumber);
          active.add(keyFor(goodsNo, number));
          remember({
            goodsNo,
            itemNumber: number,
            name: item.itemName || item.optionName,
            goodsName: metadata.goodsName,
            sku: item.legacyItemNumber,
            image: imageUrl(item.imagePath || item.goodsImagePath || item.goodsThumbnailPath, data.optionUploadUrl || data.goodsUploadUrl) || metadata.image,
            sourceGoodsNo: goodsNo,
            evidence: { type: 'active-option', goodsNo, optionNumber: number, path, ...(productId(item.legacyItemNumber) ? { productId: productId(item.legacyItemNumber) } : {}) },
            active: true
          });
        }
        activeByGoods.set(goodsNo, active);
        return;
      }
      activeByGoods.set(goodsNo, null);
      reasons.add('active_options_unavailable');
    }

    async function loadCounts(goodsNo, depth) {
      const path = '/review/api/v2/reviews/options/' + encodeURIComponent(goodsNo) + '/count';
      const data = officialData(await safeRequest({ method: 'GET', path }));
      if (!data || !Array.isArray(data.productItemReviewCountList) || !Array.isArray(data.relatedProductReviewCountList)) {
        reasons.add('review_options_unavailable');
        return false;
      }
      if (data.hasZeroReviewOption === true) hasZeroReviewOption = true;
      for (const [type, rows] of [
        ['review-option', data.productItemReviewCountList],
        ['related-review-option', data.relatedProductReviewCountList]
      ]) {
        for (const item of rows) {
          const gn = goodsNumber(item && item.goodsNumber);
          const number = optionNumber(item && item.itemNumber);
          if (!gn || !number || (type === 'review-option' && gn !== goodsNo)) {
            reasons.add('review_option_schema_incomplete');
            continue;
          }
          remember({
            goodsNo: gn,
            itemNumber: number,
            name: item.optionName,
            sourceGoodsNo: goodsNo,
            evidence: { type, goodsNo, optionNumber: number, path }
          });
          if (gn !== goodsNo) queueRelated(gn, goodsNo, depth + 1);
        }
      }
      return true;
    }

    async function resolveReviewOption(goodsNo, target) {
      const seenCursors = new Set();
      let page = 0;
      let continuation = {};
      while (target.skus.size === 0 && scannedReviewPages < reviewPageLimit) {
        const body = {
          ...continuation,
          goodsNumber: goodsNo,
          page,
          size: REVIEW_PAGE_SIZE,
          sortType: 'USEFUL_SCORE_DESC',
          reviewType: 'ALL',
          itemNumberList: [target.optionNumber]
        };
        const data = officialData(await safeRequest({ method: 'POST', path: REVIEW_CURSOR_PATH, body }));
        scannedReviewPages += 1;
        if (!data || !Array.isArray(data.goodsReviewList) || typeof data.hasNext !== 'boolean') {
          reasons.add('review_page_unavailable');
          break;
        }
        if (data.loginRequired === true) {
          reasons.add('review_login_required');
          break;
        }
        for (const review of data.goodsReviewList) {
          const item = review && review.goodsDto;
          if (!item || goodsNumber(item.goodsNumber) !== goodsNo || optionNumber(item.itemNumber) !== target.optionNumber) continue;
          remember({
            goodsNo,
            itemNumber: item.itemNumber,
            name: item.optionName,
            goodsName: item.goodsName,
            sku: item.legacyGoodsNumber,
            image: imageUrl(item.goodsImagePath || item.imagePath || item.goodsThumbnailPath),
            sourceGoodsNo: goodsNo,
            evidence: {
              type: productId(item.legacyGoodsNumber) ? 'review-goods-sku' : 'review-goods',
              goodsNo,
              optionNumber: target.optionNumber,
              ...(productId(item.legacyGoodsNumber) ? { productId: productId(item.legacyGoodsNumber) } : {}),
              path: REVIEW_CURSOR_PATH,
              page,
              ...(text(review.reviewId || review.reviewNumber) ? { reviewId: text(review.reviewId || review.reviewNumber) } : {})
            }
          });
        }
        if (target.skus.size > 0 || !data.hasNext) break;
        const cursor = JSON.stringify([data.nextCursorId, data.nextCursorScore, data.nextCursorCount]);
        if (data.nextCursorId == null || seenCursors.has(cursor)) {
          reasons.add('review_cursor_stalled');
          break;
        }
        seenCursors.add(cursor);
        // Only the first-page itemNumberList schema has been verified live.
        // A provider adapter can supply a subsequently verified cursor schema;
        // otherwise do not pretend that incrementing page advances this API.
        if (!verifiedContinuation) {
          reasons.add('review_continuation_unverified');
          break;
        }
        try {
          continuation = verifiedContinuation({
            goodsNo,
            optionNumber: target.optionNumber,
            page,
            nextCursorId: data.nextCursorId,
            nextCursorScore: data.nextCursorScore,
            nextCursorCount: data.nextCursorCount
          });
        } catch {
          continuation = null;
        }
        if (!continuation || typeof continuation !== 'object' || Array.isArray(continuation)) {
          reasons.add('review_continuation_unavailable');
          break;
        }
        page += 1;
      }
      if (target.skus.size === 0 && scannedReviewPages >= reviewPageLimit) reasons.add('review_page_limit');
    }

    for (let index = 0; index < queue.length; index += 1) {
      const { goodsNo, depth } = queue[index];
      await loadActive(goodsNo);
      await loadCounts(goodsNo, depth);
      const unresolved = [...records.values()].filter((row) => row.goodsNo === goodsNo && row.skus.size === 0);
      for (const target of unresolved) {
        if (scannedReviewPages >= reviewPageLimit) {
          reasons.add('review_page_limit');
          break;
        }
        await resolveReviewOption(goodsNo, target);
      }
    }

    const options = [...records.values()].map((row) => {
      const active = activeByGoods.get(row.goodsNo);
      const metadata = goodsMetadata.get(row.goodsNo) || {};
      if (row.skus.size > 1) reasons.add('conflicting_sku_evidence');
      return {
        goodsNo: row.goodsNo,
        optionNumber: row.optionNumber,
        productId: row.skus.size === 1 ? [...row.skus][0] : null,
        name: row.name || row.optionNumber,
        goodsName: row.goodsName || metadata.goodsName || '',
        hidden: active instanceof Set ? !active.has(keyFor(row.goodsNo, row.optionNumber)) : null,
        ...(row.image || metadata.image ? { image: row.image || metadata.image } : {}),
        aliases: [...row.aliases].filter((name) => name !== row.name),
        sourceGoodsNos: [...row.sourceGoodsNos],
        evidence: row.evidence
      };
    });
    const unresolvedOptionKeys = options
      .filter((row) => !row.productId && (!productScoped || row.goodsNo === rootGoodsNo))
      .map((row) => keyFor(row.goodsNo, row.optionNumber));
    if (unresolvedOptionKeys.length) reasons.add('unresolved_option_skus');
    return {
      options,
      relatedGoodsNos: [...relatedGoodsNos],
      coverage: {
        complete: reasons.size === 0,
        reason: reasons.size ? [...reasons].join(',') : productScoped ? 'product_public_evidence_resolved' : 'public_evidence_resolved',
        scope: productScoped ? 'official-public-product-option-and-review-evidence' : 'official-public-option-and-review-evidence',
        rootGoodsNo,
        maxRelatedDepth: relatedDepthLimit,
        maxRelatedProducts: relatedProductLimit,
        deferredRelatedGoodsNos: [...deferredRelatedGoodsNos],
        deferredOptions: options.filter((row) => deferredRelatedGoodsNos.has(row.goodsNo)).length,
        relatedDiscoveryComplete: deferredRelatedGoodsNos.size === 0,
        unresolvedOptions: unresolvedOptionKeys.length,
        unresolvedOptionKeys,
        scannedReviewPages,
        scannedProducts: queue.length,
        hasZeroReviewOption,
        observedAt
      }
    };
  };
}
