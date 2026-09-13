# 배포 설정

## 2026-09-13 일반 매장 재고 조회 복구

- `server/server.mjs`, `server/stock-request-runner.mjs` 변경은 main push의 `deploy-server.yml`로 Cloud Run에 반영한다. UI/app/config/SW 변경도 Vercel production 사전 빌드·검증·promote가 필요하다. 한쪽 배포만으로 완료 처리하지 않는다.
- 새 환경변수/Secret/유료 권한 변경 없음. 인스턴스별 매장 요청 동시성1, 시작 간격1000ms, 큐20개/대기12초, 정상 응답3분 캐시를 고정 적용한다. 이전 `STOCK_STORE_BATCH_CONCURRENCY` 값은 더 이상 동시성을 높이지 않는다. 기존 인스턴스 수·CPU/메모리 설정은 유지한다.
- 최종 정적 버전 `20260913-stock-recovery-2`(config/ui/app/hidden-stock 및 SW). 팝업 중 배경 온라인 수집 일시정지·온라인 메타 캐시 재사용, 배경 배치1개/1초, 전국 재고 선조회 제거. 매장 조회 실패는 지속 안내와 대기 후 수동 재조회로 표시한다. 추가 요청에 따라 온라인 품절 옵션의 유료 근처 조회 진입을 별도 제공한다.
- 출시 전 Node 회귀와 `tests/stock-detail-browser.py`의390/1440 모의 검증, 출시 후 실제 에스네이처 `A000000263782`/투슬래시포 `A000000227778` 조회를 별도로 확인한다. 모의 재고 수량을 운영 재고 증거로 사용하지 않는다. 배포 식별자·최종 실측은 HANDOFF에 기록한다.

2026-09-07 인증 전파 변경: [인증 전파 복구](../docs/auth-publication-recovery.md).
쿠키 갱신은 현재 운영 배포를 Vercel API로 재배포하며, Deploy Hook을 사용하지 않는다.
`deployVercel` 기본값 true. 실제 서버에 새 JWT가 적용되어야 성공한다.
로그인/구매 알림은 전송 성공 시 성공으로 종료하며 의도적인 실패 알림은 생성하지 않는다.

## 플랫폼

- 프론트/Serverless API: Vercel
- 정적 데이터: `public/data/*.json`, Vercel static route
- 실시간 재고 서버: Google Cloud Run (`server/`)
- 자동 수집/갱신: GitHub Actions
- 사용자 가격 알림 상태: 기존 Vercel 비공개 Blob 저장소. 기기·인덱스·요청률 카운터·결제의도는 모두 `access:'private'`로 읽고 쓰며 AES-256-GCM 암호문만 저장한다. 고정 기기 레코드의 ETag 조건부 쓰기와 충돌 재시도로 동시 갱신을 직렬화한다.

## 배포 트리거

### Vercel

- `vercel.json`의 Git 자동 배포는 현재 비활성화다. 새 코드 반영은 `.github/workflows/deploy-vercel.yml` 수동 실행 등 승인된 production 빌드 경로로 수행한다. 인증 갱신용 기존 배포 재생성만으로 새 기능 소스가 반영되었다고 판단하지 않는다.
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

### 로컬 - 24시간 자동 로그인/갱신 및 재연결 메일 (2026-09-06)

