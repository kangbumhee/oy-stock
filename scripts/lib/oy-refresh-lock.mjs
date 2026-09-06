import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function lockError(code = 'OY_REFRESH_BUSY') {
  const error = new Error(code);
  error.code = code;
  error.exitCode = code === 'OY_REFRESH_BUSY' ? 75 : 1;
  return error;
}

async function acquireWindowsMutex(repoRoot, scope) {
  const helper = fileURLToPath(new URL('../oy-refresh-mutex.ps1', import.meta.url));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-Mode', 'Hold', '-AuthDirectory', path.resolve(repoRoot, '.auth'), '-Scope', scope],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let exited = false;
  let stderr = '';
  let stdout = '';
  const stopped = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 512); });
  // Broken pipes after an already-exited holder must not crash the application.
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = error => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(lockError('OY_REFRESH_LOCK_FAILED')), 15000);
      child.on('error', () => finish(lockError('OY_REFRESH_LOCK_FAILED')));
      child.once('close', () => finish(lockError(stderr.trim() === 'OY_REFRESH_BUSY' ? 'OY_REFRESH_BUSY' : 'OY_REFRESH_LOCK_FAILED')));
      child.stdout.on('data', chunk => {
        stdout = (stdout + chunk.toString('utf8')).slice(0, 1024);
        if (stdout.replace(/\r/g, '') === 'OY_MUTEX_ACQUIRED\n') finish();
        else if (stdout.length >= 1024 || stdout.includes('\n')) finish(lockError('OY_REFRESH_LOCK_FAILED'));
      });
    });
  } catch (error) {
    child.stdin.end();
    if (!exited) child.kill();
    await stopped;
    throw error;
  }
  let releasePromise;
  return function release() {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      if (exited) return;
      child.stdin.end();
      const timeout = setTimeout(() => { if (!exited) child.kill(); }, 5000);
      try { await stopped; } finally { clearTimeout(timeout); }
    })();
    return releasePromise;
  };
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function reclaimDeadOwner(filename, isAlive, bootAt) {
  // Two contenders cannot both remove a stale lock and then overwrite a new owner.
  const recoveryPath = `${filename}.recovery`;
  let recoveryFd;
  try {
    recoveryFd = fs.openSync(recoveryPath, 'wx', 0o600);
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return;
    const fromPreviousBoot = Number.isFinite(record.bootAt) && record.bootAt < bootAt - 60000;
    if (fromPreviousBoot || !isAlive(record.pid)) fs.unlinkSync(filename);
  } catch { /* Unknown or exclusively held settings locks must not be removed. */ }
  finally {
    if (recoveryFd !== undefined) {
      fs.closeSync(recoveryFd);
      try { fs.unlinkSync(recoveryPath); } catch { /* best effort */ }
    }
  }
}

// The POSIX fallback is retained for non-Windows environments. Windows never
// touches legacy .lock/.recovery files; the OS mutex is shared with vault Setup/Clear.
function acquireFileLock(repoRoot, { isAlive = processIsAlive, bootAt = Date.now() - os.uptime() * 1000, scope = 'refresh' } = {}) {
  const filename = path.join(repoRoot, '.auth', scope === 'refresh' ? 'oy-cookie-refresh.lock' : 'oy-health-state.lock');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  let fd;
  const owner = randomUUID();
  try {
    try { fd = fs.openSync(filename, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      reclaimDeadOwner(filename, isAlive, bootAt);
      fd = fs.openSync(filename, 'wx', 0o600);
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, bootAt, startedAt: new Date().toISOString() }));
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    const error = new Error('OY_REFRESH_BUSY: another refresh or settings operation owns the lock.');
    error.code = 'OY_REFRESH_BUSY';
    error.exitCode = 75;
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(fd);
    // Never remove a replacement owned by another operation.
    try {
      const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (record.pid === process.pid && record.owner === owner) fs.unlinkSync(filename);
    } catch { /* leave unknown locks in place */ }
  };
}

export async function acquireRefreshLock(repoRoot, options = {}) {
  const scope = options.scope ?? 'refresh';
  if (!['refresh', 'health-state'].includes(scope)) throw lockError('OY_REFRESH_LOCK_FAILED');
  if (process.platform === 'win32') return acquireWindowsMutex(repoRoot, scope);
  const release = acquireFileLock(repoRoot, { ...options, scope });
  return async () => release();
}
