const { Readable } = require('stream');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  try {
    var path = (req.query && req.query.path) || '';
    if (!path || typeof path !== 'string' || path.charAt(0) !== '/') {
      res.statusCode = 400;
      res.end('path parameter required');
      return;
    }

    if (!/^\/(stream|download|serve)\//.test(path)) {
      res.statusCode = 403;
      res.end('archive path not allowed');
      return;
    }

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      res.end();
      return;
    }

    var headers = {
      'User-Agent': 'OliveStockArcade/1.0',
      Accept: '*/*'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    var response = await fetch('https://archive.org' + path, {
      method: req.method,
      headers: headers,
      redirect: 'follow'
    });

    res.statusCode = response.status;
    [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
      'cache-control'
    ].forEach(function (h) {
      if (req.method === 'HEAD' && h === 'content-length') return;
      var v = response.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    res.setHeader('Cache-Control', response.headers.get('cache-control') || 'public, max-age=3600, s-maxage=86400');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    if (response.body && Readable.fromWeb) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      var buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(err.message || 'Archive proxy failed');
  }
};
