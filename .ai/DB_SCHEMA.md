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

## 비공개 숨겨진 옵션 인덱스 (2026-09-13)

- 경로: `oliveyoung/hidden-stock/v2/<namespace>/shards/{00..3f}.json`(상품번호 해시64개) 및 별도 `scan.json`. `HIDDEN_STOCK_INDEX_NAMESPACE` 기본 `production`; preview는 반드시 별도 namespace를 쓴다. v1은 미배포 실험형이며 자동 마이그레이션하지 않는다.
- 저장: Cloud Run이 `HIDDEN_STOCK_BLOB_TOKEN`(미설정 시 `BLOB_READ_WRITE_TOKEN`)으로 `access:'private'` Blob JSON을 읽고 쓴다. 가격알림 암호문과 별도 구조이며, 리뷰 원문·작성자·계정·쿠키·이용권 비밀값은 저장하지 않는다.
- 분할 문서: `version:2`, `shard`, `products`, `updatedAt`. 수집 문서는 `version:2`, `scan`, `updatedAt`. 검색용 메모리 응답에서만 합쳐 읽는다.
- 상품별: `goodsNo`, `options[]`, `relatedGoodsNos`, `coverage`, `checkedAt`. 옵션은 공식 자료에서 연결된 `goodsNo`, `optionNumber`, `productId`, `name`, `goodsName`, `hidden`, 출처·확인시각을 보관한다. 부분 재조회는 기존 검증 식별자를 지우지 않고 `stale:true`로 표시한다.
- `identityVerifiedAt`은 SKU 연결을 실제로 확인한 시각이며 부분 재조회에서 갱신하지 않는다. 같은 옵션의 리뷰 응답이 실패해 SKU가 누락된 경우에만 이전 검증 SKU와 출처를 보존하고 `stale:true`로 표시한다. 신규 SKU 또는 상충하는 SKU 근거, 완전한 조사에 의한 제거는 이전 식별자로 되돌리지 않는다. 온라인/숨김 판정은 새 관찰값을 유지하므로 `hidden:null`일 수 있다. 재고 수량은 이 과거 식별자 시각과 별도로 실시간 확인한다.
- 재개 상태: `scan.page`, `offset`, `processed`, `seen`, `uniqueProducts`, `officialTotal`, `countMismatch`, `enumerationComplete`, `complete`, 실패 목록. 중복 상품을 총수로 세지 않고 고유 상품 수가 공식 총수보다 적으면 완료로 표시하지 않는다. 공개 상품 열거 완료와 모든 과거/매장 전용 SKU 발견 완료는 다르며 전체 카탈로그 완전성을 단정하지 않는다.
- 정기 수집 상태: `server/hidden-collection.mjs`가 같은 비공개 `scan.json`의 `scan.collection`(`version:1`)을 관리한다. `known[goodsNo]`는 `fingerprint`, `lastCheckedAt`, `nextCheckAt`, `attempts`, `partial`, `hiddenOptions`, `catalogCycle`; `queued[goodsNo]`는 `dueAt`, `reason`, `token`이다. 두 맵은 각각 최대50,000상품이며 상한 도달을 `capacityReached`로 표시한다.
- 수집 체크포인트: `catalog`에 `page`, `enumerationComplete`, `officialTotal`, `cycle`, `seen`, `lastPageKey`, `lastCompletedAt`, `refreshAt`, `attempts`; 최상위에 `processed`, `failed`, `consecutiveFailures`, `workSinceCatalog`, `lastRunAt`, `pausedUntil`, `pauseReason`, `lease:{owner,expiresAt}`를 둔다.150초 lease 획득·체크포인트·해제는 ETag CAS로 처리하고, 해당 lease가 소비한 큐 token만 제거한다. 중단 시 저장된 위치에서 재개하며 lease 소유권을 잃으면 체크포인트를 덮어쓰지 않는다.
- 갱신 정책: 공개 상품 목록을20개씩 열거하고, 백그라운드에서는 기준 상품만 먼저 조사한 뒤 발견한 관련 상품을 별도 큐에 넣는다. 숨김/부분 상품은 하루, 일반 상품은7일 경과 후 재조회 대상으로 삼고 카탈로그는 마지막 열거 완료24시간 후 다시 시작한다. 상품 메타데이터 변경은 먼저 재조회하며 가격/순위만 변경된 것은 fingerprint에 반영하지 않는다. 실제 갱신 완료 시점은 대기열·업스트림 상태에 따라 늦어질 수 있다. 이 상태는 매장별 실시간 수량 스냅샷이 아니다.
- 동시성/한도: 대상 분할 하나만 ETag CAS로 갱신하고 수집 진행정보는 별도 CAS 처리한다. 상품 저장 후 체크포인트 저장 전 중단되면 같은 상품을 재처리해도 안전하다. 읽기 캐시30초·ETag 재검증·동시 읽기8개, 분할당32MiB 상한. 상품/매장 조회는 `readProduct`를 사용해 전체 목록을 내려받지 않는다. 대규모 동시 사용자 부하 검증은 별도 필요하다.
- 매장 결과: 매장코드로 중복 제거하고 서명된 cursor로 이어서 조회한다. 실시간 수량·부분 조회 상태는 고객 응답이며 공개 캐시/서비스워커/브라우저 저장소에 남기지 않는다.

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

