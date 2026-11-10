const curatorRetired = require('./_curator-retired.js');

// Old purchase bookmarks still open the ordinary product page. No account,
// attribution cache, shortener, or workflow is consulted.
module.exports = function handler(req, res) {
  const query = req.query || {};
  if (req.method !== 'GET' || query.resolve != null || query.check != null || query.format != null) {
    return curatorRetired(req, res);
  }
  const goodsNo = String(query.goodsNo || '').trim().toUpperCase();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!/^[AB]\d{6,20}$/.test(goodsNo)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, error: 'invalid_goodsNo' }));
    return;
  }
  res.statusCode = 302;
  res.setHeader('Location',
    'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNo));
  res.end();
};
