const nodemailer = require('nodemailer');
const { HttpError } = require('./_http');

function configuredAccountMail(env = process.env) {
  const host = String(env.PRICE_ALERT_SMTP_HOST || '').trim();
  const port = Number(env.PRICE_ALERT_SMTP_PORT || 465);
  const user = String(env.PRICE_ALERT_SMTP_USER || '').trim();
  const password = String(env.PRICE_ALERT_SMTP_PASSWORD || '');
  const from = String(env.PRICE_ALERT_SMTP_FROM || '').trim();
  if (!/^[A-Za-z0-9.-]+$/.test(host) || ![465, 587].includes(port) ||
      !user || !password || /[\r\n]/.test(user) ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) return null;
  return { host, port, user, password, from };
}

async function sendAccountMail({ email, code, purpose }, dependencies = {}) {
  const config = dependencies.config || configuredAccountMail();
  if (!config) throw new HttpError(503, 'account_mail_not_configured');
  const recovery = purpose === 'recovery';
  const existing = purpose === 'existing';
  const unavailable = purpose === 'recovery-unavailable';
  const formatted = String(code || '').match(/.{1,4}/g)?.join('-') || '';
  const transporter = (dependencies.createTransport || nodemailer.createTransport)({
    host: config.host, port: config.port, secure: config.port === 465,
    requireTLS: true, auth: { user: config.user, pass: config.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    logger: false, debug: false
  });
  try {
    await transporter.sendMail({
      from: config.from, to: email,
      subject: existing || unavailable ? '[올리브재고] 이용권 이메일 확인 안내' : recovery
        ? '[올리브재고] 이용권 복구 인증번호' : '[올리브재고] 이메일 인증번호',
      text: unavailable
        ? '이 이메일로 복구 가능한 올리브재고 이용권을 찾지 못했습니다. 결제할 때 인증한 이메일인지 확인해 주세요.\n본인이 요청하지 않았다면 이 메일을 무시해 주세요.'
        : existing
        ? '이 이메일에 연결된 올리브재고 이용권이 있습니다. 사이트의 이메일로 이용권 복구에서 인증번호를 새로 요청해 주세요.\n본인이 요청하지 않았다면 이 메일을 무시해 주세요.'
        : `올리브재고 ${recovery ? '이용권 복구' : '이메일 확인'} 인증번호입니다.\n\n${formatted}\n\n15분 안에 사이트에 직접 입력해 주세요. 인증번호는 한 번만 사용할 수 있습니다. 다른 사람에게 전달하지 마세요.\n${recovery ? '복구를 완료하면 이전 브라우저의 이용 권한이 종료되고 현재 브라우저로 이동합니다.\n' : ''}본인이 요청하지 않았다면 이 메일을 무시해 주세요.`,
      disableFileAccess: true, disableUrlAccess: true
    });
  } catch (_) {
    // SMTP errors may contain recipient addresses and credentials.
    throw new HttpError(503, 'account_mail_unavailable');
  } finally {
    if (typeof transporter.close === 'function') transporter.close();
  }
}

module.exports = { configuredAccountMail, sendAccountMail };
