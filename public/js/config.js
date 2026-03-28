var CONFIG = {
  MCP_BASE: 'https://mcp.aka.page/api/oliveyoung',
  PROXY_PATH: '/api/proxy',
  OY_SITE: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=',
  DEFAULT_LAT: 37.5665,
  DEFAULT_LNG: 126.978,
  DEFAULT_REGION: '서울',
  SEARCH_SIZE: 20,
  MAX_HISTORY: 20,
  MAX_FAVORITES: 50,
  STOCK_LOW: 5,
  STOCK_JSON_URL: '/data/stock.json',
  DETAIL_JSON_URL: '/data/stock-detail.json',
  HISTORY_JSON_URL: '/data/history.json',
  FALLBACK_API: '/api/oliveyoung/stock',
  OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=',
  LIVE_SEARCH_SIZE: 50,

  NATIONAL_COORDS: [
    { name: '서울', lat: 37.5665, lng: 126.978 },
    { name: '인천', lat: 37.4563, lng: 126.7052 },
    { name: '경기 남부', lat: 37.2636, lng: 127.0286 },
    { name: '경기 북부', lat: 37.7413, lng: 127.0477 },
    { name: '대전', lat: 36.3504, lng: 127.3845 },
    { name: '대구', lat: 35.8714, lng: 128.6014 },
    { name: '부산', lat: 35.1578, lng: 129.0599 },
    { name: '광주', lat: 35.1595, lng: 126.8526 },
    { name: '울산', lat: 35.5384, lng: 129.3114 },
    { name: '강원', lat: 37.8813, lng: 127.7298 },
    { name: '충북', lat: 36.6372, lng: 127.4897 },
    { name: '충남', lat: 36.8049, lng: 127.1944 },
    { name: '전북', lat: 35.8219, lng: 127.1489 },
    { name: '전남', lat: 34.9896, lng: 127.3955 },
    { name: '경북', lat: 36.21, lng: 128.3544 },
    { name: '경남', lat: 35.2753, lng: 128.6515 },
    { name: '제주', lat: 33.4996, lng: 126.5312 }
  ]
};

/** @type {typeof CONFIG} 별칭 — 스크립트에서 Config / CONFIG 둘 다 사용 가능 */
var Config = CONFIG;
