import { createHash, timingSafeEqual } from 'node:crypto';
import { CaptchaError } from './oy-captcha-client.mjs';

const stateByPage = new WeakMap();
const BRIDGE = '__oliveYoungTurnstileBridge';
const NATIVE_FLAG = '__oliveyoung_native_turnstile';
const safeReasons = new Set(['ABORTED', 'UNTRUSTED_HOST', 'CHALLENGE_CHANGED', 'CHALLENGE_CLEARED_EXTERNALLY',
  'NO_DESCRIPTOR', 'TOKEN_NOT_APPLIED', 'IMAGE_INVALID', 'ANSWER_NOT_APPLIED', 'INVALID_SOLUTION',
  'APPLY_FAILED', 'MANAGED_UA_REQUIRED', 'CAPTCHA_NOT_CLEARED', 'AUTOMATIC_UNAVAILABLE', 'NO_API_KEY',
  'DISABLED', 'CHALLENGE_TASK_LIMIT', 'JOB_TASK_LIMIT', 'CREATE_TASK_UNCERTAIN', 'SOLVE_TIMEOUT',
  'REQUEST_TIMEOUT', 'NETWORK_ERROR', 'INVALID_TASK_ID', 'INVALID_TASK_STATUS', 'API_ERROR']);

export function isTrustedOliveYoungURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'oliveyoung.co.kr' || url.hostname.endsWith('.oliveyoung.co.kr'));
  } catch { return false; }
}

function assertHost(page) {
  if (!isTrustedOliveYoungURL(page.url())) throw new CaptchaError('UNTRUSTED_HOST');
}

function abortCheck(signal) {
  if (signal?.aborted) throw new CaptchaError('ABORTED');
}

async function abortable(promise, signal) {
  abortCheck(signal);
  if (!signal) return promise;
  let cancel;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      cancel = () => reject(new CaptchaError('ABORTED'));
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', cancel); }
}

function pause(ms, signal) {
  abortCheck(signal);
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new CaptchaError('ABORTED')); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// This runs before navigation. It never defines/claims window.turnstile itself.
function captureInit({ enabled, bridgeName, nativeFlag }) {
  const currentURL = new URL(location.href);
  if (currentURL.protocol !== 'https:' || currentURL.port || currentURL.username || currentURL.password ||
    !(currentURL.hostname === 'oliveyoung.co.kr' || currentURL.hostname.endsWith('.oliveyoung.co.kr'))) return;
  if (window[bridgeName]) return;
  const bridge = {
    captures: [], callbacks: new Map(), pendingCallbacks: new Set(), appliedCallbacks: new Set(),
    nodeIds: new WeakMap(), nodes: new Map(), serial: 0, documentId: crypto.randomUUID(),
  };
  Object.defineProperty(window, bridgeName, { value: bridge, enumerable: false });
  let native = false;
  try { native = sessionStorage.getItem(nativeFlag) === '1'; } catch { native = true; }
  const patched = new WeakSet();
  const seenScripts = new WeakSet();
  const onloadPatched = new WeakSet();
  const patch = () => {
    const api = window.turnstile;
    if (!api || typeof api.render !== 'function' || patched.has(api.render)) return;
    const original = api.render;
    function render(target, options = {}) {
      let element = target;
      if (typeof target === 'string') {
        try { element = document.querySelector(target); } catch { element = null; }
      }
      if (!(element instanceof Element)) return original.apply(this, arguments);
      const text = (value, limit = 10000) => typeof value === 'string' ? value.slice(0, limit) : '';
      const captureId = `${bridge.documentId}-${++bridge.serial}`;
      const managed = !!(text(options.cData) && text(options.chlPageData));
      const capture = {
        captureId, element, websiteKey: text(options.sitekey, 100), action: text(options.action, 1000),
        data: text(options.cData), pagedata: text(options.chlPageData),
        responseFieldName: text(options['response-field-name'] || 'cf-turnstile-response', 200),
        managed, renderPrevented: managed && enabled && !native,
      };
      if (typeof options.callback === 'function') bridge.callbacks.set(captureId, options.callback);
      bridge.captures.push(capture);
      while (bridge.captures.length > 10) {
        const stale = bridge.captures.shift();
        bridge.callbacks.delete(stale.captureId);
        bridge.pendingCallbacks.delete(stale.captureId);
        bridge.appliedCallbacks.delete(stale.captureId);
      }
      capture.widgetId = capture.renderPrevented ? `oliveyoung-managed-${captureId}` : String(original.apply(this, arguments) ?? '');
      return capture.widgetId;
    }
    patched.add(render);
    api.render = render;
  };
  function scan() {
    patch();
    for (const script of document.querySelectorAll('script[src]')) {
      let url;
      try { url = new URL(script.src); } catch { continue; }
      if (url.hostname !== 'challenges.cloudflare.com' || !url.pathname.includes('turnstile')) continue;
      if (!seenScripts.has(script)) { seenScripts.add(script); script.addEventListener('load', patch); }
      const name = url.searchParams.get('onload');
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const callback = window[name];
      if (typeof callback !== 'function' || onloadPatched.has(callback)) continue;
      const wrapped = function (...args) { patch(); return callback.apply(this, args); };
      onloadPatched.add(wrapped);
      window[name] = wrapped;
    }
  }
  const observer = new MutationObserver(scan);
  observer.observe(document, { childList: true, subtree: true });
  const interval = setInterval(scan, 10);
  const stopTimer = setTimeout(() => clearInterval(interval), 30000);
  addEventListener('pagehide', () => { clearInterval(interval); clearTimeout(stopTimer); observer.disconnect(); }, { once: true });
  scan();
}

