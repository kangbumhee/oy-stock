const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const REDIRECT_MODULE = path.join(
  __dirname,
  '..',
  'api',
  'oliveyoung',
  'curator-redirect.js'
);
const QUEUE_MODULE = path.join(__dirname, '..', 'api', 'oliveyoung', 'curator-queue.js');

function response(payload, status = 200) {
  const text = payload == null ? '' : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async function () {
      return payload;
    },
    text: async function () {
      return text;
    }
  };
}

function githubContent(payload) {
  return {
    content: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  };
}

function request(method, query, body) {
  return {
    method,
    query: query || {},
    body,
    headers: {
      host: 'olivestock.co.kr',
      'x-forwarded-proto': 'https',
      'user-agent': 'Mozilla/5.0'
    }
  };
}

function resultCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader: function (name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    writeHead: function (statusCode, headers) {
      this.statusCode = statusCode;
      Object.entries(headers || {}).forEach(([name, value]) => this.setHeader(name, value));
    },
    end: function (body) {
      this.body = body == null ? '' : String(body);
    }
  };
}

function saveEnvironment(names) {
  const saved = {};
  names.forEach((name) => {
    saved[name] = process.env[name];
  });
  return function restore() {
    names.forEach((name) => {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    });
  };
}

test('original-only click queues once, waits, then becomes ready only with oy.run', async () => {
  const goodsNo = 'A000000227282';
  const originalUrl =
    'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
    goodsNo +
    '&utm_source=shutter&utm_medium=affiliate&utm_content=OY_original_only';
  const shortUrl = 'https://oy.run/generatedForClick';
  let curatorData = {
    updatedAt: '2026-09-06T00:00:00.000Z',
    links: {
      [goodsNo]: { shortenedUrl: null, originalUrl, affiliateActivityId: 'original_only' }
    }
  };
  const dispatches = [];
  const previousFetch = global.fetch;
  const restoreEnv = saveEnvironment([
    'CURATOR_GITHUB_TOKEN',
    'GITHUB_TOKEN',
    'DISABLE_CURATOR_WORKFLOW_QUEUE',
    'ENABLE_CURATOR_WORKFLOW_QUEUE'
  ]);

  process.env.CURATOR_GITHUB_TOKEN = 'test-token';
  delete process.env.GITHUB_TOKEN;
  delete process.env.DISABLE_CURATOR_WORKFLOW_QUEUE;
  delete process.env.ENABLE_CURATOR_WORKFLOW_QUEUE;
  global.fetch = async function (input, init) {
    const url = String(input);
    if (url.includes('/actions/workflows/') && url.endsWith('/dispatches')) {
      dispatches.push(JSON.parse(init.body));
      return response(null, 204);
    }
    if (url.includes('/contents/public/data/curator-links.json')) {
      return response(githubContent(curatorData));
    }
    throw new Error('unexpected fetch: ' + url);
  };

  delete require.cache[require.resolve(REDIRECT_MODULE)];
  const handler = require(REDIRECT_MODULE);

  try {
    const first = resultCapture();
    await handler(
      request('GET', { goodsNo, direct: '1', noLive: '1' }),
      first
    );
    assert.equal(first.statusCode, 200);
    assert.match(first.headers['content-type'], /^text\/html/);
    assert.match(first.body, /구매 링크 준비 중/);
    assert.match(first.body, /data\.unavailable === true/);
    assert.match(first.body, /retryBtn\.disabled = true/);
    assert.doesNotMatch(first.body, new RegExp(originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(first.headers.location, undefined);
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0].inputs, { goodsNos: goodsNo });

    const repeated = resultCapture();
    await handler(
      request('GET', { goodsNo, direct: '1', noLive: '1' }),
      repeated
    );
    assert.equal(repeated.statusCode, 200);
    assert.equal(dispatches.length, 1);

    curatorData = {
      updatedAt: '2026-09-06T00:01:00.000Z',
      links: {
        [goodsNo]: { shortenedUrl: shortUrl }
      }
    };
    const poll = resultCapture();
    await handler(
      request('GET', {
        goodsNo,
        format: 'json',
        refresh: '1',
        noTrigger: '1',
        noLive: '1'
      }),
      poll
    );
    const pollJson = JSON.parse(poll.body);
    assert.equal(pollJson.ready, true);
    assert.equal(pollJson.pending, false);
    assert.equal(pollJson.shortenedUrl, shortUrl);
    assert.equal(pollJson.redirectUrl, shortUrl);
    assert.equal(dispatches.length, 1);

    const ready = resultCapture();
    await handler(request('GET', { goodsNo, direct: '1', noLive: '1' }), ready);
    assert.equal(ready.statusCode, 302);
    assert.equal(ready.headers.location, shortUrl);
    assert.equal(dispatches.length, 1);
  } finally {
    global.fetch = previousFetch;
    restoreEnv();
    delete require.cache[require.resolve(REDIRECT_MODULE)];
  }
});

