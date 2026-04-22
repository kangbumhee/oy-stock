# API 명세서

## 인증

- 공개 웹 API 대부분은 별도 사용자 인증이 없다.
- 올리브영 큐레이터 API 호출은 서버 환경변수의 `linkageString` 또는 JWT를 사용한다.
- 민감값은 GitHub Secrets 또는 Vercel Environment Variables에만 저장한다.

## 엔드포인트 목록

### [GET] `/api/oliveyoung/search`

- 설명: 키워드 기반 올리브영 상품 검색 및 매장 재고 검색 프록시.
- 인증: 불필요
- Query:
  - `keyword`: 검색어
  - `lat`: 위도
  - `lng`: 경도
  - `size`: 결과 수
- Response: 업스트림 또는 로컬 캐시 기반 상품 목록.
- 주요 헤더:
  - `X-Cache`: `HIT`, `MISS`, `ERROR`
  - `X-Search-Source`: `products-primary`, `upstream`, `fallback-local`, `empty`
- 에러코드: `400`, `500`

### [GET] `/api/oliveyoung/inventory`

- 설명: 특정 키워드/위치 기반 매장 재고 조회 프록시.
- 인증: 불필요
- Query:
  - `keyword`
  - `lat`
  - `lng`
  - `size`
- Response: 올리브영 재고 API 응답.
- 에러코드: `400`, `500`

### [GET] `/api/oliveyoung/options`

- 설명: 상품 옵션 및 상세 정보 조회.
- 인증: 불필요
- Query:
  - `goodsNo`: 상품 번호
- Response: 옵션, 이미지, 가격 등 상품 상세 데이터.
- 에러코드: `400`, `502`, `500`

### [GET] `/api/oliveyoung/stock`

- 설명: 정적/폴백 재고 데이터 조회.
- 인증: 불필요
- Query:
  - `goodsNo`: 상품 번호
- Response: 상품 재고 요약.

### [GET] `/api/oliveyoung/curator-redirect`

- 설명: `public/data/curator-links.json`에 저장된 큐레이터 링크로 리다이렉트.
- 인증: 불필요
- Query:
  - `goodsNo`: 상품 번호
  - `format`: `json` 또는 `debug` 선택
- Response:
  - 기본: `302 Location`
  - `format=json`: `shortenedUrl`, `longUrl`, `redirectUrl`, `source`, `affiliateActivityId`
  - `format=debug`: 캐시 URL, 캐시 항목, 선택된 리다이렉트 정보
- 주의: 캐시가 없으면 기본 모바일 affiliate URL로 fallback 할 수 있으므로 수익 검증 시 `source`를 확인한다.

### [GET] `/api/oliveyoung/landing-proxy?check=1`

- 설명: 서버 환경의 큐레이터 JWT 후보 상태 점검.
- 인증: 불필요
- Response:

```json
{
  "jwtValid": true,
  "jwtExp": "2026-04-23T03:49:55Z",
  "jwtSource": "OLIVEYOUNG_LINKAGE_STRING",
  "selectedSource": "OLIVEYOUNG_LINKAGE_STRING",
  "candidateSources": ["OLIVEYOUNG_LINKAGE_STRING"],
  "sub": "kbhjang"
}
```

### [POST] `/api/oliveyoung/landing-proxy`

- 설명: 올리브영 큐레이터 landing API를 호출해 `affiliateActivityId`를 생성.
- 인증: 서버 환경변수 필요
- Request Body:

```json
{
  "goodsNo": "A000000207822",
  "categoryNumber": "1000001000000000000"
}
```

- Response:

```json
{
  "affiliateActivityId": "activity-id",
  "affiliatePartnerId": "partner-id"
}
```

- 에러/실패:
  - `400 invalid_goodsNo`
  - `503 missing_or_invalid_linkage`
  - `200 landing_failed` (올리브영 API가 HTTP 200으로 실패 본문을 줄 수 있음)

### [POST] `/api/oliveyoung/shorten-proxy`

- 설명: 모바일 상품 상세 URL을 `oy.run` 짧은 링크로 변환.
- 인증: 불필요
- Request Body:

```json
{
  "originalUrl": "https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A000000207822&utm_source=shutter&utm_medium=affiliate&utm_content=OY_activity-id",
  "registerId": "affiliate-partner-id"
}
```

- Response: 올리브영 shorten API 원본 응답.
- 주의: `originalUrl`은 `https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do`만 허용한다.

### [GET] `/api/favorites/sync`

- 설명: 즐겨찾기 데이터를 GitHub 저장소 기반으로 동기화.
- 인증: 구현 내부의 GitHub 토큰/저장소 설정 필요.
- Query/Response: 코드 확인 후 변경 시 문서 보강 필요.

### [GET] `/api/kakao/geo`

- 설명: 카카오 주소/좌표 변환 프록시.
- 인증: 서버 또는 클라이언트 설정의 카카오 REST 키 사용.
- Query: 주소 또는 좌표 관련 파라미터.

### [GET] `/api/proxy/*`

- 설명: legacy/general proxy.
- 인증: 불필요
- 주의: 새 기능은 가능하면 명시적 API 파일을 만든다.

