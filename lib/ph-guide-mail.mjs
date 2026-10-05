/** Dependency-free Pro Route transactional email builder. No network or sending. */
export const MAIL_KINDS = Object.freeze(['verify', 'checkout', 'expiry-reminder', 'paid-guide']);

const ROUTES = Object.freeze({ verify: '/verify', checkout: '/checkout', 'expiry-reminder': '/checkout', 'paid-guide': '/guide' });
const DEFINITIONS = Object.freeze({
  verify: { subject: '[Pro Route] 이메일 확인', status: '이메일 확인 대기', title: '이메일을 확인하고 이어가세요', button: '이메일 확인하고 이어가기' },
  checkout: { subject: '[Pro Route] 안내 서비스 구매 안내', status: '이메일 확인 후 구매 안내', title: '안내 서비스 구매를 진행하세요', button: '50,000원 안내 구매하기' },
  'expiry-reminder': { subject: '[Pro Route] 등록한 구독 이용 종료일 안내', status: '등록한 이용 종료일 알림', title: '구독 이용 종료일을 확인하세요', button: '이용 종료 확인 후 구매하기' },
  'paid-guide': { subject: '[Pro Route] 결제 확인 · 전용 가이드', status: '안내 서비스 결제 확인', title: '결제한 전용 가이드를 열어보세요', button: '결제한 전용 가이드 열기' },
});

const PRICE_NOTICE = '안내 서비스는 50,000원 · 1회 결제입니다. ChatGPT 구독료는 OpenAI에 별도로 결제합니다.';
const PC_NOTICE = 'Windows PC 전용입니다. 모바일·태블릿에서는 연결 및 구독 진행을 지원하지 않습니다. 일반 VPN은 지원하지 않습니다.';
const BILLING_NOTICE = '본인의 실제 청구정보와 결제수단을 사용하세요. 표시 요금과 최종 청구금액은 계정·세금·환율에 따라 달라질 수 있습니다.';
const SCHEDULE_NOTICE = '등록한 이용 종료일 당일 오전 10시(한국시간, KST)부터 자동 발송 처리합니다. 처리 및 메일 서비스 상태에 따라 실제 도착 시각이 늦어질 수 있습니다.';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(name + ' must be a nonempty string');
  return value;
}

/** A HTTPS origin, optionally followed by /. No paths, credentials, query or fragment. */
export function validatePublicOrigin(publicUrl) {
  requireString(publicUrl, 'publicUrl');
  if (/[\u0000-\u0020\u007f]/.test(publicUrl)) throw new TypeError('publicUrl contains whitespace or controls');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('publicUrl must be an HTTPS origin only');
  }
  return url.origin;
}

function safeUrl(value, publicOrigin, expectedPath) {
  requireString(value, 'URL');
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new TypeError('URL contains whitespace or controls');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== publicOrigin || url.username || url.password || url.hash || url.pathname !== expectedPath) {
    throw new TypeError('URL must use the configured HTTPS origin and expected route');
  }
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'token' || !url.searchParams.get('token')) {
    throw new TypeError('URL requires exactly one nonempty token parameter');
  }
  return url.href;
}

/** Pass a raw token. URLSearchParams encodes it once; never concatenate tokens into HTML. */
export function makeServiceUrl(publicUrl, path, token) {
  const origin = validatePublicOrigin(publicUrl);
  if (!['/verify', '/checkout', '/guide', '/unsubscribe'].includes(path)) throw new TypeError('Unsupported service route');
  requireString(token, 'token');
  if (token.length > 2048) throw new TypeError('token is too long');
  const url = new URL(path, origin);
  url.searchParams.set('token', token);
  return url.href;
}

function validateExpiryDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('expiryDate must be YYYY-MM-DD');
  const date = new Date(value + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TypeError('expiryDate is not a calendar date');
  return value;
}

function dateLabel(value) {
  const [year, month, day] = validateExpiryDate(value).split('-');
  return `${year}년 ${Number(month)}월 ${Number(day)}일`;
}

function validateSubject(value) {
  requireString(value, 'subject');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('subject contains header controls');
  return value;
}

function paragraph(value) {
  return `<p style="margin:0 0 18px;color:#626f85;font-size:17px;line-height:1.75;word-break:keep-all;overflow-wrap:anywhere;">${escapeHtml(value).replace(/\r?\n/g, '<br>')}</p>`;
}

