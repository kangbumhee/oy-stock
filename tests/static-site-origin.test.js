const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const origin = 'https://oyb8.vercel.app';
const retiredOrigin = /https:\/\/(?:www\.)?olivestock\.co\.kr\b|https:\/\/oy-stock\.vercel\.app\b/;

function staticFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return staticFiles(file);
    return /\.(html|xml)$/.test(entry.name) || entry.name === 'robots.txt' ? [file] : [];
  });
}

test('static pages and discovery files never send users back to a retired app origin', () => {
  let canonicalPages = 0;
  for (const file of staticFiles(path.join(root, 'public'))) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, retiredOrigin, path.relative(root, file));
    for (const [, href] of text.matchAll(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/g)) {
      assert.equal(new URL(href).origin, origin, path.relative(root, file));
      canonicalPages++;
    }
    if (/\.(xml)$/.test(file)) {
      for (const [, url] of text.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        assert.equal(new URL(url).origin, origin, path.relative(root, file));
      }
    }
  }
  assert.ok(canonicalPages > 350, 'main, guide and published blog canonical URLs must stay covered');
});

test('future blog, guide and discovery generation uses the new app origin', () => {
  for (const file of ['scripts/build-blog-pages.js', 'scripts/generate-seo-pages.mjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(source.includes("const SITE_URL = '" + origin + "';"), file);
    assert.doesNotMatch(source, retiredOrigin, file);
  }
  const indexNow = fs.readFileSync(path.join(root, 'scripts/submit-indexnow.mjs'), 'utf8');
  assert.ok(indexNow.includes("const host = 'oyb8.vercel.app';"));
  const robots = fs.readFileSync(path.join(root, 'public/robots.txt'), 'utf8');
  assert.ok(robots.includes('Sitemap: ' + origin + '/sitemap.xml'));
});

test('main page fetches migration-versioned app assets while retaining product-image versions', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*src="(\/js\/[^\"]+)"/g)];
  assert.ok(scripts.length >= 13);
  for (const [, asset] of scripts) {
    assert.equal(new URL(asset, origin).searchParams.get('v'), '20261116-site-migration');
  }
  assert.match(html, /\/css\/style\.css\?v=20261116-site-migration/);
  assert.match(html, /images\/blog\/[^"?]+\?v=20260611-manual-review/);
});

test('review notice states the actual change scope and stays out of search indexing', () => {
  const html = fs.readFileSync(path.join(root, 'public/service-status.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.ok(html.includes('href="' + origin + '/service-status"'));
  assert.ok(html.includes('2026년 11월 16일 기준'));
  assert.ok(html.includes('입장 제한을 유지'));
  assert.ok(html.includes('재고 조회와 일반 기능'));
  assert.ok(html.includes('큐레이터 링크 생성·복사'));
  assert.ok(html.includes('추적 정보가 없는 올리브영 공식 상품 주소'));
});
