const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/ui.js'), 'utf8');
const GOODS_NO = 'A000000100001';
const SECOND_GOODS_NO = 'A000000100002';
const PARTNER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACTIVITY_ID = 'cccccccccccccccccccccccccccccccc';
const SHORT_URL = 'https://oy.run/CopyFixtureFirst';
const SECOND_SHORT_URL = 'https://oy.run/CopyFixtureSecond';
const PRIVATE_URL = 'https://member-fixture.example/api/oliveyoung/curator-redirect?goodsNo=' + GOODS_NO;
const ORIGINAL_URL = 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' + GOODS_NO +
  '&utm_source=shutter&utm_medium=affiliate&utm_content=OY_' + ACTIVITY_ID;
const LABEL = '큐레이터 링크 복사';

function entry(overrides) {
  return Object.assign({
    shortenedUrl: SHORT_URL,
    affiliatePartnerId: PARTNER_ID,
    affiliateActivityId: ACTIVITY_ID,
    originalUrl: ORIGINAL_URL
  }, overrides);
}

function copyButton(goodsNo = GOODS_NO) {
  return {
    dataset: { action: 'copyCuratorLink', goodsno: goodsNo },
    textContent: LABEL,
    disabled: false,
    isConnected: true,
    style: {},
    attributes: {},
    getAttribute(name) {
      return name === 'data-original-label' ? LABEL : this.attributes[name] || null;
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() {}
  };
}

function environment(options = {}) {
  const fetches = [];
  const clipboardAttempts = [];
  const copied = [];
  const fallbackCopied = [];
  const prompts = [];
  const elements = [];
  const timers = new Map();
  let timerSequence = 0;
  let context;
  const previousFocus = { focus() { context.document.activeElement = previousFocus; } };

  function createElement(tag) {
    const node = {
      tagName: String(tag).toUpperCase(), style: {}, value: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      focus() { context.document.activeElement = this; },
      select() { context.document.activeElement = this; },
      setSelectionRange() {},
      remove() { const index = elements.indexOf(this); if (index >= 0) elements.splice(index, 1); }
    };
    Object.defineProperty(node, 'innerHTML', {
      get() {
        return String(this.textContent || '').replace(/[&<>"']/g, value => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[value]);
      }
    });
    return node;
  }

  context = {
    URL, URLSearchParams, AbortController,
    console: { log() {}, warn() {}, error() {} },
    CONFIG: {
      AFFILIATE_REGISTER_ID: PARTNER_ID,
      CURATOR_LINKS_JSON_URL: '/data/curator-links.json',
      CURATOR_REDIRECT_PATH: '/api/oliveyoung/curator-redirect',
      OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo='
    },
    location: { protocol: 'https:', origin: 'https://member-fixture.example' },
    navigator: {
      clipboard: {
        async writeText(value) {
          clipboardAttempts.push(value);
          if (options.writeText) await options.writeText(value);
          copied.push(value);
        }
      }
    },
    document: {
      activeElement: previousFocus,
      createElement,
      getElementById() { return null; },
      body: {
        appendChild(node) { elements.push(node); node.parentNode = this; },
        removeChild(node) { node.remove(); }
      },
      execCommand(command) {
        assert.equal(command, 'copy');
        if (options.execCommandThrows) throw new Error('copy unsupported');
        if (options.execCommand === true) {
          const selected = context.document.activeElement;
          fallbackCopied.push(selected && selected.value);
          return true;
        }
        return false;
      }
    },
    prompt(message, value) { prompts.push({ message, value }); return value; },
    setTimeout(callback, delay) { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, init) {
      const parsed = new URL(String(url), context.location.origin);
      fetches.push({ url: parsed, init });
      if (parsed.pathname === '/data/curator-links.json') {
        return { ok: true, status: 200, async json() { return { links: options.indexResponse || {} }; } };
      }
      assert.equal(parsed.pathname, '/api/oliveyoung/curator-redirect', 'copy may only resolve through the same-origin curator API');
      assert.equal(parsed.origin, context.location.origin);
      if (options.resolve) return options.resolve(parsed, init);
      return { ok: true, status: 200, async json() { return options.resolverResponse || { success: true, pending: true, ready: false }; } };
    }
  };
  context.window = context;
  vm.runInNewContext(source + '\nthis.__ui = UI;', context, { filename: 'public/js/ui.js' });
  const UI = context.__ui;
  UI._curatorLinksIndex = options.cache || {};

  return {
    UI, context, fetches, clipboardAttempts, copied, fallbackCopied, prompts, elements,
    flushFeedbackTimers() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay <= 5000) { timers.delete(id); timer.callback(); }
      }
    }
  };
}

