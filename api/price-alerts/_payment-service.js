const { mutateAuthenticatedDevice } = require('./_auth');
const {
  PASS_AMOUNT_KRW,
  PASS_DURATION_DAYS,
  PAYMENT_INTENT_TTL_MS,
  applyPaymentGrant,
  newPaymentId,
  normalizeIdempotencyKey,
  normalizePaymentId,
  paymentIdempotencyHash,
  pendingPaymentActive,
  publicEntitlement,
  revokePaymentGrant
} = require('./_entitlement');
const { HttpError } = require('./_http');
const { mutateIntent, readIntent } = require('./_payment-store');
const { notifyOwnerPayment } = require('./_payment-owner-mail');
const {
  PortOneSafeError,
  getPayment,
  paymentContract,
  preRegisterPayment,
  requestPaymentPayload,
  verifyPayment
} = require('./_portone');
const {
  releaseActiveDeviceReservation,
  reserveActiveDevice,
  reserveDeviceRegistration
} = require('./_registry');
const { mutateDevice } = require('./_store');

const DIAGNOSTIC_PHASES = new Set(['ensure_intent', 'pre_register', 'mark_prepared', 'abandon_payment']);
const DIAGNOSTIC_ERROR_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'HttpError', 'PortOneSafeError',
  'PaymentIntentConflictError', 'DeviceWriteConflictError', 'BlobError',
  'BlobPreconditionFailedError', 'BlobUnknownError', 'BlobAccessError',
  'BlobServiceNotAvailable', 'BlobServiceRateLimited'
]);
const DIAGNOSTIC_PROVIDER_CODES = new Set([
  'portone_invalid_response', 'portone_unavailable', 'portone_request_pending',
  'portone_pre_register_failed', 'portone_lookup_failed', 'payment_not_found'
]);

function logPaymentFailure(phase, error) {
  // Only fixed categories and numeric HTTP status reach server logs. Never log
  // the exception, message, stack, payment/device IDs, credentials, or response.
  try {
    const diagnostic = {
      phase: DIAGNOSTIC_PHASES.has(phase) ? phase : 'unknown',
      errorClass: DIAGNOSTIC_ERROR_CLASSES.has(error && error.name) ? error.name : 'UnknownError'
    };
    if (error instanceof PortOneSafeError) {
      diagnostic.providerCode = DIAGNOSTIC_PROVIDER_CODES.has(error.code) ? error.code : 'unknown';
      if (Number.isInteger(error.providerHttpStatus) && error.providerHttpStatus >= 100 && error.providerHttpStatus <= 599) {
        diagnostic.providerHttpStatus = error.providerHttpStatus;
      }
    }
    console.error('[price-alerts/payment]', diagnostic);
  } catch (_) {
    // Diagnostic failure must not replace the operation's original error.
  }
}

function sameContract(left, right) {
  const keys = [
    'amount',
    'currency',
    'orderName',
    'payMethod',
    'easyPayProvider',
    'storeId',
    'channelKey',
    'channelType'
  ];
  return keys.every((key) => left && right && left[key] === right[key]);
}

function paymentIntentFromPending(pending) {
  return {
    version: 1,
    revision: 0,
    paymentId: pending.paymentId,
    ownerDeviceId: pending.ownerDeviceId,
    idempotencyHash: pending.idempotencyHash,
    status: pending.status,
    contract: pending.contract,
    createdAt: pending.createdAt,
    updatedAt: pending.updatedAt,
    expiresAt: pending.expiresAt,
    providerCheckedAt: null,
    decisionReason: null,
    events: [
      {
        type: 'created',
        at: pending.createdAt,
        status: pending.status,
        reason: 'payment_intent_created'
      }
    ]
  };
}

function appendIntentEvent(intent, type, at, status, reason) {
  const events = Array.isArray(intent.events) ? intent.events.slice() : [];
  events.push({
    type: String(type || '').slice(0, 40),
    at,
    status: String(status || '').slice(0, 40),
    reason: String(reason || '').slice(0, 80)
  });
  intent.events = events.slice(-50);
}

