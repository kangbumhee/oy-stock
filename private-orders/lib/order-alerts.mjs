import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const WORKFLOW = 'oy-purchase-alert.yml';
const EMAIL_STEP = 'Send purchase reconnect email';
const REASONS = new Set(['reconnect_required', 'check_failed']);
const AUTH_CODES = new Set(['AUTH_REQUIRED', 'SESSION_INVALID', 'CREDENTIALS_REJECTED', 'ADDITIONAL_VERIFICATION',
  'CAPTCHA_NOT_CLEARED', 'CAPTCHA_AUTOMATIC_DISABLED', 'AUTO_REFRESH_PAUSED']);
const ATTENTION_CODES = new Set(['DAILY_BUDGET_EXHAUSTED', 'MONTHLY_BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED']);
const SKIPPED = new Set(['cancelled', 'busy', 'skipped']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ATTEMPTS = 3;
const PENDING_LIMIT_MS = 30 * 60 * 1000;

function failure(code) { return Object.assign(new Error(code), { code, storeValidation: true }); }
function iso(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function at(clock) {
  try { return new Date(clock()).toISOString(); }
  catch { throw failure('ORDER_ALERT_CLOCK_INVALID'); }
}
function count(value) { return Number.isInteger(value) ? Math.min(MAX_ATTEMPTS, Math.max(0, value)) : 0; }

export function validatePurchaseAlertMetadata(value) {
  if (!value || !UUID.test(value.incidentId || '') || !REASONS.has(value.reason) || !iso(value.detectedAt)) {
    throw failure('ORDER_ALERT_METADATA_INVALID');
  }
  return { incidentId: value.incidentId, reason: value.reason, detectedAt: value.detectedAt };
}

function safeDelivery(value = {}) {
  return {
    status: ['pending', 'sent', 'failed'].includes(value.status) ? value.status : 'pending',
    dispatchAttempted: value.dispatchAttempted === true,
    attempts: count(value.attempts), failures: count(value.failures),
    requestedAttempt: count(value.requestedAttempt),
    runId: Number.isSafeInteger(value.runId) && value.runId > 0 ? value.runId : null,
    lastAttemptAt: iso(value.lastAttemptAt) ? value.lastAttemptAt : null,
    nextAttemptAt: iso(value.nextAttemptAt) ? value.nextAttemptAt : null,
    sentAt: iso(value.sentAt) ? value.sentAt : null,
  };
}

function alertState(state) {
  const previous = state.orderAlerts;
  if (previous != null && (previous.version !== 1 || !previous.accounts || typeof previous.accounts !== 'object'
    || Array.isArray(previous.accounts))) throw failure('ORDER_ALERT_STATE_INVALID');
  const accounts = {};
  for (const account of state.accounts || []) {
    if (account.enabled === false || typeof account.id !== 'string') continue;
    const saved = Object.hasOwn(previous?.accounts || {}, account.id) ? previous.accounts[account.id] : null;
    if (!saved) continue;
    let incident = null;
    if (saved.incident) {
      incident = { ...validatePurchaseAlertMetadata(saved.incident),
        source: saved.incident.source === 'health_check' ? 'health_check' : 'sync', delivery: safeDelivery(saved.incident.delivery) };
    }
    Object.defineProperty(accounts, account.id, { enumerable: true, configurable: true, writable: true,
      value: { consecutiveFailures: count(saved.consecutiveFailures), lastCheckedAt: iso(saved.lastCheckedAt) ? saved.lastCheckedAt : null,
        lastHealthyAt: iso(saved.lastHealthyAt) ? saved.lastHealthyAt : null, incident } });
  }
  return { version: 1, accounts };
}

/** Only random incident metadata crosses the public GitHub boundary. CLI diagnostics are discarded. */
export async function dispatchPurchaseAlert({ repoRoot, metadata, delivery, checkpoint = async () => true,
  runProcess = execute, env = process.env, clock = Date.now } = {}) {
  const safe = validatePurchaseAlertMetadata(metadata);
  let progress = safeDelivery(delivery);
  const title = `OY purchase alert ${safe.incidentId}`;
  const options = { cwd: repoRoot, env, windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, encoding: 'utf8' };
  const result = (status) => ({ status, delivery: { ...progress, status } });
  const expired = () => progress.lastAttemptAt && Date.parse(at(clock)) - Date.parse(progress.lastAttemptAt) >= PENDING_LIMIT_MS;
  const save = async () => (await checkpoint(safeDelivery(progress))) !== false;
  try {
    if (progress.status === 'sent' || progress.status === 'failed') return result(progress.status);
    let repository = String(env.GITHUB_REPO || env.GITHUB_REPOSITORY || '').trim();
    if (!repository) {
      const found = await runProcess('git', ['config', '--get', 'remote.origin.url'], options);
      const match = String(found.stdout || '').trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
      repository = match ? `${match[1]}/${match[2]}` : '';
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw failure('ORDER_ALERT_REPOSITORY_INVALID');
    if (!progress.runId) {
      const listed = await runProcess('gh', ['run', 'list', '--workflow', WORKFLOW, '--repo', repository,
        '--limit', '100', '--json', 'databaseId,displayTitle'], options);
      const runs = JSON.parse(listed.stdout);
      if (!Array.isArray(runs)) throw failure('ORDER_ALERT_RUN_INVALID');
      const matches = runs.filter(run => run.displayTitle === title && Number.isSafeInteger(run.databaseId) && run.databaseId > 0);
      if (matches.length > 1) return result('failed');
      if (matches.length === 1) { progress.runId = matches[0].databaseId; progress.dispatchAttempted = true; }
    }
    if (!progress.runId) {
      // A dispatch timeout/crash can mean GitHub accepted it. Never dispatch that incident a second time.
      if (progress.dispatchAttempted) return result(expired() ? 'failed' : 'pending');
      if (progress.attempts >= MAX_ATTEMPTS) return result('failed');
      progress = { ...progress, dispatchAttempted: true, attempts: 1, requestedAttempt: 1, lastAttemptAt: at(clock) };
      if (!await save()) return result('pending');
      await runProcess('gh', ['workflow', 'run', WORKFLOW, '--repo', repository,
        '-f', `incidentId=${safe.incidentId}`, '-f', `reason=${safe.reason}`, '-f', `detectedAt=${safe.detectedAt}`], options);
      return result('pending');
    }
    const viewed = await runProcess('gh', ['api', `repos/${repository}/actions/runs/${progress.runId}`], options);
    const run = JSON.parse(viewed.stdout);
    if (run.display_title !== title || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || (run.path && run.path !== `.github/workflows/${WORKFLOW}`)) throw failure('ORDER_ALERT_RUN_INVALID');
    progress.attempts = Math.min(MAX_ATTEMPTS, Math.max(progress.attempts, run.run_attempt));
    // A rerun accepted but not visible yet must not cause another rerun of the old attempt.
    if (run.run_attempt < progress.requestedAttempt) return result(expired() ? 'failed' : 'pending');
    if (run.status !== 'completed') return result(expired() ? 'failed' : 'pending');
    const details = await runProcess('gh', ['run', 'view', String(progress.runId), '--repo', repository,
      '--attempt', String(run.run_attempt), '--json', 'jobs'], options);
    const jobs = JSON.parse(details.stdout)?.jobs;
    if (!Array.isArray(jobs)) throw failure('ORDER_ALERT_RUN_INVALID');
    const steps = jobs.flatMap(job => Array.isArray(job.steps) ? job.steps : []).filter(step => step.name === EMAIL_STEP);
    if (steps.length === 1 && steps[0].conclusion === 'success') return result('sent');
    if (steps.length > 1 || progress.attempts >= MAX_ATTEMPTS) return result('failed');
    // Unknown SMTP outcome is not retried automatically: it may already have delivered.
    if (steps.length === 1 && !['failure', 'skipped'].includes(steps[0].conclusion)) return result('failed');
    progress.attempts += 1;
    progress.requestedAttempt = run.run_attempt + 1;
    progress.lastAttemptAt = at(clock);
    if (!await save()) return result('pending');
    await runProcess('gh', ['run', 'rerun', String(progress.runId), '--failed', '--repo', repository], options);
    return result('pending');
  } catch {
    return { ...result('pending'), retryableFailure: true };
  }
}

/** State is updated exclusively through the host's serialized encrypted store. No separate state file. */
export function createOrderAlerts({ store, repoRoot, runProcess, env, clock = Date.now, dispatchAlert } = {}) {
  if (!store?.read || !store?.update) throw new TypeError('A serialized encrypted store is required');
  let flushing = null;
  async function recordOutcome({ accountId, status, code, source = 'sync' } = {}) {
    if (typeof accountId !== 'string' || !accountId || !['sync', 'health_check'].includes(source)) throw failure('ORDER_ALERT_OUTCOME_INVALID');
    if (SKIPPED.has(status) || code === 'ABORTED' || code === 'ACCOUNT_CHANGED' || code === 'ACCOUNT_DISABLED') return { status: 'ignored' };
    let outcome = { status: 'ignored' };
    await store.update(state => {
      if (!state.accounts.some(account => account.id === accountId && account.enabled !== false)) return;
      const alerts = alertState(state);
      const saved = Object.hasOwn(alerts.accounts, accountId) ? alerts.accounts[accountId]
        : { consecutiveFailures: 0, lastCheckedAt: null, lastHealthyAt: null, incident: null };
      const checkedAt = at(clock);
      saved.lastCheckedAt = checkedAt;
      if (status === 'success' || status === 'healthy') {
        saved.consecutiveFailures = 0;
        saved.lastHealthyAt = checkedAt;
        // An authenticated health page does not prove a prior order-collection failure recovered.
        if (source === 'sync' || saved.incident?.source === 'health_check' || saved.incident?.reason === 'reconnect_required') saved.incident = null;
        outcome = { status: 'healthy', notification: saved.incident ? saved.incident.delivery.status : 'not_needed' };
      } else {
        const authFailure = AUTH_CODES.has(code);
        saved.consecutiveFailures = authFailure ? 0 : Math.min(MAX_ATTEMPTS, saved.consecutiveFailures + 1);
        const shouldAlert = authFailure || ATTENTION_CODES.has(code) || saved.consecutiveFailures >= MAX_ATTEMPTS;
        const reason = authFailure ? 'reconnect_required' : 'check_failed';
        if (shouldAlert && (!saved.incident || (authFailure && saved.incident.reason !== reason))) {
          saved.incident = { incidentId: randomUUID(), reason, detectedAt: checkedAt, source, delivery: safeDelivery() };
        }
        outcome = { status: 'recorded', consecutiveFailures: saved.consecutiveFailures,
          notification: saved.incident?.delivery.status || 'not_needed' };
      }
      Object.defineProperty(alerts.accounts, accountId, { value: saved, enumerable: true, configurable: true, writable: true });
      state.orderAlerts = alerts;
    });
    return outcome;
  }

  async function status() {
    const alerts = alertState(await store.read());
    const summary = { incidents: 0, pending: 0, sent: 0, failed: 0 };
    for (const account of Object.values(alerts.accounts)) if (account.incident) {
      summary.incidents += 1; summary[account.incident.delivery.status] += 1;
    }
    return summary;
  }

  async function deliver() {
    const snapshot = alertState(await store.read());
    for (const [accountId, account] of Object.entries(snapshot.accounts)) {
      const incident = account.incident;
      if (!incident || incident.delivery.status !== 'pending' || (incident.delivery.nextAttemptAt
        && Date.parse(incident.delivery.nextAttemptAt) > Date.parse(at(clock)))) continue;
      const metadata = validatePurchaseAlertMetadata(incident);
      const checkpoint = async (delivery) => {
        let active = false;
        await store.update(state => {
          const alerts = alertState(state);
          const current = alerts.accounts[accountId]?.incident;
          if (current?.incidentId === incident.incidentId && current.delivery.status === 'pending') {
            current.delivery = safeDelivery(delivery); state.orderAlerts = alerts; active = true;
          }
        });
        return active;
      };
      // Recheck enabled/account/incident state before invoking even an injected adapter.
      if (!await checkpoint(incident.delivery)) continue;
      let result;
      try {
        const send = dispatchAlert || (options => dispatchPurchaseAlert({ repoRoot, runProcess, env, clock, ...options }));
        result = await send({ metadata, delivery: structuredClone(incident.delivery), checkpoint });
      } catch { result = { status: 'pending', retryableFailure: true }; }
      await store.update(state => {
        const alerts = alertState(state);
        const current = alerts.accounts[accountId]?.incident;
        if (current?.incidentId !== incident.incidentId || current.delivery.status !== 'pending') return;
        const delivery = safeDelivery(result?.delivery || current.delivery);
        const failed = result?.retryableFailure === true || !['pending', 'sent', 'failed'].includes(result?.status);
        delivery.failures = failed ? Math.min(MAX_ATTEMPTS, current.delivery.failures + 1) : 0;
        delivery.status = result?.status === 'sent' ? 'sent' : result?.status === 'failed' || delivery.failures >= MAX_ATTEMPTS ? 'failed' : 'pending';
        delivery.sentAt = delivery.status === 'sent' ? at(clock) : null;
        delivery.nextAttemptAt = delivery.status === 'pending'
          ? new Date(Date.parse(at(clock)) + (failed ? 60000 * (2 ** (delivery.failures - 1)) : 60000)).toISOString() : null;
        current.delivery = delivery; state.orderAlerts = alerts;
      });
    }
    return status();
  }
  function flush() {
    if (!flushing) flushing = deliver().finally(() => { flushing = null; });
    return flushing;
  }
  return { recordOutcome, flush, status };
}

export async function sendPurchaseAlert({ env = process.env, createTransport } = {}) {
  const metadata = validatePurchaseAlertMetadata({ incidentId: env.OY_PURCHASE_ALERT_ID,
    reason: env.OY_PURCHASE_ALERT_REASON, detectedAt: env.OY_PURCHASE_ALERT_DETECTED_AT });
  const from = String(env.ALERT_EMAIL_FROM || '').trim();
  const pass = String(env.ALERT_EMAIL_PASSWORD || '').trim();
  const to = String(env.ALERT_EMAIL_TO || '').trim();
  if (!from || !pass || !to || /[\0\r\n]/.test(from + pass + to) || from.length > 320 || to.length > 1024) {
    throw failure('ORDER_ALERT_EMAIL_NOT_CONFIGURED');
  }
  let transporter;
  try {
    const makeTransport = createTransport || (await import('nodemailer')).default.createTransport;
    transporter = makeTransport({ service: 'gmail', auth: { user: from, pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    const reconnect = metadata.reason === 'reconnect_required';
    await transporter.sendMail({ from, to,
      subject: reconnect ? '[구매노트] 구매 계정 재연결 필요' : '[구매노트] 구매 내역 갱신 / 상태 확인 실패',
      text: [reconnect ? '개인 구매노트의 구매 계정 연결 확인이 필요합니다.' : '개인 구매노트에서 갱신 또는 상태 확인 오류를 감지했습니다.',
        `감지 시각: ${new Date(metadata.detectedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)`,
        '구매노트에 지정된 Google 계정으로 로그인한 뒤 구매 계정별 오류를 확인해 주세요.',
        'https://orders.cp1.co.kr',
        '추가 본인인증이 필요하면 직접 인증한 뒤 해당 구매 계정 하나를 갱신해 연결을 확인해 주세요.',
        '주문 수집은 24시간 간격입니다. 같은 장애의 반복 알림은 정상 복구가 확인될 때까지 생략합니다.',
        '반복 인증 보호 상태에서는 확인이 끝날 때까지 자동 갱신이 중지될 수 있습니다.',
        `알림 번호: ${metadata.incidentId}`,
        '이 알림에는 구매 계정 ID, 주문, 수령인, 비밀번호, 쿠키 또는 API 키가 포함되지 않습니다.'].join('\n\n') });
    return { sent: true, reason: metadata.reason };
  } catch { throw failure('ORDER_ALERT_SMTP_FAILED'); }
  finally { try { transporter?.close?.(); } catch { } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--send-email') throw failure('ORDER_ALERT_ARGUMENTS_INVALID');
    await sendPurchaseAlert();
    process.stdout.write('ORDER_ALERT_EMAIL_SENT\n');
  } catch {
    process.stderr.write('ORDER_ALERT_EMAIL_FAILED\n');
    process.exitCode = 1;
  }
}
