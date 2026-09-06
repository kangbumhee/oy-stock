// No provider response text is included in errors. Keys and task payloads stay in memory.
const SAFE_CODES = new Set([
  'ABORTED', 'REQUEST_TIMEOUT', 'SOLVE_TIMEOUT', 'NETWORK_ERROR', 'MALFORMED_RESPONSE',
  'INVALID_TASK_ID', 'INVALID_TASK_STATUS', 'INVALID_SOLUTION', 'PROVIDER_ERROR',
  'NO_API_KEY', 'DISABLED', 'FETCH_UNAVAILABLE', 'INVALID_TASK', 'HOOK_FAILED',
  'TASK_CREATED_CALLBACK_FAILED', 'CHALLENGE_CHANGED', 'CHALLENGE_CLEARED_EXTERNALLY',
  'UNTRUSTED_HOST', 'NO_DESCRIPTOR', 'TOKEN_NOT_APPLIED', 'IMAGE_INVALID',
  'ANSWER_NOT_APPLIED', 'APPLY_FAILED', 'MANAGED_UA_REQUIRED', 'APPLY_TIMEOUT',
  'AUTOMATIC_UNAVAILABLE', 'BUDGET_EXHAUSTED', 'JOB_TASK_LIMIT', 'CHALLENGE_TASK_LIMIT',
  'CREATE_TASK_UNCERTAIN', 'INVALID_CHALLENGE_IDENTITY', 'INVALID_RESERVATION',
  'INVALID_TURNSTILE_TOKEN', 'MISSING_USER_AGENT', 'IMAGE_SIZE_EXCEEDED',
  'IMAGE_DIMENSIONS_EXCEEDED', 'INVALID_IMAGE_FORMAT', 'INVALID_IMAGE_CAPTCHA_TEXT',
  'CAPTCHA_NOT_CLEARED', 'TURNSTILE_SOLVE_FAILED', 'IMAGE_CAPTCHA_FAILED'
]);
const TRANSIENT_HTTP = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

function safeCode(code) {
  return typeof code === 'string' && (SAFE_CODES.has(code) || /^HTTP_[1-5]\d{2}$/.test(code))
    ? code : 'PROVIDER_ERROR';
}

export class CaptchaError extends Error {
  constructor(code, { ambiguous = false, taskCreated = false } = {}) {
    const normalized = safeCode(code);
    super(normalized);
    this.name = 'CaptchaError';
    this.code = normalized;
    // Retries of task creation are never delegated to callers implicitly.
    this.retryable = false;
    this.ambiguous = Boolean(ambiguous);
    this.taskCreated = Boolean(taskCreated);
  }
}

function errorFrom(error, fallback) {
  return error instanceof CaptchaError ? error : new CaptchaError(fallback);
}

function signalError(signal) {
  return signal?.reason instanceof CaptchaError ? signal.reason : new CaptchaError('ABORTED');
}

function checkSignal(signal) {
  if (signal?.aborted) throw signalError(signal);
}

function withSignal(work, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signalError(signal)); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { checkSignal(signal); return work(); }).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); }
    );
  });
}

export function abortableSleep(ms, signal) {
  checkSignal(signal);
  if (!Number.isFinite(ms) || ms < 0) throw new CaptchaError('INVALID_TASK');
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signalError(signal));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function validKey(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return '';
  const key = value.trim();
  return key && key.length <= 512 ? key : '';
}

