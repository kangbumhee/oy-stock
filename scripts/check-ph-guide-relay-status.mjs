// Read-only deployed status check: SMTP.verify(), never sendMail or a PG charge.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_ORIGIN } from './configure-ph-guide-relay.mjs';

export const STATUS_URL = 'https://olivestock.co.kr/api/ph-guide';
class StatusError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export async function checkRelayStatus(env, dependencies = {}) {
  const secret = env.PH_GUIDE_RELAY_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 2048 || /[\x00-\x20\x7f]/.test(secret)) {
    throw new StatusError('invalid_configuration');
  }
  let response;
  try {
    response = await (dependencies.fetch || fetch)(STATUS_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', verifySmtp: true })
    });
  } catch { throw new StatusError('status_unavailable'); }
  if (!response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status : undefined;
    throw new StatusError('status_rejected', status);
  }
  let result;
  try { result = await response.json(); } catch { throw new StatusError('status_invalid_response'); }
  if (!result || result.success !== true || typeof result.mailReady !== 'boolean' ||
      typeof result.paymentReady !== 'boolean' || ![true, false, null].includes(result.smtpVerified) ||
      result.siteOrigin !== SITE_ORIGIN) throw new StatusError('status_invalid_response');
  // Never expose the response body, store/channel IDs or any inherited configuration.
  return { smtpVerified: result.smtpVerified === true, mailConfigured: result.mailReady,
    portOneConfigured: result.paymentReady, siteOriginMatches: true };
}

export async function runRelayStatus(env, dependencies = {}) {
  const log = dependencies.log || console.log;
  const errorLog = dependencies.errorLog || console.error;
  try {
    const status = await checkRelayStatus(env, dependencies);
    log(`PH relay diagnostics: SMTP authentication ${status.smtpVerified ? 'verified' : 'not verified'}; mail configuration ${status.mailConfigured ? 'ready' : 'incomplete'}; PortOne configuration ${status.portOneConfigured ? 'present' : 'incomplete'}; site origin matches.`);
    log('No email was sent. No PortOne payment, cancellation or live payment API verification was performed.');
    return status.smtpVerified && status.mailConfigured && status.portOneConfigured ? 0 : 1;
  } catch (error) {
    const safe = error instanceof StatusError ? error.code : 'status_failed';
    errorLog(`PH relay diagnostics failed: ${safe}${error instanceof StatusError && error.status ? ` (HTTP ${error.status})` : ''}.`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRelayStatus(process.env);
}
