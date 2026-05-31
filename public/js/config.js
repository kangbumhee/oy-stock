var CONFIG = {
  DEFAULT_LAT: 37.6152,
  DEFAULT_LNG: 126.7156,
  DEFAULT_LOCATION: '김포 사우',
  SEARCH_SIZE: 50,
  SEARCH_PREVIEW_SIZE: 20,
  SEARCH_ONLINE_ENRICH_LIMIT: 50,
  SEARCH_ONLINE_BATCH_SIZE: 3,
  SEARCH_ONLINE_BATCH_DELAY_MS: 80,
  STOCK_DETAIL_FETCH_TIMEOUT_MS: 20000,
  ONLINE_DETAIL_CACHE_TTL_MS: 2 * 60 * 1000,
  ONLINE_DETAIL_CACHE_MAX: 120,
  VELOCITY_RANK_LIMIT: 8,
  VELOCITY_RANK_WINDOW_MS: 30 * 60 * 1000,
  VELOCITY_RANK_MAX_ITEMS: 320,
  VELOCITY_AUTO_REFRESH_MS: 60 * 1000,
  HOT_RANK_API: '/api/oliveyoung/view-ranking',
  HOT_RANK_HISTORY_API: '/api/oliveyoung/hot-ranking-history',
  HOT_RANK_SIZE: 100,
  HOT_RANK_CACHE_TTL_MS: 45 * 1000,
  HOT_RANK_SALES_WINDOW_MS: 60 * 60 * 1000,
  HOT_RANK_DEFAULT_RANGE: '1d',
  HOT_RANK_RANGES: {
    '1d': { label: '24시간', hours: 24 },
    '7d': { label: '7일', hours: 24 * 7 },
    '30d': { label: '30일', hours: 24 * 30 }
  },
  HOT_RANK_STOCK_ENRICH_LIMIT: 0,
  HOT_RANK_BATCH_SIZE: 3,
  HOT_RANK_BATCH_DELAY_MS: 120,
  HOT_RANK_AUTO_REFRESH_MS: 3 * 60 * 1000,
  DETAIL_JSON_URL: '/data/stock-detail.json',
  HISTORY_JSON_URL: '/data/history.json',
  FAVORITES_SYNC_URL: '/api/favorites/sync',
  FALLBACK_API: '/api/oliveyoung/stock',
  OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=',
  OY_BASE: 'https://www.oliveyoung.co.kr',
  /** GitHub Actions로 갱신되는 큐레이터(utm_content 포함 oy.run) 캐시 — 프론트에서 먼저 조회 */
  CURATOR_LINKS_JSON_URL: '/data/curator-links.json',
  /** JSON/debug용 서버 리다이렉트 */
  CURATOR_REDIRECT_PATH: '/api/oliveyoung/curator-redirect',
  LANDING_PROXY_PATH: '/api/oliveyoung/landing-proxy',
  SHORTEN_PROXY_PATH: '/api/oliveyoung/shorten-proxy',
  AFFILIATE_REGISTER_ID: '4ee076cc92da4447a1b4b42c590e4495',

  REALTIME_API: 'https://oy-stock-api-3596046881.asia-northeast3.run.app/api/stock',

  KAKAO_REST_KEY: '57bff40a86df8f5961cb43e20c4f4976'
};
var Config = CONFIG;
