const { runCollector } = require('./_hot-ranking-store');

function cronSecret() {
  const secret = process.env.CRON_SECRET;
  return secret && String(secret).trim();
}

function isPrivileged(req) {
  const secret = cronSecret();
  if (!secret) return false;
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  const querySecret = req.query && req.query.secret;
  return auth === `Bearer ${secret}` || querySecret === secret;
}

function isSafePublicDryRun(q) {
  return (
    (q.dryRun === '1' || q.dryRun === 'true') &&
    (q.skipStock === '1' || q.skipStock === 'true') &&
    !q.force &&
    !q.stockLimit &&
    !q.stockOffset &&
    !q.size
  );
}

function hasManualOverride(q) {
  return [
    'force',
    'stockLimit',
    'stockOffset',
    'size',
    'batchSize',
    'delayMs',
    'deadlineMs',
    'timeoutMs',
    'lat',
    'lng'
  ].some((key) => q[key] != null);
}

module.exports = async function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ success: false, error: 'method not allowed' });
    return;
  }

  const q = req.query || {};
  const secret = cronSecret();
  const privileged = isPrivileged(req);

  if (secret && !privileged) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  if (!secret && hasManualOverride(q) && !isSafePublicDryRun(q)) {
    res.status(403).json({
      success: false,
      error: 'manual collection requires CRON_SECRET',
      message: 'Set CRON_SECRET on Vercel before using force, stockLimit, size, or location overrides.'
    });
    return;
  }

  try {
    const result = await runCollector({
      force: q.force === '1' || q.force === 'true',
      dryRun: q.dryRun === '1' || q.dryRun === 'true',
      skipStock: q.skipStock === '1' || q.skipStock === 'true',
      size: q.size,
      stockLimit: q.stockLimit,
      stockOffset: q.stockOffset,
      batchSize: q.batchSize,
      delayMs: q.delayMs,
      deadlineMs: q.deadlineMs,
      timeoutMs: q.timeoutMs,
      lat: q.lat,
      lng: q.lng
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      success: false,
      error: 'hot ranking collection failed',
      message: e && e.message ? e.message : String(e)
    });
  }
};
