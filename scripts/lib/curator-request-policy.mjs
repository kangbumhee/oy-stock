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

export function isInvalidCuratorAuthFailure(pack) {
  if (!pack || pack.ok || pack.hardFailure !== true) return false;
  if (landingFailureStatus(pack) !== 401) return false;
  const detail = pack.detail && pack.detail.json;
  return Boolean(
    detail &&
      (detail.error === 'invalid_token' || detail.reason === 'identity_code_22004')
  );
}

export async function runCuratorRequestWithAuthRenewal({
  runRequest,
  renewAuth,
  applyAuth,
  currentAuthJwt = '',
  authRenewalAlreadyAttempted = false
}) {
  if (typeof runRequest !== 'function') {
    throw new TypeError('runRequest function is required');
  }

  const initialOutcome = await runRequest();
  if (
    authRenewalAlreadyAttempted ||
    !isInvalidCuratorAuthFailure(initialOutcome && initialOutcome.result)
  ) {
    return {
      ...initialOutcome,
      authRenewalAttempted: false,
      authRenewed: false
    };
  }

  let renewedAuth = null;
  try {
    renewedAuth =
      typeof renewAuth === 'function'
        ? await renewAuth({
            previousAuthJwt: String(currentAuthJwt || ''),
            failure: initialOutcome.result
          })
        : null;
  } catch (authRenewalError) {
    return {
      ...initialOutcome,
      authRenewalAttempted: true,
      authRenewed: false,
      authRenewalError
    };
  }

  const nextAuthJwt = String(renewedAuth && renewedAuth.jwt ? renewedAuth.jwt : '');
  if (!nextAuthJwt || nextAuthJwt === String(currentAuthJwt || '')) {
    return {
      ...initialOutcome,
      authRenewalAttempted: true,
      authRenewed: false
    };
  }

  try {
    if (typeof applyAuth === 'function') await applyAuth(renewedAuth);
  } catch (authRenewalError) {
    return {
      ...initialOutcome,
      authRenewalAttempted: true,
      authRenewed: false,
      authRenewalError
    };
  }

  const retryOutcome = await runRequest();
  return {
    ...retryOutcome,
    authRenewalAttempted: true,
    authRenewed: true,
    initialAuthFailure: initialOutcome.result
  };
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

export function getReusableAttributedCuratorOriginal(
  entry,
  goodsNo,
  expectedPartnerId
) {
  if (!entry || isReadyCuratorShortUrl(entry.shortenedUrl)) return null;

  const normalizedGoodsNo = String(goodsNo || '').trim().toUpperCase();
  const activityId = String(entry.affiliateActivityId || '').trim();
  const partnerId = String(entry.affiliatePartnerId || '').trim();
  const expectedPartner = String(expectedPartnerId || '').trim();
  const originalUrl = String(entry.originalUrl || '').trim();

  if (!/^[AB]\d+$/i.test(normalizedGoodsNo)) return null;
  if (!/^[A-Fa-f0-9]{32}$/.test(activityId)) return null;
  if (!/^[A-Fa-f0-9]{32}$/.test(partnerId)) return null;
  if (!/^[A-Fa-f0-9]{32}$/.test(expectedPartner)) return null;
  if (partnerId.toLowerCase() !== expectedPartner.toLowerCase()) return null;

  try {
    const url = new URL(originalUrl);
    const allowedProductPath =
      (url.hostname === 'm.oliveyoung.co.kr' &&
        url.pathname === '/m/goods/getGoodsDetail.do') ||
      (url.hostname === 'www.oliveyoung.co.kr' &&
        url.pathname === '/store/goods/getGoodsDetail.do');
    if (
      url.protocol !== 'https:' ||
      !allowedProductPath ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return null;
    }
    for (const name of ['goodsNo', 'utm_source', 'utm_medium', 'utm_content']) {
      if (url.searchParams.getAll(name).length !== 1) return null;
    }
    if (String(url.searchParams.get('goodsNo') || '').toUpperCase() !== normalizedGoodsNo) {
      return null;
    }
    if (url.searchParams.get('utm_source') !== 'shutter') return null;
    if (url.searchParams.get('utm_medium') !== 'affiliate') return null;
    if (url.searchParams.get('utm_content') !== `OY_${activityId}`) return null;

    const canonical = new URL(`${url.origin}${url.pathname}`);
    canonical.searchParams.set('goodsNo', normalizedGoodsNo);
    canonical.searchParams.set('utm_source', 'shutter');
    canonical.searchParams.set('utm_medium', 'affiliate');
    canonical.searchParams.set('utm_content', `OY_${activityId}`);
    return {
      originalUrl: canonical.toString(),
      affiliateActivityId: activityId,
      affiliatePartnerId: partnerId
    };
  } catch {
    return null;
  }
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
