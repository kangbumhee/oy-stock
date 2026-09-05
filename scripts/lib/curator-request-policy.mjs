const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1200;

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function landingFailureStatus(pack) {
  const status = Number(pack && pack.detail && pack.detail.status);
  return Number.isInteger(status) && status >= 0 ? status : null;
}

export function isTransientLandingHardFailure(pack) {
  if (!pack || pack.ok || pack.hardFailure !== true) return false;
  const status = landingFailureStatus(pack);
  return (
    status === 0 ||
    status === 403 ||
    status === 429 ||
    (status != null && status >= 500)
  );
}

export function shouldRetryCuratorError(
  entry,
  { now = Date.now(), retryErrorAfterMs = 0 } = {}
) {
  if (!entry || !entry.error) return true;

  const retryAt = Date.parse(String(entry.retryAfter || ''));
  const nowMs = Number(now);
  if (Number.isFinite(retryAt)) {
    return !Number.isFinite(nowMs) || nowMs >= retryAt;
  }

  const generatedAt = Date.parse(String(entry.generatedAt || ''));
  if (!Number.isFinite(generatedAt) || !Number.isFinite(nowMs)) return true;
  return nowMs - generatedAt >= nonNegativeInteger(retryErrorAfterMs);
}

export function isReadyCuratorShortUrl(value) {
  const shortenedUrl = String(value || '').trim();
  try {
    const url = new URL(shortenedUrl);
    if (url.protocol === 'https:' && url.hostname === 'oy.run' && url.pathname !== '/') {
      return true;
    }
  } catch {}
  return false;
}

function curatorLinkQuality(entry) {
  if (!entry) return 0;
  if (isReadyCuratorShortUrl(entry.shortenedUrl)) return 2;
  return entry.originalUrl ? 1 : 0;
}

export function shouldReplaceCuratorEntry(currentEntry, incomingEntry) {
  if (!incomingEntry) return false;
  if (!currentEntry) return true;

  const currentQuality = curatorLinkQuality(currentEntry);
  const incomingQuality = curatorLinkQuality(incomingEntry);
  const currentTime = Date.parse(String(currentEntry.generatedAt || ''));
  const incomingTime = Date.parse(String(incomingEntry.generatedAt || ''));

  if (
    currentQuality === 1 &&
    incomingQuality === 0 &&
    incomingEntry.error === 'affiliate_link_unavailable'
  ) {
    return !(
      Number.isFinite(currentTime) &&
      Number.isFinite(incomingTime) &&
      currentTime > incomingTime
    );
  }

  if (
    currentQuality === 0 &&
    currentEntry.error === 'affiliate_link_unavailable' &&
    incomingQuality === 1
  ) {
    return !(
      Number.isFinite(currentTime) &&
      Number.isFinite(incomingTime) &&
      currentTime >= incomingTime
    );
  }

  if (currentQuality !== incomingQuality) return incomingQuality > currentQuality;

  if (
    Number.isFinite(currentTime) &&
    Number.isFinite(incomingTime) &&
    currentTime > incomingTime
  ) {
    return false;
  }

  return true;
}

export async function runCuratorRequestWithRetry({
  runAttempt,
  prepareRetry,
  sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
}) {
  if (typeof runAttempt !== 'function') {
    throw new TypeError('runAttempt function is required');
  }

  const attempts = Math.max(1, nonNegativeInteger(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const delayMs = nonNegativeInteger(retryDelayMs);
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const onRetry = typeof prepareRetry === 'function' ? prepareRetry : async () => {};
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryContext = null;
    try {
      const result = await runAttempt({ attempt, maxAttempts: attempts });
      if (!isTransientLandingHardFailure(result) || attempt >= attempts) {
        return { result, lastError: null, attempts: attempt };
      }
      retryContext = {
        attempt,
        maxAttempts: attempts,
        result,
        error: null,
        status: landingFailureStatus(result)
      };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        return { result: null, lastError, attempts: attempt };
      }
      retryContext = {
        attempt,
        maxAttempts: attempts,
        result: null,
        error,
        status: null
      };
    }

    try {
      await onRetry(retryContext);
    } catch (error) {
      return { result: null, lastError: error, attempts: attempt };
    }

    if (delayMs > 0) await wait(delayMs * attempt);
  }

  return { result: null, lastError, attempts };
}