export async function installCapture(page, { enabled = false } = {}) {
  if (stateByPage.has(page)) return;
  stateByPage.set(page, { manualReloadCompleted: false, restoreUA: null });
  await page.addInitScript(captureInit, { enabled: !!enabled, bridgeName: BRIDGE, nativeFlag: NATIVE_FLAG });
}

// Inspection and token writes use the SAME selector policy, recomputed atomically in the page.
function domOperation({ operation = 'inspect', expectedSignature, token, answer, bridgeName }) {
  const currentURL = new URL(location.href);
  const trusted = currentURL.protocol === 'https:' && !currentURL.port && !currentURL.username && !currentURL.password &&
    (currentURL.hostname === 'oliveyoung.co.kr' || currentURL.hostname.endsWith('.oliveyoung.co.kr'));
  if (!trusted) return { error: 'UNTRUSTED_HOST' };
  const bridge = window[bridgeName];
  if (!bridge) return { error: 'NO_DESCRIPTOR' };
  const id = (element) => {
    if (!element) return '';
    if (!bridge.nodeIds.has(element)) {
      const value = `${bridge.documentId}-node-${++bridge.serial}`;
      bridge.nodeIds.set(element, value); bridge.nodes.set(value, element);
    }
    return bridge.nodeIds.get(element);
  };
  const visible = (element) => {
    if (!(element instanceof Element) || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
  };
  const editable = (element) => visible(element) && !element.disabled && !element.readOnly;
  const marker = (element) => ['id', 'name', 'class', 'src', 'alt', 'title', 'aria-label', 'placeholder']
    .map((key) => element.getAttribute(key) || '').join(' ');
  const captchaMarker = /cap(?:t)?cha|자동\s*입력\s*방지|보안\s*문자/i;
  const responseName = /(?:turnstile|captcha|challenge)-response|^g-recaptcha-response$/i;
  const forms = [...document.forms].filter((form) => {
    const passwords = [...form.querySelectorAll('input[type="password"]')].filter(editable);
    const usernames = [...form.querySelectorAll('input:not([type]), input[type="text"], input[type="email"], input[type="tel"]')]
      .filter((input) => editable(input) && !captchaMarker.test(marker(input)) && !responseName.test(input.name));
    return passwords.length === 1 && usernames.length === 1;
  });
  const form = forms.length === 1 ? forms[0] : null;
  const formId = id(form);
  let imagePair = null;
  if (form) {
    const images = [...form.querySelectorAll('img, canvas, [role="img"]')].filter(visible).slice(0, 12);
    const inputs = [...form.querySelectorAll('input:not([type]), input[type="text"], input[type="search"], input[type="tel"]')]
      .filter((element) => editable(element) && !responseName.test(element.name)).slice(0, 12);
    const pairs = [];
    for (const image of images) {
      for (const input of inputs) {
        let parent = image.parentElement;
        for (let depth = 0; parent && depth < 4 && form.contains(parent); depth++, parent = parent.parentElement) {
          if (!parent.contains(input)) continue;
          const marked = captchaMarker.test(marker(image)) && captchaMarker.test(marker(input));
          const prompt = captchaMarker.test(`${marker(parent)} ${parent.innerText || ''}`);
          const ownImages = images.filter((item) => parent.contains(item));
          const ownInputs = inputs.filter((item) => parent.contains(item));
          if ((marked || prompt) && ownImages.length === 1 && ownInputs.length === 1) pairs.push({ image, input });
          break;
        }
      }
    }
    const unique = pairs.filter((pair, index) => pairs.findIndex((other) => other.image === pair.image && other.input === pair.input) === index);
    if (unique.length === 1) imagePair = unique[0];
  }
  const bodyText = document.body?.innerText || '';
  const explicitRejection = /인증을\s*완료한\s*후\s*로그인|사람임을\s*확인.*(?:다시|완료)|complete the.*verification/i.test(bodyText);
  const shell = /잠시만\s*기다|just a moment|checking your browser|사람인지\s*확인|사람임을\s*확인|자동\s*입력\s*방지|보안\s*문자/i.test(bodyText);
  const validKey = (key, fallback = false) => /^[A-Za-z0-9_-]{20,100}$/.test(key || '') && (!fallback || /^(?:0|[1-9])x/.test(key));
  let descriptor = null;
  let capture = null;
  let widget = null;
  if (!imagePair) {
    for (const candidate of [...bridge.captures].reverse()) {
      if (!candidate.element.isConnected || !validKey(candidate.websiteKey)) continue;
      if (!candidate.managed && (!form || candidate.element.closest('form') !== form || !visible(candidate.element))) continue;
      if (candidate.managed && !shell && !visible(candidate.element)) continue;
      capture = candidate; widget = candidate.element; break;
    }
    if (capture) {
      descriptor = {
        websiteURL: location.href, websiteKey: capture.websiteKey, userAgent: navigator.userAgent.slice(0, 512),
        action: capture.action, data: capture.data, pagedata: capture.pagedata,
        responseFieldName: capture.responseFieldName, captureId: capture.captureId, widgetId: capture.widgetId,
        managed: capture.managed, renderPrevented: capture.renderPrevented, formId, elementId: id(widget),
      };
    } else if (form) {
      const candidates = [...form.querySelectorAll('.cf-turnstile[data-sitekey], [class*="turnstile"][data-sitekey], iframe, [data-sitekey]')];
      for (const element of candidates) {
        if (!visible(element)) continue;
        let key = element.getAttribute('data-sitekey') || '';
        if (element.tagName === 'IFRAME') {
          try {
            const url = new URL(element.src);
            if (url.hostname !== 'challenges.cloudflare.com' || !/turnstile/.test(url.pathname)) continue;
            key = url.searchParams.get('sitekey') || url.searchParams.get('k') || url.pathname.split('/').find((part) => validKey(part, true)) || '';
          } catch { continue; }
        }
        if (!validKey(key, true)) continue;
        widget = element;
        descriptor = {
          websiteURL: location.href, websiteKey: key, userAgent: navigator.userAgent.slice(0, 512),
          action: element.getAttribute('data-action') || '', data: '', pagedata: '',
          responseFieldName: element.getAttribute('data-response-field-name') || 'cf-turnstile-response',
          captureId: '', widgetId: '', managed: false, renderPrevented: false, formId, elementId: id(widget),
        };
        break;
      }
    }
  }
  const chooseField = () => {
    if (!form || !descriptor) return null;
    let fields = [...form.querySelectorAll('input, textarea')].filter((field) =>
      field.form === form && !field.disabled && field.type !== 'password' &&
      (field.name === descriptor.responseFieldName || responseName.test(field.name)) &&
      !['text', 'search', 'tel'].includes(field.type));
    if (descriptor.widgetId) {
      const exact = fields.filter((field) => field.id.includes(descriptor.widgetId));
      if (exact.length) fields = exact;
    }
    const named = fields.filter((field) => field.name === descriptor.responseFieldName);
    if (named.length) fields = named;
    return fields.length === 1 ? fields[0] : null;
  };
  const field = chooseField();
  if (descriptor) descriptor.fieldId = id(field);
  const associatedToken = field && typeof field.value === 'string' && field.value.trim().length >= 20 && !/[\0\r\n]/.test(field.value);
  const callbackApplied = capture && bridge.appliedCallbacks.has(capture.captureId);
  const image = imagePair ? {
    websiteURL: location.href, formId, imageId: id(imagePair.image), inputId: id(imagePair.input),
    source: imagePair.image.getAttribute('src') || '', width: imagePair.image.clientWidth, height: imagePair.image.clientHeight,
  } : null;
  const unknownVisible = !image && !descriptor && [...document.querySelectorAll('.cf-turnstile, [class*="turnstile"][data-sitekey], iframe, img, canvas, [role="img"]')]
    .slice(0, 80).some((element) => {
      if (!visible(element)) return false;
      if (element.tagName === 'IFRAME') {
        try { const url = new URL(element.src); return url.hostname === 'challenges.cloudflare.com' && /turnstile/.test(url.pathname); }
        catch { return false; }
      }
      return element.matches('.cf-turnstile, [class*="turnstile"][data-sitekey]') || captchaMarker.test(marker(element));
    });
  const detected = !!(image || descriptor || shell || explicitRejection || unknownVisible);
  const pending = !!(image || explicitRejection || (descriptor ? descriptor.managed || !(associatedToken || callbackApplied) : shell || unknownVisible));
  const signature = JSON.stringify(image ? { type: 'image', ...image } : descriptor ? {
    ...descriptor, userAgent: undefined,
  } : { websiteURL: location.href, formId, shell, explicitRejection, unknownVisible });
  const result = { detected, pending, type: image ? 'image' : descriptor ? 'turnstile' : detected ? 'unknown' : null,
    descriptor, image, signature, managed: !!descriptor?.managed };
  if (operation === 'inspect') return result;
  if (signature !== expectedSignature) return { error: 'CHALLENGE_CHANGED' };
  if (operation === 'verify') return { appliedCurrent: imagePair ? imagePair.input.value === answer :
    !!((field && field.value === token) || callbackApplied) };
  const write = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === value;
  };
  if (operation === 'image') {
    if (!imagePair || !editable(imagePair.input) || !visible(imagePair.image)) return { error: 'CHALLENGE_CHANGED' };
    return write(imagePair.input, answer) ? { applied: true } : { error: 'ANSWER_NOT_APPLIED' };
  }
  if (!descriptor) return { error: 'CHALLENGE_CHANGED' };
  let callback = capture ? bridge.callbacks.get(capture.captureId) : null;
  let callbackKey = capture?.captureId;
  if (!callback && !capture && widget) {
    const path = widget.getAttribute('data-callback');
    if (path && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path)) {
      let owner = window;
      const parts = path.split('.');
      try {
        for (const part of parts.slice(0, -1)) owner = owner?.[part];
        const fn = owner?.[parts.at(-1)];
        if (typeof fn === 'function') { callback = fn.bind(owner); callbackKey = `dom-${id(widget)}-${path}`; }
      } catch { /* Unknown callback means no callback. */ }
    }
  }
  let written = 0;
  if (field && write(field, token)) written = 1;
  let scheduled = 0;
  if (callback && !bridge.pendingCallbacks.has(callbackKey) && !bridge.appliedCallbacks.has(callbackKey)) {
    bridge.pendingCallbacks.add(callbackKey);
    setTimeout(() => {
      Promise.resolve().then(() => {
        const current = domOperation({ bridgeName });
        if (current.error || current.signature !== signature) throw new Error('CHALLENGE_CHANGED');
        return callback(token);
      }).then(() => bridge.appliedCallbacks.add(callbackKey))
        .catch(() => {}).finally(() => bridge.pendingCallbacks.delete(callbackKey));
    }, 0);
    scheduled = 1;
  }
  return written || scheduled ? { applied: true, written, scheduled } : { error: 'TOKEN_NOT_APPLIED' };
}

