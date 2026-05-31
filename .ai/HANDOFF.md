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

- 날짜: 2026-04-22
- 내용: `scripts/refresh-oy-cookie.mjs` 및 `scripts/lib/*` 추가 — Playwright headed 로그인 후 `OY_REFRESH_COOKIE`(gh)·`OLIVEYOUNG_LINKAGE_STRING`(Vercel API) 갱신, `landing-proxy?check=1` 폴링. `linkageString`은 hex(AES)이므로 만료 비교는 복호화 후 JWT `exp` 사용.
- 브랜치: `main`
- 최근 배포 커밋: `a7c1078` (`fix: auto-select valid OliveYoung curator token`)
- 작업한 파일:
  - `scripts/refresh-oy-cookie.mjs`
  - `scripts/lib/cookie-extractor.mjs`
  - `scripts/lib/secret-manager.mjs`
  - `scripts/lib/health-check.mjs`
  - `scripts/lib/notify.mjs`
  - `CLAUDE.md`
  - `.ai/DEPLOY.md`
  - `.env.example`

### 다음 작업

- `refresh-oy-cookie.mjs`는 로컬/self-hosted 전용으로 유지하고, GitHub-hosted 단독 워크플로에는 넣지 않는다.
- GitHub Secrets에 최신 `OY_REFRESH_COOKIE`가 유지되는지 주기적으로 확인한다.
- `public/js/config.js`의 하드코딩된 공개 설정을 장기적으로 환경 기반 설정으로 정리할지 검토한다.

### 주의사항

- `api/oliveyoung/search.js`, `public/js/api.js`에 문서 작업 전부터 있던 미커밋 변경이 있다. 관련 요청이 없으면 건드리지 않는다.
- 큐레이터 링크에서 `affiliateActivityId`가 없으면 수익 링크로 간주하면 안 된다.
- `utm_content=OY_<affiliateActivityId>` 없는 `oy.run` 링크를 만들면 안 된다.
- 올리브영 로그인 자동화는 정상 로그인과 사용자 인증 절차 안에서만 구현한다. CAPTCHA, 2FA, Cloudflare 우회는 금지한다.
- 쿠키, JWT, Vercel/GitHub 토큰은 로그에 원문을 남기지 않는다.

### 테스트 현황

- [x] `node --check api/oliveyoung/landing-proxy.js`
- [x] `node --check scripts/generate-curator-links.mjs`
- [x] `node --check scripts/refresh-oy-linkage.mjs`
- [x] `node --check scripts/refresh-oy-cookie.mjs`
- [x] `node --check public/js/ui.js`
- [x] 운영 점검: `https://oy-stock.vercel.app/api/oliveyoung/landing-proxy?check=1`

## 변경 이력

| 날짜 | 작업 내용 | 변경 파일 |
|---|---|---|
| 2026-04-22 | AI 인수인계 문서 세트 추가 | `CLAUDE.md`, `.ai/*`, `.env.example` |
| 2026-04-22 | 큐레이터 토큰 후보 자동 선택, 무수익 링크 생성 차단, 배포 완료 | `.github/workflows/*`, `api/oliveyoung/landing-proxy.js`, `public/js/ui.js`, `scripts/*` |
| 2026-04-22 | `refresh-oy-cookie.mjs` HIL 쿠키 갱신, lib 분리 | `scripts/refresh-oy-cookie.mjs`, `scripts/lib/*`, `CLAUDE.md`, `.ai/DEPLOY.md`, `.env.example` |

