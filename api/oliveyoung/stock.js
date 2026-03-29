module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'Method not allowed' }));
    return;
  }

  const q = req.query || {};
  const goodsNo = String(q.goodsNo || '').trim();

  if (!goodsNo) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'goodsNo 필요' }));
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      success: false,
      message: '서버 직접 조회 불가. 즐겨찾기에 추가하면 매 시간마다 자동 수집됩니다.',
      goodsNo,
      oliveyoungLink:
        'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNo)
    })
  );
};
