const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const GOODS_NO = 'A000000259555';
const AFFILIATE_URL =
  'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
  GOODS_NO +
  '&utm_source=shutter&utm_medium=affiliate&utm_content=OY_ec8215be736040eca84d84e54ea125ef';
const SHORT_URL = 'https://oy.run/Ce4LgyvwPAnGaa';
const REDIRECT_URL =
  'https://olivestock.co.kr/api/oliveyoung/curator-redirect?goodsNo=' +
  GOODS_NO +
  '&direct=1';

function loadUi(openImpl, entry) {
  const timers = [];
  const openCalls = [];
  const window = {
    location: { protocol: 'https:', origin: 'https://olivestock.co.kr' },
    open: function () {
      const args = Array.from(arguments);
      openCalls.push(args);
      return openImpl.apply(null, args);
    },
    setTimeout: function (callback) {
      timers.push(callback);
      return timers.length;
    }
  };
  const context = {
    window,
    URL,
    console: { log: function () {}, error: function () {} },
    document: {},
    CONFIG: {
      OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=',
      CURATOR_REDIRECT_PATH: '/api/oliveyoung/curator-redirect'
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ui.js'), 'utf8');
  vm.runInNewContext(source + '\nthis.__ui = UI;', context, { filename: 'public/js/ui.js' });
  context.__ui._curatorLinksIndex[GOODS_NO] =
    entry || { shortenedUrl: SHORT_URL, originalUrl: AFFILIATE_URL };
  return { UI: context.__ui, openCalls, timers };
}

function purchaseButton() {
  return {
    className: 'btn-buy-compact',
    dataset: { action: 'buyNow', goodsno: GOODS_NO },
    disabled: false,
    textContent: '바로구매',
    getAttribute: function (name) {
      return name === 'data-original-label' ? '바로구매' : null;
    },
    removeAttribute: function (name) {
      if (name === 'data-action') delete this.dataset.action;
      if (name === 'data-oy-opening') delete this.dataset.oyOpening;
    }
  };
}

test('successful purchase click opens exactly one isolated tab with the cached oy.run URL', function () {
  const clickedLinks = [];
  const popup = {
    opener: { unsafe: true },
    document: {
      createElement: function (tagName) {
        assert.equal(tagName, 'a');
        const link = {
          style: {},
          click: function () {
            clickedLinks.push({
              href: link.href,
              target: link.target,
              rel: link.rel,
              display: link.style.display
            });
          }
        };
        return link;
      },
      body: {
        appendChild: function () {}
      }
    },
    close: function () {
      assert.fail('successful popup must not be closed');
    }
  };
  const harness = loadUi(function () {
    return popup;
  });
  const button = purchaseButton();

  harness.UI.openOliveYoungProduct(button);

  assert.equal(harness.openCalls.length, 1);
  assert.deepEqual(harness.openCalls[0], ['about:blank', '_blank']);
  assert.equal(popup.opener, null);
  assert.deepEqual(clickedLinks, [
    { href: SHORT_URL, target: '_self', rel: 'noopener noreferrer', display: 'none' }
  ]);
  assert.equal(button.dataset.action, 'buyNow');
  assert.equal(button.textContent, '사이트여는중');

  assert.equal(harness.timers.length, 1);
  harness.timers[0]();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '바로구매');
});

test('an original-only cache entry opens the server generator instead of the long URL', function () {
  const clickedLinks = [];
  const popup = {
    opener: { unsafe: true },
    document: {
      createElement: function () {
        const link = {
          style: {},
          click: function () {
            clickedLinks.push({ href: link.href, target: link.target, rel: link.rel });
          }
        };
        return link;
      },
      body: { appendChild: function () {} }
    },
    close: function () {
      assert.fail('successful popup must not be closed');
    }
  };
  const harness = loadUi(
    function () {
      return popup;
    },
    { shortenedUrl: null, originalUrl: AFFILIATE_URL }
  );

  harness.UI.openOliveYoungProduct(purchaseButton());

  assert.equal(harness.openCalls.length, 1);
  assert.deepEqual(harness.openCalls[0], ['about:blank', '_blank']);
  assert.deepEqual(clickedLinks, [
    { href: REDIRECT_URL, target: '_self', rel: 'noopener noreferrer' }
  ]);
  assert.notEqual(clickedLinks[0].href, AFFILIATE_URL);
});

test('a genuinely blocked popup changes to one manual retry without a duplicate anchor click', function () {
  const harness = loadUi(function () {
    return null;
  });
  const button = purchaseButton();

  harness.UI.openOliveYoungProduct(button);

  assert.equal(harness.openCalls.length, 1);
  assert.deepEqual(harness.openCalls[0], ['about:blank', '_blank']);
  assert.equal(button.dataset.action, undefined);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '여기를 클릭해서 열기 →');
  assert.equal(typeof button.onclick, 'function');
  assert.equal(harness.timers.length, 0);
});
