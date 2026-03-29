var REGIONS = {};

var REGION_SUGGESTIONS = [];

var Regions = {
  _selectorBound: false,

  list: [
    { name: '김포 사우', lat: 37.6152, lng: 126.7156 },
    { name: '서울 강남', lat: 37.4979, lng: 127.0276 },
    { name: '서울 명동', lat: 37.5636, lng: 126.9869 },
    { name: '서울 홍대', lat: 37.5563, lng: 126.922 },
    { name: '서울 잠실', lat: 37.5133, lng: 127.1001 },
    { name: '인천 부평', lat: 37.5075, lng: 126.7219 },
    { name: '수원 인계', lat: 37.2636, lng: 127.0286 },
    { name: '부산 서면', lat: 35.1576, lng: 129.0596 },
    { name: '대구 동성로', lat: 35.8691, lng: 128.595 },
    { name: '대전 둔산', lat: 36.3504, lng: 127.3845 }
  ],

  renderSelector: function () {
    var c = document.getElementById('region-select');
    if (!c) return;
    c.innerHTML =
      '<option value="">지역 변경</option>' +
      this.list
        .map(function (r, i) {
          return (
            '<option value="' +
            i +
            '">' +
            String(r.name).replace(/</g, '&lt;').replace(/"/g, '&quot;') +
            '</option>'
          );
        })
        .join('');
    if (this._selectorBound) return;
    this._selectorBound = true;
    c.addEventListener('change', function () {
      var idx = parseInt(c.value, 10);
      if (isNaN(idx) || !Regions.list[idx]) return;
      var r = Regions.list[idx];
      App.lat = r.lat;
      App.lng = r.lng;
      App.locationName = r.name;
      Storage.setLocation(r.lat, r.lng, r.name);
      var loc = document.getElementById('current-location');
      if (loc) loc.textContent = '📍 ' + r.name;
      c.value = '';
    });
  }
};
