# HANDOFF - AI 인수인계 문서

## 규칙

### 세션 시작 시

1. 이 파일을 읽는다.
2. "현재 상태"를 확인하고 이해한 내용을 요약한다.
3. 필요한 문서를 추가로 읽는다.
4. 작업 전 기존 수정사항을 확인한다.
5. 사용자가 명시하지 않은 기존 변경은 되돌리지 않는다.

### 세션 종료 시

1. 아래 "현재 상태"를 최신으로 업데이트한다.
2. 변경사항에 따라 관련 문서도 업데이트한다.
   - API 변경: `API_SPEC.md`
   - 데이터 구조 변경: `DB_SCHEMA.md`
   - 환경변수 추가/변경: `.env.example`, `DEPLOY.md`
   - 에러 해결: `TROUBLESHOOTING.md`
   - 코딩/운영 규칙 변경: `AGENTS.md`
3. "다음 작업"에 이어서 할 내용을 명확히 적는다.
4. 배포했다면 커밋 SHA, 배포 상태, 확인 URL을 남긴다.

## 현재 상태

### 마지막 작업 — 2026-09-13 숨겨진 옵션·전체 매장 조회 및 정기 수집

- 작업 위치: `C:\Projects\oy-hidden-offline-20260913`, 기반 `origin/main` `053ffb91`. 원래 dirty workspace는 변경하지 않는다.
- 구현: 유료 gateway search/options/stores, 서비스 Bearer 전용 Cloud Run 발견·매장 cursor API, 비공개 Blob 옵션 인덱스/백필 체크포인트, 검색 결과·상품 팝업 유료 UI와 결제·프로모션 이용권 재사용.
- 공개 옵션과 과거 리뷰의 공식 SKU 연결로 숨겨진 옵션을 찾고, 실제 매장 수량은 별도 조회한다. 프런트에 제품별 SKU를 하드코딩하거나 `public/data`·브라우저 저장소·서비스워커에 유료 자료를 저장하지 않는다.
- 검증 범위: 숨김 기능 유닛·분할 저장·실제 로컬 HTTP CORS 통합 검증, Python Playwright로390/1440폭 실제 프런트에 모의 API를 연결한 무료/평생권/해제·결제 안내·전국 조회 흐름 통과. 스크린샷도 직접 확인했다. 운영 결제·비밀키·운영 저장소를 사용하지 않았으므로 실서비스 검증과는 구분한다.
- 검증 상세와 재현 방법: `.ai/HIDDEN_STOCK_ACCEPTANCE.md`. 기존 검색·가격알림을 포함한192개 테스트 통과, 브라우저2개 폭 통과.
- 공식 매장 API 실조회에서 `충북`4개 대 `충청북도`34개 등 지역 약칭 누락을 발견하여 충청/경상은 전체 도명을 사용했다. 전북/전남 주소는 기존 `전라북도`/`전라남도` 검색이0건이므로 검증된 짧은 표기를 유지한다. 각 지역은 짧은 결과나 `totalCount`가 아니라 빈 페이지까지 순회한다.
- 저장소는 비공개v2 64분할+별도scan으로 변경했다. 상품/매장 조회는 대상 분할만 읽는다. 전체 카탈로그 운영 수집은 아직 실행하지 않았다.
- 추가 작업: `scan.collection` 기반 CAS lease/중복 제거 큐와 주기별 재조사를 연결한다. 새 `scripts/collect-hidden-stock.mjs`, GitHub Actions **Collect Hidden OliveYoung Options**로 매시17분/수동 실행, 기본100단계·최대8분, 중단 위치 재개를 제공한다. LLM API/앱 자동화는 사용하지 않는다.
- 운영 안내: [HIDDEN_STOCK_COLLECTION.md](HIDDEN_STOCK_COLLECTION.md). 일반 운영자는 GitHub Actions의 **Run workflow**를 사용하면 되며 터미널은 필수가 아니다. 매시 작업 실행과 모든 SKU 매시간 최신화는 다르다. 매장 수량은 고객 조회 요청 때 확인한다.
- 현재 경계: 배포 담당자가 GitHub/Vercel 인증 설정을 반영하는 중이며 Cloud Run/Vercel 배포와 수집 활성화의 최종 검증·완료 ID는 아직 기록하지 않았다. 전체 카탈로그 인덱싱 완료로 보고하지 않는다.

