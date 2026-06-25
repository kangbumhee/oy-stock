const QUEUE_TTL_MS = 30 * 60 * 1000;
const RECENT_ERROR_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_GOODS = 260;
const ON_DEMAND_WORKFLOW_FILE = 'curator-link-on-demand.yml';

const queuedCache = new Map();

function parseGithubRepo() {
  const rawRepo = String(process.env.GITHUB_REPO || 'kangbumhee/oy-stock').trim();
  const rawOwner = String(process.env.GITHUB_OWNER || '').trim();
  if (rawRepo.includes('/')) {
    const parts = rawRepo.split('/');
    return { owner: parts[0], repo: parts[1] };
  }
  return { owner: rawOwner || 'kangbumhee', repo: rawRepo || 'oy-stock' };
}

function githubToken() {
  return (
    String(process.env.CURATOR_GITHUB_TOKEN || '').trim() ||
    String(process.env.GITHUB_TOKEN || '').trim()
  );
}

function normalizeGoodsNo(goodsNo) {
  const gn = String(goodsNo || '').trim().toUpperCase();
  return /^[AB]\d+$/.test(gn) ? gn : '';
}

function uniqueGoodsNos(values) {
  const out = [];
  const seen = new Set();
  (Array.isArray(values) ? values : String(values || '').split(/[\s,;]+/)).forEach((value) => {
    const goodsNo = normalizeGoodsNo(value);
    if (!goodsNo || seen.has(goodsNo)) return;
    seen.add(goodsNo);
    out.push(goodsNo);
  });
  return out;
}

function maxGoods() {
  const n = Number.parseInt(String(process.env.CURATOR_QUEUE_MAX_GOODS || DEFAULT_MAX_GOODS), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 260) : DEFAULT_MAX_GOODS;
}

function pruneQueueCache() {
  const now = Date.now();
  for (const [goodsNo, ts] of queuedCache) {
    if (now - ts > QUEUE_TTL_MS) queuedCache.delete(goodsNo);
  }
}

function githubCuratorApiUrl() {
  const { owner, repo } = parseGithubRepo();
  const branch = String(process.env.GITHUB_BRANCH || 'main').trim() || 'main';
  const filePath =
    String(process.env.CURATOR_LINKS_FILE || 'public/data/curator-links.json')
      .trim()
      .replace(/^\/+/, '') || 'public/data/curator-links.json';
  const encodedPath = filePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return (
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
  );
}

function githubCuratorRawUrl() {
  const { owner, repo } = parseGithubRepo();
  const branch = String(process.env.GITHUB_BRANCH || 'main').trim() || 'main';
  const filePath =
    String(process.env.CURATOR_LINKS_FILE || 'public/data/curator-links.json')
      .trim()
      .replace(/^\/+/, '') || 'public/data/curator-links.json';
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${filePath}`;
}

function hostedCuratorUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers.host;
  if (!host) return '';
  return `${proto}://${host}/data/curator-links.json`;
}

async function fetchCuratorLinksFrom(url, source) {
  const token = githubToken();
  const headers = {
    Accept: source === 'github_api' ? 'application/vnd.github+json' : 'application/json',
    'User-Agent': 'oy-stock-curator-queue'
  };
  if (source === 'github_api' && token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-GitHub-Api-Version'] = '2022-11-28';
  }
  const requestUrl =
    source === 'github_raw' ? url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now() : url;
  const response = await fetch(requestUrl, {
    headers,
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`${source} HTTP ${response.status}`);
  const json = await response.json();
  if (source !== 'github_api') return json;
  const content = String(json && json.content ? json.content : '').replace(/\s+/g, '');
  if (!content) throw new Error('empty github content');
  return JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
}

async function loadCuratorLinks(req) {
  const candidates = [
    [githubCuratorRawUrl(), 'github_raw'],
    [hostedCuratorUrl(req), 'host_static'],
    [githubCuratorApiUrl(), 'github_api']
  ];
  const errors = [];
  for (const [url, source] of candidates) {
    if (!url) continue;
    try {
      const data = await fetchCuratorLinksFrom(url, source);
      if (data && data.links) return data;
      errors.push(`${source}: invalid curator data`);
    } catch (e) {
      errors.push(`${source}: ${e.message || e}`);
    }
  }
  throw new Error(errors.join(' | ') || 'curator links load failed');
}

function shouldGenerate(entry) {
  if (!entry) return true;
  if (entry.shortenedUrl || entry.originalUrl) return false;
  if (!entry.error || !entry.generatedAt) return true;
  const t = Date.parse(entry.generatedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > RECENT_ERROR_TTL_MS;
}

async function triggerWorkflow(goodsNos) {
  const token = githubToken();
  if (!token) return { ok: false, status: 'missing_github_token' };

  const { owner, repo } = parseGithubRepo();
  const workflow = String(process.env.CURATOR_ON_DEMAND_WORKFLOW || ON_DEMAND_WORKFLOW_FILE).trim();
  const branch = String(process.env.GITHUB_BRANCH || 'main').trim() || 'main';
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'oy-stock-curator-queue',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      ref: branch,
      inputs: { goodsNos: goodsNos.join(',') }
    })
  });
  const text = await response.text();
  if (response.status === 204 || response.ok) return { ok: true, status: 'queued' };
  return {
    ok: false,
    status: `github_dispatch_failed_${response.status}`,
    detail: text.slice(0, 200)
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'POST only' }));
    return;
  }

  try {
    let body = req.body;
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8') || '{}');
    else if (typeof body === 'string') body = JSON.parse(body || '{}');

    const requested = uniqueGoodsNos(body && (body.goodsNos || body.goodsNo)).slice(0, maxGoods());
    if (!requested.length) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, queuedCount: 0, skippedCount: 0 }));
      return;
    }

    pruneQueueCache();
    const data = await loadCuratorLinks(req);
    const links = (data && data.links) || {};
    const missing = requested.filter((goodsNo) => {
      if (queuedCache.has(goodsNo)) return false;
      return shouldGenerate(links[goodsNo]);
    });

    if (!missing.length) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          success: true,
          queuedCount: 0,
          skippedCount: requested.length,
          sourceUpdatedAt: data && data.updatedAt
        })
      );
      return;
    }

    const result = await triggerWorkflow(missing);
    if (result.ok) {
      const now = Date.now();
      missing.forEach((goodsNo) => queuedCache.set(goodsNo, now));
    }

    res.statusCode = result.ok ? 200 : 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        success: result.ok,
        queuedCount: result.ok ? missing.length : 0,
        skippedCount: requested.length - missing.length,
        requestedCount: requested.length,
        goodsNos: result.ok ? missing : [],
        status: result.status,
        detail: result.detail
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: String(e.message || e) }));
  }
};
