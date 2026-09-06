import { abortableSleep } from './oy-captcha-client.mjs';
import * as captchaDom from './oy-captcha-dom.mjs';

// One controller per login, shared before and after the guarded login submission.
export function createCaptchaHandler(page, options) {
  const { config, client, budget, signal, onEvent = () => {}, deps = captchaDom, sleep = abortableSleep, now = Date.now } = options;
  const { inspectChallenge, solveChallenge, confirmClear, releaseManaged, restoreUserAgent, isProviderApplicationCurrent } = deps;
  const appliedIdentities = new Set();
  let lastAttemptAt = 0;
  let uncertainCreate = false;
  let seen = false;
  const manual = async reason => {
    await releaseManaged(page, { signal }).catch(() => {});
    return { status: 'manual', detected: seen, reason };
  };
  return async function handleCaptcha() {
    const deadline = now() + config.timeoutMs * config.maxAttempts + 60000;
    let readinessAttempts = 0;
    let graceGiven = false;
    try {
      while (now() < deadline) {
        const current = await inspectChallenge(page, { signal });
        seen ||= current.detected;
        if (!current.pending && await confirmClear(page, { signal, timeoutMs: 2000 })) {
          return { status: 'clear', detected: seen };
        }
        if (!graceGiven) {
          graceGiven = true;
          await sleep(3500, signal);
          continue;
        }
        if (!config.enabled) return manual('CAPTCHA_AUTOMATIC_DISABLED');
        if (uncertainCreate) return manual('CREATE_TASK_UNCERTAIN');
        if (current.type === 'unknown' || !current.type) {
          if (++readinessAttempts > 3) return manual('NO_DESCRIPTOR');
          await sleep(5000, signal);
          continue;
        }
        // A solved image waits for the login submit; don't buy the same answer again.
        if (appliedIdentities.has(current.identity) && !current.managed &&
            await isProviderApplicationCurrent(page, current.identity, { signal })) {
          return { status: 'applied', detected: true, identity: current.identity };
        }
        if (!budget.canReserve(current.identity)) return manual('CAPTCHA_TASK_LIMIT');
        const cooldown = 6000 - (now() - lastAttemptAt);
        if (cooldown > 0) await sleep(cooldown, signal);
        lastAttemptAt = now();
        const result = await solveChallenge(page, { client, budget, config, signal, onEvent });
        if (result.reason === 'CREATE_TASK_UNCERTAIN') uncertainCreate = true;
        if (result.clear) return { status: 'clear', detected: seen };
        if (result.providerApplied && !result.managed) {
          const latest = await inspectChallenge(page, { signal });
          if (latest.identity === result.identity && await isProviderApplicationCurrent(page, result.identity, { signal })) {
            appliedIdentities.add(result.identity);
            return { status: 'applied', detected: true, identity: result.identity };
          }
        }
        if (result.providerApplied && result.managed) return manual('CAPTCHA_NOT_CLEARED');
        if (['UNTRUSTED_HOST', 'CREATE_TASK_UNCERTAIN', 'AUTOMATIC_UNAVAILABLE', 'JOB_TASK_LIMIT', 'INVALID_API_KEY'].includes(result.reason)) {
          return manual(result.reason);
        }
        onEvent({ type: 'captcha_retry_wait' });
      }
      return manual('CAPTCHA_NOT_CLEARED');
    } finally {
      await restoreUserAgent(page).catch(() => {});
    }
  };
}