test('a current affiliate-unavailable result fails closed instead of opening the long URL', async () => {
  const goodsNo = 'A000000299999';
  const originalUrl =
    'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
    goodsNo +
    '&utm_source=shutter&utm_medium=affiliate&utm_content=OY_unavailable';
  const curatorData = {
    updatedAt: '2026-09-06T00:00:00.000Z',
    links: {
      [goodsNo]: {
        shortenedUrl: null,
        originalUrl,
        error: 'affiliate_link_unavailable',
        generatedAt: '2026-09-06T00:00:00.000Z',
        retryAfter: '2099-01-01T00:00:00.000Z'
      }
    }
  };
  const previousFetch = global.fetch;
  const restoreEnv = saveEnvironment(['CURATOR_GITHUB_TOKEN', 'GITHUB_TOKEN']);

  process.env.CURATOR_GITHUB_TOKEN = 'test-token';
  delete process.env.GITHUB_TOKEN;
  global.fetch = async function (input) {
    const url = String(input);
    if (url.includes('/contents/public/data/curator-links.json')) {
      return response(githubContent(curatorData));
    }
    throw new Error('unexpected fetch: ' + url);
  };

  delete require.cache[require.resolve(REDIRECT_MODULE)];
  const handler = require(REDIRECT_MODULE);

  try {
    const res = resultCapture();
    await handler(request('GET', { goodsNo, direct: '1', noLive: '1' }), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /큐레이터 링크를 만들 수 없습니다/);
    assert.equal(res.headers.location, undefined);
    assert.doesNotMatch(res.body, /utm_content=OY_unavailable/);
  } finally {
    global.fetch = previousFetch;
    restoreEnv();
    delete require.cache[require.resolve(REDIRECT_MODULE)];
  }
});

test('queue dispatches original-only entries but skips ready oy.run entries', async () => {
  const originalOnly = 'A000000227282';
  const readyGoods = 'A000000259555';
  const curatorData = {
    updatedAt: '2026-09-06T00:00:00.000Z',
    links: {
      [originalOnly]: {
        shortenedUrl: null,
        originalUrl:
          'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
          originalOnly +
          '&utm_content=OY_original_only'
      },
      [readyGoods]: { shortenedUrl: 'https://oy.run/Ce4LgyvwPAnGaa' }
    }
  };
  const dispatches = [];
  const previousFetch = global.fetch;
  const restoreEnv = saveEnvironment(['CURATOR_GITHUB_TOKEN', 'GITHUB_TOKEN']);

  process.env.CURATOR_GITHUB_TOKEN = 'test-token';
  delete process.env.GITHUB_TOKEN;
  global.fetch = async function (input, init) {
    const url = String(input);
    if (url.includes('/actions/workflows/') && url.endsWith('/dispatches')) {
      dispatches.push(JSON.parse(init.body));
      return response(null, 204);
    }
    if (url.includes('raw.githubusercontent.com/')) return response(curatorData);
    throw new Error('unexpected fetch: ' + url);
  };

  delete require.cache[require.resolve(QUEUE_MODULE)];
  const handler = require(QUEUE_MODULE);

  try {
    const res = resultCapture();
    await handler(request('POST', {}, { goodsNos: [originalOnly, readyGoods] }), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.queuedCount, 1);
    assert.equal(body.skippedCount, 1);
    assert.deepEqual(body.goodsNos, [originalOnly]);
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0].inputs, { goodsNos: originalOnly });
  } finally {
    global.fetch = previousFetch;
    restoreEnv();
    delete require.cache[require.resolve(QUEUE_MODULE)];
  }
});
