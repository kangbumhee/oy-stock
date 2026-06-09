var Search = {
  renderPopularKeywords: function () {
    var c = document.getElementById('popular-keywords');
    if (!c) return;
    var keywords = [
      '선크림',
      '토너',
      '마스크팩',
      '클렌징오일',
      '쿠션',
      '립밤',
      '세럼',
      '샴푸'
    ];
    c.innerHTML = keywords
      .map(function (kw) {
        return (
          '<button type="button" class="keyword-tag" data-action="searchKeyword" data-keyword="' +
          UI.esc(kw) +
          '">' +
          UI.esc(kw) +
          '</button>'
        );
      })
      .join('');
  }
};
