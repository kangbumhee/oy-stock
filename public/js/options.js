var Options = {
  parseOptionName: function (name) {
    if (!name) return { label: '', detail: '' };
    var match = name.match(/\(([^)]+)\)$/);
    return { label: match ? match[1] : name, detail: name };
  },

  stockLabel: function (qty) {
    if (qty <= 0) return { text: '품절', cls: 'stock-out' };
    if (qty <= 3) return { text: '품절임박 (' + qty + ')', cls: 'stock-low' };
    if (qty <= 10) return { text: '재고소량 (' + qty + ')', cls: 'stock-mid' };
    return { text: '재고 ' + qty, cls: 'stock-ok' };
  }
};
