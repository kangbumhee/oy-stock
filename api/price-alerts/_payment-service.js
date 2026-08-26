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
  await mutatePaymentIntent(
    paymentId,
    (intent) => {
      if (!intent || intent.ownerDeviceId !== ownerDeviceId) {
        throw new HttpError(404, 'payment_not_found');
      }
      if (intent.status === 'prepared') return { changed: false, intent };
      if (!['created', 'pending'].includes(intent.status)) {
        return { changed: false, intent };
      }
      intent.status = 'prepared';
      intent.updatedAt = now;
      appendIntentEvent(intent, 'pre_registered', now, 'prepared', 'portone_pre_registered');
      return { changed: true, intent };
    },
    dependencies
  );
  const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
  await mutate(ownerDeviceId, (record) => {
    if (!record || !record.pendingPayment || record.pendingPayment.paymentId !== paymentId) {
      return { changed: false, record };
    }
    record.pendingPayment.status = 'prepared';
    record.pendingPayment.updatedAt = now;
    record.updatedAt = now;
    return { changed: true, record };
  }, dependencies && dependencies.deviceStore);
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
        if (pendingPaymentActive(record.pendingPayment, nowMs)) {
          if (record.pendingPayment.idempotencyHash !== idempotencyHash) {
            throw new HttpError(409, 'payment_already_pending');
          }
          return {
            changed: false,
            record,
            value: { pending: record.pendingPayment, idempotent: true }
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
  const ensured = await ensureIntent(pending, dependencies);
  const currentIntent = ensured.intent;
  if (currentIntent.status !== 'prepared') {
    const preRegister = (dependencies && dependencies.preRegisterPayment) || preRegisterPayment;
    try {
      await preRegister(config, currentIntent, normalizedKey, dependencies && dependencies.portone);
    } catch (error) {
      if (error instanceof PortOneSafeError) {
        if (!error.retryable) {
          await abandonPayment(
            currentIntent,
            now,
            error.code || 'portone_pre_register_failed',
            dependencies
          );
        }
        throw new HttpError(error.retryable ? 503 : 502, error.code, error.retryable ? 60 : null);
      }
      throw error;
    }
    await markPrepared(currentIntent.paymentId, currentIntent.ownerDeviceId, now, dependencies);
    currentIntent.status = 'prepared';
  }
  return {
    paymentId: currentIntent.paymentId,
    idempotent: saved.value.idempotent || !ensured.written,
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
  await mutatePaymentIntent(
    intent.paymentId,
    (current) => {
      if (!current || current.ownerDeviceId !== intent.ownerDeviceId) {
        throw new HttpError(404, 'payment_not_found');
      }
      if (current.status === 'cancelled' && decision.action !== 'cancelled') {
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
  return {
    unknown: false,
    paymentId: intent.paymentId,
    status: decision.action,
    idempotent: Boolean(deviceResult.value && deviceResult.value.idempotent),
    entitlement: deviceResult.value && deviceResult.value.entitlement
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
