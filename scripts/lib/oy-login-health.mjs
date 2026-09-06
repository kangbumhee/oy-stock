import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { acquireRefreshLock } from './oy-refresh-lock.mjs';

const execute = promisify(execFile);
const REASONS = new Set(['reconnect_required', 'check_failed']);
const SOURCES = new Set(['periodic_check', 'daily_refresh']);
const PRODUCTION_CHECK_URL = 'https://olivestock.co.kr/api/oliveyoung/landing-proxy?check=1';

function error(code) { return Object.assign(new Error(code), { code }); }
function iso(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function timestamp(now) {
  const value = new Date(now()).toISOString();
  if (!iso(value)) throw error('OY_LOGIN_HEALTH_CLOCK_INVALID');
  return value;
}
export function validateAlertMetadata(value) {
  if (!value || !REASONS.has(value.reason) || !SOURCES.has(value.source) || !iso(value.detectedAt)) {
    throw error('OY_LOGIN_ALERT_METADATA_INVALID');
  }
  return { reason: value.reason, source: value.source, detectedAt: value.detectedAt };
}

/** Only --check-only is permitted here. Child output is never forwarded. */
export async function checkLocalLogin({ repoRoot, runProcess = execute, env = process.env }) {
  try {
    await runProcess(process.execPath, [path.join(repoRoot, 'scripts', 'refresh-oy-cookie-from-profile.mjs'), '--check-only'], {
      cwd: repoRoot,
      env: { ...env, OY_HEADLESS: '1', OY_UNATTENDED: '1', OY_SKIP_WORKFLOW_DISPATCH: '1' },
      windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024, encoding: 'utf8',
    });
    return 0;
  } catch (failure) {
    return failure.code === 42 ? 42 : failure.code === 75 ? 75 : 1;
  }
}

/** This GET inspects deployed JWT expiry only; it never invokes the landing API. */
export async function checkProductionLogin({ fetchImpl = fetch, now = Date.now } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(PRODUCTION_CHECK_URL, {
      method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) return 1;
    const payload = await response.json();
    // Ignore response subject, JWT source, and every other field.
    if (payload?.jwtValid === false) return 42;
    if (payload?.jwtValid === true && typeof payload.jwtExpSeconds === 'number'
      && Number.isFinite(payload.jwtExpSeconds) && payload.jwtExpSeconds > now() / 1000) return 0;
    return 1;
  } catch { return 1; }
  finally { clearTimeout(timeout); }
}

function safeDelivery(value = {}) {
  return {
    dispatchAccepted: value.dispatchAccepted === true,
    attempts: Number.isInteger(value.attempts) ? Math.min(3, Math.max(0, value.attempts)) : 0,
    runId: Number.isSafeInteger(value.runId) && value.runId > 0 ? value.runId : null,
  };
}

export async function dispatchLoginAlert({ repoRoot, metadata, delivery, runProcess = execute, env = process.env }) {
  const safe = validateAlertMetadata(metadata);
  const progress = safeDelivery(delivery);
  const title = `OY login alert ${safe.detectedAt}`;
  let repository = String(env.GITHUB_REPO || env.GITHUB_REPOSITORY || '').trim();
  const options = { cwd: repoRoot, env, windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024, encoding: 'utf8' };
  try {
    if (!repository) {
      const result = await runProcess('git', ['config', '--get', 'remote.origin.url'], options);
      const match = String(result.stdout || '').trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
      repository = match ? `${match[1]}/${match[2]}` : '';
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw error('OY_LOGIN_ALERT_REPOSITORY_INVALID');
    if (!progress.runId) {
      const listed = await runProcess('gh', ['run', 'list', '--workflow', 'oy-login-alert.yml', '--repo', repository,
        '--limit', '100', '--json', 'databaseId,displayTitle,status'], options);
      const runs = JSON.parse(listed.stdout);
      if (!Array.isArray(runs)) throw error('OY_LOGIN_ALERT_RUN_INVALID');
      const match = runs.find((run) => run.displayTitle === title && Number.isSafeInteger(run.databaseId) && run.databaseId > 0);
      if (match) progress.runId = match.databaseId;
    }
    if (progress.runId) {
      const viewed = await runProcess('gh', ['api', `repos/${repository}/actions/runs/${progress.runId}`], options);
      const run = JSON.parse(viewed.stdout);
      if (run.display_title !== title || !Number.isInteger(run.run_attempt) || run.run_attempt < 1) throw error('OY_LOGIN_ALERT_RUN_INVALID');
      progress.dispatchAccepted = true;
      progress.attempts = Math.min(3, Math.max(progress.attempts, run.run_attempt));
      if (run.status !== 'completed') return { status: 'pending', delivery: progress };
      const details = await runProcess('gh', ['run', 'view', String(progress.runId), '--repo', repository, '--json', 'jobs'], options);
      const jobs = JSON.parse(details.stdout)?.jobs;
      if (!Array.isArray(jobs)) throw error('OY_LOGIN_ALERT_RUN_INVALID');
      const steps = jobs.flatMap((job) => Array.isArray(job.steps) ? job.steps : []).filter((step) => step.name === 'Send reconnect email');
      if (steps.length === 1 && steps[0].conclusion === 'success') return { status: 'sent', delivery: progress };
      if (steps.length > 1 || progress.attempts >= 3) return { status: 'failed', delivery: progress };
      // The final workflow step deliberately fails. Re-run only when email itself
      // failed/skipped, or execution failed before the email step was reached.
      progress.attempts++;
      await runProcess('gh', ['run', 'rerun', String(progress.runId), '--failed', '--repo', repository], options);
      return { status: 'pending', delivery: progress };
    }
    // Accepted dispatch may not be visible immediately; never create a duplicate.
    if (progress.dispatchAccepted) return { status: 'pending', delivery: progress };
    if (progress.attempts >= 3) return { status: 'failed', delivery: progress };
    progress.attempts++;
    await runProcess('gh', ['workflow', 'run', 'oy-login-alert.yml', '--repo', repository,
      '-f', `reason=${safe.reason}`, '-f', `source=${safe.source}`, '-f', `detectedAt=${safe.detectedAt}`], options);
    progress.dispatchAccepted = true;
    return { status: 'pending', delivery: progress };
  } catch { return { status: 'failed', delivery: progress }; }
}

function initialState() {
  return { version: 1, consecutiveFailures: 0, incident: null, lastHealthyAt: null, lastCheckedAt: null };
}
async function readState(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw error('OY_LOGIN_HEALTH_STATE_INVALID');
    const raw = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (raw?.version !== 1) return initialState();
    const state = initialState();
    state.consecutiveFailures = Number.isInteger(raw.consecutiveFailures) ? Math.min(3, Math.max(0, raw.consecutiveFailures)) : 0;
    state.lastHealthyAt = iso(raw.lastHealthyAt) ? raw.lastHealthyAt : null;
    state.lastCheckedAt = iso(raw.lastCheckedAt) ? raw.lastCheckedAt : null;
    if (raw.incident && REASONS.has(raw.incident.reason) && SOURCES.has(raw.incident.source) && iso(raw.incident.detectedAt)) {
      state.incident = { ...validateAlertMetadata(raw.incident), notifiedAt: iso(raw.incident.notifiedAt) ? raw.incident.notifiedAt : null,
        delivery: safeDelivery(raw.incident.delivery) };
    }
    return state;
  } catch (failure) {
    if (failure.code === 'ENOENT' || failure instanceof SyntaxError) return initialState();
    throw error('OY_LOGIN_HEALTH_STATE_INVALID');
  }
}
async function writeState(filename, state) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function recordOutcome({ repoRoot, exitCode, source, immediate = false, dispatchAlert, now = Date.now, statePath }) {
  const status = exitCode === 0 ? 'healthy' : exitCode === 42 ? 'reconnect_required' : exitCode === 75 ? 'busy' : 'check_failed';
  if (exitCode === 75) return { exitCode: 75, status, notification: 'not_needed' };
  const filename = statePath || path.join(repoRoot, '.auth', 'oy-login-health.json');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  let release;
  try { release = await acquireRefreshLock(repoRoot, { scope: 'health-state' }); }
  catch (failure) {
    if (failure.code === 'OY_REFRESH_BUSY') return { exitCode: 75, status: 'busy', notification: 'not_needed' };
    throw error('OY_LOGIN_HEALTH_STATE_INVALID');
  }
  try {
    const state = await readState(filename);
    const at = timestamp(now);
    state.lastCheckedAt = at;
    if (exitCode === 0) {
      state.lastHealthyAt = at;
      state.consecutiveFailures = 0;
      state.incident = null;
      await writeState(filename, state);
      return { exitCode: 0, status, notification: 'not_needed', consecutiveFailures: 0 };
    }
    state.consecutiveFailures = exitCode === 42 ? 0 : Math.min(3, state.consecutiveFailures + 1);
    const shouldAlert = exitCode === 42 || immediate || state.consecutiveFailures >= 3;
    if (shouldAlert && !state.incident) {
      state.incident = { reason: exitCode === 42 ? 'reconnect_required' : 'check_failed', source, detectedAt: at, notifiedAt: null, delivery: safeDelivery() };
    }
    // Persist pending delivery before attempting the network call; retry on the next check if dispatch fails.
    await writeState(filename, state);
    let notification = state.incident?.notifiedAt ? 'already_sent' : 'not_needed';
    if (state.incident && !state.incident.notifiedAt) {
      try {
        const send = dispatchAlert || ((metadata, delivery) => dispatchLoginAlert({ repoRoot, metadata, delivery }));
        const result = await send(validateAlertMetadata(state.incident), safeDelivery(state.incident.delivery));
        if (result?.delivery) state.incident.delivery = safeDelivery(result.delivery);
        if (result === true || result?.status === 'sent') {
          state.incident.notifiedAt = at;
          notification = 'sent';
        } else if (result?.status === 'pending') notification = 'pending';
        else notification = 'dispatch_failed';
        await writeState(filename, state);
      } catch { notification = 'dispatch_failed'; }
    }
    return { exitCode: notification === 'dispatch_failed' ? 1 : exitCode, status, notification, consecutiveFailures: state.consecutiveFailures };
  } finally { await release(); }
}

export async function runLoginHealthCheck({ repoRoot, runCheck, checkProduction, ...options }) {
  let local;
  try { local = await (runCheck || (() => checkLocalLogin({ repoRoot })))(); }
  catch { local = 1; }
  if (![0, 42, 75].includes(local)) local = 1;
  let exitCode = local;
  if (local !== 75 && local !== 42) {
    let production;
    try { production = await (checkProduction || (() => checkProductionLogin()))(); }
    catch { production = 1; }
    if (production === 42) exitCode = 42;
    else if (production !== 0 || local !== 0) exitCode = 1;
  }
  return recordOutcome({ repoRoot, ...options, exitCode, source: 'periodic_check' });
}

export async function reportRefreshFailure({ repoRoot, exitCode, ...options }) {
  const normalized = exitCode === 42 ? 42 : exitCode === 75 ? 75 : 1;
  return recordOutcome({ repoRoot, ...options, exitCode: normalized, source: 'daily_refresh', immediate: true });
}

/** Call only after the daily refresh and publication have both succeeded. */
export async function reportRefreshSuccess({ repoRoot, ...options }) {
  return recordOutcome({ repoRoot, ...options, exitCode: 0, source: 'daily_refresh' });
}
