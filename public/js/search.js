var Search = {
  popularKeywords: [
    '선크림',
    '토너',
    '클렌징',
    '수분크림',
    '마스크팩',
    '립틴트',
    '쿠션',
    '파운데이션',
    '세럼',
    '아이크림'
  ],

  renderPopularKeywords: function () {
    var c = document.getElementById('popular-keywords');
    if (!c || typeof UI === 'undefined') return;
    c.innerHTML = this.popularKeywords
      .map(function (kw) {
        return (
          '<button type="button" class="keyword-tag" data-action="search" data-keyword="' +
          UI.esc(kw) +
          '">' +
          UI.esc(kw) +
          '</button>'
        );
      })
      .join('');
  }
};
