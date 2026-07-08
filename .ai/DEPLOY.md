# 배포 설정

## 플랫폼

- 프론트/Serverless API: Vercel
- 정적 데이터: `public/data/*.json`, Vercel static route
- 실시간 재고 서버: Google Cloud Run (`server/`)
- 자동 수집/갱신: GitHub Actions
- DB: 없음

## 배포 트리거

### Vercel

- `main` 브랜치 푸시 시 자동 배포.
- `vercel.json`에서 `public/**`와 `api/**/*.js`를 빌드한다.
- 배포 확인:
  - GitHub commit status의 `Vercel`
  - `https://oy-stock.vercel.app/api/oliveyoung/landing-proxy?check=1`

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

## 로컬 명령어

```bash
npm ci
node --check api/oliveyoung/landing-proxy.js
node --check scripts/generate-curator-links.mjs
node scripts/detail-stock.mjs
node scripts/generate-curator-links.mjs
```

## 배포 시 주의사항

- Secret 값은 절대 커밋하지 않는다.
- `public/data/*.json`은 공개 파일이다.
- 큐레이터 링크 관련 배포 후 `landing-proxy?check=1`에서 `jwtValid`, `selectedSource`, `candidateSources`를 확인한다.
- Vercel env 변경 후 실제 적용에는 재배포가 필요하다.
- GitHub Actions가 `public/data`를 자동 커밋하므로 로컬 `main`이 뒤처질 수 있다. 푸시 전 `git pull --rebase --autostash origin main`을 고려한다.

