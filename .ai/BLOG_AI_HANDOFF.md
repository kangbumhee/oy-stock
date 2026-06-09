# 블로그형 SEO 페이지 작업 인수인계

작성일: 2026-06-09  
대상 사이트: 올리브재고 (`olivestock.co.kr`)  
핵심 목표: 올리브영 인기상품을 사진 많은 후기형 블로그 글처럼 보여주고, 마지막에 올리브재고/큐레이터 구매 링크로 자연스럽게 유입시키기.

## 현재 구현된 것

- 블로그 생성기: `scripts/build-blog-pages.js`
- 상품별 문장/캡션 프로필: `scripts/blog-product-profiles.js`
- 후기형 이미지 렌더러: `scripts/render-blog-product-assets.js`
- 실행 명령: `npm run build:blog` 또는 `node scripts/build-blog-pages.js --limit 1`
- 후기형 이미지 재생성: `npm run build:blog:assets`
- 생성 위치:
  - `public/blog/index.html`
  - `public/blog/<slug>/index.html`
  - `public/data/blog-posts.json`
  - `public/images/blog/`
- 현재 테스트 글:
  - `public/blog/mediheal-toner-pad-200-stock-a000000255385/index.html`
  - `public/blog/mediheal-toner-pad-200-stock-a000000255387/index.html`
  - `public/blog/torriden-serum-stock-a000000256047/index.html`
  - `public/blog/mediheal-sun-serum-stock-a000000255391/index.html`
  - `public/blog/mediheal-gel-mask-stock-a000000239102/index.html`

## 블로그 글 방향

말투는 딱딱한 분석글이 아니라 네이버 후기글처럼 자연스럽게 써야 한다.

좋은 톤:

- "민트 통 색감이 생각보다 산뜻해요"
- "요 컷이 제일 궁금한 부분이죠"
- "마음에 들면 재고부터 보는 게 편해요"
- "살 거면 옵션명은 한 번만 더 봐요"

피해야 할 톤:

- "확인 포인트입니다"
- "구성의 핵심입니다"
- "검색 의도와 부합합니다"
- "데이터 기반으로 분석했습니다"

단, 실제 사용하지 않은 제품을 "제가 며칠 써봤는데", "피부가 좋아졌어요"처럼 허위 실사용 후기로 쓰면 안 된다. 후기처럼 자연스럽게 보이되, 제품 사진/구매 전 체크/재고 확인 흐름 중심으로 작성한다.

## 이미지 규칙

현재 메디힐 토너패드 글은 생성 이미지 기반이다. 추가 인기템은 공식 상세페이지 캡처를 참고한 Playwright/HTML 렌더 이미지 기반이다.

참고:

- 공식 올리브영 상세페이지 캡처는 `tmp/oliveyoung-detail-captures/`에 참고용으로만 저장했다.
- 공개 블로그에는 공식 상세페이지 캡처를 직접 쓰지 않고, 상세페이지 색감과 상품 구조를 참고한 후기형 렌더 이미지를 사용한다.
- 이번 작업 중 기본 `image_gen` 도구가 서버 오류를 반환해서 Playwright/HTML 렌더 방식으로 대체했다. 이미지 생성 도구가 정상화되면 같은 파일명으로 더 사진 같은 PNG를 교체하면 된다.

주요 이미지:

- 상세페이지형 대표 이미지: `public/images/blog/mediheal-toner-pad-detail-page-01.png`
- 후기 컷 개별 이미지:
  - `public/images/blog/mediheal-toner-pad-review-01.png`
  - ...
  - `public/images/blog/mediheal-toner-pad-review-18.png`
- 토리든 다이브인 세럼:
  - `public/images/blog/torriden-dive-in-serum-detail-page-01.png`
  - `public/images/blog/torriden-dive-in-serum-review-01.png` ~ `review-18.png`
- 메디힐 수분 선세럼:
  - `public/images/blog/mediheal-sun-serum-detail-page-01.png`
  - `public/images/blog/mediheal-sun-serum-review-01.png` ~ `review-18.png`
- 메디힐 하이퍼 겔마스크:
  - `public/images/blog/mediheal-gel-mask-detail-page-01.png`
  - `public/images/blog/mediheal-gel-mask-review-01.png` ~ `review-18.png`

주의:

