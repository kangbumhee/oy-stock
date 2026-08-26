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
- Response: 상품 재고 요약. Cloud Run 실시간 응답의 각 `options[]`에는 기존 `name`, `productId`, 재고 필드와 함께 원본에 존재하는 경우 `optionNumber`(`itemNumber`), `priceToPay`, `originalPrice`, Boolean `soldOut`를 포함한다. 누락되거나 잘못된 선택 필드는 추정해 채우지 않는다.

### [POST] Cloud Run `/api/prices`

- 설명: 가격 알림 스케줄러 전용 공개 표시가 일괄 조회. 상품별 재고·쿠폰·회원가는 조회하지 않는다.
- 인증: `Authorization: Bearer <PRICE_ALERT_SERVICE_SECRET>` 필수.
- Request Body: `{"goodsNos":["A000000000001"]}`. 1~50개, 중복은 제거한다.
- 성공: `{"success":true,"complete":true,"count":1,"prices":[{"goodsNo":"A000000000001","priceToPay":12900,"originalPrice":15900,"options":[{"optionNumber":"100123","optionName":"01호","priceToPay":11900,"originalPrice":14900,"soldOut":false}]}]}`. 옵션이 없거나 상품상세 응답의 `options`가 없거나 `null`이면 `options:[]`이다.
- 실패 원자성: 한 상품이라도 누락·0원·조회 실패이면 HTTP `502`, `complete:false`, `failedGoodsNos`를 반환하며 Vercel 알림 상태는 갱신하지 않는다.
- 옵션 원자성: 상품상세 응답에 옵션 배열이 있으면 모든 행의 `optionNumber`, `optionName`, `finalPrice`, `salePrice`, Boolean `soldOut`가 유효하고 `optionNumber`가 중복되지 않아야 한다. 한 행이라도 잘못되면 해당 상품을 부분 응답하지 않고 전체 배치를 `502`로 실패시킨다.
- 가격 기준: 올리브영 상품상세 API의 공개 표시 판매가 `finalPrice`를 `priceToPay`로, 정상가 `salePrice`를 `originalPrice`로 반환한다. 상품과 옵션 모두 `maxBenefitPrice`와 쿠폰·회원등급·카드·앱·장바구니 할인은 포함하지 않는다.

### [GET] `/api/price-alerts/public-key`

- 설명: Web Push VAPID 공개키, 확인 주기(60분), 기기당 최대 알림 수(10개)를 반환한다.
- 인증: 불필요. 공개키만 반환하며 private key는 절대 노출하지 않는다.

### [POST, DELETE] `/api/price-alerts/subscription`

- 설명: 현재 브라우저의 Web Push 구독을 등록하거나 해제한다.
- 인증: `X-Price-Alert-Device-Id`, `X-Price-Alert-Device-Secret` 필수.
- POST Body: 브라우저 `PushSubscription.toJSON()` 결과 또는 `{ "subscription": ... }`.
- 보안: HTTPS 표준 포트의 Chrome/FCM, Firefox/Mozilla, Safari/Apple, Edge/WNS Push 서비스 endpoint만 허용한다. IP literal, localhost, 사용자정보 포함 URL, 비표준 포트, 임의 호스트는 거부한다.
- 저장: 기기 자격증명 해시와 구독 전체를 AES-256-GCM으로 암호화한 뒤 기존 Vercel 비공개 Blob 저장소에 저장한다.
- 동시성: 기기 레코드는 ETag 조건부 쓰기와 최신 상태 재적용으로 갱신해 Cron과 사용자 편집/삭제/구독 요청이 겹쳐도 변경을 잃지 않는다.
- 남용 방지: 동일 IP 대역·호스트의 생성/변경은 HMAC 처리된 Blob CAS 카운터로 제한한다. 초과 시 `429`, 저장소 확인 실패나 전체 기기 한도 초과 시 `503`과 `Retry-After`를 반환한다. 원 IP는 Blob에 저장하지 않는다.
- 이용권: POST 활성화는 유효한 가격알림 이용권이 필요하다. GET은 없고 DELETE 구독 해제는 이용권 만료 후에도 허용한다.

### [GET, POST, DELETE] `/api/price-alerts/alerts`