### 다음 작업 — 숨겨진 옵션

- 운영 설정 후 실제 gateway/Cloud Run/비공개 Blob 연결을 검증한다. 로컬 모의 검증은 `npm.cmd run test:hidden-stock`, `tests/hidden-stock-browser.py`로 재현한다.
- `.env.example` 및 `DEPLOY.md`의 별도 service secret과 비공개 Blob 설정을 승인된 운영 환경에 적용한 뒤 Cloud Run/Vercel을 배포하고 실제 도메인을 확인한다.
- 서비스 인증 상태 확인 후 GitHub Variable `HIDDEN_STOCK_COLLECTION_ENABLED=true`로 켜고 수동1회·후속 예약 실행의 Summary/체크포인트를 검증한다. 현재 workflow는 수동 실행도 이 변수가 필요하다. 상태 CLI는 `node scripts/collect-hidden-stock.mjs --status`이며 읽기 전용이다.
- 배포 담당자가 Cloud Run revision, Vercel deployment/alias, 수집 workflow 실행 ID와 진행률을 이 절에 갱신한다. 기본 배포·새 수집 관리자 검증과 이전192개 테스트 기록을 구분한다. 전체 상품 열거와 모든 오프라인 옵션 발견은 다르다.
- 아래 2026-08-27 운영 상태는 과거 기록이다. 현재 결제/배포 상태로 재사용하지 않는다.

### 이전 운영 기록 (2026-08-27)

- 날짜: 2026-08-27
- 내용: 검색 503을 Cloud Run 단일 실행·대기열 제한과 자원 설정으로 안정화하고, 60분 가격 변동 Web Push 알림을 추가했다. 이어서 운영 비공개 Blob과 가격알림 코드의 `public` 접근 불일치로 발생한 프로모션 `503 rate_limit_unavailable`, 프로모션 Enter 입력의 숨은 `required targetPrice` 오류, 신규 기기 알림 목록 `401`을 수정했다. 알림 등록은 30,000원/30일 단건 이용권 또는 HMAC 검증 평생 프로모션 권한으로 제한한다. PortOne V2 카카오페이 결제 코드는 구현했지만, 사업자 표시·환불 조건과 이 서비스 전용 PortOne 설정이 아직 없으므로 실제 결제만 fail-closed 상태다.
- 브랜치: `main`
- 운영 소스 커밋: `7792f92d5918ea4a042abb70923cd47fe1b1fff1`
- 최근 운영 배포: Vercel `dpl_GHXPMkBBTnn48yfkr1da69thKunN` (`READY`, `olivestock.co.kr`), Cloud Run `oy-stock-api-00178-nrz`(트래픽 100%, 4Gi/1 CPU/concurrency 4/timeout 240초)
- 작업한 파일:
  - `api/price-alerts/*`
  - `public/js/alerts.js`, `public/js/storage.js`, `public/sw.js`
  - `public/payment-info.html`, `public/privacy.html`
  - `server/server.mjs`, `server/official-search.mjs`
  - `tests/price-alerts*.test.js`, `tests/e2e-price-alerts.py`, `server/*.test.mjs`
  - `vercel.json`, `.github/workflows/deploy-server.yml`, `.gcloudignore`
  - `.env.example`
  - `.ai/API_SPEC.md`, `.ai/DB_SCHEMA.md`, `.ai/DEPLOY.md`, `.ai/TROUBLESHOOTING.md`, `.ai/HANDOFF.md`

### 이전 기록의 다음 작업 (현재 상태 재확인 필요)

- 실제 카카오페이 결제 공개 전 상호·대표자·사업장 주소·고객센터 전화·사업자등록번호·통신판매업 신고번호와 구체적인 취소/환불 조건을 정책 페이지에 반영한다.
- 그다음 이 서비스 전용 PortOne V2 Store ID, LIVE 카카오페이 채널 키, API secret, 웹훅을 설정하고 `paymentAvailable=true`를 스모크 테스트한다. 다른 프로젝트의 결제 키를 그대로 복사하지 않는다.
- 첫 운영 가격 알림 Cron 실행 후 통계와 Push 전달 오류를 확인하되 수동 Cron 실행으로 기존 사용자의 알림을 임의 발송하지 않는다.
- 활성 기기 수를 기본 20개보다 크게 늘리기 전 목록형 Blob 인덱스를 트랜잭션 좌석 카운터가 있는 DB로 이전한다.

