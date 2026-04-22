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

