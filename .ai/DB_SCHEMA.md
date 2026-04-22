# DB 스키마

## 사용 DB

- 종류: 없음
- 호스팅: 없음
- ORM: 없음

이 프로젝트는 데이터베이스 대신 정적 JSON 파일과 GitHub Actions 커밋을 사용한다.

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
- 쿠키/JWT/토큰은 `public/` 아래에 저장하지 않는다.

