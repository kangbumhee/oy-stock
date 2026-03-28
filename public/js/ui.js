const UI = {
  _currentPopupData: null,
  _selectedOptIdx: 0,

  esc(s) {
    return s
      ? String(s)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
      : '';
  },
  num(n) {
    return n ? Number(n).toLocaleString('ko-KR') : '0';
  },
  dist(km) {
    if (km == null) return '';
    return km < 1 ? Math.round(km * 1000) + 'm' : Number(km).toFixed(1) + 'km';
  },
  time(t) {
    if (!t || String(t).length < 4) return '';
    const s = String(t);
    return s.substring(0, 2) + ':' + s.substring(2);
  },

  renderHistory(list) {
    const c = document.getElementById('search-history');
    if (!c) return;
    if (!list || !list.length) {
      c.innerHTML = '';
      return;
    }
    c.innerHTML = `<div class="hw"><span class="hl">최근</span><div class="ht">${list
      .map(
        (h) =>
          `<span class="htag" data-action="search" data-keyword="${this.esc(h)}">${this.esc(h)}</span>`
      )
      .join('')}<span class="hx" data-action="clearHistory">✕</span></div></div>`;
  },

  showLoading(kw) {
    const el = document.getElementById('product-list');
    if (el)
      el.innerHTML = `<div class="loading"><div class="spinner"></div><p>"${this.esc(kw)}" 검색중...</p></div>`;
  },

  showError(msg) {
    const el = document.getElementById('product-list');
    if (el) el.innerHTML = `<div class="empty-state"><p>❌ ${this.esc(msg)}</p></div>`;
  },

  renderProducts(products, stockData, detailData) {
    const c = document.getElementById('product-list');
    if (!c) return;
    if (!products || !products.length) {
      c.innerHTML = '<div class="empty-state"><p>검색 결과가 없습니다</p></div>';
      return;
    }

    const statusMap = {};
    if (stockData && stockData.products) {
      stockData.products.forEach(function (sp) {
        if (sp.goodsNo != null) statusMap[String(sp.goodsNo)] = sp;
      });
    }

    function detailStoreCount(goodsNumber) {
      const entry =
        detailData && detailData.products ? detailData.products[String(goodsNumber)] : null;
      if (!entry || !entry.options) return null;
      return entry.options.reduce(function (a, o) {
        return a + (o.inStock || 0);
      }, 0);
    }

    const hasUpdated =
      stockData && stockData.updatedAt && String(stockData.updatedAt).trim() !== '';
    const barTime = hasUpdated
      ? new Date(stockData.updatedAt).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          hour: '2-digit',
          minute: '2-digit'
        })
      : '';
    const bar = `<div class="sbar"><span>검색결과 <b>${products.length}</b>개</span>${
      hasUpdated
        ? `<span class="ok">📦 ${barTime} 기준</span>`
        : '<span class="ok">상품 클릭 → 옵션별 매장재고</span>'
    }</div>`;

    const cards = products
      .map((p, i) => {
        const disc = p.discountRate > 0 ? `<span class="disc">${p.discountRate}%</span>` : '';
        const orig =
          p.originalPrice && p.originalPrice !== p.priceToPay
            ? `<span class="orig">${this.num(p.originalPrice)}원</span>`
            : '';

        const cached = statusMap[String(p.goodsNumber)];
        const dCount = detailStoreCount(p.goodsNumber);
        let badges = '';

        if (cached) {
          if (cached.status === 'discontinued') {
            badges = '<span class="badge bg-red">단종</span>';
          } else if (cached.status === 'soldout') {
            badges = '<span class="badge bg-orange">주변품절</span>';
          } else if (cached.status === 'new') {
            badges =
              '<span class="badge bg-purple">신규</span>' +
              (cached.inStock
                ? '<span class="badge bg-green">재고</span>'
                : '<span class="badge bg-red">품절</span>');
          } else if (cached.status === 'restocked') {
            badges = '<span class="badge bg-gray">복귀</span>';
            if (dCount !== null && dCount > 0) {
              badges += '<span class="badge bg-green">재고 ' + dCount + '매장</span>';
            } else if (cached.inStock) {
              badges += '<span class="badge bg-green">재고</span>';
            } else {
              badges += '<span class="badge bg-orange">품절</span>';
            }
          } else {
            let priceBadge = '';
            if (cached.priceChanged) {
              priceBadge =
                '<span class="badge bg-blue">가격' +
                (cached.prevPrice != null && cached.price < cached.prevPrice ? '↓' : '↑') +
                '</span>';
            }
            if (dCount !== null && dCount > 0) {
              badges = priceBadge + '<span class="badge bg-green">재고 ' + dCount + '매장</span>';
            } else if (cached.inStock) {
              badges = priceBadge + '<span class="badge bg-green">재고</span>';
            } else {
              badges = priceBadge + '<span class="badge bg-orange">품절</span>';
            }
          }
        } else {
          const inStock = p.inStock === true || p.o2oStockFlag === true;
          badges = inStock ? '<span class="badge bg-green">재고</span>' : '<span class="badge bg-red">품절</span>';
        }

        const today =
          cached && cached.o2oRemainQty > 0
            ? '<span class="badge bg-purple">오늘드림</span>'
            : !cached && p.o2oStockFlag
              ? '<span class="badge bg-purple">오늘드림</span>'
              : '';

        const cardCls =
          cached && cached.status === 'discontinued' ? 'card card-discontinued' : 'card';

        return `<div class="${cardCls}" data-action="showDetail" data-index="${i}">
        <div class="card-img"><img src="${this.esc(p.imageUrl)}" alt="" loading="lazy"><div class="badges">${badges}${today}</div></div>
        <div class="card-body">
          <p class="card-name">${this.esc(p.goodsName)}</p>
          <div class="card-price">${disc}<span class="price">${this.num(p.priceToPay)}원</span>${orig}</div>
        </div>
      </div>`;
      })
      .join('');
    c.innerHTML = bar + '<div class="grid">' + cards + '</div>';
  },

  showPopupBasic(p, found, updatedAt) {
    this.closePopup();
    const root = document.getElementById('popup-root');
    if (!root) return;

    const timeStr =
      updatedAt && String(updatedAt).trim() !== ''
        ? new Date(updatedAt).toLocaleString('ko-KR', {
            timeZone: 'Asia/Seoul',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })
        : '';

    const disc = found.discountRate > 0 ? `<span class="p-disc">${found.discountRate}%</span>` : '';
    const orig =
      found.originalPrice && found.originalPrice !== found.price
        ? `<span class="p-orig">${this.num(found.originalPrice)}원</span>`
        : '';

    const img = found.imageUrl || p.imageUrl;
    const price = found.price != null ? found.price : p.priceToPay;

    root.innerHTML = `<div class="overlay" data-action="closePopup"><div class="popup" data-popup-stop="1">
      <button type="button" class="popup-x" data-action="closePopup" aria-label="닫기">&times;</button>
      <div class="popup-head">
        <img src="${this.esc(img)}" class="popup-img" alt="">
        <div class="popup-ti">
          <h2>${this.esc(found.goodsName || p.goodsName)}</h2>
          <div class="popup-pr">${disc}<span class="p-sale">${this.num(price)}원</span>${orig}</div>
        </div>
      </div>
      <div class="cache-banner"><span>📦 키워드 스캔 요약</span><span>${timeStr ? timeStr + ' 기준' : '시간 미상'}</span></div>
      <div class="scan-summary-box">
        <p class="scan-status">${this.esc(found.statusLabel || '')}</p>
        <p class="scan-meta">오늘드림 잔여: <b>${this.num(found.o2oRemainQty || 0)}</b> · 키워드: ${this.esc(found.keyword || '-')}</p>
        <p class="scan-hint">매장별 재고는 상세 수집(<code>stock-detail.json</code>) 후 표시됩니다. 아래에서 올리브영에서 확인하세요.</p>
      </div>
      <div class="popup-footer-link">
        <a href="https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${this.esc(
          p.goodsNumber
        )}" target="_blank" rel="noopener noreferrer" class="btn-oy">올리브영에서 보기 →</a>
      </div>
    </div></div>`;
    document.body.style.overflow = 'hidden';
    const inner = root.querySelector('[data-popup-stop="1"]');
    if (inner) inner.addEventListener('click', (e) => e.stopPropagation());
  },

  showStockGuidePopup(p, d) {
    this.closePopup();
    const root = document.getElementById('popup-root');
    if (!root) return;

    const guideList = (Array.isArray(d.guide) ? d.guide : [])
      .map((line) => `<li>${this.esc(line)}</li>`)
      .join('');
    const link = d.oliveyoungLink || '';
    const script = d.consoleScript || '';

    root.innerHTML = `<div class="overlay" data-action="closePopup"><div class="popup popup-guide" data-popup-stop="1">
      <button type="button" class="popup-x" data-action="closePopup" aria-label="닫기">&times;</button>
      <div class="popup-head">
        <img src="${this.esc(p.imageUrl)}" class="popup-img" alt="">
        <div class="popup-ti">
          <h2>${this.esc(p.goodsName)}</h2>
          <p class="guide-lead">${this.esc(d.message || '')}</p>
        </div>
      </div>
      <div class="scan-summary-box">
        <p class="scan-status">서버 직접 조회 대신</p>
        <ul class="guide-steps">${guideList}</ul>
        <label class="guide-label" for="oy-console-script">올리브영 상품 페이지 콘솔용 스크립트</label>
        <textarea id="oy-console-script" class="guide-script" readonly rows="10"></textarea>
        <p class="scan-hint">상품 페이지를 연 뒤 F12 → Console에 붙여넣고 Enter 하세요.</p>
      </div>
      <div class="popup-footer-link">
        ${
          link
            ? `<a href="${this.esc(link)}" target="_blank" rel="noopener noreferrer" class="btn-oy">올리브영 상품 열기 →</a>`
            : ''
        }
      </div>
    </div></div>`;
    document.body.style.overflow = 'hidden';
    const inner = root.querySelector('[data-popup-stop="1"]');
    if (inner) inner.addEventListener('click', (e) => e.stopPropagation());
    const ta = root.querySelector('#oy-console-script');
    if (ta) {
      ta.textContent = script;
      ta.addEventListener('focus', function () {
        try {
          ta.select();
        } catch (e) {}
      });
    }
  },

  showPopupLoading(p) {
    this.closePopup();
    const root = document.getElementById('popup-root');
    if (!root) return;
    root.innerHTML = `<div class="overlay" data-action="closePopup"><div class="popup" data-popup-stop="1">
      <button type="button" class="popup-x" data-action="closePopup" aria-label="닫기">&times;</button>
      <div class="popup-head"><img src="${this.esc(p.imageUrl)}" class="popup-img" alt=""><div class="popup-ti"><h2>${this.esc(
      p.goodsName
    )}</h2></div></div>
      <div class="loading"><div class="spinner"></div><p>옵션별 매장 재고 조회중...</p></div>
    </div></div>`;
    document.body.style.overflow = 'hidden';
    const inner = root.querySelector('[data-popup-stop="1"]');
    if (inner) inner.addEventListener('click', (e) => e.stopPropagation());
  },

  showPopupError(p, msg) {
    const root = document.getElementById('popup-root');
    if (!root) return;
    root.innerHTML = `<div class="overlay" data-action="closePopup"><div class="popup" data-popup-stop="1">
      <button type="button" class="popup-x" data-action="closePopup" aria-label="닫기">&times;</button>
      <div class="popup-head"><img src="${this.esc(p.imageUrl)}" class="popup-img" alt=""><div class="popup-ti"><h2>${this.esc(
      p.goodsName
    )}</h2></div></div>
      <div class="empty-state"><p>❌ ${this.esc(msg)}</p>
        <p class="sub" style="margin-top:10px"><a href="https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${this.esc(
          p.goodsNumber
        )}" target="_blank" rel="noopener noreferrer" class="btn-oy">올리브영에서 보기 →</a></p>
      </div>
    </div></div>`;
    document.body.style.overflow = 'hidden';
    const inner = root.querySelector('[data-popup-stop="1"]');
    if (inner) inner.addEventListener('click', (e) => e.stopPropagation());
  },

  showPopup(p, data) {
    this._currentPopupData = { product: p, data: data };
    this._selectedOptIdx = 0;
    this._renderPopup();
  },

  selectOption(idx) {
    this._selectedOptIdx = idx;
    this._renderPopup();
  },

  _renderPopup() {
    if (!this._currentPopupData) return;
    const p = this._currentPopupData.product;
    const data = this._currentPopupData.data;
    const gi = data.goodsInfo || {};
    const options = data.options || [];
    const storesByOption = data.storesByOption || [];
    const selIdx = this._selectedOptIdx;
    const selStores = (storesByOption[selIdx] && storesByOption[selIdx].stores) || [];
    const selOpt = options[selIdx] || {};

    const todayS = selStores.filter((s) => Number(s.o2oRemainQuantity) > 0);
    const inS = selStores.filter((s) => Number(s.remainQuantity) > 0);
    const outS = selStores.filter((s) => Number(s.remainQuantity) === 0);

    const disc = gi.discountRate > 0 ? `<span class="p-disc">${gi.discountRate}%</span>` : '';
    const orig =
      gi.originalPrice && gi.originalPrice !== gi.priceToPay
        ? `<span class="p-orig">${this.num(gi.originalPrice)}원</span>`
        : '';

    const cacheInfo = data._cached
      ? `<div class="cache-banner"><span>📦 사전수집 데이터</span><span>${
          data._updatedAt
            ? new Date(data._updatedAt).toLocaleString('ko-KR', {
                timeZone: 'Asia/Seoul',
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              }) + ' 기준'
            : '시간 미상'
        }</span></div>`
      : '';

    const statusBadge =
      data._status === 'discontinued'
        ? '<div class="status-banner status-banner-discontinued">⛔ 단종/삭제된 상품입니다</div>'
        : data._status === 'soldout'
          ? '<div class="status-banner status-banner-soldout">🔴 주변 매장 전체 품절</div>'
          : '';

    const optTabs =
      options.length > 1
        ? `<div class="sec">
      <h4 class="sec-t">🎨 옵션 선택 (${options.length}개)</h4>
      <div class="opt-tabs">${options
        .map((o, i) => {
          const sel = i === selIdx;
          const list = (storesByOption[i] && storesByOption[i].stores) || [];
          const hasStock = list.some((s) => Number(s.remainQuantity) > 0);
          const dot = hasStock
            ? '<span class="opt-stock-dot" aria-hidden="true"></span>'
            : '';
          const nm = o.itemName || '';
          const short = nm.length > 18 ? nm.substring(0, 18) + '…' : nm;
          return `<button type="button" class="opt-tab${sel ? ' opt-tab-sel' : ''}" data-action="selectOption" data-opt-idx="${i}">${this.esc(
            short
          )}${dot}</button>`;
        })
        .join('')}
      </div>
    </div>`
        : '';

    const optInfo = `<div class="opt-info-box">
      <img src="${this.esc(selOpt.imageUrl || p.imageUrl)}" class="opt-info-img" alt="" onerror="this.style.display='none'">
      <div class="opt-info-txt">
        <div class="opt-info-name">${this.esc(selOpt.itemName)}</div>
        <div class="opt-info-meta">
          온라인 ${this.num(selOpt.quantity)}개
          ${
            selOpt.deliveredToday
              ? ' · <span class="opt-info-today">🚀오늘드림</span>'
              : ''
          }
          · <b>${this.num(selOpt.priceToPay || gi.priceToPay)}원</b>
        </div>
      </div>
    </div>`;

    const summary = `<div class="sum">
      <div class="si"><span class="sl">전체매장</span><span class="sv">${selStores.length}</span></div>
      <div class="si sg"><span class="sl">재고있음</span><span class="sv">${inS.length}</span></div>
      <div class="si sp"><span class="sl">오늘드림</span><span class="sv">${todayS.length}</span></div>
      <div class="si sr"><span class="sl">품절</span><span class="sv">${outS.length}</span></div>
    </div>`;

    const storeHTML = (stores, type) =>
      stores
        .map((s) => {
          const cls = type === 'today' ? 'st st-today' : type === 'out' ? 'st st-out' : 'st';
          const rq = Number(s.remainQuantity) || 0;
          const o2o = Number(s.o2oRemainQuantity) || 0;
          return `<div class="${cls}">
        <div class="st-top">
          <span class="st-name">${this.esc(s.storeName)} ${
            s.openYn ? '<span class="st-open">●영업중</span>' : ''
          } ${s.pickupYn ? '<span class="st-pickup">📦픽업</span>' : ''}</span>
          <span class="st-dist">${this.dist(s.distance)}</span>
        </div>
        <div class="st-addr">${this.esc(s.address)} · ${this.time(s.startTime)}~${this.time(s.endTime)}</div>
        <div class="st-stock">
          ${rq > 0 ? `<span class="sq">매장 ${rq}개</span>` : '<span class="sq out">품절</span>'}
          ${o2o > 0 ? `<span class="sq o2o">🚀오늘드림 ${o2o}개</span>` : ''}
        </div>
      </div>`;
        })
        .join('');

    const inNoO2o = inS.filter((s) => Number(s.o2oRemainQuantity) === 0);
    const todayHTML = todayS.length
      ? `<div class="sec"><h4 class="sec-t sec-purple">🚀 오늘드림 (${todayS.length})</h4><div class="slist">${storeHTML(
          todayS,
          'today'
        )}</div></div>`
      : '';
    const inHTML = inNoO2o.length
      ? `<div class="sec"><h4 class="sec-t">📦 재고있음 (${inNoO2o.length})</h4><div class="slist">${storeHTML(
          inNoO2o,
          ''
        )}</div></div>`
      : '';
    const outHTML = outS.length
      ? `<div class="sec"><h4 class="sec-t sec-gray">품절 (${outS.length})</h4><div class="slist collapsed" id="other-st">${storeHTML(
          outS,
          'out'
        )}</div><button type="button" class="btn-tog" data-action="toggleStores">더보기</button></div>`
      : '';

    const root = document.getElementById('popup-root');
    if (!root) return;
    root.innerHTML = `<div class="overlay" data-action="closePopup"><div class="popup" data-popup-stop="1">
      <button type="button" class="popup-x" data-action="closePopup" aria-label="닫기">&times;</button>
      <div class="popup-head">
        <img src="${this.esc(gi.thumbnailUrl || p.imageUrl)}" class="popup-img" alt="">
        <div class="popup-ti"><h2>${this.esc(gi.goodsName || p.goodsName)}</h2>
          <div class="popup-pr">${disc}<span class="p-sale">${this.num(gi.priceToPay || p.priceToPay)}원</span>${orig}</div>
        </div>
      </div>
      ${cacheInfo}${statusBadge}${optTabs}${optInfo}${summary}${todayHTML}${inHTML}${outHTML}
      <div class="popup-footer-link">
        <a href="https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${this.esc(
          p.goodsNumber
        )}" target="_blank" rel="noopener noreferrer" class="btn-oy">올리브영에서 보기 →</a>
      </div>
    </div></div>`;
    document.body.style.overflow = 'hidden';
    const inner = root.querySelector('[data-popup-stop="1"]');
    if (inner) inner.addEventListener('click', (e) => e.stopPropagation());
  },

  closePopup() {
    const root = document.getElementById('popup-root');
    if (root) root.innerHTML = '';
    document.body.style.overflow = '';
    this._currentPopupData = null;
  },

  toggleStores(btn) {
    const l = document.getElementById('other-st');
    if (!l) return;
    l.classList.toggle('collapsed');
    btn.textContent = l.classList.contains('collapsed') ? '더보기' : '접기';
  }
};
