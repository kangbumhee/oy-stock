import { abortableSleep } from './oy-captcha-client.mjs';

export const OY_LOGIN_URL = 'https://www.oliveyoung.co.kr/store/login/loginForm.do';
const USER_SELECTOR = 'input[name="loginId"], input#loginId, input[autocomplete="username"]';
const PASSWORD_SELECTOR = 'input[type="password"]';

export class AutoLoginError extends Error {
  constructor(code = 'LOGIN_FAILED') { super(code); this.code = code; }
}

export function assertLoginHost(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new AutoLoginError('UNTRUSTED_HOST'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      !(parsed.hostname === 'oliveyoung.co.kr' || parsed.hostname.endsWith('.oliveyoung.co.kr'))) {
    throw new AutoLoginError('UNTRUSTED_HOST');
  }
}

export function isLoginUrl(url) {
  try { return /\/(?:login(?:\/|$)|members\/login)/i.test(new URL(url).pathname); }
  catch { return false; }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new AutoLoginError('ABORTED');
}

function isNavigationObservationError(error) {
  if (error instanceof AutoLoginError) return false;
  // Match only known read-side navigation races, never generic timeouts or a
  // closed browser. The message is inspected locally and never returned/logged.
  const message = typeof error?.message === 'string' ? error.message : '';
  return /Execution context was destroyed|Cannot find context with specified id|Unable to retrieve content because the page is navigating and changing the content/i.test(message);
}

export async function findCredentialForm(page) {
  assertLoginHost(page.url());
  const forms = await page.locator('form').all();
  const candidates = [];
  for (const form of forms.slice(0, 30)) {
    const users = [];
    const passwords = [];
    for (const input of await form.locator(USER_SELECTOR).all()) {
      if (await input.isVisible() && await input.isEditable()) users.push(input);
    }
    for (const input of await form.locator(PASSWORD_SELECTOR).all()) {
      if (await input.isVisible() && await input.isEditable()) passwords.push(input);
    }
    if (users.length === 1 && passwords.length === 1) candidates.push({ form, user: users[0], password: passwords[0] });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export async function inspectLoginOutcome(page) {
  assertLoginHost(page.url());
  // Do not return body text: dialogs/pages can echo account information.
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const otp = [...document.querySelectorAll('input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i]')].some(visible);
    return {
      additionalVerification: otp || /휴대폰\s*인증|본인\s*인증|추가\s*인증|인증번호를\s*입력/.test(text),
      credentialsRejected: /아이디.{0,35}비밀번호.{0,35}(?:확인|일치하지|잘못)|비밀번호.{0,30}(?:잘못|틀렸|불일치)|계정.{0,20}잠금/.test(text),
      signedIn: [...document.querySelectorAll('a,button')].some(e => visible(e) && /^로그아웃$/.test(e.textContent?.trim() || ''))
    };
  });
}

async function fillCredentials(page, credentials, signal, onlyEmpty = false) {
  throwIfAborted(signal);
  const target = await findCredentialForm(page);
  if (!target) throw new AutoLoginError('LOGIN_FORM_UNAVAILABLE');
  // Retain the exact form DOM node through the writes, not a mutable nth locator.
  const formHandle = await target.form.elementHandle();
  if (!formHandle) throw new AutoLoginError('LOGIN_FORM_UNAVAILABLE');
  try {
    const action = await formHandle.getAttribute('action');
    if (action) assertLoginHost(new URL(action, page.url()).href);
    for (const [input, value] of [[target.user, credentials.username], [target.password, credentials.password]]) {
      assertLoginHost(page.url());
      throwIfAborted(signal);
      if (onlyEmpty && await input.inputValue()) continue;
      if (!(await input.evaluate((element, form) => element.form === form && form.isConnected, formHandle))) {
        throw new AutoLoginError('LOGIN_FORM_CHANGED');
      }
      await input.fill(value, { timeout: 5000 });
    }
  } finally { await formHandle.dispose(); }
}

async function submitLogin(page, signal) {
  assertLoginHost(page.url());
  throwIfAborted(signal);
  const target = await findCredentialForm(page);
  if (!target) throw new AutoLoginError('LOGIN_FORM_UNAVAILABLE');
  const action = await target.form.getAttribute('action');
  if (action) assertLoginHost(new URL(action, page.url()).href);
  const buttons = await target.form.getByRole('button', { name: '로그인', exact: true }).all();
  const usable = [];
  for (const button of buttons) if (await button.isVisible() && await button.isEnabled()) usable.push(button);
  if (usable.length !== 1) throw new AutoLoginError('LOGIN_BUTTON_UNAVAILABLE');
  await usable[0].click({ timeout: 5000 });
}

/** Submit at most twice, only re-submit after a CAPTCHA actually changed the flow.
 * The outer refresh verifies the curator dashboard and fresh cookies separately.
 * All external operations can be injected so regression tests never contact accounts.
 */