- 페이지에는 콜라주 시트를 직접 넣지 말고, 잘라낸 개별 컷 `review-01.png`부터 `review-18.png`를 사용한다. 현재 배포 대상에는 개별 컷만 포함했다.
- 이전에 콜라주 시트를 CSS `object-position`으로 자르려다가 한 칸에 여러 사진이 섞여 보이는 문제가 있었다.
- 상품 상세페이지 톤과 맞추기 위해 메디힐 토너패드는 아쿠아/민트 용기, 네모패드, 투명 집게, 촉촉한 엠보싱 패드 느낌을 유지한다.
- 토리든 다이브인 세럼은 파란 투명 보틀, 스포이드, 더블 기획 구성을 유지한다.
- 메디힐 수분 선세럼은 흰 튜브, 민트 세로 포인트, 투명 민트 캡 느낌을 유지한다.
- 메디힐 겔마스크는 핑크/보라/하늘색 팩, 8+1 기획, 촉촉한 겔 시트 느낌을 유지한다.
- 브랜드/상표가 필요한 경우 사용자가 허용했지만, 실제 공식 상세페이지를 픽셀 복사하는 이미지는 만들지 않는다.

## 스타일 규칙

`scripts/build-blog-pages.js` 안의 `blogPostTemplate()`에 인라인 CSS가 있다.

상품별 자연스러운 문장과 후기 컷 캡션은 `scripts/blog-product-profiles.js`에서 관리한다. 새 상품을 후기형으로 만들 때는 여기에 프로필을 추가하고, 이미지가 필요하면 `scripts/render-blog-product-assets.js`의 `VISUALS`와 `TARGET_IDS`도 같이 추가한다.

현재 의도:

- 밝은 민트/아쿠아 톤
- 중요한 단어는 `.highlight`로 민트색 배경
- 첫 느낌은 `.mood-note` 3개 박스
- 사진 캡션은 번호 + 짧은 제목 + 자연스러운 설명
- 마지막 CTA는 진한 민트/딥블루 박스

너무 많은 설명문보다 사진, 짧은 캡션, 자연스러운 문단을 우선한다.

## 버튼/구매 링크 흐름

블로그 마지막 CTA에는 두 버튼이 있다.

1. `구매하러가기`
   - 링크 형식: `https://olivestock.co.kr/api/oliveyoung/curator-redirect?goodsNo=<상품번호>`
   - 이 API는 `public/data/curator-links.json`의 큐레이터 링크를 먼저 사용한다.
   - 캐시에 없으면 기본 올리브영 모바일 제휴 URL로 폴백한다.

2. `재고 먼저 보고 구매하기`
   - 링크 형식: `https://olivestock.co.kr/?q=<상품명>&autoBuy=<상품번호>`
   - `public/js/app.js`에서 `autoBuy` 파라미터를 읽는다.
   - 검색 결과가 렌더링되면 해당 상품의 `data-action="buyNow"` 버튼을 찾아 자동으로 `UI.openOliveYoungProduct()`를 실행한다.

관련 앱 코드:

- `public/js/app.js`
  - `autoBuyGoodsNo`
  - `autoBuyTriggered`
  - `_runInitialQueryFromUrl()`
  - `_tryAutoBuyFromUrl()`
- `public/js/ui.js`
  - `UI.openOliveYoungProduct()`
  - `UI.loadCuratorLinksIndex()`
  - `UI.curatorRedirectUrl()`

현재는 블로그의 `구매하러가기`와 기존 프로그램 검색 결과의 `바로구매`가 같은 엔드포인트를 사용하도록 맞춰져 있다.

- 공통 URL: `https://olivestock.co.kr/api/oliveyoung/curator-redirect?goodsNo=<상품번호>`
- 로컬 `file://` 미리보기에서도 기존 프로그램 버튼은 위 절대경로로 열리도록 처리했다.
- 예전 프론트 직접 `landing-proxy → shorten-proxy` 흐름은 주소 차이를 만들 수 있어서 버튼 진입점에서는 사용하지 않는다.

## 모바일 앱/웹 열기

`api/oliveyoung/curator-redirect.js`는 모바일 User-Agent일 때 바로 302를 보내지 않고 작은 브릿지 HTML을 반환한다.

동작:

- Android: `intent://m.oliveyoung.co.kr/...#Intent;scheme=https;package=com.oliveyoung;S.browser_fallback_url=...;end`
- iOS: `https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?...` 링크로 이동한다. 올리브영 앱이 Universal Link를 처리하면 앱이 열리고, 아니면 모바일 웹이 열린다.
- 데스크톱: 기존처럼 302 redirect.
- `format=json`은 모바일/데스크톱과 무관하게 JSON을 반환한다.

