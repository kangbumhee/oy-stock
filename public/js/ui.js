var UI = {
  _curatorLinksPromise: null,
  _allStockCache: {},
  _allStockInflight: {},

  /** 일반 올리브영 상품 상세(www) — shorten 실패·에러 팝업 폴백 */
  oliveyoungFallbackUrl: function (goodsNo, categoryNumber) {
    var gn = String(goodsNo || '').trim();
    if (!gn) return CONFIG.OY_PRODUCT_URL;
    var url = CONFIG.OY_PRODUCT_URL + encodeURIComponent(gn);
    if (categoryNumber) {
      url += '&categoryNumber=' + encodeURIComponent(String(categoryNumber));
    }
    return url;
  },

  loadCuratorLinksIndex: function () {
    if (UI._curatorLinksPromise != null) return UI._curatorLinksPromise;
    var url = CONFIG.CURATOR_LINKS_JSON_URL || '/data/curator-links.json';
    UI._curatorLinksPromise = fetch(url)
      .then(function (r) {
        if (!r.ok) return {};
        return r.json().then(function (data) {
          return (data && data.links) || {};
        });
      })
      .catch(function () {
        return {};
      });
    return UI._curatorLinksPromise;
  },

  curatorRedirectUrl: function (goodsNo) {
    var gn = String(goodsNo || '').trim();
    if (!gn) return CONFIG.OY_PRODUCT_URL;
    var base = CONFIG.CURATOR_REDIRECT_PATH || '/api/oliveyoung/curator-redirect';
    if (base.charAt(0) === '/') {
      var origin =
        window.location.protocol === 'file:' ? 'https://olivestock.co.kr' : window.location.origin;
      base = origin + base;
    }
    var url =
      base +
      (base.indexOf('?') >= 0 ? '&' : '?') +
      'goodsNo=' +
      encodeURIComponent(gn);
    return url;
  },

  trackGaEvent: function (eventName, params) {
    try {
      if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
      window.gtag(
        'event',
        eventName,
        Object.assign({ transport_type: 'beacon' }, params || {})
      );
    } catch (e) {}
  },

  /**
   * 블로그 구매 버튼과 같은 서버 리다이렉트 API로 통일한다.
   * 서버에서 curator-links.json → 모바일 앱 브릿지 → 웹 fallback 순서로 처리한다.
   */
  openOliveYoungProduct: function (el) {
    var goodsNo = el.dataset.goodsno;
    if (!goodsNo) return;
    if (el.dataset.oyOpening === '1') {
      console.log('[oy] openOliveYoung 중복 진입 스킵', goodsNo);
      return;
    }
    el.dataset.oyOpening = '1';
    console.log('[oy] openOliveYoung 실행', goodsNo);
    var categoryNumber = el.dataset.category || '';
    var origLabel = el.getAttribute('data-original-label') || '올리브영에서 구매 →';
    var redirectUrl = UI.curatorRedirectUrl(goodsNo);
    var eventSource =
      el.dataset.analyticsSource ||
      el.dataset.source ||
      (String(el.className || '').indexOf('hot') >= 0 ? 'hot_ranking' : 'site_button');
    var buttonText = String(el.textContent || '').trim().slice(0, 80);

    UI.trackGaEvent('buy_click', {
      goods_no: goodsNo,
      event_source: eventSource,
      button_text: buttonText
    });
    UI.trackGaEvent('curator_redirect_open', {
      goods_no: goodsNo,
      event_source: eventSource,
      redirect_type: 'server_redirect'
    });

    function tryOpenCuratorRedirect(url) {
      var newTab = window.open(url, '_blank', 'noopener,noreferrer');
      if (newTab != null) return false;
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      el.removeAttribute('data-action');
      el.disabled = false;
      el.textContent = '여기를 클릭해서 열기 →';
      el.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
      };
      return true;
    }

    el.disabled = true;
    el.textContent = '사이트여는중';
    var manualRedirectFallback = tryOpenCuratorRedirect(redirectUrl);
    el.removeAttribute('data-oy-opening');
    if (!manualRedirectFallback) {
      window.setTimeout(function () {
        el.disabled = false;
        el.textContent = origLabel;
      }, 500);
    }
    return;

    var fallbackUrl = UI.oliveyoungFallbackUrl(goodsNo, categoryNumber || undefined);
    var longUrlBase =
      'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
      encodeURIComponent(String(goodsNo).trim()) +
      '&utm_source=shutter&utm_medium=affiliate';
    var defaultReg =
      CONFIG.AFFILIATE_REGISTER_ID || '4ee076cc92da4447a1b4b42c590e4495';

    function tryProgrammaticAnchorClick(url) {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    /**
     * @returns {boolean} true면 수동 버튼 모드(finally에서 라벨 복구 안 함)
     * location.href 는 쓰지 않음(현재 탭 이탈 방지).
     */
    function openInNewTabWithoutSameTabNav(url) {
      var newTab = window.open(url, '_blank', 'noopener,noreferrer');
      if (newTab != null) {
        try {
          if (!newTab.closed) {
            return false;
          }
        } catch (err) {
          /* cross-origin: closed 접근 불가 → 이미 탭 열림으로 간주 */
          return false;
        }
      }
      tryProgrammaticAnchorClick(url);
      if (newTab == null) {
        el.removeAttribute('data-action');
        el.disabled = false;
        el.textContent = '여기를 클릭해서 열기 →';
        el.onclick = function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          window.open(url, '_blank', 'noopener,noreferrer');
        };
        return true;
      }
      return false;
    }

    el.disabled = true;
    el.textContent = '사이트여는중';

    (async function () {
      var manualFallback = false;
      try {
        var links = await UI.loadCuratorLinksIndex();
        var entry = links[goodsNo];
        if (entry && entry.shortenedUrl) {
          manualFallback = openInNewTabWithoutSameTabNav(entry.shortenedUrl);
          return;
        }

        var landingPayload = { goodsNo: goodsNo };
        if (categoryNumber) {
          landingPayload.categoryNumber = categoryNumber;
        }

        var landRes = await fetch(
          CONFIG.LANDING_PROXY_PATH || '/api/oliveyoung/landing-proxy',
          {
            method: 'POST',
            mode: 'cors',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify(landingPayload)
          }
        );

        var landJson = await landRes.json().catch(function () {
          return null;
        });
        console.log('[oy-stock] landing HTTP', landRes.status, goodsNo);
        console.log('[oy-stock] landing 결과:', landJson);
        var activityId = landJson && landJson.affiliateActivityId;
        console.log('[oy-stock] affiliateActivityId:', activityId);
        if (activityId) {
          console.log('[oy-stock] utm_content 포함 URL 생성 (OY_' + activityId + ')');
        } else {
          console.log(
            '[oy-stock] ❌ affiliateActivityId 없음! utm_content 없이 shorten 진행'
          );
        }
        var partnerId =
          (landJson && landJson.affiliatePartnerId) || defaultReg;

        if (!activityId) {
          console.error('[landing-proxy] affiliateActivityId 없음 → 수익 링크 생성 중단', {
            goodsNo: goodsNo,
            httpStatus: landRes.status,
            response: landJson
          });
          throw new Error('affiliateActivityId missing');
        }

        var originalUrlForShorten = longUrlBase + '&utm_content=OY_' + activityId;
        console.log('[oy-stock] shorten 요청 originalUrl:', originalUrlForShorten);

        var shortRes = await fetch(
          CONFIG.SHORTEN_PROXY_PATH || '/api/oliveyoung/shorten-proxy',
          {
            method: 'POST',
            mode: 'cors',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({
              originalUrl: originalUrlForShorten,
              registerId: partnerId
            })
          }
        );

        var shortJson = await shortRes.json().catch(function () {
          return null;
        });
        var shortenedUrl =
          shortJson &&
          shortJson.data &&
          shortJson.data[0] &&
          shortJson.data[0].shortenedUrl;
        console.log('[oy-stock] shorten HTTP', shortRes.status);
        console.log('[oy-stock] shorten 결과:', shortJson);
        console.log('[oy-stock] shortenedUrl:', shortenedUrl);

        var targetUrl = shortenedUrl || fallbackUrl;
        manualFallback = openInNewTabWithoutSameTabNav(targetUrl);
      } catch (e) {
        console.error('올리브영 링크 열기 실패:', e);
        manualFallback = openInNewTabWithoutSameTabNav(fallbackUrl);
      } finally {
        el.removeAttribute('data-oy-opening');
        if (!manualFallback) {
          el.disabled = false;
          el.textContent = origLabel;
        }
      }
    })();
  },

  esc: function (s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  },

  errorText: function (value, fallback) {
    var text = '';
    if (value == null || value === true || value === false) {
      text = '';
    } else if (typeof value === 'string') {
      text = value.trim();
    } else if (typeof value === 'number') {
      text = String(value);
    } else if (typeof value === 'object') {
      if (value.message != null) return UI.errorText(value.message, fallback);
      if (value.error != null) return UI.errorText(value.error, fallback);
      try {
        text = JSON.stringify(value);
      } catch (e) {
        text = '';
      }
    } else {
      text = String(value || '').trim();
    }
    if (!text || text === 'true' || text === 'false' || text === '[object Object]') {
      return fallback || '조회 실패';
    }
    return text;
  },

  escAttr: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  num: function (n) {
    return (n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  formatRankTime: function (ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return '';
    }
  },

  formatRankElapsed: function (ms) {
    var sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var min = Math.floor(sec / 60);
    var rem = sec % 60;
    if (min <= 0) return rem + '초';
    return min + '분' + (rem ? ' ' + rem + '초' : '');
  },

  formatWon: function (n) {
    var v = Math.round(Number(n) || 0);
    return v > 0 ? UI.num(v) + '원' : '계산대기';
  },

  hotRangeLabel: function (range) {
    var ranges = (typeof CONFIG !== 'undefined' && CONFIG.HOT_RANK_RANGES) || {};
    return (ranges[range] && ranges[range].label) || '24시간';
  },

  hotRangeMetricLabel: function (range) {
    if (range === '1d') return '24시간';
    return UI.hotRangeLabel(range);
  },

  hotCategoryLabel: function (category) {
    var raw = String(category || '');
    if (!raw) return '전체';
    var cats = (typeof CONFIG !== 'undefined' && CONFIG.HOT_RANK_CATEGORIES) || [];
    var found = cats.find(function (cat) {
      return String((cat && cat.id) || '') === raw;
    });
    return (found && found.label) || raw;
  },

  formatChartDate: function (ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return '';
    }
  },

  hotChartMeta: function (mode) {
    if (mode === 'revenue') {
      return {
        mode: 'revenue',
        valueKey: 'revenue',
        deltaKey: 'revenueDelta',
        valueLabel: '기간매출',
        emptyLabel: '매출 그래프 준비중'
      };
    }
    if (mode === 'sales') {
      return {
        mode: 'sales',
        valueKey: 'sales',
        deltaKey: 'salesDelta',
        valueLabel: '기간판매',
        emptyLabel: '판매 그래프 준비중'
      };
    }
    if (mode === 'view') {
      return {
        mode: 'view',
        valueKey: 'rank',
        deltaKey: 'rankDelta',
        valueLabel: '조회순',
        emptyLabel: '조회순 그래프 준비중',
        lowerIsBetter: true
      };
    }
    return {
      mode: 'stock',
      valueKey: 'total',
      deltaKey: 'delta',
      valueLabel: '온라인 재고',
      emptyLabel: '그래프 준비중'
    };
  },

  hotChartValueText: function (mode, value) {
    var n = Math.round(Number(value) || 0);
    if (mode === 'revenue') return UI.num(n) + '원';
    if (mode === 'view') return UI.hotRankText(n);
    return UI.num(n) + '개';
  },

  hotChartDeltaText: function (mode, delta) {
    var n = Math.round(Number(delta) || 0);
    if (mode === 'view') {
      if (!n) return '순위 유지';
      return n < 0 ? '상승 ' + UI.num(Math.abs(n)) + '계단' : '하락 ' + UI.num(Math.abs(n)) + '계단';
    }
    if (!n) return '변화 없음';
    var sign = n > 0 ? '+' : '-';
    var abs = Math.abs(n);
    if (mode === 'revenue') return '매출 ' + sign + UI.num(abs) + '원';
    if (mode === 'sales') return '판매 +' + UI.num(abs) + '개';
    return n > 0 ? '입고 +' + UI.num(abs) + '개' : '감소 ' + UI.num(abs) + '개';
  },

  hotRankText: function (rank) {
    var n = Math.round(Number(rank) || 0);
    return n > 0 && n < 9999 ? '#' + UI.num(n) : '순위권 밖';
  },

  hotChartRankText: function (label, prevRank, rank) {
    var current = Math.round(Number(rank) || 0);
    if (!current || current >= 9999) return '';
    var prev = Math.round(Number(prevRank) || current);
    var prefix = label || '순위';
    if (!prev || prev >= 9999) return prefix + ' 순위권 밖 → ' + UI.hotRankText(current);
    if (prev === current) return prefix + ' ' + UI.hotRankText(current) + ' 유지';
    return prefix + ' ' + UI.hotRankText(prev) + ' → ' + UI.hotRankText(current);
  },

  renderHotSparkline: function (points, opts) {
    opts = opts || {};
    var meta = UI.hotChartMeta(opts.mode || 'stock');
    points = Array.isArray(points) ? points : [];
    if (points.length < 2) {
      return '<div class="hot-chart hot-chart-empty">' + UI.esc(meta.emptyLabel) + '</div>';
    }
    var width = 150;
    var height = 38;
    var pad = 4;
    var clean = points
      .map(function (p) {
        var value = Number(p[meta.valueKey]);
        if (!isFinite(value) && meta.valueKey === 'total') value = Number(p.stockTotal);
        var delta = Number(p[meta.deltaKey]);
        if (!isFinite(delta) && meta.deltaKey === 'delta') delta = Number(p.stockDelta);
        return {
          ts: Date.parse(p.ts),
          value: isFinite(value) ? value : 0,
          delta: isFinite(delta) ? delta : 0,
          rank: Number(p.rank) || 0,
          prevRank: Number(p.prevRank) || Number(p.rank) || 0,
          rankLabel: p.rankLabel || (meta.mode === 'revenue' ? '매출순' : meta.mode === 'sales' ? '판매순' : meta.mode === 'view' ? '조회순' : '')
        };
      })
      .filter(function (p) {
        return isFinite(p.ts);
      });
    if (clean.length < 2) {
      return '<div class="hot-chart hot-chart-empty">' + UI.esc(meta.emptyLabel) + '</div>';
    }
    var minTs = clean[0].ts;
    var maxTs = clean[clean.length - 1].ts;
    var minTotal = Math.min.apply(
      null,
      clean.map(function (p) {
        return p.value;
      })
    );
    var maxTotal = Math.max.apply(
      null,
      clean.map(function (p) {
        return p.value;
      })
    );
    var spanTs = Math.max(1, maxTs - minTs);
    var spanTotal = Math.max(1, maxTotal - minTotal);
    var coords = clean.map(function (p) {
      var x = pad + ((p.ts - minTs) / spanTs) * (width - pad * 2);
      var y = meta.lowerIsBetter
        ? pad + ((p.value - minTotal) / spanTotal) * (height - pad * 2)
        : height - pad - ((p.value - minTotal) / spanTotal) * (height - pad * 2);
      var deltaClass =
        meta.mode === 'view'
          ? p.delta < 0
            ? 'up'
            : p.delta > 0
              ? 'down'
              : ''
          : p.delta > 0
            ? 'up'
            : p.delta < 0
              ? 'down'
              : '';
      return {
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        xNorm: (x - pad) / (width - pad * 2),
        yNorm: y / height,
        ts: p.ts,
        label: UI.formatChartDate(p.ts),
        value: p.value,
        delta: p.delta,
        valueLabel: meta.valueLabel,
        valueText: UI.hotChartValueText(meta.mode, p.value),
        deltaText: UI.hotChartDeltaText(meta.mode, p.delta),
        deltaClass: deltaClass,
        rankText: UI.hotChartRankText(p.rankLabel, p.prevRank, p.rank),
        marker: meta.mode === 'view' ? p.delta !== 0 : p.delta > 0
      };
    });
    var line = coords
      .map(function (p) {
        return p.x + ',' + p.y;
      })
      .join(' ');
    var markers = coords
      .filter(function (p) {
        return p.marker;
      })
      .map(function (p) {
        return '<circle cx="' + p.x + '" cy="' + p.y + '" r="2.4"></circle>';
      })
      .join('');
    return (
      '<div class="hot-chart ' +
      UI.escAttr(meta.mode) +
      '" data-points="' +
      UI.escAttr(JSON.stringify(coords)) +
      '" data-mode="' +
      UI.escAttr(meta.mode) +
      '">' +
      '<svg viewBox="0 0 ' +
      width +
      ' ' +
      height +
      '" aria-hidden="true">' +
      '<polyline points="' +
      line +
      '"></polyline>' +
      markers +
      '</svg><div class="hot-chart-cross"></div><div class="hot-chart-dot"></div><div class="hot-chart-tip"></div>' +
      '</div>'
    );
  },

  bindHotCharts: function (root) {
    if (!root || root.dataset.hotChartBound === '1') return;
    root.dataset.hotChartBound = '1';

    function nearestChart(target) {
      var chart = target && target.closest && target.closest('.hot-chart');
      return chart && root.contains(chart) ? chart : null;
    }

    function showChartTip(chart, clientX) {
      if (!chart || !chart.dataset.points) return;
      var points;
      try {
        points = chart._points || JSON.parse(chart.dataset.points || '[]');
        chart._points = points;
      } catch (err) {
        points = [];
      }
      if (!points.length) return;
      var rect = chart.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      var nearest = points[0];
      var best = Math.abs((nearest.xNorm || 0) - ratio);
      points.forEach(function (p) {
        var diff = Math.abs((p.xNorm || 0) - ratio);
        if (diff < best) {
          best = diff;
          nearest = p;
        }
      });
      var left = Math.max(0, Math.min(rect.width, (nearest.xNorm || 0) * rect.width));
      var top = Math.max(3, Math.min(rect.height - 3, (nearest.yNorm || 0) * rect.height));
      var cross = chart.querySelector('.hot-chart-cross');
      var dot = chart.querySelector('.hot-chart-dot');
      var tip = chart.querySelector('.hot-chart-tip');
      if (!cross || !dot || !tip) return;
      cross.style.left = left + 'px';
      dot.style.left = left + 'px';
      dot.style.top = top + 'px';
      tip.classList.toggle('right', left > rect.width * 0.58);
      tip.style.left = left + 'px';
      tip.innerHTML =
        '<b>' +
        UI.esc(nearest.label || '') +
        '</b><span>' +
        UI.esc(nearest.valueLabel || '지표') +
        ' ' +
        UI.esc(nearest.valueText || '') +
        '</span><em class="' +
        UI.esc(nearest.deltaClass || '') +
        '">' +
        UI.esc(nearest.deltaText || '변화 없음') +
        '</em>' +
        (nearest.rankText ? '<span class="rank">' + UI.esc(nearest.rankText) + '</span>' : '');
      chart.classList.add('active');
    }

    root.addEventListener('mousemove', function (e) {
      var chart = nearestChart(e.target);
      if (!chart || !chart.dataset.points) return;
      showChartTip(chart, e.clientX);
    });
    root.addEventListener(
      'touchstart',
      function (e) {
        var chart = nearestChart(e.target);
        if (!chart) return;
        e.preventDefault();
        e.stopPropagation();
        var touch = e.touches && e.touches[0];
        if (touch) showChartTip(chart, touch.clientX);
      },
      { capture: true, passive: false }
    );
    root.addEventListener(
      'touchmove',
      function (e) {
        var chart = nearestChart(e.target);
        if (!chart) return;
        e.preventDefault();
        e.stopPropagation();
        var touch = e.touches && e.touches[0];
        if (touch) showChartTip(chart, touch.clientX);
      },
      { capture: true, passive: false }
    );
    root.addEventListener(
      'click',
      function (e) {
        var chart = nearestChart(e.target);
        if (!chart) return;
        e.preventDefault();
        e.stopPropagation();
        showChartTip(chart, e.clientX);
      },
      true
    );
    root.addEventListener('mouseleave', function (e) {
      var chart = e.target.closest && e.target.closest('.hot-chart[data-points]');
      if (chart) chart.classList.remove('active');
    }, true);
  },

  renderVelocityRanking: function (rows, state) {
    state = state || {};
    var root = document.getElementById('velocity-ranking');
    if (!root) return;
    if (!state.hasProducts) {
      root.innerHTML = '';
      return;
    }

    rows = rows || [];
    var head =
      '<section class="velocity-panel">' +
      '<div class="velocity-head">' +
      '<div><h2>🔥 실시간 재고 급감 TOP</h2>' +
      '<p>온라인 총재고 변화 기준 · 최근 ' +
      UI.esc(state.windowLabel || '30분') +
      '</p></div>' +
      '<button type="button" class="velocity-refresh" data-action="refreshRanking" title="다시 측정">↻</button>' +
      '</div>';

    if (!rows.length) {
      root.innerHTML =
        head +
        '<div class="velocity-empty">' +
        '<strong>재고 변화 측정 중</strong>' +
        '<span>같은 상품의 실시간 재고가 2번 이상 관측되면 순위가 표시됩니다.</span>' +
        '</div></section>';
      return;
    }

    var body = rows
      .map(function (r) {
        var img = r.imageUrl
          ? '<img src="' + UI.esc(r.imageUrl) + '" alt="" loading="lazy" decoding="async">'
          : '<div class="velocity-no-img">📦</div>';
        var from = UI.num(r.fromTotal);
        var to = UI.num(r.toTotal);
        var drop = UI.num(r.drop);
        var perMin = Math.round((r.perMin || 0) * 10) / 10;
        var pct = Math.round((r.dropPct || 0) * 10) / 10;
        var evidence =
          '근거: ' +
          UI.formatRankTime(r.fromTs) +
          ' → ' +
          UI.formatRankTime(r.toTs) +
          ' · ' +
          UI.formatRankElapsed(r.elapsedMs) +
          ' · 옵션 ' +
          UI.num(r.optionCount || 0) +
          '개 합계';
        return (
          '<article class="velocity-row" data-action="showRankDetail" data-goodsno="' +
          UI.esc(r.goodsNo) +
          '">' +
          '<div class="velocity-rank">#' +
          r.rank +
          '</div>' +
          '<div class="velocity-thumb">' +
          img +
          '</div>' +
          '<div class="velocity-main">' +
          '<p class="velocity-name">' +
          UI.esc(r.goodsName) +
          '</p>' +
          '<div class="velocity-stock"><b>' +
          from +
          '</b><span>→</span><b>' +
          to +
          '</b><em>-' +
          drop +
          '개</em></div>' +
          '<div class="velocity-proof">' +
          UI.esc(evidence) +
          '</div>' +
          '</div>' +
          '<div class="velocity-metric">' +
          '<strong>분당 ' +
          UI.num(perMin) +
          '개</strong>' +
          '<span>감소율 ' +
          pct +
          '%</span>' +
          (r.hasToday ? '<span>오늘배송</span>' : '') +
          '<button type="button" class="velocity-buy" data-action="buyNow" data-goodsno="' +
          UI.esc(r.goodsNo) +
          '" data-original-label="바로구매">바로구매</button>' +
          '</div>' +
          '</article>'
        );
      })
      .join('');

    root.innerHTML = head + '<div class="velocity-list">' + body + '</div></section>';
  },

  /** 목록용 실시간 조회: 매장 재고 없이 온라인만 채운 응답 */
  inventoryOnlineOnly: function (detail) {
    return (
      detail &&
      (detail.inventoryScope === 'online' || detail.source === 'live-online')
    );
  },

  isVendorDeliveryProduct: function (item) {
    var goodsNo = String((item && (item.goodsNo || item.goodsNumber)) || '').trim();
    return !!(
      item &&
      (item.vendorDelivery ||
        item.inventoryScope === 'vendor' ||
        item.stockStatus === 'vendor_delivery' ||
        /^B\d+/i.test(goodsNo))
    );
  },

  /**
   * 검색 API JSON → 상품 배열.
   * 실제 응답: data.inventory = { totalCount, products: [...], ... } (배열은 .products)
   * 구버전/대체: data.products
   */
  productsFromSearchApiResponse: function (d) {
    var data = d;
    var dd = (data && data.data) || {};
    console.log('inventory 타입:', typeof (dd && dd.inventory));
    var invForLog = dd && dd.inventory;
    var invJson = '';
    try {
      invJson = JSON.stringify(invForLog) || '';
    } catch (e) {
      invJson = '';
    }
    console.log('inventory 첫 항목:', invJson.slice(0, 300));
    var inv = dd.inventory != null ? dd.inventory : data && data.inventory;
    var flat =
      dd.products != null
        ? dd.products
        : data && data.products != null
          ? data.products
          : null;
    if (Array.isArray(inv)) return inv;
    if (inv && typeof inv === 'object' && Array.isArray(inv.products)) return inv.products;
    if (Array.isArray(flat)) return flat;
    return [];
  },

  renderHistory: function (arr) {
    var c = document.getElementById('search-history');
    if (!c) return;
    if (!arr || !arr.length) {
      c.innerHTML = '';
      return;
    }
    var tags = arr
      .map(function (h) {
        return (
          '<button type="button" class="history-tag" data-action="searchHistory" data-keyword="' +
          UI.esc(h) +
          '">' +
          UI.esc(h) +
          '</button>'
        );
      })
      .join('');
    c.innerHTML =
      '<div class="history-row">' +
      '<div class="history-tags">' +
      tags +
      '</div>' +
      '<button type="button" class="history-clear-btn" data-action="clearSearchHistory" title="전체 삭제">🗑 전체 삭제</button>' +
      '</div>';
  },

  showLoading: function (msg) {
    var c = document.getElementById('product-list');
    if (c)
      c.innerHTML =
        '<div class="loading"><div class="spinner"></div><p>' +
        UI.esc(msg || '로딩 중...') +
        '</p></div>';
  },

  clearResults: function () {
    var c = document.getElementById('product-list');
    if (!c) return;
    c.innerHTML = '';
  },

  showSearchLoading: function (keyword) {
    var c = document.getElementById('product-list');
    if (!c) return;
    c.innerHTML =
      '<div class="search-in-progress">' +
      '<div class="spinner search-in-progress-spinner"></div>' +
      '<p class="search-in-progress-msg"><strong>\'' +
      UI.esc(keyword) +
      '\'</strong> 검색 중…</p>' +
      '<p class="search-in-progress-hint">잠시만 기다려 주세요</p>' +
      '</div>';
  },

  showSearchError: function (message, keyword) {
    var c = document.getElementById('product-list');
    if (!c) return;
    var kw = String(keyword || '').trim();
    c.innerHTML =
      '<div class="empty-state search-error-state">' +
      '<p>⚠️ ' +
      UI.esc(message || '검색 실패') +
      '</p>' +
      (kw
        ? '<button type="button" class="retry-search-btn btn-oy" data-action="retrySearch" data-keyword="' +
          UI.esc(kw) +
          '">다시 시도</button>'
        : '') +
      '</div>';
  },

  showError: function (msg) {
    var c = document.getElementById('product-list');
    if (c) c.innerHTML = '<div class="empty-state"><p>⚠️ ' + UI.esc(msg) + '</p></div>';
  },

  setActiveTab: function (tab) {
    document.querySelectorAll('.main-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    var searchSection = document.getElementById('search-section');
    var hotSection = document.getElementById('hot-section');
    var favSection = document.getElementById('fav-section');
    if (searchSection) searchSection.style.display = tab === 'search' ? '' : 'none';
    if (hotSection) hotSection.style.display = tab === 'hot' ? '' : 'none';
    if (favSection) favSection.style.display = tab === 'favorites' ? '' : 'none';
  },

  showHotRankingLoading: function () {
    var root = document.getElementById('hot-rank-root');
    if (!root) return;
    root.innerHTML =
      '<div class="loading hot-loading"><div class="spinner"></div><p>조회 인기템 불러오는 중...</p></div>';
  },

  renderHotRanking: function (products, state) {
    state = state || {};
    var root = document.getElementById('hot-rank-root');
    if (!root) return;
    products = products || [];
    var estimates = state.estimates || {};
    var purchaseLimits = state.purchaseLimits || {};
    var sortMode =
      state.sortMode === 'revenue' ? 'revenue' : state.sortMode === 'sales' ? 'sales' : 'view';
    var range = state.range || (CONFIG.HOT_RANK_DEFAULT_RANGE || '1d');
    var category = state.category || (CONFIG.HOT_RANK_DEFAULT_CATEGORY || '');
    var categoryLabel = UI.hotCategoryLabel(category);
    var source = state.source || '';
    var includedMeasuredCount = Number(state.includedMeasuredCount || 0);
    var refreshState = state.refreshState || 'idle';
    var isRefreshing = refreshState === 'loading';
    var refreshMessage = state.refreshMessage || '';
    var refreshStatusAttr = refreshMessage
      ? ' role="status" aria-live="polite"'
      : ' aria-hidden="true"';
    var refreshStatusHtml =
      '<span class="hot-refresh-status ' +
      UI.esc(refreshState) +
      '"' +
      refreshStatusAttr +
      '>' +
      (refreshMessage ? UI.esc(refreshMessage) : '&nbsp;') +
      '</span>';
    var ranges = CONFIG.HOT_RANK_RANGES || {
      '1d': { label: '24시간' },
      '7d': { label: '7일' },
      '30d': { label: '30일' }
    };
    var categories = CONFIG.HOT_RANK_CATEGORIES || [{ id: '', label: '전체' }];
    var stockUpdatedAt = state.lastStockRunAt || state.updatedAt || '';
    var updatedAt = stockUpdatedAt ? UI.formatRankTime(stockUpdatedAt) : '';
    var measuredCount = Object.keys(estimates).filter(function (gn) {
      if (!estimates[gn]) return false;
      var dailySales =
        estimates[gn].dailyEstimatedSales != null
          ? estimates[gn].dailyEstimatedSales
          : estimates[gn].drop || estimates[gn].estimatedSales || 0;
      return Number(dailySales) > 0;
    }).length;
    var hotLimit = Number(CONFIG.HOT_RANK_SIZE || 128) || 128;
    var summaryParts = [];
    if (updatedAt) summaryParts.push(updatedAt + ' 마지막 수집');
    summaryParts.push(
      category
        ? UI.esc(categoryLabel) + ' TOP' + UI.num(hotLimit)
        : includedMeasuredCount > 0
          ? '전체 TOP' + UI.num(hotLimit) + '+측정상품'
          : '전체 TOP' + UI.num(hotLimit)
    );
    summaryParts.push('08:00~01:00 매시 자동수집');
    summaryParts.push(hotLimit + '위 밖 추적 중지');
    summaryParts.push('판매/매출 24시간 기준');
    summaryParts.push('판매측정 ' + UI.num(measuredCount) + '개');
    var basisNote = category
      ? '카테고리 탭은 목록 확인용이며 자동 재고 추적은 전체 조회 TOP' +
        UI.num(hotLimit) +
        ' 안에서만 진행됩니다'
      : includedMeasuredCount > 0
        ? '판매량·매출순은 전체 조회 TOP' +
          UI.num(hotLimit) +
          '에 별도 측정 상품 ' +
          UI.num(includedMeasuredCount) +
          '개를 합쳐 계산'
        : '전체 조회 TOP' +
          UI.num(hotLimit) +
          '만 08:00~01:00 KST 매시 저장하고, 순위 밖 상품은 다음 수집 대상에서 제외됩니다';
    if (source === 'oliveyoung-view-rank' || source === 'oliveyoung-view-rank-category') {
      basisNote = category
        ? '저장된 카테고리 랭킹이 없어 임시 조회순을 표시 중입니다. 판매량·매출은 다음 수집 후 반영됩니다'
        : '저장된 랭킹이 없어 임시 조회순을 표시 중입니다. 판매량·매출은 다음 수집 후 반영됩니다';
    }
    var rangeButtons = Object.keys(ranges)
      .map(function (key) {
        return (
          '<button type="button" data-action="setHotRange" data-range="' +
          UI.esc(key) +
          '" class="' +
          (range === key ? 'active' : '') +
          '">' +
          UI.esc(ranges[key].label || key) +
          '</button>'
        );
      })
      .join('');
    var categoryButtons = categories
      .map(function (cat) {
        var id = String((cat && cat.id) || '');
        var active = String(category || '') === id;
        return (
          '<button type="button" data-action="setHotCategory" data-category="' +
          UI.esc(id) +
          '" class="' +
          (active ? 'active' : '') +
          '" aria-pressed="' +
          (active ? 'true' : 'false') +
          '">' +
          UI.esc((cat && cat.label) || id || '전체') +
          '</button>'
        );
      })
      .join('');

    var head =
      '<section class="hot-panel">' +
      '<div class="hot-head">' +
      '<div><h2>🔥 조회 인기템 TOP ' +
      UI.num(hotLimit) +
      '</h2><p class="hot-summary">' +
      summaryParts.join(' · ') +
      '</p><p class="hot-basis-note">' +
      UI.esc(basisNote) +
      '</p></div>' +
      '<div class="hot-actions">' +
      '<div class="hot-range" role="group" aria-label="그래프 기간">' +
      rangeButtons +
      '</div>' +
      '<div class="hot-sort" role="group" aria-label="인기템 정렬">' +
      '<button type="button" data-action="setHotSort" data-sort="view" class="' +
      (sortMode === 'view' ? 'active' : '') +
      '">조회순</button>' +
      '<button type="button" data-action="setHotSort" data-sort="sales" class="' +
      (sortMode === 'sales' ? 'active' : '') +
      '">판매량순</button>' +
      '<button type="button" data-action="setHotSort" data-sort="revenue" class="' +
      (sortMode === 'revenue' ? 'active' : '') +
      '">매출순</button>' +
      '</div>' +
      refreshStatusHtml +
      '<button type="button" class="velocity-refresh hot-refresh' +
      (isRefreshing ? ' is-refreshing' : '') +
      '" data-action="refreshHotRanking" title="저장 데이터 다시 확인" aria-label="' +
      (isRefreshing ? '인기템 저장 데이터 확인 중' : '인기템 저장 데이터 다시 확인') +
      '"' +
      (isRefreshing ? ' aria-busy="true" disabled' : '') +
      '><span class="refresh-glyph">↻</span></button>' +
      '</div>' +
      '</div>' +
      '<div class="hot-categories" role="group" aria-label="인기템 카테고리">' +
      categoryButtons +
      '</div>';

    if (!products.length) {
      root.innerHTML =
        head +
        '<div class="empty-state"><p>' +
        UI.esc(categoryLabel) +
        ' 인기템을 불러오지 못했습니다</p>' +
        '<button type="button" class="retry-search-btn btn-oy" data-action="refreshHotRanking">다시 시도</button></div></section>';
      return;
    }

    var sortedProducts = products.slice();
    if (sortMode === 'sales' || sortMode === 'revenue') {
      sortedProducts.sort(function (a, b) {
        var agn = String(a.goodsNo || a.goodsNumber || '');
        var bgn = String(b.goodsNo || b.goodsNumber || '');
        var ae = estimates[agn] || {};
        var be = estimates[bgn] || {};
        var ad = Number(
          ae.dailyEstimatedSales != null ? ae.dailyEstimatedSales : ae.drop || ae.estimatedSales || 0
        );
        var bd = Number(
          be.dailyEstimatedSales != null ? be.dailyEstimatedSales : be.drop || be.estimatedSales || 0
        );
        if (sortMode === 'revenue') {
          var ar = Number(
            ae.dailyEstimatedRevenue != null
              ? ae.dailyEstimatedRevenue
              : ae.estimatedRevenue != null
                ? ae.estimatedRevenue
                : ae.revenue != null
                  ? ae.revenue
                  : ad * (ae.price || a.price || 0)
          );
          var br = Number(
            be.dailyEstimatedRevenue != null
              ? be.dailyEstimatedRevenue
              : be.estimatedRevenue != null
                ? be.estimatedRevenue
                : be.revenue != null
                  ? be.revenue
                  : bd * (be.price || b.price || 0)
          );
          if (br !== ar) return br - ar;
        }
        if (bd !== ad) return bd - ad;
        return (a.rank || 9999) - (b.rank || 9999);
      });
    }

    var body = sortedProducts
      .map(function (p, idx) {
        var gn = String(p.goodsNo || p.goodsNumber || '');
        var estimate = estimates[gn];
        var img = p.imageUrl
          ? '<img src="' + UI.esc(p.imageUrl) + '" alt="" loading="lazy" decoding="async">'
          : '<div class="velocity-no-img">📦</div>';
        var rank = sortMode === 'view' ? p.rank || idx + 1 : idx + 1;
        var viewCount = UI.num(p.viewCount || 0);
        var purchaseLimit =
          (estimate && estimate.purchaseLimit) || purchaseLimits[gn] || p.purchaseLimit || null;
        var limitText = purchaseLimit
          ? purchaseLimit.label || (purchaseLimit.limited ? '구매제한' : '제한없음')
          : '구매제한 확인중';
        var limitClass =
          purchaseLimit && purchaseLimit.limited
            ? 'hot-limit hot-limit-on'
            : purchaseLimit && purchaseLimit.checked
              ? 'hot-limit'
              : 'hot-limit hot-limit-pending';
        var chartMode =
          sortMode === 'revenue' ? 'revenue' : sortMode === 'sales' ? 'sales' : 'view';
        var salesMetricLabel = '24시간';
        var chartPoints = [];
        if (estimate) {
          chartPoints =
            chartMode === 'revenue'
              ? estimate.revenueChart || []
              : chartMode === 'sales'
                ? estimate.salesChart || []
                : estimate.viewChart || [];
        }
        var salesBlock = '';
        if (
          estimate &&
          (estimate.observationCount >= 2 ||
            (estimate.fromTs && estimate.toTs && String(estimate.fromTs) !== String(estimate.toTs)))
        ) {
          var drop = estimate.drop || estimate.estimatedSales || 0;
          var dailyDrop =
            estimate.dailyEstimatedSales != null ? estimate.dailyEstimatedSales : drop;
          var perHour = estimate.perHour != null ? estimate.perHour : (estimate.perMin || 0) * 60;
          var price = Number(estimate.price || p.price || 0);
          var revenue = Number(
            estimate.estimatedRevenue != null
              ? estimate.estimatedRevenue
              : estimate.revenue != null
                ? estimate.revenue
                : drop * price || 0
          );
          var dailyRevenue =
            estimate.dailyEstimatedRevenue != null ? Number(estimate.dailyEstimatedRevenue) : revenue;
          var restock =
            estimate.restockUnits > 0
              ? '<span class="hot-restock">입고 +' +
                UI.num(estimate.restockUnits) +
                '개 보정</span>'
              : '';
          var confidence =
            estimate.confidence === 'low'
              ? '<span class="hot-confidence-low">신뢰도 낮음</span>'
              : '';
          salesBlock =
            '<div class="hot-sales hot-sales-ok"><strong>' +
            UI.esc(salesMetricLabel) +
            '판매 ' +
            UI.num(dailyDrop) +
            '개</strong><span>' +
            UI.esc(salesMetricLabel) +
            '매출 ' +
            UI.formatWon(dailyRevenue) +
            '</span><span>' +
            UI.num(estimate.fromTotal) +
            ' → ' +
            UI.num(estimate.toTotal) +
            ' · 시간당 ' +
            UI.num(Math.round(perHour * 10) / 10) +
            '개</span>' +
            restock +
            confidence +
            '</div>' +
            UI.renderHotSparkline(chartPoints, { mode: chartMode });
        } else {
          var waitingText = '선별 재고 스냅샷 누적 대기';
          if (estimate && Number(estimate.observationCount || 0) === 1) {
            waitingText =
              '첫 수집 ' +
              UI.formatRankTime(estimate.toTs || estimate.fromTs) +
              ' · 재고 ' +
              UI.num(estimate.toTotal || estimate.fromTotal || 0) +
              '개 · 다음 수집 후 계산';
          }
          salesBlock =
            '<div class="hot-sales"><strong>측정중</strong><span>' +
            UI.esc(waitingText) +
            '</span></div>' +
            UI.renderHotSparkline(chartPoints, { mode: chartMode });
        }
        return (
          '<article class="hot-row" data-action="showHotDetail" data-goodsno="' +
          UI.esc(gn) +
          '">' +
          '<div class="hot-rank">#' +
          UI.num(rank) +
          '</div>' +
          '<div class="hot-thumb">' +
          img +
          '</div>' +
          '<div class="hot-main">' +
          '<p class="hot-name">' +
          UI.esc(p.goodsName) +
          '</p>' +
          '<div class="hot-meta"><span>' +
          viewCount +
          '명이 보고있어요</span>' +
          (sortMode !== 'view' ? '<span>조회순 ' + UI.hotRankText(p.rank || idx + 1) + '</span>' : '') +
          (estimate && estimate.salesRank ? '<span>판매순 #' + UI.num(estimate.salesRank) + '</span>' : '') +
          (estimate && estimate.revenueRank ? '<span>매출순 #' + UI.num(estimate.revenueRank) + '</span>' : '') +
          '<span class="' +
          limitClass +
          '">' +
          UI.esc(limitText) +
          '</span>' +
          '</div>' +
          salesBlock +
          '</div>' +
          '<button type="button" class="velocity-buy hot-buy" data-action="buyNow" data-goodsno="' +
          UI.esc(gn) +
          '" data-category="' +
          UI.esc(p.categoryNumber || '') +
          '" data-original-label="바로구매">바로구매</button>' +
          '</article>'
        );
      })
      .join('');

    root.innerHTML = head + '<div class="hot-list">' + body + '</div></section>';
    UI.bindHotCharts(root);
  },

  /** 검색 그리드: 공개 캐시(stock-detail.json) 기준 온라인만 표시, 매장 뱃지는 숨김(수집 위치와 사용자 위치 불일치) */
  renderProducts: function (products, detailData, opts) {
    opts = opts || {};
    var searchListCacheMode = !!opts.searchListCacheMode;
    var c = document.getElementById('product-list');
    if (!c) return;
    if (!products || !products.length) {
      c.innerHTML = '<div class="empty-state"><p>검색 결과가 없습니다</p></div>';
      return;
    }
    var detailMap = {};
    if (detailData && detailData.products) detailMap = detailData.products;

    var bar =
      '<div class="sbar"><span>검색결과 <b>' +
      products.length +
      '</b>개</span><span class="ok">상품 클릭 → 재고확인 | ⭐ → 즐겨찾기</span></div>';

    var cards = products
      .map(function (p, i) {
        var gn = String(p.goodsNumber || p.goodsNo || '');
        var isFav = Storage.isFavorite(gn);
        var detail = detailMap[gn];
        if (searchListCacheMode && detail && !UI.inventoryOnlineOnly(detail)) {
          detail = null;
        }
        var vendorDelivery = UI.isVendorDeliveryProduct(p) || UI.isVendorDeliveryProduct(detail);
        var listOnlineOnly = UI.inventoryOnlineOnly(detail);
        if (searchListCacheMode) listOnlineOnly = true;
        var catHint =
          p.categoryNumber != null && String(p.categoryNumber).trim() !== ''
            ? String(p.categoryNumber).trim()
            : p.masterCategoryNumber != null && String(p.masterCategoryNumber).trim() !== ''
              ? String(p.masterCategoryNumber).trim()
              : '';
        var disc = p.discountRate > 0 ? '<span class="disc">' + p.discountRate + '%</span>' : '';
        var orig =
          p.originalPrice && p.originalPrice !== p.priceToPay
            ? '<span class="orig">' + UI.num(p.originalPrice) + '원</span>'
            : '';
        var badges = '';
        var onlineBadge = '';
        var optionBtn = '';
        if (vendorDelivery) {
          badges = '<span class="badge bg-purple">업체배송</span>';
          onlineBadge = '<span class="badge bg-gray">실시간 재고 제외</span>';
        } else if (detail) {
          if (detail.status === 'discontinued') {
            badges = '<span class="badge bg-red">단종</span>';
          } else if (!listOnlineOnly) {
            if (detail.status === 'soldout') {
              badges = '<span class="badge bg-orange">주변품절</span>';
            } else if (detail.status === 'active') {
              var totalIn = (detail.options || []).reduce(function (a, o) {
                return a + (o.inStock || 0);
              }, 0);
              badges = '<span class="badge bg-green">매장 ' + totalIn + '곳</span>';
            }
          }

          var totalOnline = (detail.options || []).reduce(function (a, o) {
            return a + (o.onlineQty || 0);
          }, 0);
          if (totalOnline > 0) {
            onlineBadge =
              '<span class="badge bg-blue">🛒 온라인 ' + UI.num(totalOnline) + '개</span>';
            var hasToday = (detail.options || []).some(function (o) {
              return o.deliveredToday;
            });
            if (hasToday) onlineBadge += '<span class="badge bg-blue-light">⚡오늘배송</span>';
          } else if (detail.status !== 'discontinued') {
            onlineBadge = '<span class="badge bg-gray">🛒 온라인 품절</span>';
          }

          if ((detail.options || []).length > 1) {
            optionBtn =
              '<button type="button" class="badge-btn bg-purple" data-action="toggleOptions" data-goodsno="' +
              UI.esc(gn) +
              '">옵션 ' +
              detail.options.length +
              '개 ▾</button>';
          }
        }

        var optPanel = '';
        if (detail && (detail.options || []).length > 1) {
          optPanel =
            '<div class="card-options hidden" id="opts-' +
            UI.esc(gn) +
            '">' +
            detail.options
              .map(function (o) {
                var optName = o.name || '기본';
                if (optName.indexOf(']') > -1) optName = optName.substring(optName.lastIndexOf(']') + 1).trim();
                if (optName.length > 25) optName = optName.substring(0, 25) + '…';
                var storeInfo =
                  o.inStock > 0 ? '매장 ' + o.inStock + '곳(' + o.totalQty + '개)' : '매장 품절';
                var onlineInfo =
                  o.onlineQty > 0
                    ? '<span class="opt-online-ok">🛒' +
                      UI.num(o.onlineQty) +
                      '개' +
                      (o.deliveredToday ? ' ⚡' : '') +
                      '</span>'
                    : '<span class="opt-online-out">🛒품절</span>';
                var stockCol = listOnlineOnly
                  ? onlineInfo
                  : storeInfo + ' | ' + onlineInfo;
                return (
                  '<div class="card-opt-row">' +
                  '<span class="card-opt-name">' +
                  UI.esc(optName) +
                  '</span>' +
                  '<span class="card-opt-stock">' +
                  stockCol +
                  '</span>' +
                  '</div>'
                );
              })
              .join('') +
            '</div>';
        }

        var img = p.imageUrl || (detail ? detail.thumbnail : '') || '';
        var imgTag = img
          ? '<img src="' + UI.esc(img) + '" alt="" loading="lazy" decoding="async">'
          : '<div class="no-img">📦</div>';
        var cardSoldClass =
          detail && detail.status === 'discontinued'
            ? ' soldout'
            : !listOnlineOnly && detail && detail.status === 'soldout'
              ? ' soldout'
              : '';
        var buyBtn =
          '<div class="card-actions">' +
          '<button type="button" class="btn-buy-compact" data-action="buyNow" data-goodsno="' +
          UI.esc(gn) +
          '" data-category="' +
          UI.esc(catHint) +
          '" data-original-label="바로구매">바로구매</button>' +
          '</div>';
        return (
          '<div class="card' +
          cardSoldClass +
          '" data-index="' +
          i +
          '"><div class="card-img" data-action="showDetail" data-index="' +
          i +
          '">' +
          imgTag +
          '<div class="badges">' +
          badges +
          onlineBadge +
          optionBtn +
          '</div></div><div class="card-body"><div class="card-top"><p class="card-name" data-action="showDetail" data-index="' +
          i +
          '">' +
          UI.esc(p.goodsName) +
          '</p><button type="button" class="fav-btn' +
          (isFav ? ' active' : '') +
          '" data-action="toggleFav" data-index="' +
          i +
          '">' +
          (isFav ? '★' : '☆') +
          '</button></div><div class="card-price">' +
          disc +
          '<span class="price">' +
          UI.num(p.priceToPay) +
          '원</span>' +
          orig +
          '</div>' +
          buyBtn +
          '</div>' +
          optPanel +
          '</div>'
        );
      })
      .join('');

    c.innerHTML = bar + '<div class="grid">' + cards + '</div>';
  },

  updateCardBadge: function (goodsNo, detail) {
    if (!detail) return;
    var gn = String(goodsNo);

    function applyBadgesToCard(card) {
      var badgesDiv = card.querySelector('.badges');
      if (!badgesDiv) return;

      var listOnlineOnly = UI.inventoryOnlineOnly(detail);
      var badges = '';
      var onlineBadge = '';
      var optionBtn = '';
      if (UI.isVendorDeliveryProduct(detail)) {
        badges = '<span class="badge bg-purple">업체배송</span>';
        onlineBadge = '<span class="badge bg-gray">실시간 재고 제외</span>';
      } else if (detail.status === 'discontinued') {
        badges = '<span class="badge bg-red">단종</span>';
      } else if (!listOnlineOnly) {
        if (detail.status === 'soldout') {
          badges = '<span class="badge bg-orange">주변품절</span>';
        } else if (detail.status === 'active') {
          var totalIn = (detail.options || []).reduce(function (a, o) {
            return a + (o.inStock || 0);
          }, 0);
          badges = '<span class="badge bg-green">매장 ' + totalIn + '곳</span>';
        }
      }

      var totalOnline = (detail.options || []).reduce(function (a, o) {
        return a + (o.onlineQty || 0);
      }, 0);
      if (totalOnline > 0) {
        onlineBadge =
          '<span class="badge bg-blue">🛒 온라인 ' + UI.num(totalOnline) + '개</span>';
        var hasToday = (detail.options || []).some(function (o) {
          return o.deliveredToday;
        });
        if (hasToday) onlineBadge += '<span class="badge bg-blue-light">⚡오늘배송</span>';
      } else if (detail.status !== 'discontinued') {
        onlineBadge = '<span class="badge bg-gray">🛒 온라인 품절</span>';
      }

      if ((detail.options || []).length > 1) {
        optionBtn =
          '<button type="button" class="badge-btn bg-purple" data-action="toggleOptions" data-goodsno="' +
          UI.esc(gn) +
          '">옵션 ' +
          detail.options.length +
          '개 ▾</button>';
      }

      badgesDiv.innerHTML = badges + onlineBadge + optionBtn;

      card.classList.remove('soldout');
      if (detail.status === 'discontinued') {
        card.classList.add('soldout');
      } else if (!listOnlineOnly && detail.status === 'soldout') {
        card.classList.add('soldout');
      }

      if ((detail.options || []).length > 1 && !card.querySelector('.card-options')) {
        var optPanel =
          '<div class="card-options hidden" id="opts-' +
          UI.esc(gn) +
          '">' +
          detail.options
            .map(function (o) {
              var optName = o.name || '기본';
              if (optName.indexOf(']') > -1) optName = optName.substring(optName.lastIndexOf(']') + 1).trim();
              if (optName.length > 25) optName = optName.substring(0, 25) + '…';
              var storeInfo =
                o.inStock > 0 ? '매장 ' + o.inStock + '곳(' + o.totalQty + '개)' : '매장 품절';
              var onlineInfo =
                o.onlineQty > 0
                  ? '<span class="opt-online-ok">🛒' +
                    UI.num(o.onlineQty) +
                    '개' +
                    (o.deliveredToday ? ' ⚡' : '') +
                    '</span>'
                  : '<span class="opt-online-out">🛒품절</span>';
              var stockCol = listOnlineOnly
                ? onlineInfo
                : storeInfo + ' | ' + onlineInfo;
              return (
                '<div class="card-opt-row">' +
                '<span class="card-opt-name">' +
                UI.esc(optName) +
                '</span>' +
                '<span class="card-opt-stock">' +
                stockCol +
                '</span>' +
                '</div>'
              );
            })
            .join('') +
          '</div>';
        card.insertAdjacentHTML('beforeend', optPanel);
      }
    }

    var plist = document.getElementById('product-list');
    if (plist && App.products && App.products.length) {
      plist.querySelectorAll('.grid .card').forEach(function (card) {
        var imgWrap = card.querySelector('.card-img[data-action="showDetail"]');
        if (!imgWrap) return;
        var idx = parseInt(imgWrap.dataset.index, 10);
        if (isNaN(idx) || idx < 0 || !App.products[idx]) return;
        var pgn = String(App.products[idx].goodsNumber || App.products[idx].goodsNo || '');
        if (pgn !== gn) return;
        applyBadgesToCard(card);
      });
    }

    var flist = document.getElementById('fav-list');
    if (flist) {
      flist.querySelectorAll('.grid .card').forEach(function (card) {
        var imgWrap = card.querySelector('.card-img[data-action="showFavDetail"]');
        if (!imgWrap) return;
        var gno = String(imgWrap.dataset.goodsno || '');
        if (gno !== gn) return;
        applyBadgesToCard(card);
      });
    }
  },

  renderFavorites: function (favorites, detailData) {
    var c = document.getElementById('fav-list');
    if (!c) return;
    if (!favorites || !favorites.length) {
      c.innerHTML =
        '<div class="empty-state"><p>즐겨찾기한 상품이 없습니다</p><p class="sub">검색 결과에서 ⭐ 버튼을 눌러 추가하세요</p></div>';
      return;
    }
    var detailMap = {};
    if (detailData && detailData.products) detailMap = detailData.products;
    var updatedAt = detailData ? detailData.updatedAt : null;
    var timeStr = updatedAt
      ? new Date(updatedAt).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      : '';
    var bar =
      '<div class="sbar"><span>즐겨찾기 <b>' +
      favorites.length +
      '</b>개</span>' +
      (timeStr
        ? '<span class="ok">📦 공개 캐시 ' + timeStr + '</span>'
        : '<span class="ok">매장·온라인 재고는 실시간 조회</span>') +
      '<button type="button" class="alert-check-btn" data-action="checkRestockAlerts">알림확인</button>' +
      '</div>';
    var alertPanel = window.RestockAlerts ? RestockAlerts.managerHtml() : '';
    var cards = favorites
      .map(function (f) {
        var gid = String(f.goodsNo || f.goodsNumber || '');
        var detail = detailMap[gid];
        var displayName = detail ? detail.goodsName : f.goodsName;
        var displayImage = (detail ? detail.thumbnail : '') || f.imageUrl || '';
        var alertMeta = { goodsName: displayName || '', imageUrl: displayImage || '' };
        var listOnlineOnlyF = UI.inventoryOnlineOnly(detail);
        var vendorDeliveryF = UI.isVendorDeliveryProduct(f) || UI.isVendorDeliveryProduct(detail);
        var favCat =
          f.categoryNumber != null && String(f.categoryNumber).trim() !== ''
            ? String(f.categoryNumber).trim()
            : '';
        var badges = '';
        var onlineBadge = '';
        var optionBtn = '';
        if (vendorDeliveryF) {
          badges = '<span class="badge bg-purple">업체배송</span>';
          onlineBadge = '<span class="badge bg-gray">실시간 재고 제외</span>';
        } else if (detail) {
          if (detail.status === 'discontinued') {
            badges = '<span class="badge bg-red">단종</span>';
          } else if (!listOnlineOnlyF) {
            if (detail.status === 'soldout') {
              badges = '<span class="badge bg-orange">주변품절</span>';
            } else if (detail.status === 'active') {
              var totalInF = (detail.options || []).reduce(function (a, o) {
                return a + (o.inStock || 0);
              }, 0);
              badges = '<span class="badge bg-green">매장 ' + totalInF + '곳</span>';
            }
          }

          var totalOnlineF = (detail.options || []).reduce(function (a, o) {
            return a + (o.onlineQty || 0);
          }, 0);
          if (totalOnlineF > 0) {
            onlineBadge =
              '<span class="badge bg-blue">🛒 온라인 ' + UI.num(totalOnlineF) + '개</span>';
            var hasTodayF = (detail.options || []).some(function (o) {
              return o.deliveredToday;
            });
            if (hasTodayF) onlineBadge += '<span class="badge bg-blue-light">⚡오늘배송</span>';
          } else if (detail.status !== 'discontinued') {
            onlineBadge = '<span class="badge bg-gray">🛒 온라인 품절</span>';
          }

          if ((detail.options || []).length > 1) {
            optionBtn =
              '<button type="button" class="badge-btn bg-purple" data-action="toggleOptions" data-goodsno="' +
              UI.esc(gid) +
              '">옵션 ' +
              detail.options.length +
              '개 ▴</button>';
          }
        } else {
          badges = '<span class="badge bg-gray">수집대기</span>';
        }

        var optPanelF = '';
        if (detail && (detail.options || []).length > 1) {
          optPanelF =
            '<div class="card-options" id="opts-' +
            UI.esc(gid) +
            '">' +
            detail.options
              .map(function (o, optIdx) {
                var optName = o.name || '기본';
                if (optName.indexOf(']') > -1) optName = optName.substring(optName.lastIndexOf(']') + 1).trim();
                if (optName.length > 25) optName = optName.substring(0, 25) + '…';
                var storeInfo =
                  o.inStock > 0 ? '매장 ' + o.inStock + '곳(' + o.totalQty + '개)' : '매장 품절';
                var onlineInfo =
                  o.onlineQty > 0
                    ? '<span class="opt-online-ok">🛒' +
                      UI.num(o.onlineQty) +
                      '개' +
                      (o.deliveredToday ? ' ⚡' : '') +
                      '</span>'
                    : '<span class="opt-online-out">🛒품절</span>';
                var stockColF = listOnlineOnlyF
                  ? onlineInfo
                  : storeInfo + ' | ' + onlineInfo;
                var optionAlert =
                  window.RestockAlerts
                    ? RestockAlerts.optionControlHtml(gid, o, alertMeta, optIdx, true)
                    : '';
                return (
                  '<div class="card-opt-row">' +
                  '<span class="card-opt-name">' +
                  UI.esc(optName) +
                  '</span>' +
                  '<span class="card-opt-stock">' +
                  stockColF +
                  '</span>' +
                  optionAlert +
                  '</div>'
                );
              })
              .join('') +
            '</div>';
        }

        var img = displayImage;
        var imgTag = img
          ? '<img src="' + UI.esc(img) + '" alt="" loading="lazy" decoding="async">'
          : '<div class="no-img">📦</div>';
        var price = detail ? detail.price : f.price || f.priceToPay || 0;
        var disc = (detail ? detail.discountRate : f.discountRate) || 0;
        var origPrice = (detail ? detail.originalPrice : f.originalPrice) || 0;
        var favSoldClass =
          detail && detail.status === 'discontinued'
            ? ' soldout'
            : !listOnlineOnlyF && detail && detail.status === 'soldout'
              ? ' soldout'
              : '';
        var buyBtnF =
          '<div class="card-actions">' +
          '<button type="button" class="btn-buy-compact" data-action="buyNow" data-goodsno="' +
          UI.esc(gid) +
          '" data-category="' +
          UI.esc(favCat) +
          '" data-original-label="바로구매">바로구매</button>' +
          (window.RestockAlerts
            ? RestockAlerts.productControlHtml(gid, alertMeta, 'card-restock-alert')
            : '') +
          '</div>';
        return (
          '<div class="card' +
          favSoldClass +
          '"><div class="card-img" data-action="showFavDetail" data-goodsno="' +
          UI.esc(gid) +
          '">' +
          imgTag +
          '<div class="badges">' +
          badges +
          onlineBadge +
          optionBtn +
          '</div></div><div class="card-body"><div class="card-top"><p class="card-name" data-action="showFavDetail" data-goodsno="' +
          UI.esc(gid) +
          '">' +
          UI.esc(displayName) +
          '</p><button type="button" class="fav-btn active" data-action="removeFav" data-goodsno="' +
          UI.esc(gid) +
          '">★</button></div><div class="card-price">' +
          (disc > 0 ? '<span class="disc">' + disc + '%</span>' : '') +
          '<span class="price">' +
          UI.num(price) +
          '원</span>' +
          (origPrice && origPrice !== price ? '<span class="orig">' + UI.num(origPrice) + '원</span>' : '') +
          '</div>' +
          buyBtnF +
          '</div>' +
          optPanelF +
          '</div>'
        );
      })
      .join('');
    c.innerHTML = bar + alertPanel + '<div class="grid">' + cards + '</div>';
  },

  _handlePopupRootClick: function (e) {
    var root = document.getElementById('popup-root');
    var el = e.target.closest('[data-action]');
    if (!el || !root || !root.contains(el)) return;
    var action = el.dataset.action;

    if (action === 'closePopup') {
      e.preventDefault();
      e.stopPropagation();
      UI.closePopup();
      return;
    }
    if (action === 'openOliveYoung') {
      e.preventDefault();
      e.stopPropagation();
      UI.openOliveYoungProduct(el);
      return;
    }
    if (action === 'buyNow') {
      e.preventDefault();
      e.stopPropagation();
      if (el.dataset.goodsno) UI.openOliveYoungProduct(el);
      return;
    }
    if (action === 'switchTab') {
      e.preventDefault();
      e.stopPropagation();
      UI.switchTab(parseInt(el.dataset.idx, 10));
      return;
    }
    if (action === 'toggleFavPopup') {
      e.preventDefault();
      e.stopPropagation();
      App._toggleFavFromPopup(el.dataset.goodsno, el);
      return;
    }
    if (action === 'shareStockSnapshot') {
      e.preventDefault();
      e.stopPropagation();
      UI.shareStockSnapshot(el.dataset.goodsno);
      return;
    }
    if (action === 'loadAllStockOpt') {
      e.preventDefault();
      e.stopPropagation();
      var gno = el.dataset.goodsno;
      var pid = el.dataset.productid;
      if (!gno || !pid || el.classList.contains('loading')) return;
      if (!CONFIG.REALTIME_API) return;
      el.classList.add('loading');
      el.textContent = '🗺️ 전국 조회 중...';

      UI.fetchAllStock(gno, pid)
        .then(function (d) {
          if (d.success && d.options && d.options.length > 0) {
            UI.showAllStockPanel(d);
            el.textContent = '🗺️ 전국 재고 (조회완료)';
            el.classList.remove('loading');
          } else {
            el.textContent = '⚠️ 조회 실패: ' + (d.error || '데이터 없음');
            el.classList.remove('loading');
          }
        })
        .catch(function () {
          el.textContent = '⚠️ 서버 연결 실패';
          el.classList.remove('loading');
        });
    }
  },

  fetchAllStock: function (goodsNo, productId, timeoutMs) {
    var gno = String(goodsNo || '').trim();
    var pid = String(productId || '').trim();
    var key = gno + '|' + pid;
    if (!gno || !pid || !CONFIG.REALTIME_API) {
      return Promise.resolve({ success: false, error: 'invalid_request' });
    }
    if (UI._allStockCache[key]) return Promise.resolve(UI._allStockCache[key]);
    if (UI._allStockInflight[key]) return UI._allStockInflight[key];

    var allUrl =
      CONFIG.REALTIME_API.replace('/api/stock', '/api/stock-all') +
      '?goodsNo=' +
      encodeURIComponent(gno) +
      '&productId=' +
      encodeURIComponent(pid);
    var controller = new AbortController();
    var tid = setTimeout(function () {
      controller.abort();
    }, timeoutMs || 15000);

    UI._allStockInflight[key] = fetch(allUrl, { signal: controller.signal })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d && d.success && d.options && d.options.length > 0) {
          UI._allStockCache[key] = d;
          UI.markAllStockButtonReady(gno, pid);
        }
        return d;
      })
      .finally(function () {
        clearTimeout(tid);
        delete UI._allStockInflight[key];
      });
    return UI._allStockInflight[key];
  },

  prefetchAllStockForDetail: function (detail, goodsNo) {
    if (!detail || !CONFIG.REALTIME_API || !detail.options || !detail.options.length) return;
    var first = detail.options.find(function (o) {
      return o && o.productId != null && String(o.productId).trim() !== '';
    });
    if (!first) return;
    UI.fetchAllStock(goodsNo, first.productId).catch(function () {});
  },

  prefetchAllStockButton: function (btn) {
    if (!btn || !btn.dataset) return;
    var gno = btn.dataset.goodsno;
    var pid = btn.dataset.productid;
    if (!gno || !pid) return;
    UI.fetchAllStock(gno, pid).catch(function () {});
  },

  markAllStockButtonReady: function (goodsNo, productId) {
    var gno = String(goodsNo || '').trim();
    var pid = String(productId || '').trim();
    if (!gno || !pid) return;
    document.querySelectorAll('[data-action="loadAllStockOpt"]').forEach(function (btn) {
      if (
        String(btn.dataset.goodsno || '') === gno &&
        String(btn.dataset.productid || '') === pid &&
        !btn.classList.contains('loading')
      ) {
        btn.dataset.prefetched = '1';
        btn.textContent = '🗺️ 전국 재고 바로 보기';
      }
    });
  },

  _bindPopupEvents: function () {
    var root = document.getElementById('popup-root');
    if (!root || root.dataset.uiPopupClickBound === '1') return;
    root.dataset.uiPopupClickBound = '1';
    root.addEventListener('click', UI._handlePopupRootClick);
  },

  /** 재고 상세 팝업을 이미지로 저장·공유 (html2canvas) */
  shareStockSnapshot: function (goodsNo) {
    var content = document.querySelector('#popup-root .popup-content');
    if (!content) return;
    if (typeof html2canvas !== 'function') {
      alert('공유 기능을 불러오지 못했습니다. 페이지를 새로고침 해 주세요.');
      return;
    }
    var btn = document.querySelector('[data-action="shareStockSnapshot"]');
    var oldText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '이미지 만드는 중…';
    }
    var safeName =
      'oy-stock-' +
      String(goodsNo || 'goods').replace(/[^A-Za-z0-9_-]/g, '') +
      '-' +
      new Date().toISOString().slice(0, 10) +
      '.png';

    var el = content;
    var prevMax = el.style.maxHeight;
    var prevOv = el.style.overflow;
    var prevH = el.style.height;
    el.style.maxHeight = 'none';
    el.style.overflow = 'visible';
    el.style.height = 'auto';
    el.scrollTop = 0;

    var panels = el.querySelectorAll('.opt-panel');
    var panelBack = [];
    var i;
    for (i = 0; i < panels.length; i++) {
      var p = panels[i];
      panelBack.push({
        display: p.style.display,
        marginTop: p.style.marginTop,
        active: p.classList.contains('active')
      });
      p.style.display = 'block';
      p.classList.add('active');
      if (i > 0) p.style.marginTop = '12px';
    }

    function restoreLayout() {
      el.style.maxHeight = prevMax;
      el.style.overflow = prevOv;
      el.style.height = prevH;
      for (i = 0; i < panels.length; i++) {
        var pb = panelBack[i];
        var pj = panels[i];
        pj.style.display = pb.display;
        pj.style.marginTop = pb.marginTop || '';
        if (!pb.active) pj.classList.remove('active');
      }
    }

    function finishBtn() {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var w = el.scrollWidth;
        var h = el.scrollHeight;
        html2canvas(el, {
          scale: Math.min(2, (window.devicePixelRatio || 1) * 1.25),
          width: w,
          height: h,
          windowWidth: w,
          windowHeight: h,
          useCORS: true,
          allowTaint: false,
          logging: false,
          backgroundColor: '#ffffff',
          ignoreElements: function (node) {
            if (!node || !node.matches) return false;
            if (node.classList && node.classList.contains('popup-share-actions')) return true;
            if (node.matches('.popup-header button[data-action="closePopup"]')) return true;
            if (node.matches('.popup-footer')) return true;
            return false;
          },
          onclone: function (clonedDoc) {
            var pc = clonedDoc.querySelector('.popup-content');
            if (pc) {
              pc.style.maxHeight = 'none';
              pc.style.overflow = 'visible';
              pc.style.height = 'auto';
            }
          }
        })
          .then(function (canvas) {
            return new Promise(function (resolve, reject) {
              canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error('toBlob failed'));
              }, 'image/png');
            });
          })
          .then(function (blob) {
            var file = new File([blob], safeName, { type: 'image/png' });
            var canWebShare =
              navigator.share &&
              navigator.canShare &&
              navigator.canShare({ files: [file] });
            if (canWebShare) {
              return navigator
                .share({
                  files: [file],
                  title: '올리브영 매장 재고',
                  text: '재고 확인 결과'
                })
                .catch(function (err) {
                  if (err && err.name === 'AbortError') return;
                  UI._downloadBlob(blob, safeName);
                  if (typeof UI.showSyncStatus === 'function') {
                    UI.showSyncStatus('이미지를 저장했습니다', false);
                  }
                });
            }
            UI._downloadBlob(blob, safeName);
            if (typeof UI.showSyncStatus === 'function') {
              UI.showSyncStatus('이미지를 저장했습니다', false);
            }
          })
          .catch(function (err) {
            console.error('[shareStockSnapshot]', err);
            alert('이미지를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
          })
          .finally(function () {
            restoreLayout();
            finishBtn();
          });
      });
    });
  },

  _downloadBlob: function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /** 팝업: 상품 기본 정보 먼저, 재고 영역만 로딩 */
  showPopupStockSkeleton: function (preview) {
    var root = document.getElementById('popup-root');
    if (!root) return;
    var name = preview.goodsName || '';
    var gn = String(preview.goodsNo || '').trim();
    var cat = preview.category != null ? String(preview.category) : '';
    var price = preview.price;
    var orig = preview.originalPrice;
    var disc = preview.discountRate || 0;
    var imgUrl = preview.imageUrl || '';
    var isFav = gn ? Storage.isFavorite(gn) : false;
    var thumb = imgUrl
      ? '<img src="' +
        UI.esc(imgUrl) +
        '" alt="" class="popup-skel-thumb" loading="lazy" decoding="async">'
      : '<div class="popup-skel-thumb popup-skel-thumb-ph" aria-hidden="true"></div>';
    var priceRow =
      price != null && price !== ''
        ? '<div class="popup-price-row">' +
          (disc > 0 ? '<span class="disc">' + disc + '%</span>' : '') +
          '<span class="price">' +
          UI.num(price) +
          '원</span>' +
          (orig && orig !== price ? '<span class="orig">' + UI.num(orig) + '원</span>' : '') +
          '</div>'
        : '<div class="popup-price-row"><span class="price" style="color:#999">가격 확인 중…</span></div>';
    var buyRow =
      '<div class="popup-buy-inline">' +
      '<button type="button" class="btn-buy-popup-inline" data-action="buyNow" data-goodsno="' +
      UI.esc(gn) +
      '" data-category="' +
      UI.esc(cat) +
      '" data-original-label="구매 바로가기">구매 바로가기</button>' +
      '</div>';
    var favBtn =
      '<button type="button" class="popup-fav-btn' +
      (isFav ? ' active' : '') +
      '" data-action="toggleFavPopup" data-goodsno="' +
      UI.esc(gn) +
      '">' +
      (isFav ? '★ 즐겨찾기 됨' : '☆ 즐겨찾기 추가') +
      '</button>';
    root.innerHTML =
      '<div class="popup-overlay">' +
      '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
      '<div class="popup-content">' +
      '<div class="popup-header"><h3>' +
      UI.esc(name) +
      '</h3><button type="button" data-action="closePopup">✕</button></div>' +
      buyRow +
      '<div class="popup-skel-meta">' +
      thumb +
      '<div class="popup-skel-meta-text">' +
      priceRow +
      favBtn +
      '</div></div>' +
      '<div class="popup-stock-loading">' +
      '<div class="spinner popup-stock-loading-spinner"></div>' +
      '<p>주변 매장·온라인 재고 조회 중…</p>' +
      '</div></div></div>';
    document.body.style.overflow = 'hidden';
  },

  showPopupLoading: function (name, sub, goodsNo, category) {
    var root = document.getElementById('popup-root');
    if (!root) return;
    var gn = goodsNo != null ? String(goodsNo).trim() : '';
    var cat = category != null ? String(category) : '';
    var buyRow = '';
    if (gn) {
      buyRow =
        '<div class="popup-buy-inline">' +
        '<button type="button" class="btn-buy-popup-inline" data-action="buyNow" data-goodsno="' +
        UI.esc(gn) +
        '" data-category="' +
        UI.esc(cat) +
        '" data-original-label="구매 바로가기">구매 바로가기</button>' +
        '</div>';
    }
    root.innerHTML =
      '<div class="popup-overlay">' +
      '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
      '<div class="popup-content">' +
      '<div class="popup-header"><h3>' +
      UI.esc(name) +
      '</h3><button type="button" data-action="closePopup">✕</button></div>' +
      buyRow +
      '<div class="loading"><div class="spinner"></div><p>' +
      UI.esc(sub || '데이터 로드 중...') +
      '</p></div>' +
      '</div></div>';
    document.body.style.overflow = 'hidden';
  },

  showPopupError: function (name, msg, goodsNo) {
    var root = document.getElementById('popup-root');
    if (!root) return;
    var oyLink = UI.oliveyoungFallbackUrl(goodsNo);
    var safeMsg = UI.errorText(msg, '재고 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    root.innerHTML =
      '<div class="popup-overlay">' +
      '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
      '<div class="popup-content">' +
      '<div class="popup-header"><h3>' +
      UI.esc(name) +
      '</h3><button type="button" data-action="closePopup">✕</button></div>' +
      '<div class="popup-error"><p>⚠️ ' +
      UI.esc(safeMsg) +
      '</p>' +
      '<p class="popup-note">즐겨찾기에 추가하면 다음 수집 시 자동으로 재고가 업데이트됩니다.</p>' +
      '<a href="' +
      UI.esc(oyLink) +
      '" target="_blank" rel="noopener noreferrer" class="btn-oy">올리브영에서 확인 →</a></div>' +
      '</div></div>';
    document.body.style.overflow = 'hidden';
  },

  showDetailPopup: function (detail, goodsNo) {
    var root = document.getElementById('popup-root');
    if (!root) return;
    var cat =
      detail && detail.categoryNumber != null && detail.categoryNumber !== ''
        ? String(detail.categoryNumber)
        : '';
    var isFav = Storage.isFavorite(goodsNo);
    var timeStr = detail.updatedAt
      ? new Date(detail.updatedAt).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      : '';
    var cacheSuffix =
      detail.source === 'live-all'
        ? '전국 매장 조회'
        : detail.source === 'live-online'
          ? '온라인만(목록)'
          : detail.inventoryScope === 'vendor' || detail.source === 'vendor-delivery'
            ? '업체배송 상품'
          : detail.source === 'live'
            ? '실시간 조회'
            : '수집 데이터';
    var cacheInfo = timeStr
      ? '<div class="popup-cache-info">📦 ' + UI.esc(timeStr) + ' · ' + cacheSuffix + '</div>'
      : '';
    var statusBadge = '';
    if (detail.inventoryScope === 'vendor' || detail.source === 'vendor-delivery')
      statusBadge =
        '<div class="popup-badge bg-purple">업체배송 상품입니다. 매장·올영창고 실시간 재고 조회 대상이 아니며 올리브영 상품 페이지에서 구매 가능 여부를 확인합니다.</div>';
    else if (detail.status === 'discontinued')
      statusBadge = '<div class="popup-badge bg-red-light">⛔ 단종/삭제된 상품입니다</div>';
    else if (detail.status === 'soldout')
      statusBadge = '<div class="popup-badge bg-orange-light">🔴 주변 매장 전체 품절</div>';
    var priceHtml =
      '<div class="popup-price-row">' +
      (detail.discountRate > 0 ? '<span class="disc">' + detail.discountRate + '%</span>' : '') +
      '<span class="price">' +
      UI.num(detail.price) +
      '원</span>' +
      (detail.originalPrice && detail.originalPrice !== detail.price
        ? '<span class="orig">' + UI.num(detail.originalPrice) + '원</span>'
        : '') +
      '</div>';

    var opts = detail.options || [];
    var alertMeta = { goodsName: detail.goodsName || '', imageUrl: detail.thumbnail || '' };
    var optTabs = '';
    if (opts.length > 1) {
      optTabs =
        '<div class="opt-tabs">' +
        opts
          .map(function (o, i) {
            var label = o.name || '옵션 ' + (i + 1);
            if (label.indexOf(']') > -1) label = label.substring(label.lastIndexOf(']') + 1).trim();
            if (label.length > 20) label = label.substring(0, 20) + '…';
            return (
              '<button type="button" class="opt-tab' +
              (i === 0 ? ' active' : '') +
              '" data-action="switchTab" data-idx="' +
              i +
              '">' +
              UI.esc(label) +
              '</button>'
            );
          })
          .join('') +
        '</div>';
    }

    var optPanels = opts
      .map(function (o, i) {
        var optImg = o.image
          ? '<img src="' +
            UI.esc(o.image) +
            '" class="opt-img" alt="" loading="lazy" decoding="async">'
          : '';
        var onlineStatus = '';
        if (o.onlineQty != null) {
          if (o.onlineQty > 0) {
            onlineStatus =
              '<br><span class="stock-ok">🛒 온라인 재고 ' + UI.num(o.onlineQty) + '개</span>';
            if (o.deliveredToday)
              onlineStatus +=
                ' <span style="color:#2563eb;font-size:11px">⚡오늘배송</span>';
          } else {
            onlineStatus = '<br><span class="stock-out">🛒 온라인 품절</span>';
          }
        }
        var summary =
          '<div class="opt-summary">' +
          optImg +
          '<div class="opt-info"><p class="opt-name">' +
          UI.esc(o.name) +
          '</p><p class="opt-stock">' +
          (o.inStock > 0
            ? '<span class="stock-ok">✅ ' +
              o.inStock +
              '/' +
              o.totalStores +
              '매장 재고 (총 ' +
              o.totalQty +
              '개)</span>'
            : '<span class="stock-out">🔴 주변 매장 재고 없음</span>') +
          onlineStatus +
          '</p></div></div>';
        var stores = o.stores || [];
        var storeHtml;
        if (stores.length === 0) {
          storeHtml = '<div class="no-store">매장 정보 없음</div>';
        } else {
          storeHtml =
            '<div class="store-list">' +
            stores
              .map(function (s) {
                var qtyClass = s.qty > 0 ? 'stock-ok' : 'stock-out';
                var distLabel =
                  s.region != null
                    ? String(s.region)
                    : s.dist != null
                      ? String(s.dist) + 'km'
                      : '-';
                return (
                  '<div class="store-row"><div class="store-left"><span class="store-name">' +
                  UI.esc(s.name) +
                  '</span><span class="store-dist">' +
                  UI.esc(distLabel) +
                  '</span></div><div class="store-right ' +
                  qtyClass +
                  '">' +
                  (s.qty > 0
                    ? '재고 <b>' +
                      s.qty +
                      '</b>' +
                      (s.o2o > 0 ? ' · 오늘드림 ' + s.o2o : '')
                    : '품절') +
                  '</div></div>'
                );
              })
              .join('') +
            '</div>';
        }
        var pidStr = String(o.productId != null ? o.productId : '');
        var allBtnPerOpt =
          CONFIG.REALTIME_API && pidStr
            ? '<button type="button" class="btn-all-stock-opt" data-action="loadAllStockOpt" data-goodsno="' +
              UI.esc(goodsNo) +
              '" data-productid="' +
              UI.esc(pidStr) +
              '">🗺️ 이 옵션 전국 재고 보기</button>'
            : '';
        var alertBtnPerOpt =
          isFav && window.RestockAlerts
            ? RestockAlerts.optionControlHtml(goodsNo, o, alertMeta, i, false)
            : '';
        return (
          '<div class="opt-panel' +
          (i === 0 ? ' active' : '') +
          '" data-panel="' +
          i +
          '">' +
          summary +
          storeHtml +
          allBtnPerOpt +
          alertBtnPerOpt +
          '</div>'
        );
      })
      .join('');
    if (!optPanels && (detail.inventoryScope === 'vendor' || detail.source === 'vendor-delivery')) {
      optPanels =
        '<div class="no-store">업체배송 상품이라 주변 매장/온라인 수량은 표시하지 않습니다.</div>';
    }

    var favBtn =
      '<button type="button" class="popup-fav-btn' +
      (isFav ? ' active' : '') +
      '" data-action="toggleFavPopup" data-goodsno="' +
      UI.esc(goodsNo) +
      '">' +
      (isFav ? '★ 즐겨찾기 됨' : '☆ 즐겨찾기 추가') +
      '</button>';
    var alertBtn =
      isFav && window.RestockAlerts
        ? RestockAlerts.productControlHtml(goodsNo, alertMeta, 'popup-restock-alert')
        : '';
    var shareBtn =
      '<button type="button" class="popup-share-btn" data-action="shareStockSnapshot" data-goodsno="' +
      UI.esc(goodsNo) +
      '">📷 재고 결과 이미지로 공유</button>';
    var shareActions =
      '<div class="popup-share-actions">' + favBtn + alertBtn + shareBtn + '</div>';

    var buyUnderTitle =
      '<div class="popup-buy-inline">' +
      '<button type="button" class="btn-buy-popup-inline" data-action="buyNow" data-goodsno="' +
      UI.esc(goodsNo) +
      '" data-category="' +
      UI.esc(cat) +
      '" data-original-label="구매 바로가기">구매 바로가기</button>' +
      '</div>';

    root.innerHTML =
      '<div class="popup-overlay">' +
      '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
      '<div class="popup-content">' +
      '<div class="popup-header"><h3>' +
      UI.esc(detail.goodsName) +
      '</h3><button type="button" data-action="closePopup">✕</button></div>' +
      buyUnderTitle +
      cacheInfo +
      statusBadge +
      priceHtml +
      shareActions +
      optTabs +
      optPanels +
      '<div class="popup-footer"><button type="button" class="btn-oy btn-oy-cta" data-action="openOliveYoung" data-goodsno="' +
      UI.esc(goodsNo) +
      '" data-category="' +
      UI.esc(cat) +
      '" data-original-label="올리브영에서 구매 →">올리브영에서 구매 →</button></div>' +
      '</div></div>';
    document.body.style.overflow = 'hidden';
    UI.prefetchAllStockForDetail(detail, goodsNo);
    if (window.RestockAlerts) RestockAlerts.refreshControls();
  },

  showAllStockPanel: function (detail) {
    var old = document.getElementById('all-stock-panel');
    if (old) old.remove();

    var opts = detail.options || [];
    var html =
      '<div id="all-stock-panel" style="margin-top:12px;border-top:2px solid #bae6fd;padding-top:12px">';
    html +=
      '<h4 style="font-size:14px;font-weight:700;color:#0369a1;margin-bottom:8px">🗺️ 전국 매장 재고</h4>';

    opts.forEach(function (o, i) {
      var optName = o.name || '옵션 ' + (i + 1);
      if (optName.indexOf(']') > -1) optName = optName.substring(optName.lastIndexOf(']') + 1).trim();
      if (optName.length > 30) optName = optName.substring(0, 30) + '…';

      html += '<div style="margin-bottom:10px">';
      if (opts.length > 1) {
        html +=
          '<p style="font-weight:600;font-size:12px;color:#334155;margin-bottom:4px">' +
          UI.esc(optName) +
          '</p>';
      }
      html +=
        '<p style="font-size:12px;color:#059669;margin-bottom:6px">✅ ' +
        o.inStock +
        '/' +
        o.totalStores +
        '매장 재고 (총 ' +
        UI.num(o.totalQty) +
        '개)</p>';

      var stores = o.stores || [];
      if (stores.length > 0) {
        html += '<div class="store-list">';
        stores.forEach(function (s) {
          var qtyClass = s.qty > 0 ? 'stock-ok' : 'stock-out';
          html +=
            '<div class="store-row"><div class="store-left">' +
            '<span class="store-name">' +
            UI.esc(s.name) +
            '</span>' +
            '<span class="store-dist">' +
            UI.esc(s.region || '') +
            '</span>' +
            '</div><div class="store-right ' +
            qtyClass +
            '">' +
            (s.qty > 0
              ? '재고 <b>' +
                s.qty +
                '</b>' +
                (s.o2o > 0 ? ' · 오늘드림 ' + s.o2o : '')
              : '품절') +
            '</div></div>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
    html += '</div>';

    var footer = document.querySelector('.popup-footer');
    if (footer) {
      footer.insertAdjacentHTML('beforebegin', html);
    } else {
      var content = document.querySelector('.popup-content');
      if (content) content.insertAdjacentHTML('beforeend', html);
    }

    var panel = document.getElementById('all-stock-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth' });
  },

  closePopup: function () {
    var root = document.getElementById('popup-root');
    if (root) root.innerHTML = '';
    document.body.style.overflow = '';
    if (typeof App !== 'undefined' && App._resumePendingOnlineEnrich) {
      App._resumePendingOnlineEnrich();
    }
  },

  switchTab: function (idx) {
    document.querySelectorAll('.opt-tab').forEach(function (t, i) {
      t.classList.toggle('active', i === idx);
    });
    var activePanel = null;
    document.querySelectorAll('.opt-panel').forEach(function (p, i) {
      if (i === idx) activePanel = p;
      p.classList.toggle('active', i === idx);
    });
    var old = document.getElementById('all-stock-panel');
    if (old) old.remove();
    if (activePanel) {
      UI.prefetchAllStockButton(activePanel.querySelector('[data-action="loadAllStockOpt"]'));
    }
  },

  showSyncStatus: function (msg, isError, ms) {
    var el = document.getElementById('sync-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sync-status' + (isError ? ' error' : ' ok');
    el.style.display = 'block';
    setTimeout(
      function () {
        el.style.display = 'none';
      },
      typeof ms === 'number' ? ms : 3000
    );
  }
};