- 실행 PC: Windows 로그인 계정, 설치된 Chrome/Node.js, 기존 `gh auth login` 권한이 필요하다. Windows 자동 로그인이나 OS 비밀번호 저장은 설정하지 않는다.
- 최초 1회 `npm.cmd run setup:oy-login-secrets`: ID/비밀번호/선택 2Captcha API 키와 유료 API 사용 여부를 저장한다. `.auth/oy-login-secrets.json`에는 현재 Windows 사용자 DPAPI 암호문만 기록한다. GitHub에 계정 비밀번호/API 키를 올리지 않는다.
- 명령 입력 없이 실행하려면 `scripts/oy-login-settings.cmd`를 연다. 설정창은 최초 저장할 때만 필요하며, 저장 성공 후 등록된 갱신 작업을 즉시 한 번 시작한다.
- `npm.cmd run status:oy-login-secrets`는 설정 여부만 출력한다. `npm.cmd run install:oy-login-task`로 현재 저장소에 작업을 등록한다.
- `OY Refresh Cookie Daily`: PC 현지 시각 매일 00:10 (24시간 주기), Windows 로그인 후 추가 시작. 창 없이 프로필 재사용/필요 시 자동 로그인 → GitHub `OY_REFRESH_COOKIE` 갱신 → 기존 `refresh-oy-linkage.yml` 실행. 정상 등록을 검증한 뒤 기존 4시간 작업은 삭제하지 않고 비활성화한다.
- 다음 24시간 안에 만료될 linkage는 해당 쿠키만 재발급하고 만료시각 증가를 확인한다. 서버가 짧은 유효기간만 발급하거나 재발급이 실패하면 24시간 유지가 보장되지는 않으며, 실패 시 아직 유효한 이전 linkage를 복원하고 재연결을 알린다.
- `OY Login Health Every 15 Minutes`: 별도 상태 점검. 로그인 제출·유료 CAPTCHA·Secret 갱신은 하지 않는다. 명확한 연결 만료는 즉시, 네트워크/점검 오류는 연속 3회일 때 알린다. 다른 갱신/설정 작업 중이면 건너뛴다.
- `oy-login-alert.yml`을 기본 브랜치에 반영해야 메일이 동작한다. 기존 `ALERT_EMAIL_FROM/PASSWORD/TO`를 사용하며 연결 오류를 실패한 GitHub Action으로도 표시한다. 동일 장애는 복구가 확인될 때까지 한 번만 알리고, 전송 요청 실패 시 다음 점검에서 재시도한다.
- 발송 요청 접수와 메일 발송 성공은 구분한다. 다음 점검에서 실제 메일 단계 성공을 확인하며, 메일 단계 실패는 같은 실행을 최대 3회까지 재시도한다. 완료 뒤 의도적으로 표시되는 Action 실패는 메일을 재발송하지 않는다.
- 재연결: 저장 정보/키 잔액을 확인하고 필요하면 설정 명령을 다시 실행한 뒤 `npm.cmd run refresh:oy-cookie:chrome`을 실행한다. 자동 실행에서 로그인 창을 띄우거나 사용자의 CAPTCHA 응답을 기다리지 않는다.
- 유료 CAPTCHA는 같은 도전 최대 3개/프로세스 최대 12개, 응답 적용과 로그인 성공은 별도 검증한다. 2FA/계정 잠금/서비스 장애/키 잔액 부족까지 365일 성공을 보장하지 않는다.
- 테스트: `npm.cmd run test:oy-login`. `--check-only`는 읽기 전용이고 `--no-dispatch`는 워크플로만 생략한다(Secret 갱신은 수행하므로 완전한 dry-run이 아니다).
- PC가 꺼져 있거나 Windows에 로그인하지 않으면 로컬 점검/메일 요청도 실행되지 않는다. 로그는 `.ai/logs/`, 알림 상태는 `.auth/`에만 저장한다.

### 로컬 - 기존 수동 로그인 도구 (명시적 실행만)

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

## 숨겨진 옵션·전국 매장 조회 배포 준비 (2026-09-13)

