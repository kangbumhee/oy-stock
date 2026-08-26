# 배포 설정

## 플랫폼

- 프론트/Serverless API: Vercel
- 정적 데이터: `public/data/*.json`, Vercel static route
- 실시간 재고 서버: Google Cloud Run (`server/`)
- 자동 수집/갱신: GitHub Actions
- 사용자 가격 알림 상태: 기존 Vercel 비공개 Blob 저장소. 기기·인덱스·요청률 카운터·결제의도는 모두 `access:'private'`로 읽고 쓰며 AES-256-GCM 암호문만 저장한다. 고정 기기 레코드의 ETag 조건부 쓰기와 충돌 재시도로 동시 갱신을 직렬화한다.

## 배포 트리거

### Vercel

- `main` 브랜치 푸시 시 자동 배포.
- `vercel.json`에서 `public/**`와 `api/**/*.js`를 빌드한다.
- 배포 확인:
  - GitHub commit status의 `Vercel`
  - `https://oy-stock.vercel.app/api/oliveyoung/landing-proxy?check=1`
- 가격 알림 Cron: `/api/price-alerts/hourly`, `7 * * * *`(매시 7분, 60분 주기). 인기상품 Cron과 겹치지 않게 분리한다.
- 가격 알림 배포에는 아래 `PRICE_ALERT_*`, `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`이 배포 대상 환경에 먼저 있어야 한다.

### GitHub Actions - OliveYoung Stock

- 파일: `.github/workflows/stock.yml`
- 실행:
  - 수동: `workflow_dispatch`
  - 스케줄: UTC `0 0-14 * * *`
- 작업:
  - `npm ci`
  - `npx playwright install chromium --with-deps`
  - `node scripts/detail-stock.mjs`
  - `node scripts/generate-curator-links.mjs`
  - 변경된 `public/data/` 커밋 및 푸시

### GitHub Actions - Refresh OliveYoung linkageString

- 파일: `.github/workflows/refresh-oy-linkage.yml`
- 실행:
  - 수동: `workflow_dispatch`
  - 스케줄: UTC `0 15 * * *`
- 작업:
  - 쿠키에서 `linkageString` 추출
  - AES 복호화 후 JWT 만료 확인
  - Vercel `OLIVEYOUNG_LINKAGE_STRING` 갱신
  - Vercel direct production deploy로 새 환경변수 반영
  - Cloud Run `OY_REFRESH_COOKIE` / `OLIVEYOUNG_LINKAGE_STRING` 갱신

### 로컬 - Playwright로 OY_REFRESH_COOKIE 갱신 (Human-in-the-Loop)

- 파일: `scripts/refresh-oy-cookie.mjs`
- 용도: 모바일 로그인 페이지에서 ID/PW 입력 후, CAPTCHA·2FA 등은 사용자가 브라우저에서 직접 처리. 우회 자동화 없음.
- 실행: `npx playwright install chromium` 후 `node scripts/refresh-oy-cookie.mjs`
- 필요 환경변수: `OY_USERNAME`, `OY_PASSWORD`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `GITHUB_REPO`(또는 `GITHUB_REPOSITORY`, `gh secret set`용), 선택 `VERCEL_TEAM_ID`, `VERCEL_DEPLOY_HOOK`, `OY_REFRESH_COOKIE`(기존 만료 비교)
- GitHub-hosted Actions에서는 디스플레이·사람 개입이 불가하므로 **로컬 또는 self-hosted**에서만 사용한다.

### Cloud Run

- 파일: `.github/workflows/deploy-server.yml`
- 트리거:
  - `server/**` 변경 후 `main` 푸시
  - 수동 실행
- 서비스: `oy-stock-api`
- 리전: `asia-northeast3`
- 운영 안정성 기준: memory `4Gi`, concurrency `4`, max instances `3`, timeout `240s`.
- `/api/prices`는 Vercel과 공유하는 별도 `PRICE_ALERT_SERVICE_SECRET`으로만 인증한다. `CRON_SECRET`을 재사용하지 않는다.

## 환경변수 전체 목록

