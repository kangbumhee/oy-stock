var Storage = {
  _key: function (k) {
    return 'oy_' + k;
  },

  getHistory: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('history'))) || [];
    } catch (e) {
      return [];
    }
  },
  setHistory: function (arr) {
    localStorage.setItem(this._key('history'), JSON.stringify((arr || []).slice(0, 20)));
  },

  getLocation: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('location')));
    } catch (e) {
      return null;
    }
  },
  setLocation: function (lat, lng, name) {
    localStorage.setItem(this._key('location'), JSON.stringify({ lat: lat, lng: lng, name: name }));
  },

  getFavorites: function () {
    try {
      return JSON.parse(localStorage.getItem(this._key('favorites'))) || [];
    } catch (e) {
      return [];
    }
  },
  setFavorites: function (arr) {
    localStorage.setItem(this._key('favorites'), JSON.stringify(arr || []));
  },
  isFavorite: function (goodsNo) {
    var gn = String(goodsNo);
    return this.getFavorites().some(function (f) {
      return String(f.goodsNo || f.goodsNumber) === gn;
    });
  },
  addFavorite: function (product) {
    var favs = this.getFavorites();
    var gn = String(product.goodsNo || product.goodsNumber || '');
    if (!gn) return favs;
    if (favs.some(function (f) { return String(f.goodsNo || f.goodsNumber) === gn; })) return favs;
    favs.unshift({
      goodsNo: gn,
      goodsName: product.goodsName || '',
      imageUrl: product.imageUrl || product.thumbnail || '',
      price: product.price || product.priceToPay || 0,
      originalPrice: product.originalPrice || 0,
      discountRate: product.discountRate || 0,
      addedAt: new Date().toISOString()
    });
    this.setFavorites(favs);
    return favs;
  },
  removeFavorite: function (goodsNo) {
    var gn = String(goodsNo);
    var favs = this.getFavorites().filter(function (f) {
      return String(f.goodsNo || f.goodsNumber) !== gn;
    });
    this.setFavorites(favs);
    return favs;
  },
  toggleFavorite: function (product) {
    var gn = String(product.goodsNo || product.goodsNumber || '');
    if (this.isFavorite(gn)) {
      return { favs: this.removeFavorite(gn), added: false };
    }
    return { favs: this.addFavorite(Object.assign({}, product, { goodsNo: gn })), added: true };
  }
};
