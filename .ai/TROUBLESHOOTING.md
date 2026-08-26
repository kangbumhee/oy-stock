# 트러블슈팅 - 에러 해결 모음

## 에러 기록 규칙

AI가 에러를 해결할 때마다 아래 형식으로 추가한다.

```markdown
### [에러 제목]

- 발생일:
- 에러 메시지:
- 원인:
- 해결법:
- 관련 파일:
```

## 기록

### 큐레이터 링크가 내 수익 링크가 아닌 것처럼 보임

- 발생일: 2026-04-22
- 증상: 바로구매 클릭 시 `link 생성 중` 이후 생성된 링크에 내 큐레이터 수익이 붙지 않는 것으로 의심됨.
- 원인:
  - `landing-proxy`가 `affiliateActivityId`를 받지 못하면 기존 프론트가 `utm_content` 없이 shorten 링크를 만들 수 있었다.
  - GitHub Actions의 `OY_CURATOR_COOKIE`가 오래되어 landing API가 `JWT Token이 유효하지 않습니다.`를 반환했다.
- 해결법:
  - `landing-proxy`와 `generate-curator-links.mjs`에서 여러 인증 후보 중 유효한 최신 JWT를 선택하도록 변경했다.
  - `public/js/ui.js`에서 `affiliateActivityId`가 없으면 shorten 생성을 중단하도록 변경했다.
  - 운영 확인: `/api/oliveyoung/landing-proxy?check=1`
- 관련 파일:
  - `api/oliveyoung/landing-proxy.js`
  - `scripts/generate-curator-links.mjs`
  - `public/js/ui.js`

### GitHub Actions는 성공인데 curator-links 항목이 갱신되지 않음

- 발생일: 2026-04-22
- 증상: `public/data/curator-links.json`의 `updatedAt`만 바뀌고 상품별 `generatedAt`은 오래된 상태.
- 원인: landing 실패 시 기존 링크를 유지하면서 파일 저장은 성공 처리될 수 있었다.
- 해결법:
  - 전 상품 landing 실패 시 `generate-curator-links.mjs`가 실패 exit code를 내도록 변경했다.
  - Actions 로그에서 `landing 실패`, `UNAUTHORIZED`, `JWT Token이 유효하지 않습니다.`를 확인한다.
- 관련 파일:
  - `scripts/generate-curator-links.mjs`

### Vercel 배포 후 새 코드가 반영됐는지 헷갈림

- 발생일: 2026-04-22
- 확인법:
  - GitHub commit status에서 Vercel 상태가 `success`인지 확인한다.
  - `https://oy-stock.vercel.app/api/oliveyoung/landing-proxy?check=1` 응답에 `selectedSource`, `candidateSources`가 있는지 확인한다.
- 관련 파일:
  - `api/oliveyoung/landing-proxy.js`

### 쿠키 갱신 후에도 새 큐레이터 링크가 바로 생성되지 않음

- 발생일: 2026-07-08
- 증상: `/api/oliveyoung/curator-redirect?goodsNo=...`가 "구매 링크 준비 중" 화면에 머물거나 `cloudrun_live_failed`를 반환.
- 원인:
  - Vercel 프로젝트의 Ignored Build Step이 `exit 0`이라 Deploy Hook 기반 재배포가 `CANCELED` 처리되어 최신 `OY_REFRESH_COOKIE`가 운영 함수에 반영되지 않았다.
  - 빠른 생성용 Cloud Run 서비스도 오래된 `OY_REFRESH_COOKIE`를 들고 있어 `missing_or_expired_curator_auth`를 반환했다.
- 해결법:
  - `refresh-oy-linkage.yml`에서 Deploy Hook을 생략하고 Vercel CLI direct production deploy를 실행한다.
  - 같은 워크플로에서 Cloud Run `OY_REFRESH_COOKIE`와 `OLIVEYOUNG_LINKAGE_STRING`을 `gcloud run services update`로 갱신한다.
  - 확인: `landing-proxy?check=1`의 `jwtValid=true`, Cloud Run `/health?curator=1`의 `curator=true`.
- 관련 파일:
  - `.github/workflows/refresh-oy-linkage.yml`
  - `scripts/refresh-oy-linkage.mjs`

### 검색 API가 간헐적으로 503을 반환하고 상품이 일부만 보임

- 발생일: 2026-08-26
- 에러 메시지: 브라우저 `/api/oliveyoung/search` HTTP 503, Cloud Run `official_search_unavailable`; Cloud Run 로그의 `memory limit exceeded`, `Execution context was destroyed`, `Target page ... has been closed`.
- 원인:
  - 검색과 재고 상세 조회가 같은 Playwright page를 공유해 `/api/stock`의 navigation이 `/api/search`의 실행 컨텍스트를 파괴했다.
  - Cloud Run 단일 인스턴스가 2GiB, concurrency 80, maxScale 1이라 요청이 몰릴 때 OOM 재시작과 연쇄 실패가 발생했다.
  - 검색 캐시는 인스턴스 메모리에만 있어 재시작 직후 동일 검색이 한꺼번에 업스트림을 다시 호출했다.
- 해결법:
  - 검색·가격 조회를 재고 navigation page와 분리하고, 동일 검색 singleflight, 제한된 동시성/대기열, 완전한 결과만 저장하는 캐시를 적용한다.
  - Cloud Run을 memory 4GiB, concurrency 4, max instances 3으로 배포한다.
  - 검색 결과는 `complete=true`, `data.totalCount === data.products.length`인지 확인한다. 불완전 결과를 빈 성공으로 바꾸지 않는다.
- 관련 파일:
  - `server/server.mjs`
  - `server/official-search.mjs`
  - `api/oliveyoung/search.js`

### 평생 프로모션이 503이고 Enter 입력 시 숨겨진 가격 필드 오류가 남

- 발생일: 2026-08-27
- 에러 메시지: `POST /api/price-alerts/promotion`의 `503 rate_limit_unavailable`, `An invalid form control with name='targetPrice' is not focusable`, 신규 브라우저 `GET /api/price-alerts/alerts`의 `401`.
- 원인:
  - 운영 Blob 연결은 비공개 저장소인데 가격알림 저장 모듈이 `access:'public'`으로 읽고 써서 첫 요청률 카운터 저장부터 실패했다.
  - 프로모션 입력과 숨겨진 `required targetPrice`가 같은 form에 있어 Enter 제출의 네이티브 검증이 프로모션 핸들러보다 먼저 중단됐다.
  - 아직 레코드가 없는 신규 기기의 읽기 전용 알림 목록 조회가 생성 허용 없이 인증됐다.
- 해결법:
  - `_limits`, `_registry`, `_store`, `_payment-store`를 모두 비공개 Blob 계약으로 통일하고 비공개 `get(..., { useCache:false })`으로 암호문을 읽는다.
  - 이용권이 비활성일 때 목표가격 입력을 `disabled`, `required:false`로 만들고 프로모션 입력의 Enter를 전용 핸들러에서 처리한다.
  - 신규 기기의 GET은 임시 빈 레코드로 `200`을 반환하되 저장하거나 등록 슬롯을 소비하지 않는다.
- 관련 파일:
  - `api/price-alerts/_limits.js`
  - `api/price-alerts/_registry.js`
  - `api/price-alerts/_store.js`
  - `api/price-alerts/_payment-store.js`
  - `api/price-alerts/alerts.js`
  - `public/js/alerts.js`

