const { CHECK_INTERVAL_MINUTES, MAX_ALERTS_PER_DEVICE } = require('./_core');
const { methodNotAllowed, sendJson } = require('./_http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const publicKey = String(process.env.PRICE_ALERT_VAPID_PUBLIC_KEY || '').trim();
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(publicKey)) {
    return sendJson(res, 503, { success: false, error: 'push_not_configured' });
  }
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      success: true,
      publicKey,
      checkIntervalMinutes: CHECK_INTERVAL_MINUTES,
      maxAlerts: MAX_ALERTS_PER_DEVICE
    })
  );
};