export function validateCaptchaPNG(png) {
  if (!Buffer.isBuffer(png) || png.length < 33 || png.length > 100 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') throw new CaptchaError('IMAGE_INVALID');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1000 || height > 1000) throw new CaptchaError('IMAGE_INVALID');
  return createHash('sha256').update(png).digest('hex');
}

async function captureImage(page, imageId, signal) {
  assertHost(page); abortCheck(signal);
  const handle = await abortable(page.evaluateHandle(({ name, id }) => window[name]?.nodes.get(id), { name: BRIDGE, id: imageId }), signal);
  try {
    const element = handle.asElement();
    if (!element) throw new CaptchaError('CHALLENGE_CHANGED');
    await abortable(element.scrollIntoViewIfNeeded({ timeout: 2000 }), signal);
    const bounds = await abortable(element.evaluate((image) => {
      if (!image.isConnected || !image.getClientRects().length) return null;
      const rect = image.getBoundingClientRect();
      return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
    }), signal);
    if (!bounds || bounds.width < 1 || bounds.height < 1 || bounds.width > 1000 || bounds.height > 1000) throw new CaptchaError('IMAGE_INVALID');
    // Element screenshots enclose fractional bounds, which can include a neighboring
    // answer input's pixels. Capture only complete pixels INSIDE this exact image:
    // filling the answer must not change the challenge fingerprint or buy it twice.
    const x = Math.ceil(bounds.x), y = Math.ceil(bounds.y);
    const clip = { x, y, width: Math.floor(bounds.x + bounds.width) - x, height: Math.floor(bounds.y + bounds.height) - y };
    if (clip.width < 1 || clip.height < 1) throw new CaptchaError('IMAGE_INVALID');
    const png = await abortable(page.screenshot({
      type: 'png', fullPage: true, clip, timeout: 2000, animations: 'disabled', scale: 'css',
      // An adjacent focused input can paint its outline over the image's edge.
      // Visibility preserves layout; Playwright removes this style after capture.
      style: 'input, textarea { visibility: hidden !important; }',
    }), signal);
    assertHost(page);
    const sameBounds = await abortable(element.evaluate((image, expected) => {
      if (!image.isConnected || !image.getClientRects().length) return false;
      const rect = image.getBoundingClientRect();
      const actual = { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
      return Object.keys(actual).every((key) => Math.abs(actual[key] - expected[key]) < 0.01);
    }, bounds), signal);
    if (!sameBounds) throw new CaptchaError('CHALLENGE_CHANGED');
    const fingerprint = validateCaptchaPNG(png);
    return { png, fingerprint };
  } finally { await handle.dispose(); }
}

export async function inspectChallenge(page, { signal } = {}) {
  assertHost(page); abortCheck(signal);
  const result = await abortable(page.evaluate(domOperation, { bridgeName: BRIDGE }), signal);
  if (result.error) throw new CaptchaError(result.error);
  if (result.image) {
    const captured = await captureImage(page, result.image.imageId, signal);
    result.fingerprint = captured.fingerprint;
  }
  result.identity = createHash('sha256').update(`${result.signature}|${result.fingerprint || ''}`).digest('hex');
  return result;
}

export async function confirmClear(page, { signal, timeoutMs = 15000, samples = 4, intervalMs = 250 } = {}) {
  if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !Number.isFinite(intervalMs) || intervalMs <= 0) throw new CaptchaError('INVALID_SOLUTION');
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    const current = await inspectChallenge(page, { signal });
    count = current.pending ? 0 : count + 1;
    if (count >= samples) {
      assertHost(page);
      await abortable(page.evaluate((key) => { try { sessionStorage.removeItem(key); } catch { /* Optional native-mode marker. */ } }, NATIVE_FLAG), signal);
      return true;
    }
    await pause(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal);
  }
  return false;
}

