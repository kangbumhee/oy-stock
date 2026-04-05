var CONFIG = {
  DEFAULT_LAT: 37.6152,
  DEFAULT_LNG: 126.7156,
  DEFAULT_LOCATION: '김포 사우',
  SEARCH_SIZE: 50,
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

  REALTIME_API: 'https://oy-stock-api-3596046881.asia-northeast3.run.app/api/stock',

  KAKAO_REST_KEY: '57bff40a86df8f5961cb43e20c4f4976'
};
var Config = CONFIG;
