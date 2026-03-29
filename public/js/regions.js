var Regions = {
  _bound: false,
  _kakaoTimer: null,

  list: [
    { name: '김포 사우', lat: 37.6152, lng: 126.7156 },
    { name: '서울 강남', lat: 37.4979, lng: 127.0276 },
    { name: '서울 명동', lat: 37.5636, lng: 126.9869 },
    { name: '서울 홍대', lat: 37.5563, lng: 126.922 },
    { name: '서울 잠실', lat: 37.5133, lng: 127.1001 },
    { name: '인천 부평', lat: 37.5075, lng: 126.7219 },
    { name: '인천 검단', lat: 37.5899, lng: 126.6758 },
    { name: '인천 구월', lat: 37.4486, lng: 126.7052 },
    { name: '김포 풍무', lat: 37.6041, lng: 126.7279 },
    { name: '김포 장기', lat: 37.6335, lng: 126.6656 },
    { name: '고양 일산', lat: 37.658, lng: 126.771 },
    { name: '수원 인계', lat: 37.2636, lng: 127.0286 },
    { name: '부산 서면', lat: 35.1576, lng: 129.0596 },
    { name: '대구 동성로', lat: 35.8691, lng: 128.595 },
    { name: '대전 둔산', lat: 36.3504, lng: 127.3845 },
    { name: '광주 충장로', lat: 35.1492, lng: 126.9173 }
  ],

  _localItemsHtml: function (qRaw) {
    var q = qRaw.toLowerCase();
    var escQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var matches = this.list.filter(function (r) {
      return r.name.toLowerCase().indexOf(q) > -1;
    });
    if (matches.length === 0) return '';
    return matches
      .map(function (r) {
        var safeName = r.name.replace(/"/g, '&quot;');
        var hl = r.name.replace(new RegExp('(' + escQ + ')', 'gi'), '<b>$1</b>');
        return (
          '<div class="region-item region-preset" style="padding:8px 12px;font-size:13px;cursor:pointer;" data-lat="' +
          r.lat +
          '" data-lng="' +
          r.lng +
          '" data-name="' +
          safeName +
          '">' +
          hl +
          '</div>'
        );
      })
      .join('');
  },

  _kakaoSearch: function (query) {
    var url = '/api/kakao/geo?keyword=' + encodeURIComponent(query);

    return fetch(url)
      .then(function (r) {
        return r.ok ? r.json() : { documents: [] };
      })
      .then(function (data) {
        var docs = data.documents || [];
        return docs.map(function (d) {
          return {
            name: d.place_name || d.address_name || query,
            address: d.road_address_name || d.address_name || '',
            lat: parseFloat(d.y),
            lng: parseFloat(d.x),
            source: 'kakao'
          };
        });
      })
      .catch(function () {
        return [];
      });
  },

  _kakaoSearchResultsHtml: function (items) {
    if (!items || !items.length) return '';
    return items
      .map(function (d) {
        if (isNaN(d.lat) || isNaN(d.lng)) return '';
        var label = d.name + (d.address ? ' · ' + d.address : '');
        var safeName = label.replace(/"/g, '&quot;');
        return (
          '<div class="region-item region-kakao" style="padding:8px 12px;font-size:13px;cursor:pointer;" data-lat="' +
          d.lat +
          '" data-lng="' +
          d.lng +
          '" data-name="' +
          safeName +
          '"><span style="color:#16a34a;font-size:11px;">📍</span> ' +
          UI.esc(label) +
          '</div>'
        );
      })
      .join('');
  },

  renderSelector: function () {
    var wrap = document.getElementById('region-select');
    if (!wrap) return;

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'region-input';
    input.placeholder = '지역 검색 (강남역, 판교…)';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', '지역 검색');
    input.style.cssText = 'font-size:12px;padding:4px 8px;border-radius:4px;border:1px solid #ccc;width:160px;';
    wrap.parentNode.replaceChild(input, wrap);

    var dropdown = document.createElement('div');
    dropdown.id = 'region-dropdown';
    dropdown.style.cssText =
      'position:absolute;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.12);max-height:240px;overflow-y:auto;z-index:150;display:none;min-width:220px;';
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(dropdown);

    var self = this;

    function applyDropdown(html) {
      if (!html) {
        dropdown.innerHTML =
          '<div style="padding:8px 12px;font-size:12px;color:#999;">일치하는 지역 없음</div>';
      } else {
        dropdown.innerHTML = html;
      }
      dropdown.style.display = 'block';
    }

    input.addEventListener('input', function () {
      if (self._kakaoTimer) {
        clearTimeout(self._kakaoTimer);
        self._kakaoTimer = null;
      }

      var qRaw = (input.value || '').trim();
      if (qRaw.length === 0) {
        dropdown.style.display = 'none';
        return;
      }

      var localHtml = self._localItemsHtml(qRaw);

      var pending =
        '<div class="region-kakao-pending" style="padding:6px 12px;font-size:11px;color:#888;border-top:1px solid #eee;">주소 검색 중…</div>';
      applyDropdown(localHtml + pending);

      self._kakaoTimer = setTimeout(function () {
        self._kakaoTimer = null;
        self
          ._kakaoSearch(qRaw)
          .then(function (items) {
            var kHtml = self._kakaoSearchResultsHtml(items);
            var section = '';
            if (kHtml) {
              section =
                '<div style="padding:4px 10px;font-size:10px;color:#999;background:#f9fafb;border-top:1px solid #eee;">카카오 장소</div>' +
                kHtml;
            }
            var combined = localHtml + section;
            if (!combined) {
              applyDropdown('');
            } else {
              dropdown.innerHTML = combined;
              dropdown.style.display = 'block';
            }
          })
          .catch(function () {
            applyDropdown(
              localHtml ||
                '<div style="padding:8px 12px;font-size:12px;color:#c00;">장소 검색 실패 (API 확인)</div>'
            );
          });
      }, 320);
    });

    input.addEventListener('focus', function () {
      if ((input.value || '').trim().length > 0) input.dispatchEvent(new Event('input'));
    });

    dropdown.addEventListener('click', function (e) {
      var item = e.target.closest('.region-item');
      if (!item) return;
      var lat = parseFloat(item.dataset.lat);
      var lng = parseFloat(item.dataset.lng);
      var name = item.dataset.name;
      App.lat = lat;
      App.lng = lng;
      App.locationName = name;
      Storage.setLocation(lat, lng, name);
      var loc = document.getElementById('current-location');
      if (loc) loc.textContent = '📍 ' + name;
      input.value = '';
      dropdown.style.display = 'none';
      UI.showSyncStatus('📍 ' + name + '으로 변경됨', false);
    });

    dropdown.addEventListener('mouseover', function (e) {
      var item = e.target.closest('.region-item');
      if (item) item.style.background = '#f0fdf4';
    });
    dropdown.addEventListener('mouseout', function (e) {
      var item = e.target.closest('.region-item');
      if (item) item.style.background = '';
    });

    if (!this._bound) {
      this._bound = true;
      document.addEventListener('click', function (e) {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = 'none';
      });
    }
  }
};
