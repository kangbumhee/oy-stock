# 인증 전파 복구 (2026-09-07)

## 원인과 동작

- 로컬 갱신이 `deployVercel=false`로 실행되어 Vercel 환경변수만 수정하고 실제 배포에는 적용되지 않았다.
- Deploy Hook을 켜도 프로젝트의 Ignored Build Step(`exit 0`) 때문에 Git 빌드가 취소됐다.
- 현재 운영 도메인 `olivestock.co.kr`의 배포 ID를 확인하고 Vercel API로 같은 버전을 새 환경변수와 함께 재배포한다. `main`을 새로 배포하지 않으므로 최근 수동 배포 기능을 덮어쓰지 않는다.
- `deployVercel` 기본값은 true이며 로컬 갱신도 명시적으로 true를 전달한다. false는 환경변수만 수정하는 수동 유지보수 용도로 남긴다.
- 갱신 워크플로는 직렬화한다. Cloud Run 갱신 후 운영 사이트의 JWT 만료시각이 전달한 토큰 이상인지 최대 12분 확인한다. 로컬 갱신도 같은 확인을 마쳐야 성공한다.
- 로컬 로그인은 정상인데 서버 JWT만 만료됐으면 재로그인 알림으로 분류하지 않는다. 3회 연속 확인 실패 시 기존 장애 알림을 보낸다.
- 로그인/구매 알림은 SMTP 전송 성공 시 정상 완료한다. 의도적으로 실패시키던 마지막 단계를 제거하여 `Run failed` 중복 이메일을 만들지 않는다. 실제 SMTP 실패는 계속 실패로 남는다.

## 수동 복구

`node scripts/refresh-oy-cookie-from-profile.mjs --publish-only`

현재 프로필을 검증하고 쿠키를 GitHub에 전파한 뒤 배포/운영 인증 반영을 기다린다. 로그인 제출이나 쿠키 재발급을 하지 않는다. 만료된 프로필은 먼저 사용자가 로그인해야 한다. `--check-only`는 계속 조회 전용이다.

예약 실행 파일은 원래 작업 폴더에서 동작한다. 수정 버전을 해당 폴더에도 반영해야 한다. PC가 꺼졌거나 추가 본인인증이 필요한 경우 자동 갱신 성공을 보장할 수 없다.

## 검증

- `node --test tests/oy-publication.test.js tests/oy-vercel-redeploy.test.js tests/oy-login-health.test.js`
- 운영 `landing-proxy?check=1` JWT 만료시각 확인 후 상품에 대한 실제 POST가 `affiliateActivityId`를 반환하는지 확인한다.
- Vercel Ready/운영 도메인 할당과 Cloud Run 검색 준비 상태를 확인한다.
