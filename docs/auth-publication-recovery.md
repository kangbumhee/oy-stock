# 인증 전파 복구 (2026-10-27 갱신)

## 원인과 동작

- 로컬 갱신이 `deployVercel=false`로 실행되어 Vercel 환경변수만 수정하고 실제 배포에는 적용되지 않았다.
- Deploy Hook을 켜도 프로젝트의 Ignored Build Step(`exit 0`) 때문에 Git 빌드가 취소됐다.
- 현재 운영 주소 `oy-stock.vercel.app`의 배포 ID를 확인하고 Vercel API로 같은 버전을 새 환경변수와 함께 재배포한다. `main`을 새로 배포하지 않으므로 최근 수동 배포 기능을 덮어쓰지 않는다.
- `deployVercel` 기본값은 true이며 로컬 갱신도 명시적으로 true를 전달한다. false는 환경변수만 수정하는 수동 유지보수 용도로 남긴다.
- 갱신 워크플로는 직렬화한다. Cloud Run 갱신 후 운영 사이트의 JWT 만료시각과 SHA-256 인증 지문이 전달한 토큰과 정확히 일치하는지 최대 12분 확인한다.
- PC는 고유 요청 ID로 해당 GitHub 실행을 추적한다. GitHub 실행 대기는 갱신 실패가 아니다. `.auth/oy-auth-publication.json`에는 요청 ID, 실행 ID, 만료시각과 지문만 보관하며 쿠키·JWT 원문은 저장하지 않는다.
- 아직 실행 대기/진행 중이면 Node 종료 코드 `76`(`publication_pending`)을 반환한다. 예약 작업은 다음 15분 상태 검사에 확인을 넘기고 정상 종료하여 PC의 20분 실행 한도를 넘기지 않는다. 이 상태로 실패 메일을 보내거나 기존 장애를 정상 복구로 처리하지 않는다.
- 상태 검사는 기록된 실행의 성공과 정확한 운영 인증 일치를 모두 확인해야 대기 기록과 장애 상태를 해제한다. 다른 실행이나 여전히 유효한 이전 인증만으로는 해제하지 않는다. 실제 워크플로 실패·취소, 인증 만료 또는 90분 게시 지연은 장애로 알리고 중복 알림을 억제한다. 상태 검사는 새 배포·로그인·CAPTCHA·메일 테스트를 실행하지 않는다.
- 로컬 로그인은 정상인데 서버 JWT만 만료됐으면 재로그인 알림으로 분류하지 않는다. 3회 연속 확인 실패 시 기존 장애 알림을 보낸다.
- 로그인/구매 알림은 SMTP 전송 성공 시 정상 완료한다. 의도적으로 실패시키던 마지막 단계를 제거하여 `Run failed` 중복 이메일을 만들지 않는다. 실제 SMTP 실패는 계속 실패로 남는다.

## 수동 복구

`node scripts/refresh-oy-cookie-from-profile.mjs --publish-only`

현재 프로필을 검증하고 쿠키를 GitHub에 전파한 뒤 배포 요청을 추적한다. 코드 76이면 실패가 아니라 게시 확인 대기다. 로그인 제출이나 쿠키 재발급을 하지 않는다. 만료된 프로필은 먼저 사용자가 로그인해야 한다. `--check-only`는 계속 조회 전용이다.

예약 실행 파일은 원래 작업 폴더에서 동작한다. 수정 버전을 해당 폴더에도 반영해야 한다. PC가 꺼졌거나 추가 본인인증이 필요한 경우 자동 갱신 성공을 보장할 수 없다.

## 검증

- `node --test tests/oy-auth-publication-state.test.js tests/oy-publication-task.test.js tests/oy-publication.test.js tests/oy-vercel-redeploy.test.js tests/oy-login-health.test.js tests/oy-refresh-lock.test.js`
- 운영 `landing-proxy?check=1` JWT 만료시각 확인 후 상품에 대한 실제 POST가 `affiliateActivityId`를 반환하는지 확인한다.
- Vercel Ready/운영 도메인 할당과 Cloud Run 검색 준비 상태를 확인한다.