- 상태: 운영 배포 진행 중. 이 절차 자체는 배포 완료·정기 수집 활성화·전체 카탈로그 인덱싱 완료를 뜻하지 않는다. 실제 완료 ID와 확인 결과는 `HANDOFF.md`에 별도로 남긴다.
- Vercel에 `HIDDEN_STOCK_SERVICE_SECRET`와 기존 가격알림 권한 저장소 설정이 필요하다. 선택 `HIDDEN_STOCK_SERVICE_URL`은 기본 Cloud Run origin `https://oy-stock-api-3596046881.asia-northeast3.run.app`; HTTPS `*.run.app` origin만 허용하며 path/query를 넣지 않는다.
- Cloud Run에 동일한 별도 `HIDDEN_STOCK_SERVICE_SECRET`(난수32~256 printable 문자), 비공개 Blob용 `HIDDEN_STOCK_BLOB_TOKEN`을 설정한다. Blob token 미설정 시 `BLOB_READ_WRITE_TOKEN`을 사용한다. `HIDDEN_STOCK_INDEX_NAMESPACE`는 기본 `production`, preview에는 별도 값을 쓴다. 비밀값은 공개 파일·명령 출력·로그에 남기지 않는다.
- 기존 Cron/가격조회 secret과 분리한다. 이 변경은 실결제 승인·결제금액·기존 이용권 데이터·로그인 자동화를 바꾸지 않는다.
- 배포 승인 후 Cloud Run 내부 서비스→Vercel gateway/프런트 순으로 반영한다. Vercel은 `api/oliveyoung/hidden-stock.js` 명시적 build/route, 최대60초; gateway 업스트림 제한45초. 운영은 현재 도메인이 가리키는 최신 소스·배포 경계를 확인하고 별도로 검증한다.
- Cloud Run은 프로젝트 **루트 Dockerfile**을 사용한다. 기존 `server/Dockerfile` 단독 빌드는 새 서버 모듈과 `@vercel/blob`를 포함하지 못한다. 비공개 v2 인덱스는64개 상품 분할과 별도 수집 진행정보를 사용해 전체 카탈로그를 상품마다 재작성하지 않는다.
- 검증: 무인증 내부 서비스401, 무인증/만료권 gateway401/402, 유효권 search/options/stores, cursor 변조 거부, 일반 옵션 전체 매장 연속 조회, 인증 상실 후 UI 데이터 삭제, CDN/서비스워커 캐시 금지. 응답 실패/부분 결과를 품절로 표시하지 않는다.
- 매장 연속 조회는 사용자 시작 후 한 번에 한 요청, 약300ms 간격, 활성화당 최대60회다. 일시정지/닫기/인증상실/오류 시 추가 요청을 중단하고 남은 cursor가 있으면 이어서 조회하도록 표시한다. 검색은 수동 페이지 진행을 유지한다.
- 쉬운 수동/정기 수집: GitHub Actions **Collect Hidden OliveYoung Options**(`.github/workflows/hidden-stock-collect.yml`)에서 **Run workflow**를 누른다. 기본100단계/최대8분, 매시17분 예약, 중복 실행 방지, 중단 위치 재개를 사용한다. 운영자에게 터미널 입력은 필수가 아니다. 상세 절차와 상태 해석은 [수집 안내](HIDDEN_STOCK_COLLECTION.md).
- 활성화 순서: Cloud Run/Vercel 반영 → 서비스 인증 `GET /api/hidden-stock?action=status` 확인 → GitHub Secret `HIDDEN_STOCK_SERVICE_SECRET` 및 선택 Variable `HIDDEN_STOCK_SERVICE_URL` 확인 → 저장소 Actions Variable `HIDDEN_STOCK_COLLECTION_ENABLED=true` 설정 → 수동1회와 후속 예약 실행 확인. 이 변수는 현재 수동/예약 모두를 제어한다. `.env`에만 넣어서는 켜지지 않는다. 별도 Codex/app 자동화는 만들지 않는다.
- 수집기는 한 번에 내부 `POST ?action=collect`만 순차 호출한다. Cloud Run 요청당 최대5단위/30초, 숨김 검색·전체 매장 조회 우선,150초 CAS lease; 카탈로그20개 열거→중복 제거 큐→관련 상품 큐 순서로 재개한다. 숨김/부분 상품 하루·일반 상품7일·카탈로그 열거 완료 후24시간 갱신 대상 정책이며, 처리 대기/차단 때문에 실제 완료는 늦어질 수 있다.
- CLI 선택 사용: 상태만 확인하려면 `node scripts/collect-hidden-stock.mjs --status`; 수집은 `node scripts/collect-hidden-stock.mjs --steps 100 --max-seconds 480 --delay-ms 1000`. 인증값은 환경변수로만 제공하며 인자·출력·문서에 복사하지 않는다.429/503/네트워크 오류 시 대기 또는 백오프한 실행을 전체 수집 성공으로 해석하지 않는다.
- 기존 백필은 고급 복구용이다: `node scripts/backfill-hidden-stock.mjs --steps 50 --delay-ms 1000`로 내부 `POST ?action=scan` 체크포인트를 재개한다. 명시적 `--refresh`는 기존 scan만 재시작하고 발견 상품 및 `scan.collection`의 정기 수집 대기열/진행정보는 보존한다. 일반 운영은 `collect`를 사용하며 고급 복구 작업을 정기 수집과 겹쳐 실행하지 않는다.
- 전체 상품명 열거를 끝내도 온라인 미노출 옵션이 공식 자료에 한 번도 남지 않았다면 발견을 보장할 수 없다. 인덱싱 진행률과 `coverage`를 표시하며 '모든 숨겨진 옵션 수집 완료'라고 보고하지 않는다.
- 매시 수집은 모든 SKU의 매시간 최신화나 모든 매장의 재고 저장을 뜻하지 않는다. 매장 수량은 사용자가 전국 매장 조회를 요청할 때 확인한다. LLM API는 호출하지 않으며, Cloud Run·Blob 사용량 비용은 별도다.

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
| `HIDDEN_STOCK_SERVICE_SECRET` | Vercel env, Cloud Run env, GitHub Secret | 숨김 조회 gateway·정기 수집 전용 공유 Bearer; 기존 secret과 분리 | 암호학적 난수32~256문자 |
| `HIDDEN_STOCK_SERVICE_URL` | Vercel env / 운영 CLI env / GitHub Variable, 선택 | 숨김 서비스 HTTPS Cloud Run origin, path/query 없음 | 기본 canonical Cloud Run origin |
| `HIDDEN_STOCK_BLOB_TOKEN` | Cloud Run env, 배포용 GitHub Secret | 비공개 숨김 인덱스 저장소; 없으면 `BLOB_READ_WRITE_TOKEN` 사용 | 기존 PRIVATE Blob 연결 |
| `HIDDEN_STOCK_INDEX_NAMESPACE` | Cloud Run env, 선택 | production/preview 인덱스 격리 | 기본 `production` |
| `HIDDEN_STOCK_COLLECTION_ENABLED` | GitHub Actions repository Variable만 | `true`일 때 수동/정기 수집 job 실행; 설정만으로 코드가 배포되지는 않음 | 서비스 검증 후 활성화 |
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