export async function runAutoLogin(page, credentials, {
  signal,
  handleCaptcha,
  isAuthenticated = async () => (await inspectLoginOutcome(page)).signedIn,
  inspectOutcome = inspectLoginOutcome,
  fill = fillCredentials,
  submit = submitLogin,
  sleep = abortableSleep,
  onEvent = () => {},
  pollMs = 500,
  outcomePolls = 30
} = {}) {
  if (!credentials?.username || !credentials?.password) return { status: 'manual', reason: 'NO_CREDENTIALS', submits: 0 };
  if (typeof handleCaptcha !== 'function') throw new AutoLoginError('CAPTCHA_HANDLER_REQUIRED');
  let submits = 0;
  let challengeSeen = false;
  let dialogOutcome = '';
  const observe = async read => {
    for (let retry = 0; ; retry++) {
      assertLoginHost(page.url());
      throwIfAborted(signal);
      try {
        const result = await read();
        assertLoginHost(page.url());
        throwIfAborted(signal);
        return result;
      } catch (error) {
        // Recheck the destination even when the read failed during navigation.
        // Never delay an untrusted redirect or replay credential writes/submits.
        assertLoginHost(page.url());
        throwIfAborted(signal);
        if (!isNavigationObservationError(error) || retry >= 3) throw error;
        await sleep(250, signal);
      }
    }
  };
  const dialogHandler = async dialog => {
    const message = dialog.message();
    if (/아이디.{0,35}비밀번호|비밀번호.{0,30}(?:잘못|틀렸|불일치)|계정.{0,20}잠금/.test(message)) dialogOutcome = 'CREDENTIALS_REJECTED';
    else if (/인증|captcha|로봇|자동입력/i.test(message)) dialogOutcome = 'CAPTCHA_REQUIRED';
    else dialogOutcome = 'LOGIN_DIALOG';
    // Only acknowledge information, never accept an unknown confirmation/contract.
    if (dialog.type() === 'alert') await dialog.accept().catch(() => {});
    else await dialog.dismiss().catch(() => {});
  };
  page.on('dialog', dialogHandler);
  try {
    assertLoginHost(page.url());
    throwIfAborted(signal);
    if (await observe(isAuthenticated)) return { status: 'authenticated', submits };
    const initialOutcome = await observe(() => inspectOutcome(page));
    if (initialOutcome.credentialsRejected) return { status: 'manual', reason: 'CREDENTIALS_REJECTED', submits };
    if (initialOutcome.additionalVerification) return { status: 'manual', reason: 'ADDITIONAL_VERIFICATION', submits };
    // Fill BEFORE solving: input handlers may invalidate a freshly solved token.
    // Managed pages have no credential form; resolve the page challenge first.
    if (!await findCredentialForm(page)) {
      const preForm = await handleCaptcha();
      challengeSeen ||= !!preForm.detected;
      if (preForm.status === 'manual') return { status: 'manual', reason: preForm.reason, submits };
    }
    await fill(page, credentials, signal, false);
    for (; submits < 2;) {
      const captcha = await handleCaptcha();
      challengeSeen ||= !!captcha.detected;
      if (captcha.status === 'manual') return { status: 'manual', reason: captcha.reason, submits };
      if (await observe(isAuthenticated)) return { status: 'authenticated', submits };
      if (submits > 0 && !challengeSeen) break;
      const outcome = await observe(() => inspectOutcome(page));
      if (outcome.credentialsRejected || dialogOutcome === 'CREDENTIALS_REJECTED') return { status: 'manual', reason: 'CREDENTIALS_REJECTED', submits };
      if (outcome.additionalVerification) return { status: 'manual', reason: 'ADDITIONAL_VERIFICATION', submits };
      if (submits > 0) {
        // Refill only erased fields, then solve/revalidate again if input changed state.
        await fill(page, credentials, signal, true);
        const verified = await handleCaptcha();
        if (verified.status === 'manual') return { status: 'manual', reason: verified.reason, submits };
      }
      throwIfAborted(signal);
      dialogOutcome = '';
      submits += 1;
      await submit(page, signal);
      onEvent({ type: 'login_submitted', submits });
      for (let poll = 0; poll < outcomePolls; poll += 1) {
        await sleep(pollMs, signal);
        assertLoginHost(page.url());
        if (await observe(isAuthenticated)) return { status: 'authenticated', submits };
        const state = await observe(() => inspectOutcome(page));
        if (state.credentialsRejected || dialogOutcome === 'CREDENTIALS_REJECTED') return { status: 'manual', reason: 'CREDENTIALS_REJECTED', submits };
        if (state.additionalVerification) return { status: 'manual', reason: 'ADDITIONAL_VERIFICATION', submits };
        if (dialogOutcome === 'CAPTCHA_REQUIRED') { challengeSeen = true; break; }
        if (dialogOutcome === 'LOGIN_DIALOG') return { status: 'manual', reason: 'LOGIN_DIALOG', submits };
      }
      if (submits === 2) break;
      const postSubmit = await handleCaptcha();
      challengeSeen ||= !!postSubmit.detected;
      if (postSubmit.status === 'manual') return { status: 'manual', reason: postSubmit.reason, submits };
      if (!challengeSeen) break;
    }
    return { status: 'manual', reason: 'LOGIN_NOT_CONFIRMED', submits };
  } catch (error) {
    if (signal?.aborted || error?.code === 'ABORTED') throw new AutoLoginError('ABORTED');
    // Playwright's fill errors can contain the value being typed; never propagate them.
    const code = error instanceof AutoLoginError ? error.code : 'LOGIN_FAILED';
    return { status: 'manual', reason: code, submits };
  } finally {
    page.off('dialog', dialogHandler);
  }
}
