// Manual deployment utility. Values stay inside GitHub Secrets and Vercel;
// never log provider response bodies or the SMTP password.
import nodemailer from 'nodemailer';
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = 'team_kCYpXTZeNpSxqcelRRUUSUKy';
const token = process.env.VERCEL_TOKEN;
const from = String(process.env.ALERT_EMAIL_FROM || '').trim();
const password = String(process.env.ALERT_EMAIL_PASSWORD || '');
if (projectId !== 'prj_Sj0zepEyW8AB3956ssl7zx163DOP' || !token ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) || !password || /[\r\n]/.test(password)) {
  throw new Error('Membership email deployment inputs missing or invalid');
}
const entries = {
  PRICE_ALERT_SMTP_HOST: 'smtp.gmail.com',
  PRICE_ALERT_SMTP_PORT: '465',
  PRICE_ALERT_SMTP_USER: from,
  PRICE_ALERT_SMTP_FROM: from,
  PRICE_ALERT_SMTP_PASSWORD: password,
  PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED: 'true'
};
try {
  const transporter = nodemailer.createTransport({
    host: entries.PRICE_ALERT_SMTP_HOST, port: 465, secure: true, requireTLS: true,
    auth: { user: from, pass: password }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    logger: false, debug: false
  });
  try { await transporter.verify(); } finally { transporter.close(); }
  const response = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&upsert=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.entries(entries).map(([key, value]) => ({ key, value, type: 'sensitive', target: ['production'] }))),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Vercel environment update HTTP ${response.status}`);
  const result = await response.json();
  if (result.error || result.errors?.length || result.failed?.length) throw new Error('Vercel environment update rejected');
  const created = Array.isArray(result.created) ? result.created : result.created ? [result.created] : [];
  const savedKeys = new Set(created.map((entry) => entry.key));
  if (!Object.keys(entries).every((key) => savedKeys.has(key))) throw new Error('Vercel environment update incomplete');
  console.log('OliveStock membership SMTP configuration saved. Redeploy required. No email sent.');
} catch (error) {
  console.error(error.message.startsWith('Vercel environment') ? error.message : 'Membership email configuration failed');
  process.exitCode = 1;
}
