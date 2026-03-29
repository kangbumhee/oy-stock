var UI = {
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
        var gn = p.goodsNumber || p.goodsNo;
        var isFav = Storage.isFavorite(gn);
        var detail = detailMap[gn];
        var disc = p.discountRate > 0 ? '<span class="disc">' + p.discountRate + '%</span>' : '';
        var orig =
          p.originalPrice && p.originalPrice !== p.priceToPay
            ? '<span class="orig">' + UI.num(p.originalPrice) + '원</span>'
            : '';
        var badges = '';
        if (detail) {
          if (detail.status === 'discontinued') badges = '<span class="badge bg-red">단종</span>';
          else if (detail.status === 'soldout') badges = '<span class="badge bg-orange">주변품절</span>';
          else if (detail.status === 'active') {
            var totalIn = (detail.options || []).reduce(function (a, o) {
              return a + (o.inStock || 0);
            }, 0);
            badges = '<span class="badge bg-green">재고 ' + totalIn + '매장</span>';
          }
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
          '</div></div></div>'
        );
      })
      .join('');

    c.innerHTML = bar + '<div class="grid">' + cards + '</div>';
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
        ? '<span class="ok">📦 ' + timeStr + ' 기준</span>'
        : '<span class="ok">다음 수집 시 재고 업데이트</span>') +
      '</div>';
    var syncBtn =
      '<button type="button" class="sync-btn" data-action="syncFavorites">🔄 동기화 (' +
      favorites.length +
      '개 → GitHub)</button>';
    var cards = favorites
      .map(function (f) {
        var gid = String(f.goodsNo || f.goodsNumber || '');
        var detail = detailMap[gid];
        var badges = '';
        if (detail) {
          if (detail.status === 'discontinued') badges = '<span class="badge bg-red">단종</span>';
          else if (detail.status === 'soldout') badges = '<span class="badge bg-orange">주변품절</span>';
          else if (detail.status === 'active') {
            var totalIn = (detail.options || []).reduce(function (a, o) {
              return a + (o.inStock || 0);
            }, 0);
            badges = '<span class="badge bg-green">재고 ' + totalIn + '매장</span>';
          }
        } else {
          badges = '<span class="badge bg-gray">수집대기</span>';
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
          '</div></div></div>'
        );
      })
      .join('');
    c.innerHTML = bar + syncBtn + '<div class="grid">' + cards + '</div>';
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
      if (action === 'switchTab') {
        UI.switchTab(parseInt(el.dataset.idx, 10));
        return;
      }
      if (action === 'toggleFavPopup') {
        App._toggleFavFromPopup(el.dataset.goodsno, el);
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
    var oyLink = CONFIG.OY_PRODUCT_URL + encodeURIComponent(goodsNo || '');
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
      oyLink +
      '" target="_blank" rel="noopener noreferrer" class="btn-oy">올리브영에서 확인 →</a></div>' +
      '</div></div>';
    document.body.style.overflow = 'hidden';
  },

  showDetailPopup: function (detail, goodsNo) {
    var root = document.getElementById('popup-root');
    if (!root) return;
    var oyLink = CONFIG.OY_PRODUCT_URL + encodeURIComponent(goodsNo);
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
    var cacheSuffix = detail.source === 'live' ? '실시간 조회' : '수집 데이터';
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
                return (
                  '<div class="store-row"><div class="store-left"><span class="store-name">' +
                  UI.esc(s.name) +
                  '</span><span class="store-dist">' +
                  UI.esc(String(s.dist != null ? s.dist : '-')) +
                  'km</span></div><div class="store-right ' +
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
        return (
          '<div class="opt-panel' +
          (i === 0 ? ' active' : '') +
          '" data-panel="' +
          i +
          '">' +
          summary +
          storeHtml +
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
      '<div class="popup-footer"><a href="' +
      oyLink +
      '" target="_blank" rel="noopener noreferrer" class="btn-oy">올리브영에서 보기 →</a></div>' +
      '</div></div>';
    document.body.style.overflow = 'hidden';
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
