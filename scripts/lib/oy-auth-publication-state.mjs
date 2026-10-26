import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { acquireRefreshLock } from './oy-refresh-lock.mjs';

const execute = promisify(execFile);
const WORKFLOW = 'refresh-oy-linkage.yml';
const WORKFLOW_NAME = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const CHECK_URL = 'https://oy-stock.vercel.app/api/oliveyoung/landing-proxy?check=1';
const MAX_AGE_MS = 90 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const FIELDS = ['version', 'requestId', 'requestedAt', 'repository', 'workflow', 'runId', 'expectedExpiry', 'expectedFingerprint'];

function failure(code) { return Object.assign(new Error(code), { code }); }
function filenameFor(repoRoot, statePath) { return statePath || path.join(repoRoot, '.auth', 'oy-auth-publication.json'); }
function titleFor(record) { return `OY auth publication ${record.requestId}`; }
function validRecord(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).length === FIELDS.length && Object.keys(record).every(key => FIELDS.includes(key))
    && record.version === 1 && UUID.test(record.requestId) && REPOSITORY.test(record.repository)
    && typeof record.workflow === 'string' && WORKFLOW_NAME.test(record.workflow)
    && (record.runId === null || Number.isSafeInteger(record.runId) && record.runId > 0)
    && typeof record.requestedAt === 'string' && Number.isFinite(Date.parse(record.requestedAt))
    && new Date(record.requestedAt).toISOString() === record.requestedAt
    && Number.isSafeInteger(record.expectedExpiry) && record.expectedExpiry > 0
    && typeof record.expectedFingerprint === 'string' && FINGERPRINT.test(record.expectedFingerprint);
}

async function ensureDirectory(filename, create = false) {
  const directory = path.dirname(filename);
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('OY_AUTH_PUBLICATION_STATE_INVALID');
}

async function readRecord(filename) {
  try {
    await ensureDirectory(filename);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw failure('OY_AUTH_PUBLICATION_STATE_INVALID');
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!validRecord(record)) throw failure('OY_AUTH_PUBLICATION_STATE_INVALID');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('OY_AUTH_PUBLICATION_STATE_INVALID');
  }
}

async function writeRecord(filename, record) {
  if (!validRecord(record)) throw failure('OY_AUTH_PUBLICATION_STATE_INVALID');
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > 4096) throw failure('OY_AUTH_PUBLICATION_STATE_INVALID');
  await ensureDirectory(filename, true);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function locked(repoRoot, operation) {
  const release = await acquireRefreshLock(repoRoot, { scope: 'publication-state' });
  try { return await operation(); } finally { await release(); }
}

function optionsFor(repoRoot, env = process.env) {
  return { cwd: repoRoot, env, windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024, encoding: 'utf8' };
}

function pending(record, now, reason, allowLateCompletion = false) {
  const time = now();
  if (!Number.isFinite(time) || Date.parse(record.requestedAt) > time + 60000) return { status: 'failed', reason: 'state_clock_invalid', runId: record.runId };
  if (record.expectedExpiry <= time / 1000 + 60) return { status: 'failed', reason: 'publication_token_expired', runId: record.runId };
  if (!allowLateCompletion && time - Date.parse(record.requestedAt) >= MAX_AGE_MS) return { status: 'failed', reason: 'publication_timeout', runId: record.runId };
  return { status: 'pending', reason, runId: record.runId };
}