export async function restoreUserAgent(page) {
  const state = stateByPage.get(page);
  const restore = state?.restoreUA;
  if (state) state.restoreUA = null;
  if (restore) await restore();
}

export const restoreOriginalUserAgent = restoreUserAgent;

export async function isProviderApplicationCurrent(page, identity, { signal } = {}) {
  const application = stateByPage.get(page)?.application;
  if (!application || application.identity !== identity) return false;
  try {
    const current = await inspectChallenge(page, { signal });
    if (current.identity !== identity) return false;
    const check = await abortable(page.evaluate(domOperation, {
      bridgeName: BRIDGE, operation: 'verify', expectedSignature: application.signature,
      ...(application.type === 'image' ? { answer: application.value } : { token: application.value }),
    }), signal);
    return check.appliedCurrent === true;
  } catch (error) {
    if (error?.code === 'ABORTED') throw error;
    return false;
  }
}

async function useUserAgent(page, value) {
  if (typeof value !== 'string' || value.trim().length < 20 || value.length > 512 || /[\0\r\n]/.test(value)) throw new CaptchaError('MANAGED_UA_REQUIRED');
  assertHost(page);
  const original = await page.evaluate(() => navigator.userAgent);
  const session = await page.context().newCDPSession(page);
  const state = stateByPage.get(page);
  if (!state) { await session.detach(); throw new CaptchaError('NO_DESCRIPTOR'); }
  state.restoreUA = async () => {
    try { await session.send('Network.setUserAgentOverride', { userAgent: original }); }
    finally { await session.detach(); }
  };
  try { await session.send('Network.setUserAgentOverride', { userAgent: value.trim() }); }
  catch { await restoreUserAgent(page); throw new CaptchaError('APPLY_FAILED'); }
}

