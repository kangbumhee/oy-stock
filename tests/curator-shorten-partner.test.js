const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/oliveyoung/shorten-proxy');

test('shortening rejects a previous client account and uses only the active server partner', async () => {
  const previousPartner = process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID;
  const previousFetch = global.fetch;
  const current = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID = current;
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body)[0].registerId, current);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ shortenedUrl: 'https://oy.run/test-only' }] }) };
  };
  const invoke = async registerId => {
    const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await handler({ method: 'POST', body: {
      originalUrl: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A000000171423&utm_content=OY_test-only', registerId
    } }, res);
    return res;
  };
  try {
    assert.equal((await invoke('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).statusCode, 409);
    assert.equal(calls, 0);
    assert.equal((await invoke(undefined)).statusCode, 200);
    assert.equal(calls, 1);
  } finally {
    global.fetch = previousFetch;
    if (previousPartner == null) delete process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID;
    else process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID = previousPartner;
  }
});
