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
        price_up: '📈 가격↑'
      };
      var rows = data.events.slice(0, 50).map(function (e) {
        var time = new Date(e.date).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        var extra =
          e.from != null && e.to != null
            ? ' <span class="inv-extra">' + UI.num(e.from) + '→' + UI.num(e.to) + '</span>'
            : '';
        return (
          '<div class="inv-history-row">' +
          '<span class="inv-type">' +
          UI.esc(typeLabels[e.type] || e.type) +
          '</span>' +
          '<span class="inv-name">' +
          UI.esc(e.goodsName || '') +
          extra +
          '</span>' +
          '<span class="inv-time">' +
          UI.esc(time) +
          '</span></div>'
        );
      });
      var root = document.getElementById('popup-root');
      if (!root) return;
      if (typeof UI !== 'undefined' && UI.closePopup) UI.closePopup();
      root.innerHTML =
        '<div class="popup-overlay" data-action="closePopup">' +
        '<div class="popup-content popup-history-wrap" data-popup-stop="1">' +
        '<div class="popup-header"><h3>📋 변경 이력</h3><button type="button" data-action="closePopup">✕</button></div>' +
        '<div class="inv-history-scroll">' +
        rows.join('') +
        '</div></div></div>';
      document.body.style.overflow = 'hidden';
      var inner = root.querySelector('[data-popup-stop="1"]');
      if (inner) inner.addEventListener('click', function (e) { e.stopPropagation(); });
    });
  }
};