### 주의사항

- 실제 결제는 의도적으로 비활성이다. `PRICE_ALERT_PORTONE_*`가 모두 검증되고 법정 표시사항이 채워지기 전에는 활성화 완료라고 보고하지 않는다.
- 평생 프로모션 원문, PortOne 비밀값, 가격 서비스 Bearer, VAPID private key, Blob 암호화 키를 로그·문서·클라이언트에 남기지 않는다.
- 이용권은 익명 브라우저 기기 자격증명에 연결되므로 사이트 데이터를 삭제하거나 다른 브라우저를 쓰면 자동 복구되지 않는다.
- 운영 기본 제한은 기기당 알림 10개, 등록 기기 5,000개, 활성 기기 20개다.
- 큐레이터 링크에서 `affiliateActivityId`가 없으면 수익 링크로 간주하면 안 된다.
- `utm_content=OY_<affiliateActivityId>` 없는 `oy.run` 링크를 만들면 안 된다.
- 올리브영 로그인 자동화는 정상 로그인과 사용자 인증 절차 안에서만 구현한다. CAPTCHA, 2FA, Cloudflare 우회는 금지한다.
- 쿠키, JWT, Vercel/GitHub 토큰은 로그에 원문을 남기지 않는다.
- Vercel 프로젝트는 Git 배포가 비활성이고 커밋 작성자 팀 연결에 따라 CLI 배포도 `TEAM_ACCESS_REQUIRED`로 막힐 수 있다. 운영은 권한 있는 CLI 계정의 direct deploy를 사용하고 `READY`와 실제 도메인 별칭을 확인한다.

### 테스트 현황

- [x] `npm.cmd run test:price-alerts` → 66/66
- [x] `npm.cmd run test:server` → 30/30
- [x] Playwright E2E → 결제 8경로, 프로모션, 옵션 2개 시나리오 통과(실결제·PortOne 네트워크 호출 없음)
- [x] `npm audit --omit=dev` → 취약점 0
- [x] 운영 검색: `어노브` → HTTP 200, `complete=true`, 22/22
- [x] 운영 옵션: `A000000180872` → 옵션 `001`, `003`, 가격 양수
- [x] 운영 알림 설정: 60분, 기기당 10개, `promotionAvailable=true`, 신규 기기 목록 200, 잘못된 프로모션은 400, 실제 결제 비활성
- [x] 운영 Cron: `/api/price-alerts/hourly` → `7 * * * *`, 무인증 요청 401
- [x] 운영 인증: `/api/oliveyoung/landing-proxy?check=1` → `jwtValid=true`
- [x] Cloud Run `/api/prices` 무인증 요청 → 401

## 변경 이력

| 날짜 | 작업 내용 | 변경 파일 |
|---|---|---|
| 2026-09-13 | 유료 숨겨진 옵션·전체 매장 연속조회 구현, 비공개 인덱스/재개 백필 준비. 운영 배포·전체 인덱싱 미완료 | `api/oliveyoung/*hidden-stock*`, `server/hidden-*`, `public/*`, `tests/*hidden-stock*`, 배포 설정·문서 |
| 2026-08-27 | 프로모션 Blob 503·Enter 폼 검증·신규 기기 401 수정 및 운영 재배포 | `api/price-alerts/*`, `public/*`, `tests/*`, `.ai/*` |
| 2026-08-27 | 검색 503 안정화, 옵션별 60분 가격 변동 알림, 30일 이용권·평생 프로모션, 운영 배포 | `server/*`, `api/price-alerts/*`, `public/*`, `tests/*`, 배포·문서 설정 |
| 2026-04-22 | AI 인수인계 문서 세트 추가 | `CLAUDE.md`, `.ai/*`, `.env.example` |
| 2026-04-22 | 큐레이터 토큰 후보 자동 선택, 무수익 링크 생성 차단, 배포 완료 | `.github/workflows/*`, `api/oliveyoung/landing-proxy.js`, `public/js/ui.js`, `scripts/*` |
| 2026-04-22 | `refresh-oy-cookie.mjs` HIL 쿠키 갱신, lib 분리 | `scripts/refresh-oy-cookie.mjs`, `scripts/lib/*`, `CLAUDE.md`, `.ai/DEPLOY.md`, `.env.example` |