function bounded(value, fallback, min, max) {
  if ((typeof value === 'string' && !value.trim()) || value == null || typeof value === 'boolean') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

export function readCaptchaConfig(env = process.env) {
  const setting = suffix => env[`OLIVEYOUNG_2CAPTCHA_${suffix}`] ?? env[`KOREA_TOP_2CAPTCHA_${suffix}`];
  const apiKey = validKey(env.TWOCAPTCHA_API_KEY) || validKey(env.TWO_CAPTCHA_API_KEY);
  const configured = Boolean(apiKey);
  const enabled = configured && !DISABLED_VALUES.has(String(setting('ENABLED') ?? '').trim().toLowerCase());
  return Object.freeze({
    apiKey, configured, enabled,
    pollIntervalMs: bounded(setting('POLL_INTERVAL_MS'), 5000, 5000, 30000),
    timeoutMs: bounded(setting('TIMEOUT_MS'), 120000, 30000, 300000),
    requestTimeoutMs: bounded(setting('REQUEST_TIMEOUT_MS'), 30000, 5000, 60000),
    applyTimeoutMs: bounded(setting('APPLY_TIMEOUT_MS'), 15000, 5000, 60000),
    maxAttempts: bounded(setting('MAX_ATTEMPTS'), 3, 1, 3),
    maxJobTasks: bounded(setting('JOB_TASK_LIMIT'), 12, 1, 12)
  });
}

function validTaskId(taskId) {
  return Number.isSafeInteger(taskId) && taskId > 0;
}

// Keep one instance for the whole login job, not one per handleCaptcha invocation.
export function createCaptchaBudget(config = {}) {
  const maxAttempts = bounded(config.maxAttempts, 3, 1, 3);
  const maxJobTasks = bounded(config.maxJobTasks, 12, 1, 12);
  const events = new Map();
  let reserved = 0;
  let created = 0;
  function assertIdentity(identity) {
    if (typeof identity !== 'string' || !identity || identity.length > 32768) {
      throw new CaptchaError('INVALID_CHALLENGE_IDENTITY');
    }
  }
  function unavailable(identity) {
    const event = events.get(identity);
    if (event?.pending) return 'CREATE_TASK_UNCERTAIN';
    if (reserved >= maxJobTasks) return 'JOB_TASK_LIMIT';
    if ((event?.reserved || 0) >= maxAttempts) return 'CHALLENGE_TASK_LIMIT';
    return null;
  }
  return Object.freeze({
    canReserve(identity) { assertIdentity(identity); return !unavailable(identity); },
    reserve(identity) {
      assertIdentity(identity);
      const code = unavailable(identity);
      if (code) throw new CaptchaError(code);
      const event = events.get(identity) || { reserved: 0, taskIds: new Set(), pending: false };
      event.reserved += 1;
      event.pending = true;
      events.set(identity, event);
      reserved += 1;
    },
    markCreated(identity, taskId) {
      assertIdentity(identity);
      if (!validTaskId(taskId)) throw new CaptchaError('INVALID_TASK_ID');
      const event = events.get(identity);
      if (!event || !event.pending || event.taskIds.has(taskId)) throw new CaptchaError('INVALID_RESERVATION');
      event.taskIds.add(taskId);
      event.pending = false;
      created += 1;
    },
    snapshot(identity) {
      const event = identity == null ? undefined : events.get(identity);
      return Object.freeze({ reserved, created, maxAttempts, maxJobTasks,
        ...(identity == null ? {} : {
          eventReserved: event?.reserved || 0,
          eventCreated: event?.taskIds.size || 0,
          uncertain: Boolean(event?.pending)
        })
      });
    }
  });
}

export class TwoCaptchaClient {
  #key; #enabled; #fetch; #sleep; #now; #config;
  constructor(config = readCaptchaConfig(), { fetchImpl = globalThis.fetch, sleep = abortableSleep, now = Date.now } = {}) {
    this.#key = validKey(config.apiKey);
    this.#enabled = config.enabled !== false;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
    this.#now = now;
    this.#config = {
      pollIntervalMs: bounded(config.pollIntervalMs, 5000, 5000, 30000),
      timeoutMs: bounded(config.timeoutMs, 120000, 30000, 300000),
      requestTimeoutMs: bounded(config.requestTimeoutMs, 30000, 5000, 60000)
    };
  }

  async #post(endpoint, body, parentSignal) {
    checkSignal(parentSignal);
    const controller = new AbortController();
    const abort = () => controller.abort(signalError(parentSignal));
    parentSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new CaptchaError('REQUEST_TIMEOUT')), this.#config.requestTimeoutMs);
    try {
      let response;
      try {
        response = await withSignal(() => this.#fetch(`https://api.2captcha.com/${endpoint}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal, redirect: 'error'
        }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw signalError(controller.signal);
        throw errorFrom(error, 'NETWORK_ERROR');
      }
      if (!response?.ok) {
        const status = response?.status;
        throw new CaptchaError(Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP_${status}` : 'NETWORK_ERROR');
      }
      let result;
      try { result = await withSignal(() => response.json(), controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw signalError(controller.signal);
        throw new CaptchaError('MALFORMED_RESPONSE');
      }
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Number.isInteger(result.errorId) || result.errorId < 0) {
        throw new CaptchaError('MALFORMED_RESPONSE');
      }
      if (result.errorId !== 0) throw new CaptchaError('PROVIDER_ERROR');
      return result;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
    }
  }

  async solve(task, { signal, beforeCreate, beforePoll, beforeReturn, onTaskCreated } = {}) {
    checkSignal(signal);
    if (!this.#key) throw new CaptchaError('NO_API_KEY');
    if (!this.#enabled) throw new CaptchaError('DISABLED');
    if (typeof this.#fetch !== 'function') throw new CaptchaError('FETCH_UNAVAILABLE');
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.type !== 'string') throw new CaptchaError('INVALID_TASK');
    const controller = new AbortController();
    const startedAt = this.#now();
    const abort = () => controller.abort(new CaptchaError('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new CaptchaError('SOLVE_TIMEOUT')), this.#config.timeoutMs);
    const check = () => {
      checkSignal(controller.signal);
      if (this.#now() - startedAt >= this.#config.timeoutMs) throw new CaptchaError('SOLVE_TIMEOUT');
    };
    const hook = async fn => {
      check();
      if (!fn) return;
      try {
        if (await withSignal(() => fn(), controller.signal) === false) throw new CaptchaError('CHALLENGE_CHANGED');
      } catch (error) { throw errorFrom(error, 'HOOK_FAILED'); }
      check();
    };
    let creationStarted = false;
    let taskCreated = false;
    try {
      await hook(beforeCreate);
      check();
      creationStarted = true;
      // Never retry this POST, even after a timeout or malformed success response.
      const created = await this.#post('createTask', { clientKey: this.#key, task }, controller.signal);
      if (!validTaskId(created.taskId)) throw new CaptchaError('INVALID_TASK_ID');
      const taskId = created.taskId;
      taskCreated = true;
      // Invoke synchronously after validation so cancellation cannot hide a created task.
      if (onTaskCreated) {
        try {
          const notification = Promise.resolve(onTaskCreated(taskId));
          // An async observer may abort synchronously and reject later. Keep that
          // rejection observed even when cancellation wins before await attaches.
          notification.catch(() => {});
          await withSignal(() => notification, controller.signal);
        } catch (error) { throw errorFrom(error, 'TASK_CREATED_CALLBACK_FAILED'); }
      }
      let transientRetries = 0;
      while (true) {
        check();
        await withSignal(() => this.#sleep(this.#config.pollIntervalMs, controller.signal), controller.signal);
        await hook(beforePoll);
        let result;
        try { result = await this.#post('getTaskResult', { clientKey: this.#key, taskId }, controller.signal); }
        catch (error) {
          const normalized = errorFrom(error, 'NETWORK_ERROR');
          const transient = normalized.code === 'NETWORK_ERROR' || normalized.code === 'REQUEST_TIMEOUT'
            || (normalized.code.startsWith('HTTP_') && TRANSIENT_HTTP.has(Number(normalized.code.slice(5))));
          if (transient && transientRetries < 3) { transientRetries += 1; continue; }
          throw normalized;
        }
        check();
        if (result.status === 'processing') continue;
        if (result.status !== 'ready') throw new CaptchaError('INVALID_TASK_STATUS');
        if (!result.solution || typeof result.solution !== 'object' || Array.isArray(result.solution)) throw new CaptchaError('INVALID_SOLUTION');
        await hook(beforeReturn);
        check();
        return result.solution;
      }
    } catch (error) {
      const normalized = errorFrom(error, 'PROVIDER_ERROR');
      throw new CaptchaError(normalized.code, { ambiguous: creationStarted && !taskCreated, taskCreated });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
