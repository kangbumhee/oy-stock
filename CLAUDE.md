# OliveYoung Stock Checker

> 작업 시작 전 반드시 `.ai/HANDOFF.md`를 먼저 읽을 것.

## 기본 정보

- 언어/프레임워크: Vanilla JavaScript, Node.js Serverless Functions
- 패키지 매니저: npm
- Node 버전: 18 이상, GitHub Actions는 Node 20 사용
- 주요 실행 명령어:
  - 의존성 설치: `npm ci`
  - 문법 점검: `node --check <file>`
  - 재고 수집: `node scripts/detail-stock.mjs`
  - 큐레이터 링크 생성: `node scripts/generate-curator-links.mjs`
  - linkageString 갱신: `node scripts/refresh-oy-linkage.mjs`

## 프로젝트 구조

```text
api/
  favorites/          # 즐겨찾기 동기화 API
  kakao/              # 카카오 주소/좌표 API 프록시
  oliveyoung/         # 올리브영 검색, 재고, 옵션, 큐레이터 링크 API
public/
  css/                # 정적 스타일
  data/               # GitHub Actions가 갱신하는 JSON 데이터
  js/                 # 브라우저 앱 코드
scripts/              # Playwright 기반 재고/큐레이터/토큰 자동화
server/               # Cloud Run 실시간 재고 서버
.github/workflows/    # 재고 수집, linkage 갱신, Cloud Run 배포
.ai/                  # AI 전용 프로젝트 문서
```

## AI 문서 위치

- 모든 AI 관련 문서는 `.ai/` 폴더에 있다.
- 읽는 순서: `.ai/HANDOFF.md` -> `.ai/AGENTS.md` -> 필요한 문서.
- API 변경 시 `.ai/API_SPEC.md`를 갱신한다.
- 환경변수 또는 배포 방식 변경 시 `.env.example`과 `.ai/DEPLOY.md`를 갱신한다.
- 운영 장애나 해결책을 찾으면 `.ai/TROUBLESHOOTING.md`에 추가한다.

