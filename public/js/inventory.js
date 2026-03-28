var Inventory = {
  showHistory: async function () {
    var data = null;
    try {
      if (typeof API !== 'undefined' && API.loadHistory) {
        data = await API.loadHistory();
      } else {
        var url =
          (typeof Config !== 'undefined' && Config.HISTORY_JSON_URL) ||
          (typeof CONFIG !== 'undefined' && CONFIG.HISTORY_JSON_URL) ||
          '/data/history.json';
        var r = await fetch(url);
        if (r.ok) data = await r.json();
      }
    } catch (e) {}

    if (!data || !data.events || !data.events.length) {
      alert('변경 이력이 없습니다.');
      return;
    }

    var typeLabels = {
      new: '🆕 신규',
      discontinued: '⛔ 단종',
      restocked: '🔄 재등록',
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
      var label = typeLabels[e.type] || e.type;
      var name = (e.goodsName && UI.esc(e.goodsName)) || '';
      var extra = '';
      if (e.from != null && e.to != null) {
        extra =
          ' <span class="inv-extra">' + UI.num(e.from) + '→' + UI.num(e.to) + '</span>';
      }
      return (
        '<div class="inv-history-row">' +
        '<span class="inv-type">' +
        UI.esc(label) +
        '</span>' +
        '<span class="inv-name">' +
        name +
        extra +
        '</span>' +
        '<span class="inv-time">' +
        UI.esc(time) +
        '</span></div>'
      );
    });

    var root = document.getElementById('popup-root');
    if (!root || typeof UI === 'undefined') return;
    UI.closePopup();
    root.innerHTML =
      '<div class="overlay" data-action="closePopup"><div class="popup popup-history" data-popup-stop="1">' +
      '<button type="button" class="popup-x" data-action="closePopup" aria-label="닫기">&times;</button>' +
      '<h2 class="inv-history-title">📋 변경 이력</h2>' +
      '<div class="inv-history-scroll">' +
      rows.join('') +
      '</div></div></div>';
    document.body.style.overflow = 'hidden';
    var inner = root.querySelector('[data-popup-stop="1"]');
    if (inner) inner.addEventListener('click', function (e) { e.stopPropagation(); });
  }
};