주의:

- 브릿지 화면에는 상품번호를 노출하지 않는다.
- `webUrl`은 큐레이터 캐시의 `shortenedUrl`이 있으면 그 링크를 fallback으로 쓰고, 없으면 `originalUrl` 또는 기본 제휴 URL을 쓴다.
- `appUrl`은 앱/Universal Link에 더 잘 걸리도록 `m.oliveyoung.co.kr` 원본 모바일 상품 URL을 쓴다.
- 올리브영 앱 패키지는 `com.oliveyoung`으로 설정되어 있다.

## GitHub 자동 생성 큐레이터 링크

워크플로우:

- `.github/workflows/stock.yml`
- `node scripts/detail-stock.mjs`
- `node scripts/generate-curator-links.mjs`

큐레이터 링크는 `public/data/curator-links.json`에 저장된다.

메디힐 상품 번호 `A000000255385`는 `scripts/detail-stock.mjs`의 `POPULAR_PRODUCTS`에 추가되어 있다. 다음 GitHub Actions 실행 때 수집/큐레이터 링크 생성 대상에 포함된다.

추가된 인기템 상품 번호:

- `A000000256047`: 토리든 다이브인 저분자 히알루론산 세럼
- `A000000255391`: 메디힐 마데카소사이드 수분 선세럼
- `A000000239102`: 메디힐 하이퍼 겔마스크 4종

현재 `curator-links.json`에 해당 상품 링크가 아직 없을 수 있다. 이 경우 `curator-redirect` API가 기본 제휴 URL로 폴백한다.

## 라우팅/배포

`vercel.json`에 블로그 라우팅이 추가되어 있다.

- `/blog/` -> `/public/blog/index.html`
- `/blog/<slug>/` -> `/public/blog/<slug>/index.html`

생성기는 sitemap/rss/site-map/home 블로그 블록도 갱신한다.

갱신 대상:

- `public/sitemap.xml`
- `public/rss.xml`
- `public/site-map.html`
- `public/index.html`
- `public/blog/index.html`
- `public/data/blog-posts.json`

## 검증 명령

문법 체크:

```bash
node --check public/js/app.js
node --check scripts/blog-product-profiles.js
node --check scripts/build-blog-pages.js
node --check scripts/render-blog-product-assets.js
node --check scripts/detail-stock.mjs
```

블로그 재생성:

```bash
node scripts/render-blog-product-assets.js
node scripts/build-blog-pages.js --limit 1
# 이번 작업처럼 상위 4개까지 생성하려면:
node scripts/build-blog-pages.js --limit 4
```

이미지/레이아웃 확인은 Playwright로 `file://` 페이지를 열어 검사했다.

체크해야 할 항목:

- 이미지가 모두 로드되는지
- `.review-photo`가 18개인지
- 모바일 가로 넘침이 없는지
- "상품 번호" 또는 `A000000...`이 화면 본문에 노출되지 않는지
- `구매하러가기`가 `https://olivestock.co.kr/api/oliveyoung/curator-redirect?goodsNo=...`로 연결되는지
- `재고 먼저 보고 구매하기`가 `https://olivestock.co.kr/?q=...&autoBuy=...`로 연결되는지

## 다음 AI가 건드릴 때 조심할 점

- `build-blog-pages.js`는 현재 인기순위 API에서 최신 1위 상품을 가져오므로, 실행 시 새 slug가 추가될 수 있다.
- 기존 글도 템플릿 변경 시 다시 쓰도록 `for (const post of posts)`로 되어 있다. 이 동작을 유지해야 예전 글도 최신 템플릿을 반영한다.
- 상품별 문체를 고칠 때는 `scripts/blog-product-profiles.js`의 해당 프로필을 먼저 본다.
- `build-blog-pages.js`는 같은 상품번호가 새 slug로 다시 들어오면 기존 slug를 manifest에서 빼도록 처리되어 있다. 다만 이미 생성된 예전 디렉터리는 필요하면 직접 삭제해야 한다.
- 콜라주 원본을 직접 페이지에 넣지 않는다.
- 방문자용 글에 `GitHub Actions`, `curator-links.json` 같은 내부 기술 용어를 노출하지 않는다.
- 큐레이터 링크 생성 로직 자체는 `generate-curator-links.mjs`와 API들에 이미 있으므로, 블로그에서는 해당 API로 연결만 하면 된다.
