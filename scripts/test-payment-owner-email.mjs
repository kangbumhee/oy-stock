// Operator-approved test only. Never invoke from automatic workflows.
import ownerMail from '../api/price-alerts/_payment-owner-mail.js';

const from = String(process.env.ALERT_EMAIL_FROM || '').trim();
const password = String(process.env.ALERT_EMAIL_PASSWORD || '');
const env = {
  PRICE_ALERT_PAYMENT_OWNER_MAIL_ENABLED: 'true',
  PRICE_ALERT_PAYMENT_OWNER_MAIL_START_AT: new Date().toISOString(),
  PRICE_ALERT_SMTP_HOST: 'smtp.gmail.com',
  PRICE_ALERT_SMTP_PORT: '465',
  PRICE_ALERT_SMTP_USER: from,
  PRICE_ALERT_SMTP_FROM: from,
  PRICE_ALERT_SMTP_PASSWORD: password
};
const result = await ownerMail.sendOwnerPaymentTest({ env });
if (result.state === 'sent') {
  console.log('One labeled owner notification test accepted by SMTP. No payment or cancellation performed.');
} else {
  console.error('Owner notification test not confirmed. No automatic retry; check before sending again.');
  process.exitCode = 1;
}
