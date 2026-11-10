import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

process.env.OY_SERVER_DISABLE_START = '1';
const { server } = await import('./server.mjs');

test('retired Cloud Run endpoint and health flag cannot start a curator browser or call its provider', async t => {
  let launches = 0;
  let upstreamCalls = 0;
  t.mock.method(chromium, 'launch', async () => { launches++; throw new Error('unexpected browser launch'); });
  const previousFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return previousFetch(url, options);
    upstreamCalls++;
    throw new Error('unexpected provider call');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const method of ['GET', 'POST']) {
    const response = await fetch(base + '/api/curator-link?goodsNo=A000000171423', {
      method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{"goodsNo":"A000000171423"}' } : {})
    });
    assert.equal(response.status, 410);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await response.json(), {
      success: false, removed: true, error: 'curator_link_generation_removed'
    });
  }
  const health = await fetch(base + '/health?curator=1&warmCurator=true');
  assert.equal(health.status, 200);
  const payload = await health.json();
  assert.equal(payload.curator, false);
  assert.equal(payload.curatorRemoved, true);
  assert.equal(launches, 0);
  assert.equal(upstreamCalls, 0);
});
