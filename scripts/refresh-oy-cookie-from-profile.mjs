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
 *   node scripts/refresh-oy-cookie-from-profile.mjs --check-only
 *   node scripts/refresh-oy-cookie-from-profile.mjs --no-dispatch
 *
 * Env:
 *   OY_AUTOMATION_PROFILE_DIR  Override profile dir. Default: .auth/oy-chrome-profile
 *   OY_REFRESH_WORKFLOW        Override workflow file. Default: refresh-oy-linkage.yml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';
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
const PROFILE_DIR =
  (process.env.OY_AUTOMATION_PROFILE_DIR || '').trim() ||
  path.join(repoRoot, '.auth', 'oy-chrome-profile');

const args = new Set(process.argv.slice(2));
const setupMode = args.has('--setup');
const checkOnly = args.has('--check-only') || args.has('--check');
const noDispatch = args.has('--no-dispatch');
const headed = setupMode || args.has('--headed') || process.env.OY_HEADLESS !== '1';

function help() {
  console.log(`Usage:
  node scripts/refresh-oy-cookie-from-profile.mjs --setup
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
    maxBuffer: 10 * 1024 * 1024
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
    throw new Error(`gh ${argsToRun.join(' ')} failed: ${err}`);
  }
  return (r.stdout || '').trim();
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function previewText(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 240);
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

async function dashboardPage(context) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  return page;
}

async function collectState(context, page) {
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

  return { title, url, text, cookies, exp };
}

function logState(state) {
  log(`dashboard url: ${state.url}`);
  log(`dashboard title: ${state.title || 'unknown'}`);
  log(`dashboard preview: ${previewText(state.text)}`);
  log(`linkageString: ${state.cookies.linkageHex ? 'present' : 'missing'}`);
  log(`OYSESSIONID: ${state.cookies.oySessionId ? 'present' : 'missing'}`);
  log(`linkage JWT exp: ${state.exp ? new Date(state.exp * 1000).toISOString() : 'unknown'}`);
}

function isLoginPage(state) {
  return (
    /\/login\//i.test(state.url) ||
    state.text.includes('올리브영 로그인') ||
    state.text.includes('카카오로 로그인')
  );
}

function hasUsableCookies(state) {
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

  while (!hasUsableCookies(state) && Date.now() < deadline) {
    await wait(1000);
    state = await collectState(context, page);
  }

  return state;
}

async function clickCuratorActivation(page) {
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
      log(`curator activation dialog: ${previewText(dialogMessage)}`);
      await dialog.accept().catch(() => {});
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
  if (hasUsableCookies(state)) return state;

  for (let attempt = 1; attempt <= LINKAGE_ACTIVATION_ATTEMPTS; attempt += 1) {
    if (!state.cookies.oySessionId || isLoginPage(state)) return state;

    const activation = await clickCuratorActivation(page).catch((err) => {
      log(`curator activation click ${attempt} failed: ${err.message || err}`);
      return { clicked: false, requiresLogin: false };
    });

    if (activation.clicked) {
      log(`curator activation requested (${attempt}/${LINKAGE_ACTIVATION_ATTEMPTS})`);
    } else {
      log(`curator activation control not found (${attempt}/${LINKAGE_ACTIVATION_ATTEMPTS})`);
    }

    if (activation.requiresLogin) {
      await page.waitForTimeout(1000);
      return collectState(context, page);
    }

    state = await waitForUsableCookies(context, page);
    if (hasUsableCookies(state)) {
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

  const screenshotPath = path.join(repoRoot, '.ai', 'logs', 'oy-cookie-refresh-failure.png');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  log(`refresh failure screenshot: ${screenshotPath}`);

  return state;
}

function assertUsableCookies(state) {
  if (!state.cookies.linkageHex || !state.cookies.oySessionId || !state.cookies.raw) {
    throw new Error(
      `Automation profile is not logged in or required cookies are missing. ` +
        `Run: npm run setup:oy-cookie-profile`
    );
  }

  if (!state.exp) {
    throw new Error('linkageString JWT expiry could not be verified. Run setup/login again.');
  }

  if (state.exp && state.exp <= Date.now() / 1000) {
    throw new Error('linkageString JWT is expired. Run setup/login again.');
  }
}

async function setupProfile(context, page) {
  console.log('');
  console.log('로그인 전용 Chrome 창이 열렸습니다.');
  console.log('자동로그인을 체크하고 올리브영 큐레이터 로그인을 완료해 주세요.');
  console.log('로그인 뒤 큐레이터 활동 시작과 쿠키 발급은 자동으로 진행됩니다.');
  console.log('터미널은 닫지 말고 그대로 두세요. 최대 10분 기다립니다.');
  console.log('');

  const deadline = Date.now() + 10 * 60 * 1000;
  let lastState = await collectState(context, page);

  while (Date.now() < deadline) {
    lastState = await collectState(context, page);
    if (
      lastState.cookies.oySessionId &&
      !isLoginPage(lastState) &&
      !hasUsableCookies(lastState)
    ) {
      lastState = await ensureFreshLinkage(context, page);
    }
    if (hasUsableCookies(lastState)) {
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
  log(`automation profile: ${PROFILE_DIR}`);
  log(`browser mode: ${headed ? 'headed' : 'headless'}`);

  const context = await openProfile();
  try {
    const page = await dashboardPage(context);

    if (setupMode) {
      await setupProfile(context, page);
      return;
    }

    const state = await ensureFreshLinkage(context, page);
    logState(state);
    assertUsableCookies(state);

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
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message || err}`);
  process.exit(1);
});
