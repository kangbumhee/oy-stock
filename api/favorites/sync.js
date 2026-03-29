module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'POST only' }));
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'kangbumhee/oy-stock';
  const filePath = 'scripts/watchlist.json';

  if (!token) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'GITHUB_TOKEN 환경변수가 설정되지 않았습니다' }));
    return;
  }

  try {
    let body = req.body;
    if (Buffer.isBuffer(body)) {
      body = JSON.parse(body.toString('utf8') || '{}');
    } else if (typeof body === 'string') {
      body = JSON.parse(body || '{}');
    }

    const favorites = body && body.favorites;
    const location = body && body.location;

    if (!favorites || !Array.isArray(favorites)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'favorites 배열이 필요합니다' }));
      return;
    }

    const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    const getRes = await fetch(apiBase, { headers });
    let sha = '';
    let currentData = {};

    if (getRes.ok) {
      const getJson = await getRes.json();
      sha = getJson.sha || '';
      const decoded = Buffer.from(getJson.content, 'base64').toString('utf8');
      currentData = JSON.parse(decoded);
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      throw new Error(`GitHub GET ${getRes.status}: ${errText}`);
    }

    const newData = {
      location:
        location ||
        currentData.location || {
          lat: 37.6152,
          lng: 126.7156,
          name: '김포 사우'
        },
      favorites: favorites.map((f) => ({
        goodsNo: String(f.goodsNo || ''),
        goodsName: f.goodsName || '',
        addedAt: f.addedAt || new Date().toISOString()
      })),
      maxPerRun: currentData.maxPerRun || 50
    };

    const content = Buffer.from(JSON.stringify(newData, null, 2), 'utf8').toString('base64');

    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `⭐ 즐겨찾기 ${favorites.length}개 동기화`,
        content,
        sha: sha || undefined
      })
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      throw new Error(`GitHub API ${putRes.status}: ${err}`);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        success: true,
        count: favorites.length,
        message: `${favorites.length}개 즐겨찾기 동기화 완료`
      })
    );
  } catch (e) {
    console.error('Sync error:', e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, error: e.message || String(e) }));
  }
};
