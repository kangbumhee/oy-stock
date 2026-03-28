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
  const keyword = q.keyword;
  const lat = q.lat || '37.6152';
  const lng = q.lng || '126.7156';
  const size = q.size || '1';

  if (!keyword) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'keyword required' }));
    return;
  }

  try {
    const url =
      'https://mcp.aka.page/api/oliveyoung/inventory?keyword=' +
      encodeURIComponent(keyword) +
      '&lat=' +
      encodeURIComponent(lat) +
      '&lng=' +
      encodeURIComponent(lng) +
      '&size=' +
      encodeURIComponent(size);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'OliveyoungStockChecker/1.0' },
      signal: controller.signal
    });
    clearTimeout(t);

    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(text);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: e.message || 'Inventory proxy error' }));
  }
};
