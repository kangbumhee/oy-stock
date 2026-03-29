module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  var q = req.query || {};
  var x = q.x;
  var y = q.y;
  var keyword = q.keyword;

  var key = process.env.KAKAO_REST_KEY || '57bff40a86df8f5961cb43e20c4f4976';

  try {
    var url;
    if (keyword) {
      url =
        'https://dapi.kakao.com/v2/local/search/keyword.json?query=' +
        encodeURIComponent(keyword) +
        '&size=10';
    } else if (x && y) {
      url =
        'https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?x=' +
        encodeURIComponent(x) +
        '&y=' +
        encodeURIComponent(y);
    } else {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'x,y 또는 keyword 필요' }));
      return;
    }

    var r = await fetch(url, {
      headers: { Authorization: 'KakaoAK ' + key }
    });
    var text = await r.text();
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(text);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: e.message }));
  }
};