export function isSystemicLandingHardFailure({
  hardFailureCount,
  landingFailureCount,
  generatedCount,
  affiliateUnavailableCount,
  maxConsecutiveHardFailures
}) {
  const hard = nonNegativeInteger(hardFailureCount);
  if (hard === 0) return false;

  const landing = nonNegativeInteger(landingFailureCount);
  const generated = nonNegativeInteger(generatedCount);
  const unavailable = nonNegativeInteger(affiliateUnavailableCount);
  const consecutive = nonNegativeInteger(maxConsecutiveHardFailures);
  const attemptedLandingCount = generated + landing;

  const allLandingAttemptsHardFailed =
    landing > 0 && generated === 0 && unavailable === 0 && hard >= landing;
  const repeatedConsecutiveFailure = consecutive >= 3;
  const repeatedMajorityFailure =
    hard >= 2 && attemptedLandingCount > 0 && hard * 2 >= attemptedLandingCount;

  return (
    allLandingAttemptsHardFailed ||
    repeatedConsecutiveFailure ||
    repeatedMajorityFailure
  );
}

export function evaluateCuratorBatchFailure({
  generatedCount,
  shortenFailureCount,
  landingFailureCount,
  affiliateUnavailableCount,
  exceptionFailureCount,
  hardFailureCount,
  authFailureCount,
  maxConsecutiveHardFailures,
  maxConsecutivePolicyFailures
}) {
  const generated = nonNegativeInteger(generatedCount);
  const shortenFailures = nonNegativeInteger(shortenFailureCount);
  const landing = nonNegativeInteger(landingFailureCount);
  const unavailable = nonNegativeInteger(affiliateUnavailableCount);
  const exceptions = nonNegativeInteger(exceptionFailureCount);
  const hard = nonNegativeInteger(hardFailureCount);
  const auth = nonNegativeInteger(authFailureCount);
  const consecutivePolicy = nonNegativeInteger(maxConsecutivePolicyFailures);
  const attemptedRequestCount = generated + shortenFailures + landing + exceptions;
  const healthyRequestOutcomeCount = generated + unavailable;
  const unresolvedLandingFailureCount = Math.max(0, landing - unavailable);
  const unresolvedRequestFailureCount =
    shortenFailures + unresolvedLandingFailureCount + exceptions;
  const noUsableResultFailureCount =
    attemptedRequestCount > 0 && healthyRequestOutcomeCount === 0
      ? shortenFailures + unresolvedLandingFailureCount + exceptions
      : 0;
  const systemicHardFailure = isSystemicLandingHardFailure({
    hardFailureCount: hard,
    landingFailureCount: landing,
    generatedCount: generated,
    shortenFailureCount: shortenFailures,
    affiliateUnavailableCount: unavailable,
    maxConsecutiveHardFailures
  });
  const systemicUnresolvedFailure =
    consecutivePolicy >= 3 ||
    (
      unresolvedRequestFailureCount >= 3 &&
      attemptedRequestCount > 0 &&
      unresolvedRequestFailureCount * 2 >= attemptedRequestCount
    );

  return {
    attemptedRequestCount,
    healthyRequestOutcomeCount,
    shortenFailureCount: shortenFailures,
    unresolvedLandingFailureCount,
    unresolvedRequestFailureCount,
    noUsableResultFailureCount,
    systemicHardFailure,
    systemicUnresolvedFailure,
    criticalFailureCount: Math.max(
      auth,
      systemicHardFailure ? hard : 0,
      systemicUnresolvedFailure ? unresolvedRequestFailureCount : 0,
      noUsableResultFailureCount
    )
  };
}
