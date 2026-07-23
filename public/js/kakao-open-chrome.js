(function () {
  'use strict';

  if (window.__olivestockKakaoChromeHandoff) return;
  window.__olivestockKakaoChromeHandoff = true;

  var ua = navigator.userAgent || '';
  var isKakao = /KAKAOTALK|KakaoTalk/i.test(ua);
  var isBot = /bot|crawler|spider|Googlebot|Yeti|BingPreview|facebookexternalhit|Twitterbot/i.test(ua);
  if (!isKakao || isBot || /^\/api\//.test(location.pathname)) return;

  var isAndroid = /Android/i.test(ua);
  var isIOS = /iPhone|iPad|iPod/i.test(ua);
  var leftPage = false;
  var cleanUrl = removeParam(location.href, 'kakao_chrome_fallback');
  var attemptKey = 'olivestock:kakao-chrome:' + location.origin + location.pathname + location.search;

  window.addEventListener('pagehide', function () {
    leftPage = true;
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') leftPage = true;
  });

  function removeParam(url, key) {
    try {
      var u = new URL(url);
      u.searchParams.delete(key);
      return u.href;
    } catch (e) {
      return url;
    }
  }

  function withParam(url, key, value) {
    try {
      var u = new URL(url);
      u.searchParams.set(key, value);
      return u.href;
    } catch (e) {
      return url;
    }
  }

  function androidIntentUrl(url) {
    var target = url.replace(/^https?:\/\//i, '');
    var fallback = withParam(url, 'kakao_chrome_fallback', '1');
    return 'intent://' + target + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(fallback) + ';end';
  }

  function iosChromeUrl(url) {
    if (/^https:\/\//i.test(url)) return 'googlechromes://' + url.replace(/^https:\/\//i, '');
    if (/^http:\/\//i.test(url)) return 'googlechrome://' + url.replace(/^http:\/\//i, '');
    return 'googlechromes://' + url.replace(/^\/+/, '');
  }

  function alreadyAttempted() {
    if (/[?&]kakao_chrome_fallback=1\b/.test(location.search)) return true;
    try {
      return sessionStorage.getItem(attemptKey) === '1';
    } catch (e) {
      return false;
    }
  }

  function markAttempted() {
    try {
      sessionStorage.setItem(attemptKey, '1');
    } catch (e) {
      // Storage can be blocked in some in-app browsers.
    }
  }

  function openChrome() {
    markAttempted();
    if (isAndroid) {
      location.href = androidIntentUrl(cleanUrl);
      return;
    }
    if (isIOS) {
      location.href = iosChromeUrl(cleanUrl);
      return;
    }
    showChromeGuide();
  }

  function ensureStyles() {
    if (document.getElementById('kakao-open-chrome-style')) return;
    var style = document.createElement('style');
    style.id = 'kakao-open-chrome-style';
    style.textContent = [
      '.kakao-chrome-guide{position:fixed;z-index:2147483647;left:0;right:0;bottom:0;padding:16px;background:linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,.96) 18%,#fff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;color:#172018}',
      '.kakao-chrome-guide__panel{max-width:520px;margin:0 auto;border:1px solid #dfead8;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgba(15,23,42,.22);padding:18px}',
      '.kakao-chrome-guide__top{display:flex;align-items:center;gap:12px;margin-bottom:10px}',
      '.kakao-chrome-guide__mark{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:#193d22;color:#d7ff52;font-weight:900}',
      '.kakao-chrome-guide strong{display:block;font-size:18px;line-height:1.35;color:#172018}',
      '.kakao-chrome-guide p{margin:7px 0 14px;font-size:14px;line-height:1.55;color:#475569;font-weight:700}',
      '.kakao-chrome-guide__actions{display:grid;grid-template-columns:1fr auto;gap:8px}',
      '.kakao-chrome-guide button{height:46px;border:0;border-radius:12px;font-weight:900;font-size:15px;cursor:pointer;-webkit-tap-highlight-color:transparent}',
      '.kakao-chrome-guide__open{background:#193d22;color:#d7ff52;box-shadow:0 10px 22px rgba(25,61,34,.18)}',
      '.kakao-chrome-guide__stay{padding:0 14px;background:#eef5e8;color:#315b11}',
      '@media(max-width:520px){.kakao-chrome-guide{padding:12px}.kakao-chrome-guide__panel{border-radius:16px}.kakao-chrome-guide__actions{grid-template-columns:1fr}.kakao-chrome-guide__stay{width:100%}}'
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function showChromeGuide() {
    if (leftPage || document.querySelector('.kakao-chrome-guide')) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showChromeGuide, { once: true });
      return;
    }
    ensureStyles();
    var root = document.createElement('div');
    root.className = 'kakao-chrome-guide';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-live', 'polite');
    root.innerHTML = [
      '<div class="kakao-chrome-guide__panel">',
      '<div class="kakao-chrome-guide__top"><span class="kakao-chrome-guide__mark">O</span><strong>크롬에서 바로 이어서 열기</strong></div>',
      '<p>카카오톡 안에서는 소리, 게임 조작, 일부 재고 조회가 제한될 수 있어요. 크롬으로 열면 더 안정적으로 사용할 수 있습니다.</p>',
      '<div class="kakao-chrome-guide__actions">',
      '<button type="button" class="kakao-chrome-guide__open">Chrome으로 열기</button>',
      '<button type="button" class="kakao-chrome-guide__stay">그냥 보기</button>',
      '</div>',
      '</div>'
    ].join('');
    root.querySelector('.kakao-chrome-guide__open').addEventListener('click', openChrome);
    root.querySelector('.kakao-chrome-guide__stay').addEventListener('click', function () {
      root.remove();
    });
    document.body.appendChild(root);
  }

  if (!alreadyAttempted() && (isAndroid || isIOS)) {
    window.setTimeout(openChrome, 160);
  }
  window.setTimeout(showChromeGuide, 1100);
}());