- 설명: 현재 브라우저의 상품 또는 옵션별 목표가격 알림을 조회·저장·삭제한다. 알림 식별자 `alertId`는 상품 알림이면 `goodsNo`, 옵션 알림이면 `goodsNo::optionNumber`이다.
- 인증: `X-Price-Alert-Device-Id`, `X-Price-Alert-Device-Secret` 필수.
- 최초 조회: 형식이 올바른 신규 기기는 서버 레코드를 만들거나 등록 슬롯을 소비하지 않고 `200`, 빈 `alerts`, `subscribed:false`를 반환한다. 이미 저장된 기기의 secret이 일치하지 않으면 `401 device_auth_failed`다.
- POST Body: `goodsNo`, `goodsName`, `imageUrl`, `targetPrice`와 옵션 알림일 때 `optionNumber`, `optionName`, 선택적 `legacyItemNumber`. 같은 상품의 옵션은 각각 독립적으로 upsert한다.
- DELETE Query: `goodsNo`와 옵션 알림일 때 `optionNumber`. 옵션이 없으면 상품 단위 알림만 삭제하며 같은 상품의 옵션 알림은 유지한다.
- 응답: 공개 알림과 가격변동 알림에는 `alertId`, `optionNumber`, `optionName`, `legacyItemNumber`가 포함된다. 상품 단위 알림의 옵션 필드는 `null` 또는 빈 문자열이다.
- 이용권: GET과 DELETE는 만료 후에도 허용하고, POST 등록·수정은 유효한 이용권이 없으면 `402 entitlement_required`로 거부한다.
- 제한: 기기당 활성 알림 10개. 상품 알림 1개와 옵션별 알림은 서로 다른 슬롯이다. Blob MVP는 활성 기기 기본 20개로 제한하며 첫 알림 슬롯이 없으면 `503 active_device_capacity_reached`와 `Retry-After`를 반환한다.

### [GET] `/api/price-alerts/entitlement`

- 설명: 현재 익명 기기의 이용권 활성 여부, 만료시각, 평생 프로모션 여부와 고정 요금제를 반환한다.
- 인증: `X-Price-Alert-Device-Id`, `X-Price-Alert-Device-Secret` 필수.
- 요금제: `30,000 KRW`, 30일, `autoRenew:false`. 정기결제·자동연장 상품이 아니다.
- 준비상태: 브라우저에는 비밀값이나 누락된 환경변수 이름 대신 `paymentAvailable`, `promotionAvailable` 불리언만 반환한다. `paymentAvailable`은 결제 설정과 현재 활성 기기 여유 슬롯을 함께 확인하며 Blob 확인 실패나 용량 초과 시 `false`다. 형식이 올바른 신규 기기 조회는 저장·등록 슬롯을 소비하지 않고 `active:false`를 반환한다.

### [POST] `/api/price-alerts/promotion`

- 설명: 재사용 가능한 평생 이용 프로모션 코드를 현재 기기에 적용한다.
- 인증/보안: 기기 인증과 same-origin 필수. Body는 `{"code":"..."}`. 코드는 서버 전용 pepper로 HMAC-SHA256 후 설정된 digest와 timing-safe 비교하며 원문을 저장·로그하지 않는다.
- 실패: 미설정·형식 오류·불일치 모두 `400 promotion_invalid`로 동일하게 반환한다. 요청률 제한을 적용한다.

### [POST] `/api/price-alerts/payment/create`

- 설명: 고정 30일 이용권의 PortOne V2 카카오페이 결제 의도를 만들고 PortOne 사전등록 완료 후 SDK `requestPayment` payload를 반환한다.
- 인증/입력: 기기 인증과 same-origin 필수. 클라이언트 Body는 강한 `idempotencyKey` 하나만 허용한다. 금액·통화·주문명·Store ID·Channel Key·채널 유형·결제수단·카카오페이는 서버가 고정한다.
- 저장: 결제 의도는 소유 기기, 예상 계약, 24시간 만료, 상태를 포함해 AES-256-GCM 암호화된 고정 Blob 경로에 ETag CAS로 저장한다. 기기당 활성 결제 의도는 하나이고 동일 키만 같은 결제 ID로 재시도할 수 있다.
- 결제 요청: 응답의 `requestPayment`는 `currency:"KRW"`, `payMethod:"EASY_PAY"`, 카카오페이, 고정 상품 1개, 고정 동일-origin `redirectUrl`과 `noticeUrls`를 포함한다. 평생 이용권 기기에는 결제의도를 만들지 않고 `409 lifetime_entitlement_active`를 반환한다.
- 용량보호: 결제의도를 저장하기 전에 활성 인덱스 슬롯을 CAS 방식으로 실제 예약한다. 같은 기기의 멱등 재시도는 같은 슬롯을 재사용하며, 슬롯이 가득 찼거나 Blob 확인이 실패하면 PortOne 사전등록 전에 `503`으로 중단한다. 예약은 의도 만료·비재시도 실패·`abandoned`·전액취소 때 조건부 해제되고, `PAID` 권한이나 활성 알림을 사용할 동안 유지된다.
- 감사기록: 결제의도 안에 공급자 원문·비밀값 없는 상태/사유/시각 감사 이벤트를 최대 50개 보존한다.
- 상품: `30,000원 / 30일 / 자동갱신 없음`. 구독·빌링키·정기결제 API를 호출하지 않는다.