test('copy button identifies its own product and has an explicit non-submit action', () => {
  const env = environment();
  const html = env.UI.curatorCopyButtonHtml(GOODS_NO);
  assert.match(html, /type="button"/);
  assert.match(html, /data-action="copyCuratorLink"/);
  assert.match(html, new RegExp('data-goodsno="' + GOODS_NO + '"'));
  assert.ok(html.includes(LABEL));
});

test('copy rejects cache entries without the current operator attribution or a public short URL', () => {
  const env = environment();
  const rejected = [
    entry({ affiliatePartnerId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    entry({ affiliatePartnerId: '' }),
    entry({ affiliateActivityId: '', originalUrl: '' }),
    entry({ shortenedUrl: PRIVATE_URL }),
    entry({ shortenedUrl: 'http://oy.run/CopyFixtureFirst' }),
    entry({ shortenedUrl: 'https://oy.run.evil.example/CopyFixtureFirst' }),
    entry({ shortenedUrl: 'https://oy.run/' })
  ];
  for (const value of rejected) {
    env.UI._curatorLinksIndex[GOODS_NO] = value;
    assert.equal(env.UI.curatorCopyUrlForGoodsNo(GOODS_NO), '');
  }
  env.UI._curatorLinksIndex[GOODS_NO] = entry({ affiliateActivityId: '', originalUrl: ORIGINAL_URL });
  assert.equal(env.UI.curatorCopyUrlForGoodsNo(GOODS_NO), SHORT_URL, 'legacy original URL can prove affiliate attribution');
  assert.deepEqual(env.clipboardAttempts, []);
});

test('cached copy writes exactly the selected public curator URL without fetching', async () => {
  const env = environment({ cache: {
    [GOODS_NO]: entry(),
    [SECOND_GOODS_NO]: entry({ shortenedUrl: SECOND_SHORT_URL })
  } });
  const button = copyButton(SECOND_GOODS_NO);
  await env.UI.copyCuratorLink(button);
  assert.deepEqual(env.copied, [SECOND_SHORT_URL]);
  assert.equal(env.fetches.length, 0);
  assert.equal(button.textContent, '복사 완료 ✓');
  assert.equal(button.disabled, false);
  env.flushFeedbackTimers();
  assert.equal(button.textContent, LABEL);
});

test('a missing cache entry resolves a ready attributed public link for that product', async () => {
  const env = environment({ resolverResponse: {
    success: true, ready: true, shortenedUrl: SHORT_URL, affiliateActivityId: ACTIVITY_ID,
    redirectUrl: PRIVATE_URL, longUrl: ORIGINAL_URL
  } });
  const button = copyButton();
  await env.UI.copyCuratorLink(button);
  assert.deepEqual(env.copied, [SHORT_URL]);
  const resolutions = env.fetches.filter(call => call.url.pathname.endsWith('/curator-redirect'));
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].url.searchParams.get('goodsNo'), GOODS_NO);
  assert.equal(resolutions[0].url.searchParams.get('format'), 'json');
  assert.equal(button.textContent, '복사 완료 ✓');
  assert.equal(button.disabled, false);
});

