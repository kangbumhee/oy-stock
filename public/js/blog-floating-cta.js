(function () {
  'use strict';

  var SHOW_DELAY_MS = 2000;
  var RETRY_MS = 500;
  var MAX_ATTEMPTS = 12;

  function absoluteUrl(value) {
    try {
      return new URL(value, window.location.href).href;
    } catch (e) {
      return value || '';
    }
  }

  function firstText(selector, fallback) {
    var el = document.querySelector(selector);
    var value = el && el.textContent ? el.textContent.trim() : '';
    return value || fallback || '';
  }

  function firstElement(selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function hrefFrom(el) {
    return el ? el.getAttribute('href') || '' : '';
  }

  function goodsNoFromUrl() {
    var match = window.location.pathname.match(/a\d{9,}/i);
    return match ? match[0].toUpperCase() : '';
  }

  function productImage() {
    var cover = document.querySelector('.cover');
    if (cover && cover.getAttribute('src')) return absoluteUrl(cover.getAttribute('src'));
    var og = document.querySelector('meta[property="og:image"]');
    return og ? absoluteUrl(og.getAttribute('content')) : '';
  }

  function createButton(className, text, href, source) {
    var a = document.createElement('a');
    a.className = className;
    a.href = absoluteUrl(href);
    a.textContent = text;
    if (source && source.target) a.target = source.target;
    if (source && source.rel) a.rel = source.rel;
    return a;
  }

  function showFloatingCta(attempt) {
    if (document.querySelector('.oy-floating-cta')) return;

    var buySource = firstElement([
      '.cta .buy-link',
      '.buy-link',
      'a[href*="/api/oliveyoung/curator-redirect"]',
      'a[href*="curator-redirect?goodsNo="]'
    ]);
    var stockSource = firstElement([
      '.cta .stock-link',
      '.stock-link',
      'a[href*="autoBuy="]',
      'a[href*="/?q="]'
    ]);
    var title = firstText('h1', '올리브영 인기 상품');
    var goodsNo = goodsNoFromUrl();
    var buyHref = hrefFrom(buySource) || (goodsNo ? '/api/oliveyoung/curator-redirect?goodsNo=' + goodsNo : '');
    var stockHref = hrefFrom(stockSource) || '/?q=' + encodeURIComponent(title) + (goodsNo ? '&autoBuy=' + goodsNo : '');
    if (!buyHref || !stockHref) {
      if ((attempt || 0) < MAX_ATTEMPTS) {
        window.setTimeout(function () {
          showFloatingCta((attempt || 0) + 1);
        }, RETRY_MS);
      }
      return;
    }

    var imageUrl = productImage();
    var root = document.createElement('aside');
    root.className = 'oy-floating-cta';
    root.setAttribute('aria-label', '구매와 재고 확인 바로가기');

    var thumb = document.createElement('div');
    thumb.className = 'oy-floating-cta__thumb';
    if (imageUrl) {
      var img = document.createElement('img');
      img.src = imageUrl;
      img.alt = title;
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      var fallback = document.createElement('div');
      fallback.className = 'oy-floating-cta__fallback';
      fallback.textContent = 'O';
      thumb.appendChild(fallback);
    }

    var copy = document.createElement('div');
    copy.className = 'oy-floating-cta__copy';

    var eyebrow = document.createElement('div');
    eyebrow.className = 'oy-floating-cta__eyebrow';
    eyebrow.textContent = '지금 바로 확인';

    var heading = document.createElement('strong');
    heading.className = 'oy-floating-cta__title';
    heading.textContent = title;

    var sub = document.createElement('p');
    sub.className = 'oy-floating-cta__sub';
    sub.textContent = '구매 링크와 재고 확인을 아래에서 바로 열 수 있어요.';

    copy.appendChild(eyebrow);
    copy.appendChild(heading);
    copy.appendChild(sub);

    var actions = document.createElement('div');
    actions.className = 'oy-floating-cta__actions';
    actions.appendChild(
      createButton('oy-floating-cta__btn oy-floating-cta__btn--buy', '바로 구매 링크 열기', buyHref, buySource)
    );
    actions.appendChild(
      createButton('oy-floating-cta__btn oy-floating-cta__btn--stock', '재고 먼저 확인', stockHref, stockSource)
    );

    root.appendChild(thumb);
    root.appendChild(copy);
    root.appendChild(actions);
    document.body.appendChild(root);
    document.body.classList.add('oy-blog-floating-cta-ready');
    window.requestAnimationFrame(function () {
      root.classList.add('is-visible');
    });
  }

  function schedule() {
    window.setTimeout(function () {
      showFloatingCta(0);
    }, SHOW_DELAY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
})();