| 변수명 | 위치 | 설명 | 발급/설정 위치 |
|---|---|---|---|
| `OY_USERNAME` | 로컬 `.env` 권장 | `refresh-oy-cookie.mjs` 로그인 ID | 직접 설정 |
| `OY_PASSWORD` | 로컬 `.env` 권장 | `refresh-oy-cookie.mjs` 로그인 비밀번호 | 직접 설정 |
| `OY_REFRESH_COOKIE` | GitHub Secrets | 최신 올리브영 쿠키 전체. `linkageString` 포함 권장 | 브라우저 DevTools |
| `OY_CURATOR_COOKIE` | GitHub Secrets, 선택 | 큐레이터 페이지용 쿠키 후보 | 브라우저 DevTools |
| `OY_SESSION_ID` | GitHub Secrets, 선택 | `OYSESSIONID` 단독 보관 시 사용 | 브라우저 쿠키 |
| `OY_LINKAGE_STRING` | GitHub Secrets, 선택 | `linkageString` 단독 보관 시 사용 | 브라우저 쿠키 |
| `OY_LINKAGE_JWT` | GitHub Secrets, 선택 | 복호화된 JWT 직접 후보 | 내부 점검용 |
| `OLIVEYOUNG_LINKAGE_STRING` | Vercel env, GitHub Secrets 선택 | Serverless API가 사용하는 linkageString | GitHub Action 또는 Vercel |
| `OLIVEYOUNG_LINKAGE_JWT` | Vercel env, 선택 | Serverless API가 직접 사용하는 JWT | Vercel |
| `OLIVEYOUNG_AFFILIATE_REGISTER_ID` | GitHub Secrets, 선택 | 큐레이터 파트너 ID | 올리브영 큐레이터 |
| `VERCEL_TOKEN` | GitHub Secrets | Vercel env PATCH용 토큰 | Vercel Account Tokens |
| `VERCEL_PROJECT_ID` | GitHub Secrets | Vercel 프로젝트 ID | `.vercel/project.json` 또는 Vercel |
| `VERCEL_TEAM_ID` | GitHub Secrets, 선택 | 팀 프로젝트 ID | `.vercel/project.json` |
| `VERCEL_DEPLOY_HOOK` | GitHub Secrets | env 갱신 후 재배포 트리거 | Vercel Deploy Hook |
| `SKIP_VERCEL_DEPLOY_HOOK` | GitHub Actions env | Deploy Hook 취소 방지용. refresh workflow는 direct deploy 사용 | `1` 권장 |
| `ALERT_EMAIL_FROM` | GitHub Secrets, 선택 | 알림 발신 Gmail | Gmail |
| `ALERT_EMAIL_PASSWORD` | GitHub Secrets, 선택 | Gmail 앱 비밀번호 | Google 계정 |
| `ALERT_EMAIL_TO` | GitHub Secrets, 선택 | 알림 수신 주소 | 직접 설정 |
| `GITHUB_TOKEN` | GitHub Actions 기본 | `public/data` 커밋 | GitHub Actions |
| `GCP_SA_KEY` | GitHub Secrets | Cloud Run 배포 권한 | Google Cloud IAM |
| `GCP_PROJECT_ID` | GitHub Secrets | GCP 프로젝트 ID | Google Cloud |
| `BLOB_READ_WRITE_TOKEN` | Vercel env | 암호화된 기기·구독·목표가·outbox·결제의도·이용권 저장 | Vercel Blob 연결 |
| `CRON_SECRET` | Vercel env | Vercel 가격 알림/인기상품 Cron 인증 | 임의 강력한 비밀값 |
| `PRICE_ALERT_DATA_KEY` | Vercel env | Blob 레코드 AES-256-GCM 암호화용 32바이트 base64 키 | 암호학적 난수 생성 |
| `PRICE_ALERT_STORE_NAMESPACE` | Vercel env, 선택 | 같은 Blob store의 production/preview 격리. 기본값은 `VERCEL_ENV` | 보통 미설정 |
| `PRICE_ALERT_SERVICE_SECRET` | Vercel env, Cloud Run env | Vercel Cron → Cloud Run `/api/prices` 전용 Bearer 인증 | 암호학적 난수 생성 |
| `PRICE_ALERT_PRICE_API_URL` | Vercel env | Cloud Run `/api/prices` HTTPS URL | Cloud Run 서비스 URL |
| `PRICE_ALERT_UPSTREAM_TIMEOUT_MS` | Vercel env, 선택 | 보수적 가격 배치 대기 제한. 기본 190초 | `190000` |
| `PRICE_ALERT_VAPID_SUBJECT` | Vercel env | Web Push VAPID 연락처/사이트 | `https://olivestock.co.kr` |
| `PRICE_ALERT_VAPID_PUBLIC_KEY` | Vercel env | 브라우저 Push 구독 공개키 | `web-push` 생성 |
| `PRICE_ALERT_VAPID_PRIVATE_KEY` | Vercel env | Web Push 서명 비밀키 | `web-push` 생성 |
| `PRICE_ALERT_CREATE_LIMIT` / `PRICE_ALERT_CREATE_WINDOW_SECONDS` | Vercel env, 선택 | IP 대역·호스트별 익명 기기 생성 제한 | 기본 `8` / `3600` |
| `PRICE_ALERT_MUTATION_LIMIT` / `PRICE_ALERT_MUTATION_WINDOW_SECONDS` | Vercel env, 선택 | IP 대역·호스트별 알림/구독 변경 제한 | 기본 `120` / `3600` |
| `PRICE_ALERT_MAX_REGISTERED_DEVICES` | Vercel env, 선택 | 등록 기기 hard cap | 기본 `5000` |
| `PRICE_ALERT_MAX_ACTIVE_DEVICES` | Vercel env, 선택 | 시간당 검사 대상 활성 기기 hard cap | 기본 `20` |
| `PRICE_ALERT_INACTIVE_TTL_DAYS` | Vercel env, 선택 | 알림이 없는 장기 비활성 익명 기기 보존일 | 기본 `30` |
| `PRICE_ALERT_MAINTENANCE_MAX_PER_RUN` | Vercel env, 선택 | 시간당 TTL 정리 최대 기기 수 | 기본 `100` |
| `PRICE_ALERT_TOMBSTONE_TTL_HOURS` | Vercel env, 선택 | 동시쓰기 안전 삭제 tombstone 보존시간 | 기본 `24` |
| `PRICE_ALERT_ENTITLEMENT_ENABLED` | Vercel env | 이용권 검사 fail-closed 스위치 | 모든 결제 설정 후 `true` |
| `PRICE_ALERT_PORTONE_STORE_ID` | Vercel env | PortOne V2 고정 Store ID | PortOne 콘솔 |
| `PRICE_ALERT_PORTONE_CHANNEL_KEY` | Vercel env | 카카오페이 LIVE 채널 키 | PortOne 콘솔 |
| `PRICE_ALERT_PORTONE_API_SECRET` | Vercel env | 사전등록·결제 GET 전용 서버 비밀값 | PortOne 콘솔 |
| `PRICE_ALERT_PORTONE_EXPECTED_CHANNEL_TYPE` | Vercel env, 선택 | 허용 채널 유형 | 기본 `LIVE` |
| `PRICE_ALERT_PORTONE_TIMEOUT_MS` | Vercel env, 선택 | PortOne 읽기 제한 | 기본 `65000`, 최소 60초 |
| `PRICE_ALERT_PUBLIC_SITE_URL` | Vercel env | 결제 완료 redirect HTTPS origin | `https://olivestock.co.kr` |
| `PRICE_ALERT_PROMO_CODE_DIGEST` | Vercel env | 평생 코드의 HMAC-SHA256 digest | 서버 밖에서 생성 |
| `PRICE_ALERT_PROMO_CODE_PEPPER` | Vercel env | 평생 코드 HMAC 서버 전용 pepper | 암호학적 난수 생성 |
| `PRICE_ALERT_PAYMENT_WEBHOOK_LIMIT` / `PRICE_ALERT_PAYMENT_WEBHOOK_WINDOW_SECONDS` | Vercel env, 선택 | PortOne 웹훅 재시도용 별도 요청률 제한 | 기본 `600` / `3600` |