function recoveredPendingPayment(record) {
  const pending = record && record.pendingPayment;
  const account = record && record.account;
  const recoveredAt = Date.parse(account && account.recoveredAt || '');
  const createdAt = Date.parse(pending && pending.createdAt || '');
  return Boolean(pending && normalizePaymentId(pending.paymentId) &&
    ['created', 'prepared', 'pending', 'review_required'].includes(pending.status) &&
    account && account.indexLinked === true && Number(account.credentialVersion) > 0 &&
    Number.isFinite(recoveredAt) && Number.isFinite(createdAt) && recoveredAt >= createdAt);
}

async function checkRecoveredPayment(intent, config, nowMs, dependencies) {
  const lookup = (dependencies && dependencies.getPayment) || getPayment;
  let payment;
  let providerNotFound = false;
  try {
    payment = await lookup(config, intent.paymentId, dependencies && dependencies.portone);
  } catch (error) {
    // Pre-registration does not necessarily create a payment GET resource. Only
    // an authoritative 404 permits reopening that SAME, unexpired payment ID.
    if (!(error instanceof PortOneSafeError) || error.code !== 'portone_lookup_failed' ||
        error.providerHttpStatus !== 404) {
      if (error instanceof PortOneSafeError) {
        throw new HttpError(error.retryable ? 503 : 502, error.code, error.retryable ? 60 : null);
      }
      throw error;
    }
    providerNotFound = true;
  }
  if (!providerNotFound && (!payment || typeof payment !== 'object' || Array.isArray(payment))) {
    throw new HttpError(502, 'portone_invalid_response');
  }
  if (providerNotFound || (payment.paymentId === intent.paymentId && payment.status === 'READY')) {
    if (!['created', 'pending', 'prepared'].includes(intent.status) ||
        !Number.isFinite(Date.parse(intent.expiresAt || '')) ||
        Date.parse(intent.expiresAt) <= nowMs) {
      // Do not replace an expired/ambiguous intent while another browser may
      // still be completing it. A verified terminal provider result resolves it.
      throw new HttpError(409, 'payment_reconciliation_required');
    }
    return null;
  }
  return reconcilePayment(intent.paymentId, intent.ownerDeviceId, config, {
    ...dependencies,
    // Reuse the authoritative result, not a client-supplied payment status.
    getPayment: async () => payment
  });
}

async function ensureIntent(pending, dependencies) {
  const mutate = (dependencies && dependencies.mutateIntent) || mutateIntent;
  return mutate(
    pending.paymentId,
    (current) => {
      if (current) {
        if (
          current.ownerDeviceId !== pending.ownerDeviceId ||
          current.idempotencyHash !== pending.idempotencyHash ||
          !sameContract(current.contract, pending.contract)
        ) {
          throw new HttpError(409, 'payment_intent_conflict');
        }
        return { changed: false, intent: current };
      }
      return { changed: true, intent: paymentIntentFromPending(pending) };
    },
    dependencies
  );
}

