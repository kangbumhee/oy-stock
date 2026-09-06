import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const VAULT_SCRIPT = fileURLToPath(new URL('../oy-login-secrets.ps1', import.meta.url));
const DISABLED = new Set(['0', 'false', 'no', 'off', 'disabled']);
const SAFE_ERRORS = new Set([
  'OY_LOGIN_VAULT_WINDOWS_ONLY', 'OY_LOGIN_VAULT_INVALID_PATH',
  'OY_LOGIN_VAULT_LOCKED', 'OY_LOGIN_VAULT_INVALID', 'OY_LOGIN_VAULT_DECRYPT_FAILED',
  'OY_LOGIN_VAULT_READ_INTERNAL_ONLY', 'OY_LOGIN_CREDENTIALS_INVALID',
  'OY_LOGIN_CAPTCHA_KEY_INVALID', 'OY_LOGIN_VAULT_OPERATION_FAILED',
]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stringValue(value, code) {
  if (value == null) return '';
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) throw failure(code);
  return value;
}

function keyValue(value) {
  const key = stringValue(value, 'OY_LOGIN_CAPTCHA_KEY_INVALID').trim();
  if (key.length > 512) throw failure('OY_LOGIN_CAPTCHA_KEY_INVALID');
  return key;
}

function isDisabled(env) {
  return ['OLIVEYOUNG_2CAPTCHA_ENABLED', 'KOREA_TOP_2CAPTCHA_ENABLED']
    .some((name) => DISABLED.has(String(env[name] ?? '').trim().toLowerCase()));
}

function normalize(record, source, env) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw failure('OY_LOGIN_VAULT_INVALID');
  if (source === 'saved' && (typeof record.username !== 'string' || typeof record.password !== 'string'
    || typeof record.captchaApiKey !== 'string' || typeof record.captchaEnabled !== 'boolean')) {
    throw failure('OY_LOGIN_VAULT_INVALID');
  }
  const username = stringValue(record.username, 'OY_LOGIN_CREDENTIALS_INVALID').trim();
  // Spaces can be part of a password. Only username/API key are trimmed.
  const password = stringValue(record.password, 'OY_LOGIN_CREDENTIALS_INVALID');
  if (Boolean(username) !== Boolean(password)) throw failure('OY_LOGIN_CREDENTIALS_INCOMPLETE');
  if (source === 'saved' && (!username || !password)) throw failure('OY_LOGIN_CREDENTIALS_INVALID');
  const captchaApiKey = keyValue(record.captchaApiKey);
  return {
    username,
    password,
    captchaApiKey,
    captchaEnabled: Boolean(captchaApiKey) && record.captchaEnabled !== false && !isDisabled(env),
    source,
    configured: Boolean(username && password),
  };
}

/** Load a current-user DPAPI vault. A corrupt/unreadable saved record NEVER falls back to env. */
export async function loadLoginSecrets({ repoRoot, env = process.env } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw failure('OY_LOGIN_VAULT_INVALID_PATH');
  const vaultPath = path.resolve(repoRoot, '.auth', 'oy-login-secrets.json');
  let exists = false;
  try {
    const info = await lstat(vaultPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw failure('OY_LOGIN_VAULT_INVALID');
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw failure(error.code === 'OY_LOGIN_VAULT_INVALID' ? error.code : 'OY_LOGIN_VAULT_OPERATION_FAILED');
  }
  if (exists) {
    if (process.platform !== 'win32') throw failure('OY_LOGIN_VAULT_WINDOWS_ONLY');
    let output;
    try {
      // Values travel only through this private child-process pipe, never arguments or logs.
      ({ stdout: output } = await runFile('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', VAULT_SCRIPT, '-Action', 'Read', '-VaultPath', vaultPath,
      ], {
        env: { ...process.env, ...env, OY_LOGIN_SECRETS_INTERNAL_READ: '1' },
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 128 * 1024,
        timeout: 15000,
      }));
    } catch (error) {
      const code = typeof error.stderr === 'string' ? error.stderr.trim() : '';
      // child_process errors include stdout/stderr; never propagate that error object.
      throw failure(SAFE_ERRORS.has(code) ? code : 'OY_LOGIN_VAULT_OPERATION_FAILED');
    }
    let record;
    try { record = JSON.parse(output.replace(/^\uFEFF/u, '').trim()); }
    catch { throw failure('OY_LOGIN_VAULT_INVALID'); }
    return normalize(record, 'saved', env);
  }
  const record = {
    username: env.OY_USERNAME,
    password: env.OY_PASSWORD,
    captchaApiKey: env.TWOCAPTCHA_API_KEY || env.TWO_CAPTCHA_API_KEY || '',
  };
  const hasValues = Boolean(record.username || record.password || record.captchaApiKey);
  return normalize(record, hasValues ? 'environment' : 'none', env);
}
