const service = require('./_account-service');
const { HttpError, assertSameOrigin, handleHttpError, methodNotAllowed, readJson, sendJson } = require('./_http');
const { consumeRateLimit } = require('./_limits');

function createAccountHandler(dependencies = {}) {
  const calls = { ...service, ...dependencies };
  const rateLimit = dependencies.consumeRateLimit || consumeRateLimit;
  return async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
    try {
      assertSameOrigin(req);
      if (req.method === 'GET') {
        await rateLimit(req, 'account_read');
        return sendJson(res, 200, await calls.accountStatus(req, dependencies));
      }
      const body = await readJson(req, 2048);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          typeof body.action !== 'string') {
        throw new HttpError(400, 'invalid_account_request');
      }
      const actions = {
        'request-verification': { scope: 'account_send', fields: ['action', 'email'], call: calls.requestEmailVerification },
        'verify-email': { scope: 'account_verify', fields: ['action', 'email', 'code'], call: calls.verifyEmail },
        'request-recovery': { scope: 'account_send', fields: ['action', 'email'], call: calls.requestRecovery },
        recover: { scope: 'account_verify', fields: ['action', 'email', 'code'], call: calls.recoverAccount },
        'record-visit': { scope: 'account_visit', fields: ['action', 'visitId'], call: calls.recordVisit }
      };
      const selected = Object.prototype.hasOwnProperty.call(actions, body.action) ? actions[body.action] : null;
      if (!selected || Object.keys(body).some((key) => !selected.fields.includes(key)) ||
          selected.fields.some((key) => typeof body[key] !== 'string') ||
          (body.email != null && body.email.length > 254) ||
          (body.code != null && body.code.length > 160) ||
          (body.visitId != null && !/^[A-Za-z0-9_-]{20,80}$/.test(body.visitId))) {
        throw new HttpError(400, 'invalid_account_request');
      }
      await rateLimit(req, selected.scope);
      const result = selected.scope === 'account_visit'
        ? await selected.call(req, body.visitId, dependencies)
        : selected.scope === 'account_send'
          ? await selected.call(req, body.email, dependencies)
          : await selected.call(req, body.email, body.code, dependencies);
      return sendJson(res, 200, result);
    } catch (error) {
      return handleHttpError(res, error);
    }
  };
}

module.exports = createAccountHandler();
module.exports._test = { createAccountHandler };
