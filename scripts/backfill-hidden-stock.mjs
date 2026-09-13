import { pathToFileURL } from 'node:url';

export function backfillConfig(args = process.argv.slice(2), env = process.env) {
  const values = { steps: 50, delay: 1000, refresh: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--refresh') values.refresh = true;
    else if (args[i] === '--steps') values.steps = Number(args[++i]);
    else if (args[i] === '--delay-ms') values.delay = Number(args[++i]);
    else throw new Error('Usage: node scripts/backfill-hidden-stock.mjs [--steps 50] [--delay-ms 1000] [--refresh]');
  }
  if (!Number.isInteger(values.steps) || values.steps < 1 || values.steps > 1000 ||
      !Number.isInteger(values.delay) || values.delay < 500 || values.delay > 60000) throw new Error('Invalid bounded scan settings');
  const secret = String(env.HIDDEN_STOCK_SERVICE_SECRET || '');
  if (!/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('HIDDEN_STOCK_SERVICE_SECRET is required');
  const url = new URL(env.HIDDEN_STOCK_SERVICE_URL || 'https://oy-stock-api-3596046881.asia-northeast3.run.app');
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/.test(url.hostname) ||
      url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('HIDDEN_STOCK_SERVICE_URL must be the trusted Cloud Run origin');
  }
  url.pathname = '/api/hidden-stock';
  url.searchParams.set('action', 'scan');
  return { ...values, url, secret };
}

export async function runBackfill(config, { fetchImpl = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), report = console.log } = {}) {
  for (let step = 0; step < config.steps; step++) {
    const url = new URL(config.url);
    if (step === 0 && config.refresh) url.searchParams.set('refresh', '1');
    let response, data;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.secret}`, Accept: 'application/json' }, signal: AbortSignal.timeout(55000) });
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw new Error('oversize');
      data = JSON.parse(raw);
    } catch { throw new Error('Hidden index scan connection failed; checkpoint is retained. Retry the same command without --refresh.'); }
    if (!response.ok || !data?.success) {
      // Never include provider error bodies or request headers in logs.
      throw new Error(`Hidden index scan stopped (HTTP ${response.status}); checkpoint is retained.`);
    }
    const scan = data.scan || {};
    report(JSON.stringify({ step: step + 1, processed: scan.processed || 0, page: scan.page,
      uniqueProducts: scan.uniqueProducts || 0, catalogCountMismatch: scan.countMismatch === true,
      offset: scan.offset, catalogEnumerationComplete: scan.enumerationComplete === true,
      unresolvedProducts: Object.keys(scan.failures || {}).length, complete: scan.complete === true }));
    if (scan.complete === true) return { complete: true, steps: step + 1 };
    if (step + 1 < config.steps) await pause(config.delay);
  }
  report('Batch limit reached. The private checkpoint is saved; run again to continue.');
  return { complete: false, steps: config.steps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/backfill-hidden-stock.mjs [--steps 50] [--delay-ms 1000] [--refresh]\nRequires HIDDEN_STOCK_SERVICE_SECRET; optional HIDDEN_STOCK_SERVICE_URL. --refresh restarts catalog enumeration but retains discovered options.');
  } else {
    try { await runBackfill(backfillConfig()); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
