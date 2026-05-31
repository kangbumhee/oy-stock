/**
 * 올리브영 쿠키 갱신 (Human-in-the-Loop)
 *
 * 핸드오프: CAPTCHA/2FA/Cloudflare 우회 금지, 토큰·쿠키 원문 로그 금지,
 * 배포 후 landing-proxy 검증 없이 링크 생성 로직을 가정하지 않음(이 스크립트는 링크를 만들지 않음).
 *
 * 로컬 또는 디스플레이 있는 self-hosted에서만 실사용 권장 (headless:false).
 *
 * 환경변수: OY_USERNAME, OY_PASSWORD, VERCEL_TOKEN, VERCEL_PROJECT_ID,
 *   선택 VERCEL_TEAM_ID, VERCEL_DEPLOY_HOOK, VERCEL_ENV_TARGETS,
 *   OY_REFRESH_COOKIE(기존 만료 비교용), GITHUB_REPO 또는 GITHUB_REPOSITORY(gh secret용),
 *   SLACK_WEBHOOK_URL, LANDING_PROXY_CHECK_URL
 */

import { chromium } from 'playwright';
import {
  readSecrets,
  updateGitHubSecret,
  updateVercelLinkageString
} from './lib/secret-manager.mjs';
import { extractCookies, jwtExpFromLinkageHex } from './lib/cookie-extractor.mjs';
import { verifyLandingProxy } from './lib/health-check.mjs';
import { sendNotification } from './lib/notify.mjs';

const LOGIN_URL = 'https://m.oliveyoung.co.kr/m/members/login.do';

const HUMAN_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTH_POLL_ATTEMPTS = 10;
const HEALTH_POLL_MS = 12000;

async function waitForLandingHealthy() {
  for (let i = 0; i < HEALTH_POLL_ATTEMPTS; i++) {
    const h = await verifyLandingProxy();
    if (h.ok) return h;
    console.log(`[INFO] landing-proxy 헬스체크 대기 ${i + 1}/${HEALTH_POLL_ATTEMPTS}…`);
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return verifyLandingProxy();
}

/**
 * @returns {Promise<'SUCCESS'|'NEED_HUMAN'|'BLOCKED'>}
 */
async function raceLoginResult(page) {
  const SUCCESS_PATTERNS = ['/main', '/mypage', '/m/main/main.do'];
  const CAPTCHA_SELECTORS = [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '#captchaLayer',
    '.captcha-wrap',
    'input[name="otpNumber"]',
    '.auth-additional',
    '[class*="verify"]'
  ].join(', ');
  const BLOCKED_PATTERNS = ['challenge-platform', 'cf-browser-verification'];

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    page
      .waitForURL(
        (url) => SUCCESS_PATTERNS.some((p) => url.href.includes(p)),
        { timeout: 15000 }
      )
      .then(() => done('SUCCESS'))
      .catch(() => {});

    (async () => {
      try {
        await page.waitForSelector(CAPTCHA_SELECTORS, { timeout: 15000 });
        done('NEED_HUMAN');
      } catch {
        /* continue */
      }
    })();

    (async () => {
      try {
        await page.waitForFunction(
          (patterns) =>
            patterns.some((p) => document.body?.innerHTML?.includes(p)),
          BLOCKED_PATTERNS,
          { timeout: 15000 }
        );
        done('BLOCKED');
      } catch {
        /* continue */
      }
    })();

    setTimeout(() => done('NEED_HUMAN'), 16000);
  });
}

