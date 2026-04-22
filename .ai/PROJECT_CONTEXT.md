# 프로젝트 컨텍스트

## 프로젝트 목적

- 한 줄 설명: 올리브영 상품의 매장/온라인 재고를 확인하고, 큐레이터 수익 링크로 구매 이동을 돕는 웹앱.

## 기술 스택

- 프론트: HTML, CSS, Vanilla JavaScript
- 백엔드: Vercel Node Serverless Functions
- 자동화: GitHub Actions, Playwright
- 실시간 서버: Google Cloud Run Node.js
- DB: 없음, JSON 파일 기반
- 배포: Vercel, Cloud Run

## 주요 기능

- 상품 검색
- 매장/온라인 재고 확인
- 옵션별 재고 상세
- 즐겨찾기
- 재고 결과 이미지 공유
- 올리브영 바로구매 링크 생성
- 큐레이터 수익 링크 캐시 및 자동 갱신
- linkageString/JWT 만료 점검 및 Vercel env 갱신

## TODO

### 긴급

- [ ] `OY_REFRESH_COOKIE` 만료 전 알림이 정상 수신되는지 확인
- [ ] `OliveYoung Stock` workflow에서 `Generate curator links`가 landing 성공으로 끝나는지 확인

### 다음

- [ ] 자동 로그인 쿠키 갱신을 구현할 경우 human-in-the-loop 설계 문서 작성
- [ ] `api/favorites/sync.js` 상세 API 명세 보강
- [ ] `api/kakao/geo.js` 상세 Query/Response 문서화

### 나중에

- [ ] 공개 설정값을 `public/js/config.js` 하드코딩 대신 빌드/런타임 설정으로 정리
- [ ] API 공통 에러 포맷 정리
- [ ] 큐레이터 링크 유효성 점검용 별도 관리 화면 검토

## 외부 서비스 연동 현황

| 서비스 | 상태 | 비고 |
|---|---|---|
| 올리브영 Web/Mobile API | 사용 중 | 검색, 재고, 옵션, 큐레이터 landing, shorten |
| Vercel | 사용 중 | 정적 웹, Serverless API, env |
| GitHub Actions | 사용 중 | 재고 수집, 링크 생성, env 갱신 |
| Google Cloud Run | 사용 중 | 실시간 재고 서버 |
| Kakao API | 사용 중 | 주소/좌표 변환 |
| Gmail SMTP | 선택 | linkage 만료/실패 알림 |

## 최근 핵심 변경

- 2026-04-22: 큐레이터 인증 후보 자동 선택 추가.
- 2026-04-22: `affiliateActivityId` 없을 때 `utm_content` 없는 shorten 링크 생성 차단.
- 2026-04-22: AI 인수인계 문서 세트 추가.