### [POST] `/api/price-alerts/payment/complete`

- 설명: Body의 `paymentId`가 현재 기기 소유인지 먼저 확인하고 PortOne `GET /payments/{paymentId}`의 권위 응답으로만 이용권을 확정한다.
- 승인 조건: `PAID`, 30,000원, KRW, 설정된 Store/Channel, 기본 Channel Type `LIVE`, `EASY_PAY`, `KAKAOPAY`, 취소금액 0이 모두 정확히 일치해야 한다.
- 유효시각: 권한 시작은 reconcile 실행시각이 아니라 PortOne의 권위 `paidAt`이다. 로컬 의도가 뒤늦게 조회됐더라도 `paidAt`이 의도 생성~24시간 만료 안이면 승인할 수 있다.
- 취소/검토: 전액 `CANCELLED`는 해당 paymentId의 권한을 취소하고 남은 30일권을 원 결제시각 기준으로 다시 쌓는다. `PARTIAL_CANCELLED`는 결제 전·후 모두 즉시 해당 paymentId를 취소 tombstone 처리하고 이미 부여된 grant를 revoke하며 대기 Push를 비운 뒤 `review_required`로 운영 검토에 남긴다. 다른 계약 불일치도 `review_required`이며 새 권한을 부여하지 않는다.
- 멱등성: 기기 레코드 CAS에서 paymentId당 한 번만 30일을 부여하므로 complete와 webhook 동시 실행도 중복 연장하지 않는다.

### [POST] `/api/price-alerts/payment/webhook`

- 설명: PortOne 웹훅의 알려진 이벤트와 `paymentId`는 로컬 결제의도 조회를 시작하는 비신뢰 트리거로만 사용한다. 본문 상태·금액·판매자·결제수단은 권한 근거가 아니다.
- 검증: 로컬 결제의도가 있을 때만 서버 전용 `Authorization: PortOne <API secret>`으로 PortOne GET을 호출하고 위 complete와 동일한 판정을 적용한다. Provider 원문과 비밀값은 로그에 남기지 않는다.
- 남용방지: 웹훅 재시도를 수용하는 별도 고한도 rate limit을 적용하며, 형식이 잘못된 paymentId는 공급자 조회 없이 무시한다.

### [GET, POST] `/api/price-alerts/hourly`

- 설명: Vercel Cron이 매시 7분 호출하는 중앙 가격 확인·Web Push 작업(60분 주기).
- 인증: `Authorization: Bearer <CRON_SECRET>` 필수.
- 동작:
  - 암호화된 16-shard 활성 인덱스만 읽고 해당 기기의 최신 CAS 레코드를 확인한 뒤, 활성 알림을 `goodsNo`로 중복 제거해 Cloud Run `/api/prices`에 최대 50개씩 조회한다. 매 실행 전체 기기 Blob을 복호화하지 않는다.
  - 최초 유효 가격은 기준값으로만 저장하고 알리지 않는다.
  - 이후 `현재가 > 직전가`이면 상승, `현재가 < 직전가`이면 하락 알림을 보낸다.
  - 하락하면서 `직전가 > 목표가` 및 `현재가 <= 목표가`가 되면 같은 알림에 목표가 도달을 함께 표시한다.
  - 옵션 알림은 정확히 같은 `optionNumber`의 공개 표시가만 평가한다. 옵션 누락·품절·0원·형식 오류 시 그 옵션의 기준가와 확인시각을 바꾸지 않는다. 같은 상품의 다른 옵션과 대기 알림에도 영향을 주지 않는다.
  - 가격 0·누락·503·불완전 배치는 상태를 바꾸지 않는다.
  - 이용권이 만료되거나 없는 기기는 활성 인덱스에서 제거하되 저장된 알림은 삭제하지 않는다. 만료 뒤 대기 중인 Push도 전송하지 않으며, 새 이용권 부여 후 다시 활성화할 수 있다.
  - 일시적인 Push 실패는 암호화 outbox에 남겨 다음 실행에서 재시도하고, 404/410 구독은 비활성화한다.
  - 매시간 등록 인덱스 16개 shard 중 하나를 순환 점검한다. 빈·미구독 레코드는 즉시 tombstone 처리하고, 30일 비활성 레코드 및 2시간 지난 생성 예약 orphan을 정리하며, tombstone 본문은 기본 24시간 뒤 ETag 조건부 삭제한다.

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