function actionButton(actionUrl, label) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:24px 0;"><tr><td bgcolor="#185bf7" style="background:#185bf7;border-radius:9px;text-align:center;"><a href="${escapeHtml(actionUrl)}" style="display:block;padding:16px 20px;color:#ffffff;font-size:17px;font-weight:700;line-height:1.5;text-align:center;text-decoration:none;border-radius:9px;word-break:keep-all;">${escapeHtml(label)}</a></td></tr></table>`;
}

function shell({ subject, status, title, content, actionUrl, unsubscribeUrl }) {
  const fallback = actionUrl ? `<p style="margin:20px 0 0;color:#626f85;font-size:13px;line-height:1.7;">버튼이 열리지 않으면 아래 주소를 복사해 Windows PC에서 열어주세요.<br><span style="word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(actionUrl)}</span></p>` : '';
  const optout = unsubscribeUrl ? `<p style="margin:16px 0 0;color:#626f85;font-size:13px;line-height:1.7;">등록한 이용 종료일 알림 취소:<br><span style="word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(unsubscribeUrl)}</span></p>` : '';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f8fe;color:#06112b;font-family:Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;">${escapeHtml(title)} · 50,000원 1회 안내 서비스 · OpenAI 구독료 별도 · Windows PC 전용</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f5f8fe;"><tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e6eaf0;border-radius:12px;"><tr><td style="padding:28px;">
<p style="margin:0 0 30px;color:#06112b;font-size:29px;font-weight:800;line-height:1.2;letter-spacing:-1px;">Pro Route</p>
<p style="margin:0 0 10px;color:#185bf7;font-size:14px;font-weight:700;line-height:1.6;">${escapeHtml(status)}</p>
<h1 style="margin:0 0 22px;color:#06112b;font-size:27px;font-weight:800;line-height:1.4;letter-spacing:-0.7px;word-break:keep-all;">${escapeHtml(title)}</h1>
${content}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:24px 0 0;border-top:1px solid #e6eaf0;"><tr><td style="padding-top:20px;">
<p style="margin:0 0 10px;color:#06112b;font-size:16px;font-weight:700;line-height:1.7;">안내 서비스 <span style="color:#185bf7;">50,000원</span> · 1회 결제</p>
<p style="margin:0 0 10px;color:#626f85;font-size:14px;line-height:1.7;">ChatGPT 구독료는 OpenAI에 별도로 결제합니다.</p>
<p style="margin:0 0 12px;color:#06112b;font-size:14px;font-weight:700;line-height:1.7;">${escapeHtml(PC_NOTICE)}</p>
<p style="margin:0;color:#626f85;font-size:13px;line-height:1.7;">${escapeHtml(BILLING_NOTICE)}</p>
</td></tr></table>
${fallback}${optout}
<p style="margin:24px 0 0;padding-top:18px;border-top:1px solid #e6eaf0;color:#626f85;font-size:12px;line-height:1.7;">안내 신청과 구매에 관한 이메일입니다. 광고 수신 동의와 별개입니다.<br>Pro Route는 독립적인 이용 안내 서비스입니다.</p>
</td></tr></table></td></tr></table></body></html>`;
}

/**
 * @param {{kind:'verify'|'checkout'|'expiry-reminder'|'paid-guide',publicUrl:string,actionUrl:string,unsubscribeUrl?:string,expiryDate?:string}} options
 * @returns {{subject:string,text:string,html:string}}
 */
export function buildTransactionalMail(options) {
  if (!options || !MAIL_KINDS.includes(options.kind)) throw new TypeError('Unsupported mail kind');
  const { kind } = options;
  const origin = validatePublicOrigin(options.publicUrl);
  const actionUrl = safeUrl(options.actionUrl, origin, ROUTES[kind]);
  const unsubscribeUrl = options.unsubscribeUrl !== undefined ? safeUrl(options.unsubscribeUrl, origin, '/unsubscribe') : undefined;
  const expiryDate = options.expiryDate !== undefined ? validateExpiryDate(options.expiryDate) : undefined;
  if (kind === 'expiry-reminder' && !expiryDate) throw new TypeError('expiry-reminder requires expiryDate');
  const definition = DEFINITIONS[kind];
  let paragraphs;
  if (kind === 'verify') {
    paragraphs = ['아래 버튼으로 안내를 받을 이메일 주소를 확인하세요. 인증 링크의 유효기간은 24시간입니다.', expiryDate ? `등록한 구독 이용 종료일은 ${dateLabel(expiryDate)}입니다. ${SCHEDULE_NOTICE}` : '이메일을 확인한 뒤 안내 서비스 구매를 진행할 수 있습니다.', '본인이 신청하지 않았다면 인증 버튼을 누르지 마세요.'];
  } else if (kind === 'checkout') {
    paragraphs = ['이메일 확인이 완료되었습니다. 아래 구매 페이지에서 안내 서비스 내용과 이용약관을 확인한 뒤 카카오페이로 1회 결제할 수 있습니다.', '결제 승인이 확인되면 전용 가이드 링크를 이메일로 안내합니다. 이 이메일 자체는 결제 완료 확인이 아닙니다.'];
  } else if (kind === 'expiry-reminder') {
    paragraphs = [`등록한 구독 이용 종료일은 ${dateLabel(expiryDate)}입니다.`, '구매 전에 ChatGPT 설정에서 기존 구독이 실제로 종료됐는지 직접 확인하세요. Pro Route가 해지 상태를 자동 확인하거나 계정을 변경하지 않습니다.', SCHEDULE_NOTICE];
  } else {
    paragraphs = ['안내 서비스 50,000원 결제가 확인되었습니다. 아래 전용 페이지에서 Windows PC 연결과 구독 진행 순서를 확인하세요.', '전용 링크와 안내된 접속 정보를 다른 사람에게 공유하지 마세요. OpenAI 구독은 본인의 계정에서 별도로 진행합니다.'];
  }
  const text = [definition.title, ...paragraphs, `${definition.button}: ${actionUrl}`, PRICE_NOTICE, PC_NOTICE, BILLING_NOTICE, ...(unsubscribeUrl ? [`등록한 이용 종료일 알림 취소: ${unsubscribeUrl}`] : [])].join('\n\n');
  return { subject: definition.subject, text, html: shell({ ...definition, content: paragraphs.map(paragraph).join('') + actionButton(actionUrl, definition.button), actionUrl, unsubscribeUrl }) };
}

function findKnownAction(text, origin) {
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const candidate = new URL(match[0]);
      if (!['/verify', '/checkout', '/guide'].includes(candidate.pathname)) continue;
      const url = safeUrl(match[0], origin, candidate.pathname);
      return { url, raw: match[0], index: match.index, path: candidate.pathname };
    } catch { /* Untrusted/unknown links remain escaped plain text, never CTA hrefs. */ }
  }
  return undefined;
}

/** Compatibility adapter for an existing queue containing {subject,text}. */
export function renderMail(subject, text, publicUrl) {
  validateSubject(subject); requireString(text, 'text');
  const origin = validatePublicOrigin(publicUrl);
  const action = findKnownAction(text, origin);
  const dateMatch = text.match(/(?:만료일|이용 종료일)(?:은|:)?\s*(\d{4}-\d{2}-\d{2})/);
  let expiryDate;
  if (dateMatch) { try { expiryDate = validateExpiryDate(dateMatch[1]); } catch { /* Preserve invalid legacy date as escaped original text only. */ } }
  const kind = action?.path === '/verify' ? 'verify' : action?.path === '/guide' ? 'paid-guide' : expiryDate ? 'expiry-reminder' : 'checkout';
  const definition = DEFINITIONS[kind];
  let content = action
    ? paragraph(text.slice(0, action.index).trimEnd()) + actionButton(action.url, definition.button) + paragraph(text.slice(action.index + action.raw.length).trimStart())
    : paragraph(text);
  // Keep every original plaintext URL, including unsubscribe, in the original order.
  const scheduleNote = expiryDate && ['/verify', '/checkout'].includes(action?.path) && !text.includes('오전 10시') ? SCHEDULE_NOTICE : undefined;
  if (scheduleNote) content += paragraph(scheduleNote);
  const enrichedText = [text, ...(scheduleNote ? [scheduleNote] : []), PRICE_NOTICE, PC_NOTICE, BILLING_NOTICE].join('\n\n');
  return { subject, text: enrichedText, html: shell({ subject, title: subject.replace(/^\[[^\]]+\]\s*/, ''), status: action ? definition.status : '이용 안내', content, actionUrl: action?.url }) };
}
