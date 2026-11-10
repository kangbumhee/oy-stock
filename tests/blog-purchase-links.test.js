const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const GOODS_NO = 'A000000255324';
const PRODUCT_URL = 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + GOODS_NO;

test('every published blog buy link opens the matching official product without curator tracking', () => {
  let count = 0;
  for (const entry of fs.readdirSync(path.join(root, 'public', 'blog'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, 'public', 'blog', entry.name, 'index.html');
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /curator-redirect|oy\.run|utm_source=shutter|utm_medium=affiliate/i, file);
    const links = [...html.matchAll(/<a\b[^>]*class="buy-link"[^>]*href="([^"]+)"/g)];
    for (const [, href] of links) {
      const goodsNo = entry.name.match(/([ab]\d{12})$/i);
      assert.ok(goodsNo, entry.name);
      assert.equal(href, 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + goodsNo[1].toUpperCase());
      count++;
    }
  }
  assert.ok(count > 300, 'published product pages must remain covered');
});

function runFloatingCta(sourceHref) {
  const callbacks = [];
  const appended = [];
  const events = [];
  const listeners = {};
  function element(tag) {
    return {
      tag, children: [], attributes: {}, classList: { add() {} },
      appendChild(child) { this.children.push(child); },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name] || ''; }
    };
  }
  const buy = sourceHref ? element('a') : null;
  if (buy) { buy.attributes.href = sourceHref; buy.target = '_blank'; buy.rel = 'noopener noreferrer'; }
  const document = {
    readyState: 'complete',
    body: { appendChild(el) { appended.push(el); }, classList: { add() {} } },
    addEventListener(name, callback) { listeners[name] = callback; },
    createElement: element,
    querySelector(selector) {
      if (selector === '.cta .buy-link') return buy;
      if (selector === 'h1') return { textContent: '상품 이름' };
      return null;
    }
  };
  const window = {
    location: { href: 'https://member-fixture.example/blog/test-a000000255324/', pathname: '/blog/test-a000000255324/' },
    setTimeout(callback) { callbacks.push(callback); },
    requestAnimationFrame(callback) { callback(); },
    gtag(...args) { events.push(args); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'js', 'blog-floating-cta.js'), 'utf8'), {
    window, document, URL,
    fetch() { assert.fail('blog purchase must not fetch a link generator'); }
  });
  callbacks[0]();
  return { root: appended[0], events, listeners, buy };
}

test('floating blog CTA uses a direct product link even when its source has tracking parameters', () => {
  const page = runFloatingCta(PRODUCT_URL + '&utm_source=shutter&utm_medium=affiliate&utm_content=OY_old');
  const actions = page.root.children[2];
  assert.equal(actions.children[0].href, PRODUCT_URL);
  assert.equal(actions.children[0].target, '_blank');
  assert.equal(actions.children[0].rel, 'noopener noreferrer');
  page.buy.textContent = '구매하러가기';
  page.buy.closest = () => null;
  page.listeners.click({ target: { closest: () => page.buy } });
  assert.equal(page.buy.attributes.href, PRODUCT_URL);
  assert.deepEqual(page.events.map(args => args[1]), ['buy_click']);
});

test('floating blog CTA can open the slug product without any buy-link source', () => {
  const page = runFloatingCta('');
  assert.equal(page.root.children[2].children[0].href, PRODUCT_URL);
});