Cloud Run 가격 조회 기본값은 `PRICE_LOOKUP_CONCURRENCY=1`, `PRICE_LOOKUP_PACE_MS=1000`, `PRICE_LOOKUP_WINDOW_MAX=20`, `PRICE_LOOKUP_WINDOW_MS=60000`, `PRICE_LOOKUP_TOTAL_TIMEOUT_MS=180000`이다. 정상으로 열린 올리브영 상품 페이지 안에서 상품상세 API를 호출하며, 공개 표시가 `finalPrice`만 사용하고 조건부 `maxBenefitPrice`는 사용하지 않는다. 2026-08-26 로컬의 오래된 50상품 표본 1회에서 첫 25개 응답 뒤 나머지 25개가 HTTP 429였으므로 이 제한은 의도적으로 보수적이며, 같은 실서비스 배치 재검사는 하지 않았다.

PortOne 배포 순서는 Store/Channel/API secret/공개 URL/프로모션 digest·pepper를 먼저 설정하고 `/api/price-alerts/payment/webhook`을 웹훅 URL로 등록한 다음, 마지막에 `PRICE_ALERT_ENTITLEMENT_ENABLED=true`로 전환한다. 결제 상품은 30,000원 30일 단건 이용권뿐이며 빌링키·구독·자동갱신을 사용하지 않는다. 웹훅 본문은 조회 트리거일 뿐이고 실제 권한은 PortOne GET의 일치 검증 후에만 부여한다.