async function markPrepared(paymentId, ownerDeviceId, now, dependencies) {
  const mutatePaymentIntent = (dependencies && dependencies.mutateIntent) || mutateIntent;
  const prepared = await mutatePaymentIntent(
    paymentId,
    (intent) => {
      if (!intent || intent.paymentId !== paymentId || intent.ownerDeviceId !== ownerDeviceId) {
        throw new HttpError(404, 'payment_not_found');
      }
      if (intent.status === 'prepared') return { changed: false, intent };
      if (!['created', 'pending'].includes(intent.status)) {
        throw new HttpError(409, 'payment_not_pending');
      }
      intent.status = 'prepared';
      intent.updatedAt = now;
      appendIntentEvent(intent, 'pre_registered', now, 'prepared', 'portone_pre_registered');
      return { changed: true, intent };
    },
    dependencies
  );
  if (!prepared || !prepared.intent || prepared.intent.paymentId !== paymentId ||
      prepared.intent.ownerDeviceId !== ownerDeviceId || prepared.intent.status !== 'prepared') {
    throw new HttpError(409, 'payment_not_pending');
  }
  const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
  await mutate(ownerDeviceId, (record) => {
    if (!record || record.deviceId !== ownerDeviceId || !record.pendingPayment ||
        record.pendingPayment.paymentId !== paymentId ||
        record.pendingPayment.ownerDeviceId !== ownerDeviceId ||
        !['created', 'pending', 'prepared'].includes(record.pendingPayment.status)) {
      throw new HttpError(409, 'payment_not_pending');
    }
    if (record.pendingPayment.status === 'prepared') return { changed: false, record };
    record.pendingPayment.status = 'prepared';
    record.pendingPayment.updatedAt = now;
    record.updatedAt = now;
    return { changed: true, record };
  }, dependencies && dependencies.deviceStore);
  // Reconciliation may finish between the intent and device CAS operations.
  // Never turn a terminal canonical record back into a checkout response.
  const read = (dependencies && dependencies.readIntent) || readIntent;
  const latest = await read(paymentId, dependencies && dependencies.intentStore);
  if (!latest || !latest.intent || latest.intent.paymentId !== paymentId ||
      latest.intent.ownerDeviceId !== ownerDeviceId || latest.intent.status !== 'prepared') {
    throw new HttpError(409, 'payment_not_pending');
  }
  return latest.intent;
}

async function abandonPayment(intent, now, reason, dependencies) {
  const mutatePaymentIntent = (dependencies && dependencies.mutateIntent) || mutateIntent;
  await mutatePaymentIntent(
    intent.paymentId,
    (current) => {
      if (!current || current.ownerDeviceId !== intent.ownerDeviceId) {
        return { changed: false, intent: current };
      }
      if (['paid', 'cancelled'].includes(current.status)) {
        return { changed: false, intent: current };
      }
      current.status = 'abandoned';
      current.decisionReason = reason;
      current.updatedAt = now;
      appendIntentEvent(current, 'abandoned', now, 'abandoned', reason);
      return { changed: true, intent: current };
    },
    dependencies && dependencies.intentStore
  );
  const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
  await mutate(
    intent.ownerDeviceId,
    (record) => {
      if (
        !record ||
        !record.pendingPayment ||
        record.pendingPayment.paymentId !== intent.paymentId
      ) {
        return { changed: false, record };
      }
      record.pendingPayment = null;
      record.updatedAt = now;
      return { changed: true, record };
    },
    dependencies && dependencies.deviceStore
  );
}

