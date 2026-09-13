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

### 마지막 작업 — 2026-09-13 옵션 무료 미리보기·재고 조회 결제·전국 수량순

- 사용자 요청: 결제 없이 숨겨진 옵션의 사진·상품명·옵션 내용을 보여주고, 근처 재고 버튼을 누를 때만 이용권 팝업을 연다. 전국 재고는 수량 많은 순, 근처는 거리순을 유지하며 검증 후 운영 배포를 요청받았다.
- gateway `search`/`options`는 기기 인증 없이 접근하되 공개 필드만 새 객체로 선별한다. 매장·수량·내부 증거·예상치 못한 추가 필드는 무료 응답에 포함하지 않는다. `stores`의 최신 서버 권한 확인·동일 출처·요청률 제한·서비스 Bearer·no-store는 유지한다. Cloud Run의 공식 재고 조회/수집 로직은 변경하지 않는다.
- 프런트는 공개 목록과 유료 재고의 수명을 분리한다. 무료 검색/옵션 팝업은 이용권 확인 성공을 기다리지 않으며, 결제 취소/권한 만료 때 사진과 설명을 남긴다. 유료 재고 요청/화면은 권한 상실 시 취소·제거하고 결제 성공 후 선택한 옵션 조회로 이어진다.
- 전국은 현재 수집된 결과를 매 페이지 병합할 때 수량 내림차순으로 재정렬하며 동률은 거리순, 수량 미확인은 마지막이다. 아직 읽지 못한 전국 결과까지 순위를 보장한다고 표시하지 않는다.
- `hidden-stock.js`/`alerts.js` 및 SW 캐시 버전 `20260913-hidden-preview-1`. 전체272개 Node 테스트 통과, Python Playwright360/390/1440폭에서 무료 사진·설명/클릭 결제/취소·승인 재개/10개씩 근처 조회/전국 수량순·동률 거리순/권한 만료 제거/초점 복귀 통과, 페이지 오류0. 실제 결제나 운영 권한 부여는 수행하지 않았다. Main이 최신 무료360·결제360·전국1440 스크린샷을 직접 검토했다.
- 소스 `133e194ede4b319343443f912ddd4429122dee47` main 반영. Vercel 사전 빌드의 변경 정적4파일/gateway가 검증 소스와 동일한 해시임을 확인했고 `dpl_7JwSSXwSk5ufz5FnsSg2DSqtJ2Wp` READY 후 promote했다. [배포 URL](https://oy-stock-m98fjtqhr-kbhs-projects-ee1427b6.vercel.app), [운영 alias](https://olivestock.co.kr) inspect와 실제 새 JS 버전 확인. Cloud Run 소스/배포는 변경하지 않았다.
- 운영 브라우저 확인(2026-09-13 13:47 KST): 무료 `메디큐브` 검색에서4개 옵션명/설명 및4개 실제1000px 이미지 로딩, `근처 매장 재고 확인` 클릭 시 `매장 재고 · 가격 알림 이용권` 팝업, 닫은 후4개 공개 카드 유지/매장 행0 확인. 무인증 전국 stores 직접 요청401 `device_auth_required`/`private, no-store, max-age=0`/stores 없음 확인. 결제·프로모션 제출이나 실제 유료계정 재고 조회는 이번 검증에 포함하지 않는다.

### 후속 작업 — 2026-09-13 숨김 옵션 이미지·근처 우선 팝업

- 사용자 요청: 숨김 옵션 이미지, 기존 재고 팝업과 같은 근처 우선 조회, 맨 아래 전국 재고 버튼. 검증 후 운영 배포를 명시적으로 승인받았다.
- 옵션 목록/선택 팝업에 공식 `image`를 표시하며 유효하지 않거나 깨진 이미지는 안내 문구로 대체한다. 상품 대표 이미지가 포함될 수 있어 실제 옵션 구성과 다를 수 있다는 설명을 표시한다.
- 숨김 옵션 클릭은 `App.lat/lng/locationName`의 선택 지역 근처부터 조회한다. 처음10매장, 더 보기로10개씩 표시하며 받은 결과를 모두 펼치기 전에는 추가 통신하지 않는다. 하단 전국 버튼을 눌러야 새 범위/커서로 전국 연속 조회한다. 목록/근처 화면 복귀, 기존 상품 팝업 보존, 페이지 갱신 시 스크롤/초점 보존을 추가했다.
- 실제 김포 기준 근처 요청200/150매장/거리순 확인, 요청 SKU 사진1000x1000 로딩 확인. 후속 전국 요청에서 부분 재수집이 기존 SKU를 null로 덮어써404가 된 기존 병합 결함을 발견해 보완했다. 상충 없는 불완전 관찰만 기존 검증 식별자를 stale로 보존하고, SKU 연결과 온라인 노출 분류를 구분한다.
- 유료 gateway의 stores에 scope/lat/lng를 추가했다. 공식 distance(km)로 정렬하고 거리 미확인/수량 미확인/재고0을 구분한다. scope/좌표는 커서 서명에 결합하며 기존 scope 없는 전국 조회는 호환한다. 유료권한·비공개 저장 정책 유지.
- Node259개 테스트 및 Python Playwright360/390/1440폭 모의 브라우저 검증 통과. 실제 이미지 디코딩/대체 표시/10개씩 펼치기/명시적 전국 조회/중복 제거/복귀/권한 해제 검증, 페이지 오류0. 저장한 스크린샷 직접 확인.
- 배포 소스 `3d337cc9592d475f6e1a4b7ddc0a39dca2e4fb42` 및 보완 `d528b570dab83205286c2ede1740d7cddefae52b`를 main에 반영했다. Cloud Run [실행34737383668](https://github.com/kangbumhee/oy-stock/actions/runs/34737383668) 성공, `oy-stock-api-00245-jcn` ready/트래픽100% 확인.
- 운영 프런트는 Vercel `dpl_Cgz3wugZSkyfAm8Mv3mVQBUX8XkE` READY를 검증 후 promote했다. [배포 URL](https://oy-stock-6t1oxc2kb-kbhs-projects-ee1427b6.vercel.app), [운영 alias](https://olivestock.co.kr) 연결을 inspect로 확인하고 실제 브라우저에서 JS/CSS `20260913-hidden-nearby-2` 로딩을 확인했다.
- 보완본 실제 재검증(2026-09-13 13:20~13:21 KST): 동일 SKU 근처200/150매장 및 전국200/첫150매장, 둘 다 이미지·거리순·후속 커서 확인. 이번 후속 검증은 전국 페이지를 끝까지 재수집한 것이 아니다. 부분 재수집으로 이미 지워졌던 식별자는 공식 자체 재조회에서 회복됐으며 수동 인덱스 편집은 하지 않았다. 검토했던 관련 root fallback은 저장 증거가 없어 배포하지 않았다.
- 공개 gateway는 실제 브라우저에서 무인증401/`private, no-store, max-age=0`/옵션·매장 자료 없음 확인. 최종 소스 전체 회귀259/259 재통과. 이전 배포/전국 매장 수는 아래 초기 배포 시점 기록이다.

### 마지막 작업 — 2026-09-13 숨겨진 옵션·전체 매장 조회 및 정기 수집

- 작업 위치: `C:\Projects\oy-hidden-offline-20260913`, 기반 `origin/main` `053ffb91`. 원래 dirty workspace는 변경하지 않는다.
- 구현: 유료 gateway search/options/stores, 서비스 Bearer 전용 Cloud Run 발견·매장 cursor API, 비공개 Blob 옵션 인덱스/백필 체크포인트, 검색 결과·상품 팝업 유료 UI와 결제·프로모션 이용권 재사용.
- 공개 옵션과 과거 리뷰의 공식 SKU 연결로 숨겨진 옵션을 찾고, 실제 매장 수량은 별도 조회한다. 프런트에 제품별 SKU를 하드코딩하거나 `public/data`·브라우저 저장소·서비스워커에 유료 자료를 저장하지 않는다.
- 검증 상세와 재현 방법: [HIDDEN_STOCK_ACCEPTANCE.md](HIDDEN_STOCK_ACCEPTANCE.md). 기존 검색·가격알림·수집기·서버를 포함한239개 Node 테스트 통과. Python Playwright390/1440폭 재실행 통과, 페이지 오류0, 스크린샷 직접 검토. 유료/평생권 화면은 모의 API 검증이며 실제 결제를 실행한 것은 아니다.
- 운영 프런트: Vercel `dpl_8faSNYwFf92KaGWUJ9Jg22UzBw5m` READY, [배포 URL](https://oy-stock-7nrlkesu2-kbhs-projects-ee1427b6.vercel.app), [운영 alias](https://olivestock.co.kr) 연결과 소스 `89acaad6` 확인. 공개 gateway 무인증401·`private, no-store`·옵션 자료 없음, 무료 이용권 안내/모달 확인.
- 운영 백엔드: 최종 수정 `6e90591355dd49ef8d07a80e547fd166330d1946` 반영. [Cloud Run 배포 실행34734380525](https://github.com/kangbumhee/oy-stock/actions/runs/34734380525)가3분21초에 성공했으며 `oy-stock-api-00243-lw4` ready/트래픽100%를 확인했다.
- 운영 연결 검증: 공식 모바일 비서명 컨텍스트, 비공개 Blob `Accept-Encoding:identity`의 strong ETag 및304 누락 태그 보존을 반영했다. 실제 읽기와 같은 내용 조건부 쓰기(CAS) 확인. 큐레이터 JWT 확인은 유효, 관찰된 만료시각 `2026-09-13T15:10:13Z`이며 이후 세션 상태는 다시 확인한다.
- 공식 매장 API 실조회에서 `충북`4개 대 `충청북도`34개 등 지역 약칭 누락을 발견하여 충청/경상은 전체 도명을 사용했다. 전북/전남 주소는 기존 `전라북도`/`전라남도` 검색이0건이므로 검증된 짧은 표기를 유지한다. 각 지역은 짧은 결과나 `totalCount`가 아니라 빈 페이지까지 순회한다.
- 운영 발견: 요청한 `A000000255680`/`8800289469145` 옵션을 실제 서비스에서 찾았다. `한교동` 검색은13개 숨김 옵션을 반환했지만 `coverage`는 부분 상태다. 모든 숨김 옵션이나 모든 실물 재고 발견 완료가 아니다.
- 대상 SKU 전국 검증:17개 지역의 공식 공개 페이지를18회 연속 조회해 `public_pages_exhausted`/`complete=true`를 확인했다. 중복 제거1,343매장, 양수 재고147매장, 수량 미확인0매장이다. 해당 SKU의 조회 시점 결과이며 전체 상품이나 모든 물리적 재고를 검증했다는 의미가 아니다.
- 저장소는 비공개v2 64분할+별도scan이며 상품/매장 조회는 대상 분할만 읽는다. `scan.collection` CAS lease/중복 제거 큐/주기별 재조회가 연결되었고, GitHub Variable `HIDDEN_STOCK_COLLECTION_ENABLED=true`를 확인했다.
- 첫 수집: [수동5단계 실행34734224217](https://github.com/kangbumhee/oy-stock/actions/runs/34734224217)가1분19초 후 백오프 경고와 함께 종료되었다. 실행 종료는 인덱싱 완료가 아니다. 당시 상태는 알려진 상품101, 확인20, 숨김 옵션15, 대기81, 실패 상품3, 부분 상품1, 공식 카탈로그 총수21,591; `pausedUntil=2026-09-13T03:56:50.664Z`. 백오프 이후 후속 예약에서 재개하며, 이 수치는 당시 스냅샷이다.
- 정기 수집: GitHub Actions **Collect Hidden OliveYoung Options** 매시17분/수동 실행, 기본100단계·최대8분, 중단 위치 재개. PC/브라우저 상시 실행은 필요 없고 LLM API/앱 자동화는 사용하지 않는다.
- 운영 안내: [HIDDEN_STOCK_COLLECTION.md](HIDDEN_STOCK_COLLECTION.md). 일반 운영자는 GitHub Actions의 **Run workflow**를 사용하면 되며 터미널은 필수가 아니다. 매시 작업 실행과 모든 SKU 매시간 최신화는 다르다. 매장 수량은 고객 조회 요청 때 확인한다.
- 현재 경계: 초기 카탈로그 수집 및 업스트림 백오프 단계다. 최종 지역 종료조건 수정(`false`+빈 목록+총수0)의 Cloud Run 반영과 대상17지역 조회 확인은 완료했다. 배포 후 수집 상태 재조회에서도 기존101/20/15/81 및 백오프 체크포인트 보존을 확인했다. 전체 카탈로그 인덱싱·모든 SKU의 매시간 갱신·모든 매장 내부 옵션 발견을 보장하지 않는다.

### 다음 작업 — 숨겨진 옵션

- 백오프 이후 후속 매시17분 예약 실행에서 카탈로그/대기열이 재개되는지 확인한다. `node scripts/collect-hidden-stock.mjs --status`는 읽기 전용이다. 실패/부분/한도 상태를 완료로 변경하거나 상한을 무작정 올리지 않는다.
- 로컬 회귀는 `npm.cmd run test:hidden-stock`, `tests/hidden-stock-browser.py`로 재현한다. 실제 결제 및 운영 평생권 사용자 테스트는 이번 모의 UI 검증과 구분한다.
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