## 로컬 명령어

```bash
npm ci
node --check api/oliveyoung/landing-proxy.js
node --check scripts/generate-curator-links.mjs
node --check api/price-alerts/hourly.js
node --test tests/price-alerts*.test.js server/*.test.mjs
node scripts/detail-stock.mjs
node scripts/generate-curator-links.mjs
```

## 배포 시 주의사항

- Secret 값은 절대 커밋하지 않는다.
- `public/data/*.json`은 공개 파일이다.
- 큐레이터 링크 관련 배포 후 `landing-proxy?check=1`에서 `jwtValid`, `selectedSource`, `candidateSources`를 확인한다.
- Vercel env 변경 후 실제 적용에는 재배포가 필요하다.
- `PRICE_ALERT_DATA_KEY`를 잃거나 교체하면 기존 암호화 알림 레코드를 읽을 수 없다. 백업 없이 회전하지 않는다.
- 기존 Blob 연결이 비공개 저장소이므로 가격알림 모듈을 `access:'public'`으로 배포하면 프로모션 첫 단계의 요청률 카운터부터 `503 rate_limit_unavailable`로 중단된다. `_limits`, `_registry`, `_store`, `_payment-store`의 접근 유형을 모두 `private`로 유지한다.
- VAPID private key를 교체하면 기존 브라우저 구독이 더 이상 유효하지 않을 수 있으므로 재구독 안내가 필요하다.
- Blob MVP는 활성 기기 기본 20개, 기기당 상품·옵션 합계 10개 알림을 상한으로 둔다. Cron은 옵션 알림도 `goodsNo`로 중복 제거해 같은 상품을 한 번만 조회하므로 시간당 최악 200개 고유 상품이고, 옵션 비교 작업만 알림 수만큼 수행한다. 이 값을 올리기 전 Cloud Run/Vercel 최대 실행시간을 부하 검증해야 한다. 수천 활성 기기로 확장할 때는 Blob 인덱스 한도를 무작정 올리지 말고 트랜잭션·상품 역색인이 가능한 DB/queue로 이전한다.
- 결제 생성은 PortOne 사전등록보다 먼저 활성 인덱스 슬롯을 실제 예약한다. 동일 기기·동일 idempotency 재시도는 같은 예약을 사용하고, 의도 만료·비재시도 실패·abandoned·전액취소는 최신 device revision과 인덱스 revision을 대조해 안전하게 해제한다. PAID 권한이나 활성 알림 사용 중에는 슬롯을 유지한다. 여러 기기의 동시 예약은 초과 시 생성한 인덱스를 조건부 롤백해 상한을 넘기지 않지만, 활성 기기 수를 크게 늘릴 때는 목록 기반 Blob 인덱스 대신 트랜잭션 좌석 카운터가 있는 DB로 이전한다.
- PortOne `PARTIAL_CANCELLED`는 운영 검토 대상이더라도 사용을 계속 허용하지 않는다. 해당 paymentId grant를 즉시 revoke하고 취소 tombstone 및 빈 outbox 상태를 확인한 뒤, `review_required` 결제의도를 관리자가 검토한다.
- 결제 의도와 기기 권한은 모두 암호화 Blob에 저장하며 `PRICE_ALERT_DATA_KEY` 회전 시 함께 접근할 수 없게 된다. PortOne API secret, 프로모션 코드·pepper, Provider 원문을 로그나 클라이언트 응답에 넣지 않는다.
- 가격 알림 변경은 원 IP가 아닌 `/24` 또는 `/64` 대역과 요청 호스트의 HMAC만 CAS rate counter 경로에 사용한다. Blob 확인 실패 시 fail-closed `503`이 정상 안전동작이다.
- 배포 후 `/api/price-alerts/public-key`, 인증 없는 `/api/price-alerts/hourly`의 `401`, Cloud Run 인증 없는 `/api/prices`의 `401`을 확인한다. 실제 비밀값은 로그나 명령 출력에 남기지 않는다.
- GitHub Actions가 `public/data`를 자동 커밋하므로 로컬 `main`이 뒤처질 수 있다. 푸시 전 `git pull --rebase --autostash origin main`을 고려한다.

