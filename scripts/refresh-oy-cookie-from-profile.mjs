/**
 * OliveYoung cookie refresh using a dedicated Playwright/Chrome profile.
 *
 * This intentionally does not attach to the user's existing Chrome via remote
 * debugging, because Chrome can require an interactive "allow remote debugging"
 * approval. Instead, run setup once, log in inside the automation profile, and
 * scheduled refreshes reuse that profile's cookies.
 *
 * Commands:
 *   node scripts/refresh-oy-cookie-from-profile.mjs --setup
 *   node scripts/refresh-oy-cookie-from-profile.mjs --setup --wait-until-login
 *   node scripts/refresh-oy-cookie-from-profile.mjs --check-only
 *   node scripts/refresh-oy-cookie-from-profile.mjs --no-dispatch
 *
 * Env:
 *   OY_AUTOMATION_PROFILE_DIR  Override profile dir. Default: .auth/oy-chrome-profile
 *   OY_REFRESH_WORKFLOW        Override workflow file. Default: refresh-oy-linkage.yml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';
import { loadLoginSecrets } from './lib/oy-login-secrets.mjs';
import { readCaptchaConfig, TwoCaptchaClient, createCaptchaBudget, abortableSleep } from './lib/oy-captcha-client.mjs';
import { installCapture, inspectChallenge, restoreUserAgent } from './lib/oy-captcha-dom.mjs';
import { createCaptchaHandler } from './lib/oy-captcha-flow.mjs';
import { OY_LOGIN_URL, runAutoLogin, assertLoginHost, isLoginUrl, inspectLoginOutcome } from './lib/oy-auto-login.mjs';
import { acquireRefreshLock } from './lib/oy-refresh-lock.mjs';
import { extractCookies, jwtExpFromLinkageHex } from './lib/cookie-extractor.mjs';
import {
  githubRepoArgs,
  updateGitHubSecret
} from './lib/secret-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DASHBOARD_URL = 'https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard';
const CURATOR_ACTIVATION_TEXT = '큐레이터 활동 시작하기';
const LINKAGE_WAIT_MS = 25000;
const LINKAGE_ACTIVATION_ATTEMPTS = 3;
const HUMAN_LOGIN_EXIT_CODE = 42;
const DAILY_REFRESH_SECONDS = 24 * 60 * 60;
const PROFILE_DIR =
  (process.env.OY_AUTOMATION_PROFILE_DIR || '').trim() ||
  path.join(repoRoot, '.auth', 'oy-chrome-profile');

const args = new Set(process.argv.slice(2));
const setupMode = args.has('--setup');
const waitUntilLogin = setupMode && args.has('--wait-until-login');
const checkOnly = args.has('--check-only') || args.has('--check');
const noDispatch = args.has('--no-dispatch');
const unattended = !setupMode && process.env.OY_UNATTENDED !== '0';
const headed = setupMode || args.has('--headed') || (!unattended && process.env.OY_HEADLESS !== '1');
const abortController = new AbortController();
const signal = abortController.signal;
let activeContext;
const cancel = () => {
  abortController.abort();
  void activeContext?.close().catch(() => {});
};

function help() {
  console.log(`Usage:
  node scripts/refresh-oy-cookie-from-profile.mjs --setup
  node scripts/refresh-oy-cookie-from-profile.mjs --setup --wait-until-login
  node scripts/refresh-oy-cookie-from-profile.mjs --check-only
  node scripts/refresh-oy-cookie-from-profile.mjs [--no-dispatch]

Profile: ${PROFILE_DIR}`);
}

if (args.has('--help') || args.has('-h')) {
  help();
  process.exit(0);
}

function log(message) {
  console.log(`[INFO] ${message}`);
}

function runGh(argsToRun) {
  const r = spawnSync('gh', argsToRun, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true
  });
  if (r.status !== 0) {
    throw new Error('GITHUB_COMMAND_FAILED');
  }
  return (r.stdout || '').trim();
}

async function wait(ms) {
  await abortableSleep(ms, signal);
}

async function openProfile() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: !headed,
    viewport: { width: 412, height: 915 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled']
  });
}

async function dashboardPage(context, automaticCaptchaEnabled = false) {
  const page = context.pages()[0] || (await context.newPage());
  await installCapture(page, { enabled: automaticCaptchaEnabled });
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(8000);
  return page;
}

async function collectState(context, page) {
  assertLoginHost(page.url());
  const title = await page.title().catch(() => '');
  const url = page.url();
  const text = await page
    .locator('body')
    .innerText({ timeout: 5000 })
    .catch(() => '');
  const cookies = await extractCookies(context, 'm.oliveyoung.co.kr', {
    warnMissing: false
  });
  const exp = jwtExpFromLinkageHex(cookies.linkageHex);
  const challenge = await inspectChallenge(page, { signal });
  const captchaDetected = challenge.pending;

  return { title, url, text, cookies, exp, captchaDetected };
}

function logState(state) {
  const location = new URL(state.url);
  log(`dashboard location: ${location.origin}${location.pathname}`);
  log(
    `dashboard state: ${
      needsHumanVerification(state)
        ? 'human-verification-required'
        : isLoginPage(state)
        ? 'login-required'
        : needsCuratorActivation(state)
          ? 'curator-activation-required'
          : 'ready'
    }`
  );
  log(`linkageString: ${state.cookies.linkageHex ? 'present' : 'missing'}`);
  log(`OYSESSIONID: ${state.cookies.oySessionId ? 'present' : 'missing'}`);
  log(`linkage JWT exp: ${state.exp ? new Date(state.exp * 1000).toISOString() : 'unknown'}`);
}

function isLoginPage(state) {
  return (
    state.loginRequiredByDialog === true ||
    isLoginUrl(state.url) ||
    state.text.includes('올리브영 로그인') ||
    state.text.includes('카카오로 로그인') ||
    state.text.includes('로그인이 필요') ||
    state.text.includes('로그인 후 이용')
  );
}

function needsHumanVerification(state) {
  return Boolean(
    state.captchaDetected ||
      /captcha|recaptcha|hcaptcha/i.test(state.url) ||
      /캡차|자동\s*입력\s*방지|로봇이\s*아닙니다|보안\s*문자|추가\s*인증/.test(state.text)
  );
}

function needsCuratorActivation(state) {
  return (
    /\/affiliate\/apply(?:[/?#]|$)/i.test(state.url) ||
    state.text.includes(CURATOR_ACTIVATION_TEXT)
  );
}

export function hasUsableCookies(state) {
  const now = Math.floor(Date.now() / 1000);
  return Boolean(
    state.cookies.linkageHex &&
      state.cookies.oySessionId &&
      state.cookies.raw &&
      state.exp &&
      state.exp > now + 60
  );
}

async function waitForUsableCookies(context, page, timeoutMs = LINKAGE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let state = await collectState(context, page);

  while (
    (!hasUsableCookies(state) || needsCuratorActivation(state)) &&
    Date.now() < deadline
  ) {
    await wait(1000);
    state = await collectState(context, page);
  }

  return state;
}

async function clickCuratorActivation(page) {
  assertLoginHost(page.url());
  const candidates = [
    page.getByRole('button', { name: CURATOR_ACTIVATION_TEXT, exact: true }),
    page.getByRole('link', { name: CURATOR_ACTIVATION_TEXT, exact: true }),
    page
      .locator('button, a, [role="button"], [onclick]')
      .filter({ hasText: CURATOR_ACTIVATION_TEXT }),
    page.getByText(CURATOR_ACTIVATION_TEXT, { exact: true })
  ];

  for (const candidate of candidates) {
    const target = candidate.first();
    if (!(await target.isVisible({ timeout: 1500 }).catch(() => false))) continue;

    await target.scrollIntoViewIfNeeded().catch(() => {});
    const tagName = await target
      .evaluate((element) => element.tagName.toLowerCase())
      .catch(() => 'control');
    let dialogMessage = '';
    const acceptDialog = async (dialog) => {
      dialogMessage = dialog.message();
      log('curator activation notice received');
      if (dialog.type() === 'alert') await dialog.accept().catch(() => {});
      else await dialog.dismiss().catch(() => {});
    };

    page.on('dialog', acceptDialog);
    try {
      log(`clicking curator activation <${tagName}>`);
      await target.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
    } finally {
      page.off('dialog', acceptDialog);
    }
    return {
      clicked: true,
      requiresLogin: dialogMessage.includes('로그인 후')
    };
  }

  return { clicked: false, requiresLogin: false };
}

async function ensureFreshLinkage(context, page) {
  let state = await collectState(context, page);
  if (needsHumanVerification(state) || isLoginPage(state)) return state;
  if (hasUsableCookies(state) && !needsCuratorActivation(state)) return state;

  for (let attempt = 1; attempt <= LINKAGE_ACTIVATION_ATTEMPTS; attempt += 1) {
    if (
      !state.cookies.oySessionId ||
      needsHumanVerification(state) ||
      isLoginPage(state)
    ) {
      return state;
    }

    const activation = await clickCuratorActivation(page).catch(() => {
      log(`curator activation click ${attempt} failed`);
      return { clicked: false, requiresLogin: false };
    });

    if (activation.clicked) {
      log(`curator activation requested (${attempt}/${LINKAGE_ACTIVATION_ATTEMPTS})`);
    } else {
      log(`curator activation control not found (${attempt}/${LINKAGE_ACTIVATION_ATTEMPTS})`);
    }

    if (activation.requiresLogin) {
      await page.waitForTimeout(1000);
      const loginState = await collectState(context, page);
      return { ...loginState, loginRequiredByDialog: true };
    }

    state = await waitForUsableCookies(context, page);
    if (hasUsableCookies(state) && !needsCuratorActivation(state)) {
      log('fresh linkageString issued automatically');
      return state;
    }

    if (attempt < LINKAGE_ACTIVATION_ATTEMPTS) {
      await page
        .goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(() => {});
      await page.waitForTimeout(3000);
      state = await collectState(context, page);
    }
  }

  return state;
}

function humanLoginRequired(message) {
  const error = new Error(message);
  error.exitCode = HUMAN_LOGIN_EXIT_CODE;
  return error;
}

export function assertUsableCookies(state) {
  assertLoginHost(state.url);
  if (/general\s*error|access\s*denied|service\s*unavailable/i.test(state.title || '')) {
    throw new Error('CURATOR_DASHBOARD_UNAVAILABLE');
  }
  if (needsHumanVerification(state)) {
    throw humanLoginRequired(
      'RECONNECT_REQUIRED: CAPTCHA or additional verification was not completed.'
    );
  }

  if (isLoginPage(state)) {
    throw humanLoginRequired(
      'RECONNECT_REQUIRED: OliveYoung login expired. Check saved login settings and reconnect.'
    );
  }

  if (needsCuratorActivation(state)) {
    throw humanLoginRequired('RECONNECT_REQUIRED: curator activation has not completed.');
  }
  if (new URL(state.url).pathname !== new URL(DASHBOARD_URL).pathname) {
    throw new Error('CURATOR_DASHBOARD_NOT_CONFIRMED');
  }

  if (!state.cookies.linkageHex || !state.cookies.oySessionId || !state.cookies.raw) {
    throw humanLoginRequired(
      `Automation profile is not logged in or required cookies are missing. ` +
        `Run: npm run setup:oy-cookie-profile`
    );
  }

  if (!state.exp) {
    throw humanLoginRequired(
      'linkageString JWT expiry could not be verified. Run setup/login again.'
    );
  }

  if (state.exp && state.exp <= Date.now() / 1000 + 60) {
    throw humanLoginRequired('linkageString JWT is expired. Run setup/login again.');
  }
}

async function setupProfile(context, page) {
  console.log('');
  console.log('로그인 전용 Chrome 창이 열렸습니다.');
  console.log('자동로그인을 체크하고 올리브영 큐레이터 로그인을 완료해 주세요.');
  console.log('CAPTCHA나 추가 인증이 보이면 이 창에서 직접 완료해 주세요.');
  console.log('로그인 뒤 큐레이터 활동 시작과 쿠키 발급은 자동으로 진행됩니다.');
  console.log(
    waitUntilLogin
      ? '터미널은 닫지 말고 그대로 두세요. 로그인 완료까지 계속 기다립니다.'
      : '터미널은 닫지 말고 그대로 두세요. 최대 10분 기다립니다.'
  );
  console.log('');

  const deadline = Date.now() + 10 * 60 * 1000;
  let lastState = await collectState(context, page);

  while (waitUntilLogin || Date.now() < deadline) {
    lastState = await collectState(context, page);
    if (
      lastState.cookies.oySessionId &&
      !isLoginPage(lastState) &&
      (!hasUsableCookies(lastState) || needsCuratorActivation(lastState))
    ) {
      lastState = await ensureFreshLinkage(context, page);
    }
    if (hasUsableCookies(lastState) && !needsCuratorActivation(lastState) && !isLoginPage(lastState) && !needsHumanVerification(lastState)) {
      logState(lastState);
      log(`automation profile ready: ${PROFILE_DIR}`);
      return;
    }
    await wait(5000);
  }

  logState(lastState);
  throw new Error('Setup timed out before required OliveYoung cookies appeared.');
}

function dispatchRefreshWorkflow() {
  const workflow = (process.env.OY_REFRESH_WORKFLOW || 'refresh-oy-linkage.yml').trim();
  runGh(['workflow', 'run', workflow, ...githubRepoArgs()]);
  log(`GitHub workflow '${workflow}' dispatched`);

  try {
    const latest = runGh([
      'run',
      'list',
      '--workflow',
      workflow,
      '--limit',
      '1',
      '--json',
      'databaseId,status,conclusion,url,createdAt',
      ...githubRepoArgs()
    ]);
    if (latest) log(`latest run: ${latest}`);
  } catch {
    log('workflow dispatched; latest run lookup skipped');
  }
}

async function main() {
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  log(`automation profile: ${PROFILE_DIR}`);
  log(`browser mode: ${headed ? 'headed' : 'headless'}`);

  const releaseLock = await acquireRefreshLock(repoRoot);
  let context;
  let page;
  let previousLinkageCookies = [];
  let linkageReissueValidated = false;
  try {
    // Explicit inspection/setup never loads credentials or creates provider tasks.
    const secrets = checkOnly || setupMode ? { configured: false, captchaEnabled: false } : await loadLoginSecrets({ repoRoot });
    const parsedConfig = readCaptchaConfig({ ...process.env, TWOCAPTCHA_API_KEY: secrets.captchaApiKey || '' });
    const captchaConfig = { ...parsedConfig, enabled: Boolean(secrets.captchaEnabled && parsedConfig.enabled) };
    const budget = createCaptchaBudget(captchaConfig);
    const client = captchaConfig.enabled ? new TwoCaptchaClient(captchaConfig) : null;
    log(`saved login: ${secrets.configured ? 'configured' : 'not configured'}; CAPTCHA API: ${captchaConfig.enabled ? 'enabled' : 'disabled'}`);
    context = await openProfile();
    activeContext = context;
    page = await dashboardPage(context, captchaConfig.enabled && secrets.configured);

    if (setupMode) {
      await setupProfile(context, page);
      return;
    }

    // Health checks never activate curator membership, submit login, solve challenges,
    // or update GitHub. Only the daily refresh may perform those operations.
    let state = checkOnly ? await collectState(context, page) : await ensureFreshLinkage(context, page);
    let previousExpiry = null;
    if (!checkOnly && hasUsableCookies(state) && !isLoginPage(state) && !needsHumanVerification(state) &&
        !needsCuratorActivation(state) && state.exp < Date.now() / 1000 + DAILY_REFRESH_SECONDS) {
      // Reissue only the curator linkage token; preserve the underlying login session.
      // A token expiring before tomorrow must not be re-published unchanged as a refresh.
      previousExpiry = state.exp;
      previousLinkageCookies = (await context.cookies()).filter(cookie =>
        cookie.name === 'linkageString' && /(^|\.)oliveyoung\.co\.kr$/i.test(cookie.domain.replace(/^\./, '')));
      for (const cookie of previousLinkageCookies) {
        await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
      }
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await wait(3000);
      state = await ensureFreshLinkage(context, page);
    }
    if (!checkOnly && secrets.configured && (isLoginPage(state) || needsHumanVerification(state) || !hasUsableCookies(state))) {
      log('session renewal requires automatic login');
      const onEvent = event => {
        const descriptions = {
          login_submitted: 'automatic login submitted',
          captcha_detected: 'CAPTCHA detected; automatic API processing',
          captcha_task_created: 'CAPTCHA provider task created',
          captcha_provider_applied: 'CAPTCHA response applied',
          captcha_retry_wait: 'CAPTCHA retry cooldown'
        };
        if (descriptions[event.type]) log(descriptions[event.type]);
      };
      const handleCaptcha = createCaptchaHandler(page, { config: captchaConfig, client, budget, signal, onEvent });
      // Resolve a managed page before navigating so one-use metadata is not discarded.
      if (needsHumanVerification(state)) {
        const checkpoint = await handleCaptcha();
        if (checkpoint.status === 'manual') throw humanLoginRequired(`Automatic CAPTCHA did not complete (${checkpoint.reason}). Next scheduled run will retry.`);
      }
      if (!isLoginUrl(page.url())) {
        await page.goto(OY_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      const result = await runAutoLogin(page, secrets, {
        signal, handleCaptcha, onEvent,
        isAuthenticated: async () => {
          const outcome = await inspectLoginOutcome(page);
          if (outcome.signedIn) return true;
          const snapshot = await collectState(context, page);
          return new URL(snapshot.url).pathname === new URL(DASHBOARD_URL).pathname &&
            !isLoginPage(snapshot) && !needsHumanVerification(snapshot) && hasUsableCookies(snapshot) && !needsCuratorActivation(snapshot);
        }
      });
      if (result.status !== 'authenticated') {
        throw humanLoginRequired(`Automatic login did not complete (${result.reason}). No interactive window is opened; next scheduled run will retry.`);
      }
      await restoreUserAgent(page);
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await wait(3000);
      state = await ensureFreshLinkage(context, page);
      log('automatic login complete; curator cookie validation resumed');
    }
    logState(state);
    if (previousExpiry && (!hasUsableCookies(state) || state.exp <= previousExpiry)) {
      // Restore still-valid linkage when reissue fails; no healthy/published success.
      throw humanLoginRequired('RECONNECT_REQUIRED: daily linkage reissue did not produce a later expiry.');
    }
    assertUsableCookies(state);
    linkageReissueValidated = true;

    if (checkOnly) {
      log('check-only mode: required cookies are available; no secrets updated');
      return;
    }

    await updateGitHubSecret('OY_REFRESH_COOKIE', state.cookies.raw);

    if (noDispatch || process.env.OY_SKIP_WORKFLOW_DISPATCH === '1') {
      log('workflow dispatch skipped');
      return;
    }

    dispatchRefreshWorkflow();
  } finally {
    if (context && previousLinkageCookies.length && !linkageReissueValidated) {
      await context.addCookies(previousLinkageCookies).catch(() => {});
    }
    if (page) await restoreUserAgent(page).catch(() => {});
    if (context) await context.close().catch(() => {});
    activeContext = undefined;
    await releaseLock();
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => {
  // Never expose Playwright call logs, which can echo entered secrets.
  console.error(`[ERROR] ${signal.aborted ? 'ABORTED' : err.exitCode === HUMAN_LOGIN_EXIT_CODE ? err.message : err.code === 'OY_REFRESH_BUSY' ? 'OY_REFRESH_BUSY' : 'COOKIE_REFRESH_FAILED'}`);
  process.exit(Number.isInteger(err.exitCode) ? err.exitCode : 1);
});
