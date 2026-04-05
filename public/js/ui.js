var UI = {
  _curatorLinksPromise: null,

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

  /**
   * 1) curator-links.json 의 shortenedUrl
   * 2) 없으면 landing-proxy → shorten-proxy (성공 시 utm_content)
   * 3) landing 실패 시에도 shorten(utm 없음) → oy.run
   * 4) shorten 실패 시 www 일반 상세
   */
  openOliveYoungProduct: function (el) {
    var goodsNo = el.dataset.goodsno;
    if (!goodsNo) return;
    var categoryNumber = el.dataset.category || '';
    var origLabel = el.getAttribute('data-original-label') || '올리브영에서 보기 →';
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
      if (newTab && !newTab.closed) {
        return false;
      }
      tryProgrammaticAnchorClick(url);
      if (!newTab) {
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
    el.textContent = '링크 생성 중...';

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
        var activityId = landJson && landJson.affiliateActivityId;
        var partnerId =
          (landJson && landJson.affiliatePartnerId) || defaultReg;

        var originalUrlForShorten = activityId
          ? longUrlBase + '&utm_content=OY_' + activityId
          : longUrlBase;

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

        var targetUrl = shortenedUrl || fallbackUrl;
        manualFallback = openInNewTabWithoutSameTabNav(targetUrl);
      } catch (e) {
        console.error('올리브영 링크 열기 실패:', e);
        manualFallback = openInNewTabWithoutSameTabNav(fallbackUrl);
      } finally {
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

  num: function (n) {
    return (n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  renderHistory: function (arr) {
    var c = document.getElementById('search-history');
    if (!c) return;
    if (!arr || !arr.length) {
      c.innerHTML = '';
      return;
    }
    c.innerHTML = arr
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
  },

  showLoading: function (msg) {
    var c = document.getElementById('product-list');
    if (c)
      c.innerHTML =
        '<div class="loading"><div class="spinner"></div><p>' +
        UI.esc(msg || '로딩 중...') +
        '</p></div>';
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
    var favSection = document.getElementById('fav-section');
    if (searchSection) searchSection.style.display = tab === 'search' ? '' : 'none';
    if (favSection) favSection.style.display = tab === 'favorites' ? '' : 'none';
  },

  renderProducts: function (products, detailData) {
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
        var disc = p.discountRate > 0 ? '<span class="disc">' + p.discountRate + '%</span>' : '';
        var orig =
          p.originalPrice && p.originalPrice !== p.priceToPay
            ? '<span class="orig">' + UI.num(p.originalPrice) + '원</span>'
            : '';
        var badges = '';
        var onlineBadge = '';
        var optionBtn = '';
        if (detail) {
          if (detail.status === 'discontinued') {
            badges = '<span class="badge bg-red">단종</span>';
          } else if (detail.status === 'soldout') {
            badges = '<span class="badge bg-orange">주변품절</span>';
          } else if (detail.status === 'active') {
            var totalIn = (detail.options || []).reduce(function (a, o) {
              return a + (o.inStock || 0);
            }, 0);
            badges = '<span class="badge bg-green">매장 ' + totalIn + '곳</span>';
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
            onlineBadge = '<span class="badge bg-gray">🛒 온라인품절</span>';
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
                return (
                  '<div class="card-opt-row">' +
                  '<span class="card-opt-name">' +
                  UI.esc(optName) +
                  '</span>' +
                  '<span class="card-opt-stock">' +
                  storeInfo +
                  ' | ' +
                  onlineInfo +
                  '</span>' +
                  '</div>'
                );
              })
              .join('') +
            '</div>';
        }

        var img = p.imageUrl || (detail ? detail.thumbnail : '') || '';
        var imgTag = img
          ? '<img src="' + UI.esc(img) + '" alt="" loading="lazy">'
          : '<div class="no-img">📦</div>';
        return (
          '<div class="card" data-index="' +
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
          '</div></div>' +
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

      var badges = '';
      var onlineBadge = '';
      var optionBtn = '';
      if (detail.status === 'discontinued') {
        badges = '<span class="badge bg-red">단종</span>';
      } else if (detail.status === 'soldout') {
        badges = '<span class="badge bg-orange">주변품절</span>';
      } else if (detail.status === 'active') {
        var totalIn = (detail.options || []).reduce(function (a, o) {
          return a + (o.inStock || 0);
        }, 0);
        badges = '<span class="badge bg-green">매장 ' + totalIn + '곳</span>';
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
        onlineBadge = '<span class="badge bg-gray">🛒 온라인품절</span>';
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
              return (
                '<div class="card-opt-row">' +
                '<span class="card-opt-name">' +
                UI.esc(optName) +
                '</span>' +
                '<span class="card-opt-stock">' +
                storeInfo +
                ' | ' +
                onlineInfo +
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
      '</div>';
    var cards = favorites
      .map(function (f) {
        var gid = String(f.goodsNo || f.goodsNumber || '');
        var detail = detailMap[gid];
        var badges = '';
        var onlineBadge = '';
        var optionBtn = '';
        if (detail) {
          if (detail.status === 'discontinued') {
            badges = '<span class="badge bg-red">단종</span>';
          } else if (detail.status === 'soldout') {
            badges = '<span class="badge bg-orange">주변품절</span>';
          } else if (detail.status === 'active') {
            var totalInF = (detail.options || []).reduce(function (a, o) {
              return a + (o.inStock || 0);
            }, 0);
            badges = '<span class="badge bg-green">매장 ' + totalInF + '곳</span>';
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
            onlineBadge = '<span class="badge bg-gray">🛒 온라인품절</span>';
          }

          if ((detail.options || []).length > 1) {
            optionBtn =
              '<button type="button" class="badge-btn bg-purple" data-action="toggleOptions" data-goodsno="' +
              UI.esc(gid) +
              '">옵션 ' +
              detail.options.length +
              '개 ▾</button>';
          }
        } else {
          badges = '<span class="badge bg-gray">수집대기</span>';
        }

        var optPanelF = '';
        if (detail && (detail.options || []).length > 1) {
          optPanelF =
            '<div class="card-options hidden" id="opts-' +
            UI.esc(gid) +
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
                return (
                  '<div class="card-opt-row">' +
                  '<span class="card-opt-name">' +
                  UI.esc(optName) +
                  '</span>' +
                  '<span class="card-opt-stock">' +
                  storeInfo +
                  ' | ' +
                  onlineInfo +
                  '</span>' +
                  '</div>'
                );
              })
              .join('') +
            '</div>';
        }

        var img = (detail ? detail.thumbnail : '') || f.imageUrl || '';
        var imgTag = img
          ? '<img src="' + UI.esc(img) + '" alt="" loading="lazy">'
          : '<div class="no-img">📦</div>';
        var price = detail ? detail.price : f.price || f.priceToPay || 0;
        var disc = (detail ? detail.discountRate : f.discountRate) || 0;
        var origPrice = (detail ? detail.originalPrice : f.originalPrice) || 0;
        return (
          '<div class="card' +
          (detail && detail.status === 'discontinued' ? ' soldout' : '') +
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
          UI.esc(detail ? detail.goodsName : f.goodsName) +
          '</p><button type="button" class="fav-btn active" data-action="removeFav" data-goodsno="' +
          UI.esc(gid) +
          '">★</button></div><div class="card-price">' +
          (disc > 0 ? '<span class="disc">' + disc + '%</span>' : '') +
          '<span class="price">' +
          UI.num(price) +
          '원</span>' +
          (origPrice && origPrice !== price ? '<span class="orig">' + UI.num(origPrice) + '원</span>' : '') +
          '</div></div>' +
          optPanelF +
          '</div>'
        );
      })
      .join('');
    c.innerHTML = bar + '<div class="grid">' + cards + '</div>';
  },

  _bindPopupEvents: function () {
    var root = document.getElementById('popup-root');
    if (!root) return;
    root.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.dataset.action;
      if (action === 'closePopup') {
        UI.closePopup();
        return;
      }
      if (action === 'openOliveYoung') {
        UI.openOliveYoungProduct(el);
        return;
      }
      if (action === 'switchTab') {
        UI.switchTab(parseInt(el.dataset.idx, 10));
        return;
      }
      if (action === 'toggleFavPopup') {
        App._toggleFavFromPopup(el.dataset.goodsno, el);
        return;
      }
      if (action === 'loadAllStockOpt') {
        var gno = el.dataset.goodsno;
        var pid = el.dataset.productid;
        if (!gno || !pid || el.classList.contains('loading')) return;
        if (!CONFIG.REALTIME_API) return;
        el.classList.add('loading');
        el.textContent = '🗺️ 전국 조회 중... (5~10초)';

        var allUrl =
          CONFIG.REALTIME_API.replace('/api/stock', '/api/stock-all') +
          '?goodsNo=' +
          encodeURIComponent(gno) +
          '&productId=' +
          encodeURIComponent(pid);

        fetch(allUrl)
          .then(function (r) {
            return r.json();
          })
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
        return;
      }
    });
  },

  showPopupLoading: function (name, sub) {
    var root = document.getElementById('popup-root');
    if (!root) return;
    root.innerHTML =
      '<div class="popup-overlay">' +
      '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
      '<div class="popup-content">' +
      '<div class="popup-header"><h3>' +
      UI.esc(name) +
      '</h3><button type="button" data-action="closePopup">✕</button></div>' +
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
    root.innerHTML =
      '<div class="popup-overlay">' +
      '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
      '<div class="popup-content">' +
      '<div class="popup-header"><h3>' +
      UI.esc(name) +
      '</h3><button type="button" data-action="closePopup">✕</button></div>' +
      '<div class="popup-error"><p>⚠️ ' +
      UI.esc(msg) +
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
        : detail.source === 'live'
          ? '실시간 조회'
          : '수집 데이터';
    var cacheInfo = timeStr
      ? '<div class="popup-cache-info">📦 ' + UI.esc(timeStr) + ' · ' + cacheSuffix + '</div>'
      : '';
    var statusBadge = '';
    if (detail.status === 'discontinued')
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
        var optImg = o.image ? '<img src="' + UI.esc(o.image) + '" class="opt-img" alt="">' : '';
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
        return (
          '<div class="opt-panel' +
          (i === 0 ? ' active' : '') +
          '" data-panel="' +
          i +
          '">' +
          summary +
          storeHtml +
          allBtnPerOpt +
          '</div>'
        );
      })
      .join('');

    var favBtn =
      '<button type="button" class="popup-fav-btn' +
      (isFav ? ' active' : '') +
      '" data-action="toggleFavPopup" data-goodsno="' +
      UI.esc(goodsNo) +
      '">' +
      (isFav ? '★ 즐겨찾기 됨' : '☆ 즐겨찾기 추가') +
      '</button>';

    root.innerHTML =
      '<div class="popup-overlay">' +
      '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
      '<div class="popup-content">' +
      '<div class="popup-header"><h3>' +
      UI.esc(detail.goodsName) +
      '</h3><button type="button" data-action="closePopup">✕</button></div>' +
      cacheInfo +
      statusBadge +
      priceHtml +
      favBtn +
      optTabs +
      optPanels +
      '<div class="popup-footer"><button type="button" class="btn-oy" data-action="openOliveYoung" data-goodsno="' +
      UI.esc(goodsNo) +
      '" data-category="' +
      UI.esc(cat) +
      '" data-original-label="올리브영에서 보기 →">올리브영에서 보기 →</button></div>' +
      '</div></div>';
    document.body.style.overflow = 'hidden';
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
  },

  switchTab: function (idx) {
    document.querySelectorAll('.opt-tab').forEach(function (t, i) {
      t.classList.toggle('active', i === idx);
    });
    document.querySelectorAll('.opt-panel').forEach(function (p, i) {
      p.classList.toggle('active', i === idx);
    });
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