async function main() {
  let browser;

  try {
    const secrets = await readSecrets();
    console.log('[INFO] 계정·기존 쿠키 메타 로드 완료 (원문 미출력)');

    browser = await chromium.launch({
      headless: false,
      slowMo: 300
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915 }
    });

    const page = await context.newPage();

    console.log('[INFO] 로그인 페이지 이동 중…');
    await page.goto(LOGIN_URL, { waitUntil: 'load' });

    await page.fill('input[name="loginId"], input#loginId', secrets.username);
    await page.fill('input[name="password"], input#password', secrets.password);
    console.log('[INFO] 계정 필드 입력 완료 (값 미출력)');

    await page.click('button[type="submit"], .btnLogin, #btnLogin');
    console.log('[INFO] 로그인 요청 전송');

    const loginResult = await raceLoginResult(page);

    if (loginResult === 'NEED_HUMAN') {
      console.log('[WARN] 추가 인증 가능성 — 브라우저에서 직접 완료해 주세요');
      await sendNotification({
        title: '올리브영 로그인 인증 필요',
        body: 'CAPTCHA·2FA 등 추가 단계가 있을 수 있습니다. 브라우저에서만 처리하세요.',
        urgency: 'high'
      });

      try {
        await page.waitForURL(
          (url) => url.href.includes('/main') || url.href.includes('/mypage'),
          { timeout: HUMAN_TIMEOUT_MS }
        );
        console.log('[INFO] 로그인 완료 URL 확인');
      } catch {
        console.error('[FAIL] 인증 대기 시간 초과');
        await sendNotification({
          title: '올리브영 쿠키 갱신 실패',
          body: '인증 대기 시간 초과. 수동으로 쿠키를 갱신해 주세요.',
          urgency: 'high'
        });
        return;
      }
    } else if (loginResult === 'BLOCKED') {
      console.error('[FAIL] 보안·챌린지 페이지 감지 — 자동 우회하지 않음');
      await sendNotification({
        title: '올리브영 보안 차단 감지',
        body: '우회 시도 없이 종료합니다. 네트워크·환경을 바꿔 수동 처리하세요.',
        urgency: 'critical'
      });
      return;
    }

    const cookies = await extractCookies(context, 'm.oliveyoung.co.kr');

    if (!cookies.linkageHex) {
      console.error('[FAIL] linkageString 쿠키 없음');
      await sendNotification({
        title: '쿠키 추출 실패',
        body: 'linkageString이 없습니다. 로그인·도메인을 확인해 주세요.',
        urgency: 'high'
      });
      return;
    }

    console.log('[INFO] 쿠키 추출 완료 (원문 미출력)');

    const newExp = jwtExpFromLinkageHex(cookies.linkageHex);
    const oldExp = secrets.currentJwtExp;

    console.log(
      `[INFO] 기존 JWT 만료: ${oldExp ? new Date(oldExp * 1000).toISOString() : '없음'}`
    );
    console.log(
      `[INFO] 새 JWT 만료:   ${newExp ? new Date(newExp * 1000).toISOString() : '파싱실패'}`
    );

    if (oldExp && newExp && newExp <= oldExp) {
      console.log('[SKIP] 새 linkage 만료가 기존 이하 — GitHub/Vercel 갱신 생략');
      await sendNotification({
        title: '쿠키 갱신 불필요',
        body: '새 linkage의 만료가 기존과 같거나 이전입니다.',
        urgency: 'low'
      });
      return;
    }

    console.log('[INFO] GitHub Secret 갱신…');
    await updateGitHubSecret('OY_REFRESH_COOKIE', cookies.raw);

    console.log('[INFO] Vercel OLIVEYOUNG_LINKAGE_STRING 갱신·재배포…');
    await updateVercelLinkageString(cookies.linkageHex);

    console.log('[INFO] landing-proxy 헬스체크(배포 반영 대기 포함)…');
    const health = await waitForLandingHealthy();

    if (health.ok) {
      console.log(`[OK] selectedSource: ${health.selectedSource}`);
      console.log(`[OK] jwtValid: ${health.jwtValid}`);
      console.log(`[OK] 만료: ${health.expiry}`);
      await sendNotification({
        title: '올리브영 쿠키 갱신 성공',
        body: `JWT 유효, 만료: ${health.expiry}`,
        urgency: 'normal'
      });
    } else {
      console.error('[FAIL] 헬스체크 실패 — 운영에서 landing-proxy?check=1 확인 필요');
      await sendNotification({
        title: '쿠키 갱신 후 검증 실패',
        body: 'Secret 반영은 했으나 헬스체크가 통과하지 않았습니다. 배포·환경변수를 확인하세요.',
        urgency: 'high'
      });
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    await sendNotification({
      title: '쿠키 갱신 스크립트 오류',
      body: err.message,
      urgency: 'critical'
    });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

main();
