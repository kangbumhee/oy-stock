var Inventory = {
  showHistory: function () {
    API.loadHistory().then(function (data) {
      if (!data || !data.events || !data.events.length) {
        alert('변경 이력이 없습니다.');
        return;
      }
      var typeLabels = {
        new: '🆕 신규',
        discontinued: '⛔ 단종',
        restocked: '🔄 복귀',
        soldout: '🔴 품절',
        back_in_stock: '🟢 재입고',
        removed: '🗑 제거',
        price_down: '💰 가격↓',
        price_up: '📈 가격↑',
        stock_changed: '📦 재고변동'
      };
      var rows = data.events.slice(0, 100).map(function (e) {
        var time = new Date(e.date).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });

        var extra = '';
        // 가격 변동
        if ((e.type === 'price_down' || e.type === 'price_up') && e.from != null && e.to != null) {
          extra =
            '<span class="inv-extra">' + UI.num(e.from) + '원 → ' + UI.num(e.to) + '원</span>';
        }
        // 재고 변동 (매장 수 + 수량)
        if (e.type === 'stock_changed' && e.from != null && e.to != null) {
          extra = '<span class="inv-extra">' + e.from + '매장 → ' + e.to + '매장';
          if (e.fromQty != null && e.toQty != null) {
            extra += ' (' + e.fromQty + '개 → ' + e.toQty + '개)';
          }
          extra += '</span>';
        }
        // 품절
        if (e.type === 'soldout') {
          extra = '<span class="inv-extra" style="color:#dc2626">';
          if (e.from != null) extra += e.from + '매장';
          if (e.fromQty != null) extra += '(' + e.fromQty + '개)';
          extra += ' → 0</span>';
        }
        // 재입고
        if (e.type === 'back_in_stock') {
          extra = '<span class="inv-extra" style="color:#16a34a">';
          extra += '0 → ';
          if (e.to != null) extra += e.to + '매장';
          if (e.toQty != null) extra += '(' + e.toQty + '개)';
          extra += '</span>';
        }
        // 신규
        if (e.type === 'new') {
          if (e.stores != null || e.qty != null) {
            extra = '<span class="inv-extra" style="color:#2563eb">';
            if (e.stores != null) extra += e.stores + '매장';
            if (e.qty != null) extra += ' ' + e.qty + '개';
            extra += '</span>';
          }
        }

        var typeColor = {
          new: '#2563eb',
          discontinued: '#dc2626',
          soldout: '#dc2626',
          back_in_stock: '#16a34a',
          restocked: '#16a34a',
          stock_changed: '#ea580c',
          price_down: '#16a34a',
          price_up: '#dc2626',
          removed: '#999'
        };
        var color = typeColor[e.type] || '#16a34a';

        return (
          '<div class="inv-history-row">' +
          '<span class="inv-type" style="color:' +
          color +
          '">' +
          UI.esc(typeLabels[e.type] || e.type) +
          '</span>' +
          '<span class="inv-name">' +
          UI.esc(e.goodsName || '') +
          (extra ? ' ' + extra : '') +
          '</span>' +
          '<span class="inv-time">' +
          UI.esc(time) +
          '</span></div>'
        );
      });
      var root = document.getElementById('popup-root');
      if (!root) return;
      UI.closePopup();
      root.innerHTML =
        '<div class="popup-overlay">' +
        '<div class="popup-backdrop" data-action="closePopup" style="position:absolute;inset:0;z-index:0"></div>' +
        '<div class="popup-content popup-history-wrap">' +
        '<div class="popup-header"><h3>📋 변경 이력</h3><button type="button" data-action="closePopup">✕</button></div>' +
        '<div class="inv-history-scroll">' +
        rows.join('') +
        '</div></div></div>';
      document.body.style.overflow = 'hidden';
    });
  }
};
