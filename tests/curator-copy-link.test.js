const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const GOODS_NO = 'A000000259555';
const product = { goodsNo: GOODS_NO, goodsName: '재고 조회 테스트 상품', imageUrl: 'https://image.example/product.jpg', priceToPay: 15200 };

function environment() {
  const elements = new Map(['product-list', 'fav-list'].map(id => [id, { innerHTML: '', querySelectorAll() { return []; } }]));
  const context = {
    console, URL, Date, Intl, Number, Math, setTimeout, clearTimeout,
    CONFIG: { COUPANG_STOCK_LINK: 'https://link.coupang.com/a/test', OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' },
    Storage: { isFavorite() { return false; } },
    PriceAlerts: { productControlHtml() { return '<button data-price-alert>가격 알림</button>'; }, managerHtml() { return ''; } },
    document: {
      getElementById(id) { return elements.get(id); },
      createElement() {
        return { textContent: '', get innerHTML() {
          return this.textContent.replace(/[&<>\"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[value]));
        } };
      }
    },
    fetch() { assert.fail('rendering cards must not request curator data'); }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/ui.js'), 'utf8') + '\nthis.UI = UI;', context);
  return { UI: context.UI, elements };
}

test('search cards keep purchase, inventory, and price alerts with no curator copy control', () => {
  const env = environment();
  env.UI.renderProducts([product], null);
  const html = env.elements.get('product-list').innerHTML;
  assert.match(html, /data-action="buyNow"/);
  assert.match(html, /data-action="showDetail"/);
  assert.match(html, /data-price-alert/);
  assert.match(html, /재고 조회 테스트 상품/);
  assert.match(html, /15,200/);
  assert.doesNotMatch(html, /copyCuratorLink|btn-copy-curator|큐레이터 링크/);
});

test('favorites retain purchase and price controls without curator copies', () => {
  const env = environment();
  env.UI.renderFavorites([product], null);
  const html = env.elements.get('fav-list').innerHTML;
  assert.match(html, /data-action="buyNow"/);
  assert.match(html, /data-action="showFavDetail"/);
  assert.match(html, /data-price-alert/);
  assert.doesNotMatch(html, /copyCuratorLink|btn-copy-curator|큐레이터 링크/);
});

test('entry, search, ranking, and favorites have no curator generation or cache paths', () => {
  for (const file of ['public/js/ui.js', 'public/js/app.js', 'public/js/config.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /curator|landing-proxy|shorten-proxy|affiliateActivityId|AFFILIATE_REGISTER_ID|oy\.run/i, file);
  }
});