export async function releaseManaged(page, { signal } = {}) {
  await restoreUserAgent(page);
  assertHost(page); abortCheck(signal);
  const state = stateByPage.get(page);
  if (!state || state.manualReloadCompleted) return false;
  const current = await inspectChallenge(page, { signal });
  if (!current.descriptor?.managed || !current.descriptor.renderPrevented) return false;
  state.manualReloadCompleted = true;
  await abortable(page.evaluate((key) => sessionStorage.setItem(key, '1'), NATIVE_FLAG), signal);
  await abortable(page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }), signal);
  return true;
}

export async function solveChallenge(page, { client, budget, config = {}, signal, onEvent } = {}) {
  let initial;
  let providerApplied = false;
  const emit = (event) => { try { Promise.resolve(onEvent?.(event)).catch(() => {}); } catch { /* UI must not change solver safety. */ } };
  try {
    initial = await inspectChallenge(page, { signal });
    if (!initial.pending) return { detected: initial.detected, type: initial.type, identity: initial.identity, providerApplied: false, applied: false, clear: true };
    if (!config.enabled || !client || !budget) throw new CaptchaError('AUTOMATIC_UNAVAILABLE');
    if (!['image', 'turnstile'].includes(initial.type)) throw new CaptchaError('NO_DESCRIPTOR');
    emit({ type: 'captcha_detected', challengeType: initial.type });
    const assertCurrent = async () => {
      assertHost(page); abortCheck(signal);
      if (page.url() !== (initial.descriptor?.websiteURL || initial.image?.websiteURL)) throw new CaptchaError('CHALLENGE_CHANGED');
      const current = await inspectChallenge(page, { signal });
      if (!current.detected || !current.pending) throw new CaptchaError('CHALLENGE_CLEARED_EXTERNALLY');
      if (current.identity !== initial.identity) throw new CaptchaError('CHALLENGE_CHANGED');
    };
    let task;
    if (initial.type === 'image') {
      const captured = await captureImage(page, initial.image.imageId, signal);
      if (!timingSafeEqual(Buffer.from(captured.fingerprint, 'hex'), Buffer.from(initial.fingerprint, 'hex'))) throw new CaptchaError('CHALLENGE_CHANGED');
      task = { type: 'ImageToTextTask', body: captured.png.toString('base64') };
    } else {
      const descriptor = initial.descriptor;
      task = { type: 'TurnstileTaskProxyless', websiteURL: descriptor.websiteURL, websiteKey: descriptor.websiteKey, userAgent: descriptor.userAgent };
      for (const key of ['action', 'data', 'pagedata']) if (descriptor[key]) task[key] = descriptor[key];
    }
    const solution = await client.solve(task, {
      signal,
      beforeCreate: async () => { await assertCurrent(); budget.reserve(initial.identity); },
      beforePoll: assertCurrent,
      beforeReturn: assertCurrent,
      onTaskCreated: (taskId) => { budget.markCreated(initial.identity, taskId); emit({ type: 'captcha_task_created', challengeType: initial.type }); },
    });
    await assertCurrent();
    let apply;
    let appliedValue;
    if (initial.type === 'image') {
      if (typeof solution.text !== 'string' || /[\0\r\n]/.test(solution.text)) throw new CaptchaError('INVALID_SOLUTION');
      const answer = solution.text.trim().replace(/\s+/gu, ' ');
      if ([...answer].length < 1 || [...answer].length > 32) throw new CaptchaError('INVALID_SOLUTION');
      appliedValue = answer;
      apply = await abortable(page.evaluate(domOperation, { bridgeName: BRIDGE, operation: 'image', expectedSignature: initial.signature, answer }), signal);
    } else {
      const token = typeof solution.token === 'string' ? solution.token.trim() : '';
      if (token.length < 20 || token.length > 20000 || /[\0\r\n]/.test(token)) throw new CaptchaError('INVALID_SOLUTION');
      appliedValue = token;
      if (initial.descriptor.managed) await useUserAgent(page, solution.userAgent);
      await assertCurrent();
      apply = await abortable(page.evaluate(domOperation, { bridgeName: BRIDGE, operation: 'turnstile', expectedSignature: initial.signature, token }), signal);
    }
    if (apply.error) throw new CaptchaError(apply.error);
    providerApplied = !!apply.applied;
    if (providerApplied) stateByPage.get(page).application = {
      identity: initial.identity, signature: initial.signature, type: initial.type, value: appliedValue,
    };
    emit({ type: 'captcha_provider_applied', challengeType: initial.type });
    // Image answers require the enclosing login flow's single guarded submission.
    const clear = initial.type === 'image' ? false : await confirmClear(page, { signal, timeoutMs: config.applyTimeoutMs || 15000 });
    return { detected: true, type: initial.type, identity: initial.identity, providerApplied, applied: providerApplied, clear,
      managed: initial.managed, reason: clear || initial.type === 'image' ? undefined : 'CAPTCHA_NOT_CLEARED' };
  } catch (error) {
    const reason = safeReasons.has(error?.code) || /^HTTP_\d{3}$/.test(error?.code || '') ? error.code : 'PROVIDER_ERROR';
    if (reason === 'ABORTED') throw new CaptchaError('ABORTED');
    return { detected: initial?.detected ?? true, type: initial?.type || null, identity: initial?.identity,
      providerApplied, applied: providerApplied, clear: false, managed: initial?.managed || false, reason, automaticUnavailable: true };
  } finally { await restoreUserAgent(page); }
}