async function createPayment(req, config, idempotencyKey, dependencies) {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
  if (!normalizedKey) throw new HttpError(400, 'invalid_idempotency_key');
  const nowMs = Number(dependencies && dependencies.now) || Date.now();
  const now = new Date(nowMs).toISOString();
  const generatedPaymentId = (
    (dependencies && dependencies.newPaymentId) || newPaymentId
  )();
  const contract = paymentContract(config);
  let registrationReserved = false;
  let activeReservation = null;
  const mutateAuth =
    (dependencies && dependencies.mutateAuthenticatedDevice) || mutateAuthenticatedDevice;
  let saved;
  try {
    saved = await mutateAuth(
      req,
      { allowCreate: true },
      async (record, context) => {
        if (publicEntitlement(record, nowMs).lifetime) {
          throw new HttpError(409, 'lifetime_entitlement_active');
        }
        const reserveCapacity =
          (dependencies && dependencies.reserveActiveDevice) || reserveActiveDevice;
        const reservation = await reserveCapacity(
          record,
          dependencies && dependencies.registry
        );
        if (reservation && reservation.created && !activeReservation) {
          activeReservation = {
            deviceId: record.deviceId,
            revision: Math.max(0, Number(record.revision || 0))
          };
        }
        if (context.created && !registrationReserved) {
          const reserve =
            (dependencies && dependencies.reserveDeviceRegistration) || reserveDeviceRegistration;
          await reserve(record, dependencies && dependencies.registry);
          registrationReserved = true;
        }
        const idempotencyHash = paymentIdempotencyHash(record.deviceId, normalizedKey);
        const recovered = recoveredPendingPayment(record);
        if (pendingPaymentActive(record.pendingPayment, nowMs) || recovered) {
          if (record.pendingPayment.ownerDeviceId !== record.deviceId ||
              !sameContract(record.pendingPayment.contract, contract)) {
            throw new HttpError(409, 'payment_intent_conflict');
          }
          const differentKey = record.pendingPayment.idempotencyHash !== idempotencyHash;
          if (differentKey && !recovered) {
            throw new HttpError(409, 'payment_already_pending');
          }
          return {
            changed: false,
            record,
            // Recovery rotates the secret but retains the canonical device.
            // Never rewrite the original idempotency hash or payment ID.
            value: { pending: record.pendingPayment, idempotent: true, resumed: recovered }
          };
        }
        const pending = {
          paymentId: generatedPaymentId,
          ownerDeviceId: record.deviceId,
          idempotencyHash,
          status: 'created',
          contract,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(nowMs + PAYMENT_INTENT_TTL_MS).toISOString()
        };
        record.pendingPayment = pending;
        record.updatedAt = now;
        return { changed: true, record, value: { pending, idempotent: false } };
      }
    );
  } catch (error) {
    if (activeReservation) {
      const release =
        (dependencies && dependencies.releaseActiveDeviceReservation) ||
        releaseActiveDeviceReservation;
      await release(activeReservation, dependencies && dependencies.registry).catch(() => {});
    }
    throw error;
  }
  const pending = saved.value.pending;
  let ensured;
  try {
    ensured = await ensureIntent(pending, dependencies);
    if (!ensured.intent || (!saved.value.resumed &&
        !['created', 'pending', 'prepared'].includes(ensured.intent.status))) {
      throw new HttpError(409, 'payment_not_pending');
    }
  } catch (error) {
    logPaymentFailure('ensure_intent', error);
    throw error;
  }
  let currentIntent = ensured.intent;
  if (saved.value.resumed) {
    const reconciliation = await checkRecoveredPayment(currentIntent, config, nowMs, dependencies);
    // Re-authenticate after the provider lookup: a subsequent recovery must not
    // let this now-revoked browser receive a checkout handoff.
    await mutateAuth(req, { allowCreate: false }, (record) => {
      if (record.deviceId !== currentIntent.ownerDeviceId) throw new HttpError(404, 'payment_not_found');
      return { changed: false, record };
    });
    if (reconciliation) {
      return {
        paymentId: currentIntent.paymentId,
        idempotent: true,
        resumed: true,
        expiresAt: currentIntent.expiresAt,
        reconciliation,
        requestPayment: null,
        plan: { amount: PASS_AMOUNT_KRW, currency: 'KRW', durationDays: PASS_DURATION_DAYS, autoRenew: false }
      };
    }
  }
  if (currentIntent.status !== 'prepared') {
    const preRegister = (dependencies && dependencies.preRegisterPayment) || preRegisterPayment;
    // Client attempts may survive an abandoned intent. Provider keys must instead
    // identify the immutable payment request, while retries keep its existing ID.
    const providerIdempotencyKey = `price-alert-pre-register:${currentIntent.paymentId}`;
    try {
      await preRegister(config, currentIntent, providerIdempotencyKey, dependencies && dependencies.portone);
    } catch (error) {
      logPaymentFailure('pre_register', error);
      if (error instanceof PortOneSafeError) {
        if (!error.retryable) {
          try {
            await abandonPayment(
              currentIntent,
              now,
              error.code || 'portone_pre_register_failed',
              dependencies
            );
          } catch (cleanupError) {
            // Leave any surviving pending state for a retry; do not reset the
            // device or create another payment to conceal this cleanup failure.
            logPaymentFailure('abandon_payment', cleanupError);
          }
        }
        throw new HttpError(error.retryable ? 503 : 502, error.code, error.retryable ? 60 : null);
      }
      throw error;
    }
  }
  try {
    currentIntent = await markPrepared(currentIntent.paymentId, currentIntent.ownerDeviceId, now, dependencies);
  } catch (error) {
    logPaymentFailure('mark_prepared', error);
    throw error;
  }
  return {
    paymentId: currentIntent.paymentId,
    idempotent: saved.value.idempotent || !ensured.written,
    ...(saved.value.resumed ? { resumed: true } : {}),
    expiresAt: currentIntent.expiresAt,
    requestPayment: requestPaymentPayload(currentIntent, config),
    plan: { amount: PASS_AMOUNT_KRW, currency: 'KRW', durationDays: PASS_DURATION_DAYS, autoRenew: false }
  };
}