/** Persist the request before dispatch. An ambiguous network error must never cause another dispatch. */
export async function startAuthPublication({ repoRoot, expectedExpiry, expectedFingerprint, env = process.env, runProcess = execute, now = Date.now, statePath } = {}) {
  const time = now();
  if (!Number.isFinite(time) || !Number.isSafeInteger(expectedExpiry) || expectedExpiry <= time / 1000 + 60
    || typeof expectedFingerprint !== 'string' || !FINGERPRINT.test(expectedFingerprint)) throw failure('OY_AUTH_PUBLICATION_EXPECTATION_INVALID');
  let repository = String(env.GITHUB_REPO || env.GITHUB_REPOSITORY || '').trim();
  const workflow = String(env.OY_REFRESH_WORKFLOW || WORKFLOW).trim();
  if (!WORKFLOW_NAME.test(workflow)) throw failure('OY_AUTH_PUBLICATION_WORKFLOW_INVALID');
  const options = optionsFor(repoRoot, env);
  if (!repository) {
    const remote = await runProcess('git', ['config', '--get', 'remote.origin.url'], options);
    const match = String(remote.stdout || '').trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    repository = match ? `${match[1]}/${match[2]}` : '';
  }
  if (!REPOSITORY.test(repository)) throw failure('OY_AUTH_PUBLICATION_REPOSITORY_INVALID');
  const filename = filenameFor(repoRoot, statePath);
  await ensureDirectory(filename, true);
  let created = false;
  let record = await locked(repoRoot, async () => {
    const previous = await readRecord(filename);
    if (previous && previous.expectedExpiry === expectedExpiry && previous.expectedFingerprint === expectedFingerprint
      && previous.repository === repository && previous.workflow === workflow && pending(previous, now).status === 'pending') return previous;
    const next = { version: 1, requestId: randomUUID(), requestedAt: new Date(time).toISOString(), repository,
      workflow, runId: null, expectedExpiry, expectedFingerprint };
    await writeRecord(filename, next);
    created = true;
    return next;
  });
  if (!created) return record;
  let output;
  try {
    output = await runProcess('gh', ['workflow', 'run', workflow, '--repo', repository,
      '-f', 'deployVercel=true', '-f', `requestId=${record.requestId}`], options);
  } catch { return record; }
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(output.stdout || '').match(new RegExp(`https://github\\.com/${escapedRepository}/actions/runs/([1-9][0-9]*)`));
  const runId = match ? Number(match[1]) : null;
  if (Number.isSafeInteger(runId) && runId > 0) {
    record = await locked(repoRoot, async () => {
      const current = await readRecord(filename);
      if (current?.requestId !== record.requestId) return record;
      const next = { ...current, runId };
      await writeRecord(filename, next);
      return next;
    });
  }
  return record;
}

/** Delete only the request which was actually verified, never a newer replacement. */
export async function clearAuthPublication(repoRoot, requestId, { statePath } = {}) {
  if (!UUID.test(String(requestId || ''))) return false;
  const filename = filenameFor(repoRoot, statePath);
  return locked(repoRoot, async () => {
    const current = await readRecord(filename);
    if (current?.requestId !== requestId) return false;
    await fs.unlink(filename);
    return true;
  });
}

/** Read-only remote inspection. Never dispatch or rerun from a periodic health check. */
export async function inspectAuthPublication({ repoRoot, runProcess = execute, fetchImpl = fetch, now = Date.now, statePath } = {}) {
  const filename = filenameFor(repoRoot, statePath);
  let record;
  try { record = await readRecord(filename); }
  catch { return { status: 'failed', reason: 'publication_state_invalid' }; }
  if (!record) return { status: 'none' };
  // A PC may resume after the queue budget although the job finished on time.
  // Still inspect completed proof; every unconfirmed path retains the deadline.
  const budget = pending(record, now, 'workflow_pending', true);
  if (budget.status === 'failed') return budget;
  const options = optionsFor(repoRoot);
  let run;
  try {
    if (!record.runId) {
      const listed = await runProcess('gh', ['run', 'list', '--workflow', record.workflow, '--repo', record.repository,
        '--limit', '100', '--json', 'databaseId,displayTitle,status,conclusion'], options);
      const runs = JSON.parse(listed.stdout);
      if (!Array.isArray(runs)) return pending(record, now, 'workflow_lookup_unavailable');
      const matches = runs.filter(value => value.displayTitle === titleFor(record)
        && Number.isSafeInteger(value.databaseId) && value.databaseId > 0);
      if (matches.length !== 1) return pending(record, now, 'workflow_not_matched');
      record = { ...record, runId: matches[0].databaseId };
      await locked(repoRoot, async () => {
        const current = await readRecord(filename);
        if (current?.requestId === record.requestId) await writeRecord(filename, record);
      });
    }
    const viewed = await runProcess('gh', ['api', `repos/${record.repository}/actions/runs/${record.runId}`], options);
    run = JSON.parse(viewed.stdout);
  } catch { return pending(record, now, 'workflow_lookup_unavailable'); }
  if (run?.display_title !== titleFor(record) || run.id !== record.runId) return pending(record, now, 'workflow_not_matched');
  if (run.status !== 'completed') return pending(record, now, 'workflow_pending');
  if (run.conclusion !== 'success') return { status: 'failed', reason: 'publication_workflow_failed', runId: record.runId };
  try {
    const response = await fetchImpl(CHECK_URL, { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const payload = response.ok ? await response.json() : null;
    if (payload?.jwtValid !== true || payload.jwtExpSeconds !== record.expectedExpiry || payload.authFingerprint !== record.expectedFingerprint) {
      return pending(record, now, 'publication_not_confirmed');
    }
    const finalBudget = pending(record, now, 'publication_not_confirmed', true);
    if (finalBudget.status === 'failed') return finalBudget;
    if (!await clearAuthPublication(repoRoot, record.requestId, { statePath })) return pending(record, now, 'publication_request_replaced');
    return { status: 'published', runId: record.runId };
  } catch { return pending(record, now, 'publication_check_unavailable'); }
}