for (const [name, response] of [
  ['pending', { success: true, ready: false, pending: true, redirectUrl: PRIVATE_URL, longUrl: ORIGINAL_URL }],
  ['unavailable', { success: true, ready: false, unavailable: true, redirectUrl: PRIVATE_URL, longUrl: ORIGINAL_URL }],
  ['ready without attribution', { success: true, ready: true, shortenedUrl: SHORT_URL, redirectUrl: PRIVATE_URL, longUrl: ORIGINAL_URL }],
  ['ready with private URL', { success: true, ready: true, shortenedUrl: PRIVATE_URL, affiliateActivityId: ACTIVITY_ID, longUrl: ORIGINAL_URL }]
]) {
  test(name + ' never copies the internal endpoint or an unverified fallback', async () => {
    const env = environment({ resolverResponse: response });
    const button = copyButton();
    await env.UI.copyCuratorLink(button);
    assert.deepEqual(env.clipboardAttempts, []);
    assert.deepEqual(env.fallbackCopied, []);
    assert.deepEqual(env.prompts, []);
    assert.equal(button.disabled, false);
    assert.notEqual(button.textContent, '복사 완료 ✓');
    if (name === 'pending') assert.equal(button.textContent, '링크 준비 중 · 다시 복사');
  });
}

test('an expired entry session does not copy an API error or leave the button disabled', async () => {
  const env = environment({
    resolve: async () => ({ ok: false, status: 401, async json() { return { success: false, error: 'site_access_required', redirectUrl: PRIVATE_URL }; } })
  });
  const button = copyButton();
  await env.UI.copyCuratorLink(button);
  assert.deepEqual(env.clipboardAttempts, []);
  assert.deepEqual(env.fallbackCopied, []);
  assert.deepEqual(env.prompts, []);
  assert.equal(button.disabled, false);
  assert.notEqual(button.textContent, '복사 완료 ✓');
});

test('clipboard permission failure can copy through a temporary textarea and cleans it up', async () => {
  const env = environment({
    cache: { [GOODS_NO]: entry() },
    writeText: async () => { throw new Error('permission denied'); },
    execCommand: true
  });
  const button = copyButton();
  await env.UI.copyCuratorLink(button);
  assert.deepEqual(env.copied, []);
  assert.deepEqual(env.fallbackCopied, [SHORT_URL]);
  assert.equal(env.elements.length, 0);
  assert.equal(env.prompts.length, 0);
  assert.equal(button.textContent, '복사 완료 ✓');
  assert.equal(button.disabled, false);
});

test('manual copy fallback presents only the public URL and does not claim clipboard success', async () => {
  const env = environment({
    cache: { [GOODS_NO]: entry() },
    writeText: async () => { throw new Error('permission denied'); },
    execCommand: false
  });
  const button = copyButton();
  await env.UI.copyCuratorLink(button);
  assert.deepEqual(env.copied, []);
  assert.deepEqual(env.fallbackCopied, []);
  assert.equal(env.prompts.length, 1);
  assert.equal(env.prompts[0].value, SHORT_URL);
  assert.equal(env.elements.length, 0);
  assert.equal(button.textContent, '주소를 직접 복사해 주세요');
  assert.equal(button.disabled, false);
});

test('repeated clicks on one button share a single copy operation and restore the button', async () => {
  let finishCopy;
  const waitForCopy = new Promise(resolve => { finishCopy = resolve; });
  const env = environment({ cache: { [GOODS_NO]: entry() }, writeText: () => waitForCopy });
  const button = copyButton();
  const first = env.UI.copyCuratorLink(button);
  await Promise.resolve();
  const repeated = env.UI.copyCuratorLink(button);
  await Promise.resolve();
  assert.equal(env.clipboardAttempts.length, 1);
  finishCopy();
  await Promise.all([first, repeated]);
  assert.deepEqual(env.copied, [SHORT_URL]);
  assert.equal(button.disabled, false);
  env.flushFeedbackTimers();
  assert.equal(button.textContent, LABEL);
});
