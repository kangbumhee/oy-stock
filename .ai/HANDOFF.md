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

### 마지막 작업

- 날짜: 2026-08-27
- 내용: 검색 503을 Cloud Run 단일 실행·대기열 제한과 자원 설정으로 안정화하고, 60분 가격 변동 Web Push 알림을 추가했다. 상품과 `goodsNo::optionNumber` 옵션을 각각 추적하며 상승·하락을 모두 알리고, 목표가 하향 돌파는 같은 하락 알림에 합친다. 알림 등록은 30,000원/30일 단건 이용권 또는 HMAC 검증 평생 프로모션 권한으로 제한한다. PortOne V2 카카오페이 결제 코드는 구현했지만, 사업자 표시·환불 조건과 운영 PortOne 설정이 아직 없으므로 실제 결제만 fail-closed 상태로 배포했다.
- 브랜치: `main`
- 운영 소스 커밋: `55c51277df7fefa444f3c1729ce7cc196a720903`
- 최근 운영 배포: Vercel `dpl_44wUcsNZ9x5VG5aZhRLXV3QfMadG` (`READY`, `olivestock.co.kr`), Cloud Run `oy-stock-api-00178-nrz`(트래픽 100%, 4Gi/1 CPU/concurrency 4/timeout 240초)
- 작업한 파일:
  - `api/price-alerts/*`
  - `public/js/alerts.js`, `public/js/storage.js`, `public/sw.js`
  - `public/payment-info.html`, `public/privacy.html`
  - `server/server.mjs`, `server/official-search.mjs`
  - `tests/price-alerts*.test.js`, `tests/e2e-price-alerts.py`, `server/*.test.mjs`
  - `vercel.json`, `.github/workflows/deploy-server.yml`, `.gcloudignore`
  - `.env.example`
  - `.ai/API_SPEC.md`, `.ai/DB_SCHEMA.md`, `.ai/DEPLOY.md`, `.ai/TROUBLESHOOTING.md`, `.ai/HANDOFF.md`

### 다음 작업

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

- [x] `npm.cmd run test:price-alerts` → 64/64
- [x] `npm.cmd run test:server` → 30/30
- [x] Playwright E2E → 결제 8경로, 프로모션, 옵션 2개 시나리오 통과(실결제·PortOne 네트워크 호출 없음)
- [x] `npm audit --omit=dev` → 취약점 0
- [x] 운영 검색: `어노브` → HTTP 200, `complete=true`, 22/22
- [x] 운영 옵션: `A000000180872` → 옵션 `001`, `003`, 가격 양수
- [x] 운영 알림 설정: 60분, 기기당 10개, 프로모션 활성, 실제 결제 비활성
- [x] 운영 Cron: `/api/price-alerts/hourly` → `7 * * * *`, 무인증 요청 401
- [x] 운영 인증: `/api/oliveyoung/landing-proxy?check=1` → `jwtValid=true`
- [x] Cloud Run `/api/prices` 무인증 요청 → 401

## 변경 이력

| 날짜 | 작업 내용 | 변경 파일 |
|---|---|---|
| 2026-08-27 | 검색 503 안정화, 옵션별 60분 가격 변동 알림, 30일 이용권·평생 프로모션, 운영 배포 | `server/*`, `api/price-alerts/*`, `public/*`, `tests/*`, 배포·문서 설정 |
| 2026-04-22 | AI 인수인계 문서 세트 추가 | `CLAUDE.md`, `.ai/*`, `.env.example` |
| 2026-04-22 | 큐레이터 토큰 후보 자동 선택, 무수익 링크 생성 차단, 배포 완료 | `.github/workflows/*`, `api/oliveyoung/landing-proxy.js`, `public/js/ui.js`, `scripts/*` |
| 2026-04-22 | `refresh-oy-cookie.mjs` HIL 쿠키 갱신, lib 분리 | `scripts/refresh-oy-cookie.mjs`, `scripts/lib/*`, `CLAUDE.md`, `.ai/DEPLOY.md`, `.env.example` |

