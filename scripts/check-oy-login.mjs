import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoginHealthCheck, reportRefreshFailure, reportRefreshSuccess } from './lib/oy-login-health.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
try {
  let result;
  if (args.length === 0) result = await runLoginHealthCheck({ repoRoot });
  else if (args.length === 2 && args[0] === '--refresh-failed' && /^(?:1|42|75)$/.test(args[1])) {
    result = await reportRefreshFailure({ repoRoot, exitCode: Number(args[1]) });
  } else if (args.length === 1 && args[0] === '--refresh-succeeded') {
    result = await reportRefreshSuccess({ repoRoot });
  } else {
    throw new Error('invalid_arguments');
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
} catch {
  console.error('OY_LOGIN_HEALTH_FAILED');
  process.exitCode = 1;
}