async function mutateOwnedDeviceForDecision(intent, decision, now, dependencies) {
  const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
  return mutate(
    intent.ownerDeviceId,
    (record) => {
      if (!record) throw new HttpError(404, 'payment_not_found');
      let changed = false;
      let idempotent = true;
      if (decision.action === 'paid') {
        const result = applyPaymentGrant(
          record,
          intent.paymentId,
          decision.effectiveAt || now
        );
        changed = result.changed;
        idempotent = !result.changed;
      } else if (decision.action === 'cancelled') {
        const result = revokePaymentGrant(
          record,
          intent.paymentId,
          decision.effectiveAt || now
        );
        changed = result.changed;
        idempotent = !result.changed;
      } else if (decision.suspendGrant) {
        const result = revokePaymentGrant(
          record,
          intent.paymentId,
          decision.effectiveAt || now
        );
        changed = result.changed;
        idempotent = !result.changed;
        if (Array.isArray(record.pendingNotifications) && record.pendingNotifications.length > 0) {
          record.pendingNotifications = [];
          changed = true;
        }
      }
      if (
        record.pendingPayment &&
        record.pendingPayment.paymentId === intent.paymentId
      ) {
        const terminal = ['paid', 'cancelled', 'abandoned'].includes(decision.action);
        if (terminal) record.pendingPayment = null;
        else {
          record.pendingPayment.status = decision.action;
          record.pendingPayment.updatedAt = now;
        }
        changed = true;
      }
      if (changed) record.updatedAt = now;
      return {
        changed,
        record,
        value: {
          idempotent,
          suspended: Boolean(decision.suspendGrant),
          entitlement: publicEntitlement(record, Date.parse(now))
        }
      };
    },
    dependencies && dependencies.deviceStore
  );
}

