var Storage = {
  KEY_SEARCH: 'oy_search_history',
  KEY_REGION: 'oy_region_history',
  KEY_FAVORITES: 'oy_favorites',

  getSearchHistory: function () {
    try {
      return JSON.parse(localStorage.getItem(this.KEY_SEARCH)) || [];
    } catch (e) {
      return [];
    }
  },
  addSearch: function (keyword) {
    if (!keyword || !keyword.trim()) return;
    keyword = keyword.trim();
    var list = this.getSearchHistory().filter(function (k) {
      return k !== keyword;
    });
    list.unshift(keyword);
    var maxH = typeof CONFIG !== 'undefined' && CONFIG.MAX_HISTORY ? CONFIG.MAX_HISTORY : 20;
    if (list.length > maxH) list.length = maxH;
    localStorage.setItem(this.KEY_SEARCH, JSON.stringify(list));
  },
  removeSearch: function (keyword) {
    var list = this.getSearchHistory().filter(function (k) {
      return k !== keyword;
    });
    localStorage.setItem(this.KEY_SEARCH, JSON.stringify(list));
  },
  clearSearch: function () {
    localStorage.removeItem(this.KEY_SEARCH);
  },

  getRegionHistory: function () {
    try {
      return JSON.parse(localStorage.getItem(this.KEY_REGION)) || [];
    } catch (e) {
      return [];
    }
  },
  addRegion: function (name) {
    if (!name) return;
    var list = this.getRegionHistory().filter(function (r) {
      return r !== name;
    });
    list.unshift(name);
    if (list.length > 10) list.length = 10;
    localStorage.setItem(this.KEY_REGION, JSON.stringify(list));
  },

  getFavorites: function () {
    try {
      return JSON.parse(localStorage.getItem(this.KEY_FAVORITES)) || [];
    } catch (e) {
      return [];
    }
  },
  addFavorite: function (product) {
    var list = this.getFavorites().filter(function (f) {
      return f.goodsNumber !== product.goodsNumber;
    });
    list.unshift({
      goodsNumber: product.goodsNumber,
      goodsName: product.goodsName,
      imageUrl: product.imageUrl,
      priceToPay: product.priceToPay,
      originalPrice: product.originalPrice,
      discountRate: product.discountRate,
      addedAt: Date.now()
    });
    var maxF = typeof CONFIG !== 'undefined' && CONFIG.MAX_FAVORITES ? CONFIG.MAX_FAVORITES : 50;
    if (list.length > maxF) list.length = maxF;
    localStorage.setItem(this.KEY_FAVORITES, JSON.stringify(list));
  },
  removeFavorite: function (goodsNumber) {
    var list = this.getFavorites().filter(function (f) {
      return f.goodsNumber !== goodsNumber;
    });
    localStorage.setItem(this.KEY_FAVORITES, JSON.stringify(list));
  },
  isFavorite: function (goodsNumber) {
    return this.getFavorites().some(function (f) {
      return f.goodsNumber === goodsNumber;
    });
  }
};
