# DB 스키마

## 사용 DB

- 관계형 DB: 없음
- 상태 저장소: Vercel Blob
- ORM: 없음

재고·큐레이터 공개 데이터는 정적 JSON 파일과 GitHub Actions 커밋을 사용한다. 가격 알림의 기기·이용권·결제 의도·작업 인덱스는 Vercel Blob에 AES-256-GCM 암호문으로 저장한다.

## Vercel Blob 가격 알림 상태

기본 루트는 `oliveyoung/price-alerts/v1/<namespace>/`이며 운영 namespace는 `production`이다. 공개 Blob URL에는 평문 JSON을 저장하지 않는다.

### 기기 레코드

- 경로: `devices/<HMAC(deviceId)>/device.enc`
- 식별: 브라우저가 보관한 `deviceId`와 `deviceSecret`; 서버에는 secret hash만 저장한다.
- 주요 상태: Push 구독, 상품·옵션별 `alerts[]`, 마지막 평가가격, 암호화된 알림 outbox, 이용권 grant, pending payment, revision, 활동·삭제 시각.
- 알림 키: 상품은 `goodsNo`, 옵션은 `goodsNo::optionNumber`.
- 동시성: 고정 경로 Blob의 ETag 조건부 쓰기와 최대 8회 충돌 재시도를 사용한다.

### 결제 의도

- 경로: `payments/<HMAC(paymentId)>.enc`
- 주요 상태: 소유 deviceId, 30,000원/30일 고정 계약, PortOne 사전등록·권위 조회 결과, 상태 전이, 취소·검토 상태, revision.
- 규칙: 클라이언트 결과나 웹훅 본문만으로 grant를 만들지 않고 PortOne GET 검증이 일치할 때만 기기 레코드에 권한을 부여한다.

### 기기 인덱스와 요청률 카운터

- 경로: `indexes/<kind>/<shard>/<HMAC(deviceId)>.idx`
- 용도: 등록 기기, 활성 기기, 시간당 작업 대상과 결제 중 좌석 예약을 제한한다.
- 기본 상한: 등록 5,000개, 활성 20개, 기기당 알림 10개.
- 요청률 카운터도 원 IP가 아닌 익명화된 네트워크 대역·호스트 HMAC 키로 Blob에 저장하고 저장소 오류 시 fail-closed 처리한다.

## 데이터 파일 정의

### `public/data/stock-detail.json`

용도: 수집된 상품별 재고 상세 데이터.

```json
{
  "updatedAt": "ISO timestamp",
  "summary": {},
  "products": {
    "A000000000000": {
      "goodsNo": "A000000000000",
      "goodsName": "상품명",
      "thumbnail": "image-url",
      "price": 0,
      "originalPrice": 0,
      "discountRate": 0,
      "statusLabel": "재고 상태",
      "options": [],
      "stores": []
    }
  }
}
```

### `public/data/history.json`

용도: 재고 변화 이력.

```json
{
  "updatedAt": "ISO timestamp",
  "items": []
}
```

### `public/data/curator-links.json`

용도: 큐레이터 수익 링크 캐시.

```json
{
  "updatedAt": "ISO timestamp",
  "links": {
    "A000000000000": {
      "shortenedUrl": "https://oy.run/...",
      "originalUrl": "https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?...&utm_content=OY_activity-id",
      "affiliateActivityId": "activity-id",
      "affiliatePartnerId": "partner-id",
      "generatedAt": "ISO timestamp"
    }
  }
}
```

필수 규칙:

- `originalUrl`에 `utm_content=OY_<affiliateActivityId>`가 있어야 수익 링크로 간주한다.
- `shortenedUrl`만 보고 수익 링크라고 판단하지 않는다.
- `generatedAt`이 오래됐거나 landing 실패가 반복되면 쿠키/JWT 상태를 점검한다.

### `scripts/watchlist.json`

용도: 재고 수집 대상 상품 목록.

```json
[
  {
    "goodsNo": "A000000000000",
    "keyword": "검색어",
    "enabled": true
  }
]
```

## 관계도

```text
watchlist goodsNo -> stock-detail.products[goodsNo]
stock-detail.products[goodsNo] -> curator-links.links[goodsNo]
history items -> stock-detail products/options/stores 변경 기록
```

## 권한 정책

- Secret은 GitHub Secrets/Vercel Environment Variables에 저장한다.
- `public/data/*.json`은 공개 정적 파일로 배포된다. 민감정보를 넣지 않는다.
- Vercel Blob은 `access: public`이어도 가격 알림 상태를 `PRICE_ALERT_DATA_KEY`로 암호화한 값만 저장한다.
- `PRICE_ALERT_DATA_KEY`를 분실·교체하면 기존 기기·이용권·결제 의도 레코드를 복호화할 수 없으므로 무계획 회전하지 않는다.
- 쿠키/JWT/토큰은 `public/` 아래에 저장하지 않는다.

