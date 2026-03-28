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
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    var query = req.query || {};
    var path = query.path;
    if (!path || typeof path !== 'string') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'path parameter required' }));
      return;
    }

    if (path.indexOf('/api/oliveyoung') !== 0) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'only oliveyoung API allowed' }));
      return;
    }

    var params = Object.assign({}, query);
    delete params.path;
    var qs = new URLSearchParams(params).toString();
    var url = 'https://mcp.aka.page' + path + (qs ? '?' + qs : '');

    var controller = new AbortController();
    var timeout = setTimeout(function () {
      controller.abort();
    }, 15000);

    var response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OYStockChecker/5.0'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    var text = await response.text();
    res.statusCode = response.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(text);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
  }
};
