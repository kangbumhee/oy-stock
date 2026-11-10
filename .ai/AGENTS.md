# AGENTS - 코딩 규칙 및 프로젝트 규칙

## 코딩 컨벤션

- 언어: JavaScript, Node.js CommonJS API 파일, ESM 스크립트 파일 혼용
- 네이밍: 변수/함수는 `camelCase`, 상수는 `UPPER_SNAKE_CASE`
- 파일 네이밍: 기존 파일명 유지, 새 API는 `kebab-case.js` 우선
- 들여쓰기: 스페이스 2칸
- 세미콜론: 사용
- 따옴표: 기존 파일 스타일을 따른다. 대부분 작은따옴표를 사용한다.

## 금지 사항

- 사용자가 만든 기존 변경사항을 임의로 되돌리지 않는다.
- 실제 Secret, 쿠키, JWT, 토큰 원문을 코드/문서/로그에 남기지 않는다.
- `affiliateActivityId` 없이 `utm_content` 없는 짧은 구매 링크를 만들지 않는다.
- 2FA·휴대폰 인증·계정 잠금 해제·구매 승인은 자동화하지 않는다. 2026-09-06 사용자 요청에 따른 본인 계정 로그인용 CAPTCHA API 연동만 `scripts/lib/oy-captcha-*`에서 허용한다. 현재 폼/도전 검증·유료 작업 한도·명시적 API 활성화를 유지하며 다른 서비스/구매 작업으로 확대하지 않는다.
- `public/data/*.json` 자동 수집 결과를 이유 없이 수동 편집하지 않는다.
- Vercel/GitHub/GCP 토큰을 클라이언트 코드에 넣지 않는다.

## 필수 사항

- 작업 전 `git status --short`로 워크트리를 확인한다.
- API 파일 수정 후 `node --check <file>`를 실행한다.
- 큐레이터 생성 기능은 2026-11-10 사용자 요청으로 제거됐다. 생성·자동 로그인·갱신 작업을 재도입하지 않는다. 일반 구매 버튼은 추적 없는 공식 상품 주소를 사용하고, 폐기된 생성 API의 410 응답을 확인한다.
- 환경변수 추가 시 `.env.example`과 `.ai/DEPLOY.md`를 함께 갱신한다.
- API 변경 시 `.ai/API_SPEC.md`를 갱신한다.

## 데이터 저장소 요약

이 프로젝트는 전통적인 DB를 사용하지 않는다. 정적 JSON 파일과 GitHub Actions 커밋을 데이터 저장소처럼 사용한다.

| 파일 | 용도 | 주요 필드 |
|---|---|---|
| `public/data/stock-detail.json` | 상품별 매장/온라인 재고 상세 | `updatedAt`, `products`, `goodsNo`, `options`, `stores` |
| `public/data/history.json` | 재고 변동 이력 | `updatedAt`, `items`, `changes` |
| `scripts/watchlist.json` | 수집 대상 상품 목록 | `goodsNo`, `keyword`, `enabled` |

## 핵심 비즈니스 흐름

### 재고 확인 흐름

사용자 검색 -> `/api/oliveyoung/search` -> 상품 목록 표시 -> 실시간/정적 재고 조회 -> 팝업 상세 표시 -> 즐겨찾기/공유/바로구매.

### 일반 구매 링크 흐름

바로구매 클릭 -> 상품번호로 공식 올리브영 상품 URL 생성 -> 새 탭 열기. 큐레이터 API·캐시·생성 대기열을 사용하지 않는다.

### 자동 운영 흐름

GitHub Actions `OliveYoung Stock` -> `detail-stock.mjs` 재고 수집 -> 재고·이력 JSON만 커밋. 큐레이터 생성·백필·로그인 감시·인증 갱신 워크플로는 제거됐다. Vercel 배포는 별도 운영 배포 작업이며 git 자동 배포는 비활성이다.

## 배포 체크리스트

- [ ] `git status --short`에서 의도한 파일만 변경됐는지 확인
- [ ] 문법 점검 통과
- [ ] Secret 원문이 diff에 포함되지 않았는지 확인
- [ ] `main` 푸시 후 Vercel 상태 성공 확인
- [ ] 폐기된 큐레이터 생성 API는 410, 일반 구매·검색·입장 잠금은 정상인지 확인

