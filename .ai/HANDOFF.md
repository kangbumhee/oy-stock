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

- 날짜: 2026-07-08
- 내용: 큐레이터 링크 즉시 생성 장애 점검. Vercel Deploy Hook 배포가 Ignored Build Step(`exit 0`) 때문에 `CANCELED`되어 최신 `OY_REFRESH_COOKIE`가 운영 함수에 반영되지 않았고, Cloud Run 빠른 생성 서버도 오래된 쿠키로 `missing_or_expired_curator_auth`를 반환했다. 운영은 깨끗한 `origin/main` worktree에서 direct production deploy 후 Cloud Run env를 수동 갱신해 복구했고, `refresh-oy-linkage.yml`이 이후 Vercel direct deploy와 Cloud Run env update를 같이 수행하도록 변경했다.
- 브랜치: `main`
- 최근 운영 배포: Vercel `dpl_F9fTNYKdpjJA5FWndL6QCQw7C72y` (`900763e5`, direct deploy, READY), Cloud Run `oy-stock-api-00073-cvs`
- 작업한 파일:
  - `.github/workflows/refresh-oy-linkage.yml`
  - `scripts/refresh-oy-linkage.mjs`
  - `.env.example`
  - `.ai/DEPLOY.md`
  - `.ai/TROUBLESHOOTING.md`
  - `.ai/HANDOFF.md`

### 다음 작업

- `refresh-oy-linkage.yml` 수동 실행 후 Vercel direct deploy와 Cloud Run env update가 둘 다 성공하는지 GitHub Actions 로그로 재확인한다.
- `curator-redirect`의 `cloudrun_fallback_shortened` 링크는 `affiliateActivityId`가 없으므로 실제 수익 반영 여부를 올리브영 큐레이터 대시보드에서 별도 검증한다.
- `public/js/config.js`의 하드코딩된 공개 설정을 장기적으로 환경 기반 설정으로 정리할지 검토한다.

### 주의사항

- `api/oliveyoung/search.js`, `public/js/api.js`에 문서 작업 전부터 있던 미커밋 변경이 있다. 관련 요청이 없으면 건드리지 않는다.
- 큐레이터 링크에서 `affiliateActivityId`가 없으면 수익 링크로 간주하면 안 된다.
- `utm_content=OY_<affiliateActivityId>` 없는 `oy.run` 링크를 만들면 안 된다.
- 올리브영 로그인 자동화는 정상 로그인과 사용자 인증 절차 안에서만 구현한다. CAPTCHA, 2FA, Cloudflare 우회는 금지한다.
- 쿠키, JWT, Vercel/GitHub 토큰은 로그에 원문을 남기지 않는다.
- Vercel 프로젝트의 Ignored Build Step이 `exit 0`으로 설정되어 있어 Git/Deploy Hook 기반 배포는 취소된다. env 반영이 필요한 운영 배포는 direct deploy 경로를 사용한다.

### 테스트 현황

- [x] `node --check api/oliveyoung/landing-proxy.js`
- [x] `node --check scripts/generate-curator-links.mjs`
- [x] `node --check scripts/refresh-oy-linkage.mjs`
- [x] `node --check scripts/refresh-oy-cookie.mjs`
- [x] `node --check public/js/ui.js`
- [x] 운영 점검: `https://oy-stock.vercel.app/api/oliveyoung/landing-proxy?check=1` → `jwtValid=true`
- [x] 운영 점검: `https://oy-stock-api-3596046881.asia-northeast3.run.app/health?curator=1` → `curator=true`

## 변경 이력

| 날짜 | 작업 내용 | 변경 파일 |
|---|---|---|
| 2026-04-22 | AI 인수인계 문서 세트 추가 | `CLAUDE.md`, `.ai/*`, `.env.example` |
| 2026-04-22 | 큐레이터 토큰 후보 자동 선택, 무수익 링크 생성 차단, 배포 완료 | `.github/workflows/*`, `api/oliveyoung/landing-proxy.js`, `public/js/ui.js`, `scripts/*` |
| 2026-04-22 | `refresh-oy-cookie.mjs` HIL 쿠키 갱신, lib 분리 | `scripts/refresh-oy-cookie.mjs`, `scripts/lib/*`, `CLAUDE.md`, `.ai/DEPLOY.md`, `.env.example` |

