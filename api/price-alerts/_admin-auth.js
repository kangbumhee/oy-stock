const { OAuth2Client } = require('google-auth-library');
const { HttpError } = require('./_http');

const ADMIN_EMAIL = 'kbhjjan@gmail.com';
const googleClient = new OAuth2Client();

function configuredGoogleClientId() {
  const value = String(process.env.PRICE_ALERT_GOOGLE_CLIENT_ID || '').trim();
  return /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value) ? value : '';
}

async function authenticateAdmin(req, dependencies = {}) {
  const audience = configuredGoogleClientId();
  if (!audience) throw new HttpError(503, 'admin_not_configured');
  const header = String((req.headers || {}).authorization || '');
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  if (!match || header.length > 8192) throw new HttpError(401, 'admin_auth_required');
  let payload;
  try {
    // The Google library retrieves and caches Google's trusted signing certificates.
    // The token's untrusted jku/x5u fields never select a verification key.
    const ticket = await (dependencies.googleClient || googleClient).verifyIdToken({
      idToken: match[1], audience
    });
    payload = ticket.getPayload();
  } catch (_) {
    throw new HttpError(401, 'admin_auth_failed');
  }
  const now = Number.isFinite(dependencies.now) ? dependencies.now : Date.now();
  if (!payload || payload.aud !== audience ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
      !Number.isFinite(payload.exp) || payload.exp * 1000 <= now ||
      !Number.isFinite(payload.iat) || payload.iat * 1000 > now + 60000 ||
      (payload.azp && payload.azp !== audience) ||
      typeof payload.sub !== 'string' || !payload.sub) {
    throw new HttpError(401, 'admin_auth_failed');
  }
  if (payload.email_verified !== true || payload.email !== ADMIN_EMAIL) {
    throw new HttpError(403, 'admin_access_denied');
  }
  return { email: ADMIN_EMAIL, subject: payload.sub, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

module.exports = { ADMIN_EMAIL, authenticateAdmin, configuredGoogleClientId };