async function reconcilePayment(paymentId, ownerDeviceId, config, dependencies) {
  const normalizedPaymentId = normalizePaymentId(paymentId);
  if (!normalizedPaymentId) throw new HttpError(404, 'payment_not_found');
  const read = (dependencies && dependencies.readIntent) || readIntent;
  const loaded = await read(normalizedPaymentId, dependencies && dependencies.intentStore);
  if (!loaded.intent) return { unknown: true };
  const intent = loaded.intent;
  if (ownerDeviceId && intent.ownerDeviceId !== ownerDeviceId) {
    throw new HttpError(404, 'payment_not_found');
  }
  const lookup = (dependencies && dependencies.getPayment) || getPayment;
  let payment;
  try {
    payment = await lookup(config, normalizedPaymentId, dependencies && dependencies.portone);
  } catch (error) {
    if (error instanceof PortOneSafeError) {
      throw new HttpError(error.retryable ? 503 : 502, error.code, error.retryable ? 60 : null);
    }
    throw error;
  }
  let decision = verifyPayment(payment, intent);
  const nowMs = Number(dependencies && dependencies.now) || Date.now();
  const now = new Date(nowMs).toISOString();
  if (
    decision.action === 'paid' &&
    (
      !Number.isFinite(Date.parse(decision.effectiveAt || '')) ||
      !Number.isFinite(Date.parse(intent.createdAt || '')) ||
      !Number.isFinite(Date.parse(intent.expiresAt || '')) ||
      Date.parse(decision.effectiveAt) < Date.parse(intent.createdAt || '') ||
      Date.parse(decision.effectiveAt) > Date.parse(intent.expiresAt || '')
    )
  ) {
    decision = { action: 'review_required', reason: 'paid_outside_intent_window' };
  }
  if (intent.status === 'cancelled' && decision.action === 'paid') {
    decision = { action: 'cancelled', reason: 'already_cancelled' };
  }
  if (
    intent.decisionReason === 'partial_cancellation' &&
    decision.action === 'paid'
  ) {
    decision = {
      action: 'review_required',
      reason: 'partial_cancellation',
      suspendGrant: true,
      effectiveAt: intent.updatedAt || now
    };
  }
  const deviceResult = await mutateOwnedDeviceForDecision(
    intent,
    decision,
    now,
    dependencies
  );
  const mutatePaymentIntent = (dependencies && dependencies.mutateIntent) || mutateIntent;
  const savedIntent = await mutatePaymentIntent(
    intent.paymentId,
    (current) => {
      if (!current || current.ownerDeviceId !== intent.ownerDeviceId) {
        throw new HttpError(404, 'payment_not_found');
      }
      if (current.status === 'cancelled' && decision.action !== 'cancelled') {
        return { changed: false, intent: current };
      }
      if (current.decisionReason === 'partial_cancellation' && decision.action === 'paid') {
        return { changed: false, intent: current };
      }
      current.status = decision.action;
      current.decisionReason = decision.reason;
      current.providerCheckedAt = now;
      current.updatedAt = now;
      const eventType = decision.suspendGrant
        ? deviceResult.value && deviceResult.value.idempotent
          ? 'idempotent'
          : 'suspend'
        : decision.action === 'paid'
        ? deviceResult.value && deviceResult.value.idempotent
          ? 'idempotent'
          : 'grant'
        : decision.action === 'cancelled'
          ? deviceResult.value && deviceResult.value.idempotent
            ? 'idempotent'
            : 'revoke'
          : 'provider_decision';
      appendIntentEvent(current, eventType, now, decision.action, decision.reason);
      return { changed: true, intent: current };
    },
    dependencies && dependencies.intentStore
  );
  // Financial reconciliation must finish before enqueueing the independent mail.
  // Use the final CAS result so a concurrent cancellation cannot send stale PAID mail.
  let ownerNotification;
  try {
    const notify = (dependencies && dependencies.notifyOwnerPayment) || notifyOwnerPayment;
    ownerNotification = await notify({
      payment,
      intent: savedIntent.intent,
      decision,
      ownerRecord: deviceResult.record,
      now: nowMs
    }, dependencies && dependencies.ownerMail);
  } catch (_) {
    // Do not roll back a verified grant/revocation for a notification outage.
    ownerNotification = { state: 'queue_error' };
  }
  return {
    unknown: false,
    paymentId: intent.paymentId,
    status: decision.action,
    idempotent: Boolean(deviceResult.value && deviceResult.value.idempotent),
    entitlement: deviceResult.value && deviceResult.value.entitlement,
    ...(ownerNotification && ownerNotification.state !== 'disabled' ? { ownerNotification } : {})
  };
}

module.exports = {
  appendIntentEvent,
  abandonPayment,
  createPayment,
  ensureIntent,
  markPrepared,
  paymentIntentFromPending,
  reconcilePayment,
  sameContract
};
