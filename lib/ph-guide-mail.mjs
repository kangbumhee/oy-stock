/** Dependency-free Pro Route transactional email builder. No network or sending. */
export const MAIL_KINDS = Object.freeze(['verify', 'checkout', 'expiry-reminder', 'paid-guide']);

const ROUTES = Object.freeze({ verify: '/verify', checkout: '/checkout', 'expiry-reminder': '/checkout', 'paid-guide': '/guide' });
const DEFINITIONS = Object.freeze({
  verify: { subject: '[Pro Route] 이메일 확인', status: '이메일 확인 대기', title: '이메일을 확인하고 이어가세요', button: '이메일 확인하고 이어가기' },
  checkout: { subject: '[Pro Route] 안내 서비스 구매 안내', status: '이메일 확인 후 구매 안내', title: '안내 서비스 구매를 진행하세요', button: '포트원·카카오페이로 50,000원 결제하기' },
  'expiry-reminder': { subject: '[Pro Route] 등록한 구독 이용 종료일 안내', status: '등록한 이용 종료일 알림', title: '구독 이용 종료일을 확인하세요', button: '이용 종료 확인 후 카카오페이 결제하기' },
  'paid-guide': { subject: '[Pro Route] 결제 확인 · 이용 안내', status: '안내 서비스 결제 확인', title: '결제가 확인되었습니다. 아래 순서대로 진행하세요', button: '연결 도구 준비·시작하기' },
});

const PRICE_NOTICE = '안내 서비스는 50,000원 · 1회 결제입니다. ChatGPT 구독료는 OpenAI에 별도로 결제합니다.';
const PC_NOTICE = 'Windows PC 전용입니다. 모바일·태블릿에서는 연결 및 구독 진행을 지원하지 않습니다. 일반 VPN은 지원하지 않습니다.';
const BILLING_NOTICE = '본인의 실제 청구정보와 결제수단을 사용하세요. 표시 요금과 최종 청구금액은 계정·세금·환율에 따라 달라질 수 있습니다.';
const SCHEDULE_NOTICE = '등록한 이용 종료일 당일 오전 10시(한국시간, KST)부터 자동 발송 처리합니다. 처리 및 메일 서비스 상태에 따라 실제 도착 시각이 늦어질 수 있습니다.';
const CONNECTION_NOTICE = '고객 전용 Windows PC 접속은 1시간 제공됩니다. 결제 시점이 아니라 전용 가이드에서 연결 시작 버튼을 누른 시점부터 1시간을 계산합니다.';
const PURCHASE_NOTICE = '결제 전에 현재 무료 구독 상태인지 꼭 확인하세요. 이 메일의 구매 버튼은 본인 인증이 연결된 Pro Route 결제 페이지입니다. 해당 페이지에서 포트원·카카오페이로 안내 서비스 50,000원을 1회 결제합니다. 링크를 여는 것만으로 결제되지 않습니다. 구매 링크는 7일간 유효하며 다른 사람에게 공유하지 마세요.';
const ACCOUNT_NOTICE = '새 계정을 만들 필요 없이 기존 ChatGPT 계정을 그대로 사용합니다. 이미 유료 구독 중이라면 실제 이용 종료를 확인한 뒤 같은 계정으로 재구독하세요.';
const GUIDE_NOTICE = '아래에 전체 이용 순서를 담았습니다. 메일에는 재생형 모션을 실행할 수 없어 단원별 설명으로 안내합니다. 같은 개인 페이지에서 연결 도구와 발급 정보를 확인하고, 필요하면 마우스 이동·클릭 모션을 재생할 수 있습니다.';
const REMOTE_HELP_NOTICE = '따라 했는데도 진행이 어렵다면 연결 페이지 마지막의 원격제어 도움 요청 버튼 또는 고객지원 kbhjjan@naver.com으로 문의하세요. 막힌 단계와 오류 화면을 알려주시고 개인정보는 가려주세요. ChatGPT 비밀번호·카드번호·보안코드는 채팅에 보내지 마세요. 상담과 본인 동의 후 도움을 진행하며 링크를 여는 것만으로 원격제어가 시작되지는 않습니다.';

// Email clients do not run the web guide's JavaScript. Keep its complete practical
// sequence inline; only customer-specific credentials and the explicit timer stay
// behind the paid, signed page. This file is also the SMTP relay's renderer.
export const EMAIL_GUIDE_CHAPTERS = Object.freeze([
  { title: '시작 전 준비', steps: ['Windows PC의 Chrome 또는 Edge에서 진행합니다. 모바일·태블릿은 지원하지 않습니다.', '연결은 결제 시각이 아닌 연결 시작 버튼을 누른 순간부터 1시간입니다. 먼저 이 메일을 끝까지 읽고 본인 결제수단·청구정보를 준비하세요.', '전용 링크와 연결용 아이디·비밀번호를 공유하지 마세요. 이 서비스는 ChatGPT 비밀번호나 카드정보를 받지 않습니다.'] },
  { title: '기존 계정과 무료 상태 확인', steps: ['본인의 기존 ChatGPT 계정을 그대로 사용합니다. 공식 ChatGPT 웹에서 프로필 → 설정 → 결제 또는 계정으로 이동하세요.', '현재 플랜이 Free인지 확인합니다. 해지를 신청했어도 유료 이용 기간이 남아 있다면 아직 무료 상태가 아닙니다.', '유료 구독이 남았다면 이용 종료일까지 기다린 후 같은 계정으로 진행하세요. 연결을 미리 시작하지 마세요.'] },
  { title: '연결 도구 준비·시간 시작', steps: ['이 메일의 연결 버튼을 눌러 개인 페이지를 열고 Windows 연결 도구 ZIP을 내려받습니다.', 'ZIP을 우클릭해 모두 압축 풀기를 선택한 뒤, 압축을 푼 폴더의 START.cmd를 실행하세요. ZIP 안에서 바로 실행하지 않습니다. 회사 관리 PC는 관리자에게 먼저 확인하세요.', '도구가 준비되면 개인 페이지에서 연결 시작하기를 누릅니다. 이때부터 1시간이 계산됩니다. 화면의 종료 시각과 고객 전용 연결 정보를 확인하세요. 로컬 도구 실행만으로 필리핀 접속이 확인된 것은 아닙니다.'] },
  { title: 'Windows 프록시 설정 열기', steps: ['Win + I로 Windows 설정을 열고 네트워크 및 인터넷 → 프록시로 이동합니다.', '수동 프록시 설정의 프록시 서버 사용 → 설정을 누릅니다. 자동 프록시 설정과 구분하세요.', '기존 프록시를 사용 중이라면 복구할 수 있도록 현재 설정을 먼저 기록하세요.'] },
  { title: '로컬 프록시 연결', steps: ['프록시 서버 사용을 켜고 IP 주소에 127.0.0.1, 포트에 18789를 입력한 뒤 저장합니다.', 'IP 주소 칸에는 숫자 주소만 쓰고, 프로토콜 표시·연결용 아이디·비밀번호 또는 사진 속 운영자 IP를 붙이지 마세요.', 'START.cmd 창은 연결이 끝날 때까지 열어 두세요. 이 로컬 주소와 포트는 고객 도구가 사용하는 값입니다.'] },
  { title: '브라우저 인증·접속 위치 확인', steps: ['Chrome 또는 Edge를 새로고침하면 프록시 인증창이 나타날 수 있습니다. 개인 페이지에서 발급된 고객 전용 연결용 아이디·비밀번호를 입력하세요.', '이는 ChatGPT 로그인창이 아닙니다. ChatGPT 이메일·비밀번호를 프록시 인증창에 입력하지 마세요.', 'IP 위치 확인 화면에서 Philippines 또는 PH가 표시되는지 확인하세요. 오류가 나면 STATUS.cmd, 로컬 주소·포트, 앞뒤 공백과 만료 시각을 점검합니다. 위치가 확인되지 않으면 구독을 결제하지 마세요.'] },
  { title: '요금제·통화·사용량 확인', steps: ['접속 위치를 확인한 뒤 본인 계정의 설정 → 결제 또는 업그레이드에서 요금제를 엽니다. 메뉴 위치는 업데이트에 따라 달라질 수 있습니다.', 'PHP 표시인지, 원하는 Pro 사용량 옵션인지 확인합니다. 시작가와 선택한 플랜의 금액을 구분하세요.', 'IP 연결만으로 특정 통화·가격·플랜 표시나 결제가 보장되지는 않습니다. 촬영 당시 프로모션·표시 금액은 현재 가격과 다를 수 있으므로 본인 화면을 확인하세요.'] },
  { title: '본인 청구정보·결제수단 확인', steps: ['결제 정보 편집 또는 결제수단 새로 추가에서 본인의 실제 이메일·이름·청구정보를 확인합니다.', '본인이 실제 사용할 자격이 있는 국가·주소·우편번호를 사용하세요. 임의 주소나 허위 세금번호를 입력하지 않습니다.', '세금 ID는 실제 유효한 번호와 적용 자격이 있을 때만 추가하고, 없다면 추가하지 마세요. 번호 입력만으로 면세가 보장되지는 않습니다. 카드정보는 OpenAI 공식 결제 화면에만 입력하세요.'] },
  { title: '최종 금액·승인 확인', steps: ['플랜·통화·월 구독료·VAT·최종 결제액과 해외 결제 수수료를 확인합니다. 안내와 다른 금액이면 결제를 멈추고 먼저 도움을 요청하세요.', '본인이 금액에 동의하는 경우에만 OpenAI 공식 화면에서 직접 결제하고 영수증과 다음 갱신일을 보관하세요. 실패하면 중복 승인 여부부터 확인하세요.', '안내에 따라 진행했으나 안내한 금액으로 할인이 적용되지 않으면 안내 서비스비 50,000원을 전액 환불합니다. OpenAI에 직접 결제한 구독료는 별도입니다. 면세나 이후 갱신 가격은 보장하지 않습니다. 구매 이메일과 주문 식별정보로 고객지원에 문의하세요.'] },
  { title: '연결 종료·설정 복구', steps: ['사용을 마치면 Windows 프록시를 처음 기록한 상태로 복구합니다. 원래 프록시를 쓰지 않았다면 프록시 서버 사용을 끄고 저장하세요.', 'STOP.cmd를 실행하고 일반 웹페이지가 열리는지 확인합니다. 1시간이 만료되어도 시스템 프록시 설정이 자동 복구되지는 않습니다.', '이후 구독·자동 갱신은 본인의 OpenAI 계정에서 관리하세요. 다음 갱신 가격과 정책은 달라질 수 있습니다.'] },
  { title: '진행이 어려울 때', steps: [REMOTE_HELP_NOTICE, '결제·인증을 반복하거나 운영자 개인정보를 복사하지 마세요. 원격 도움은 상담 후 본인이 동의한 경우에만 진행합니다.'] },
]);

function serviceNotes(kind) {
  if (kind === 'verify') return [];
  if (kind === 'paid-guide') return [CONNECTION_NOTICE, GUIDE_NOTICE, ACCOUNT_NOTICE];
  return [PURCHASE_NOTICE, CONNECTION_NOTICE, ACCOUNT_NOTICE, '결제 승인이 확인되면 전체 이용 순서를 이메일 본문으로 보내드립니다. 연결 도구·고객 전용 발급 정보·연결 시작 기능은 같은 개인 페이지에서 이용합니다.'];
}

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

function serviceSummary(kind) {
  const notes = serviceNotes(kind);
  if (!notes.length) return '';
  return `<div style="margin:24px 0;padding:20px;background:#f3f7ff;border:1px solid #d6e2ff;border-radius:10px;"><h2 style="margin:0 0 14px;color:#06112b;font-size:18px;line-height:1.5;">${kind === 'paid-guide' ? '가이드 이용 순서' : '구매 전 안내'}</h2>${notes.map(note => paragraph(note)).join('')}</div>`;
}

function inlineGuideHtml() {
  return EMAIL_GUIDE_CHAPTERS.map((chapter, index) => `<section style="margin:22px 0;padding:20px;border:1px solid #e0e7f4;border-radius:10px;"><h2 style="margin:0 0 12px;color:#06112b;font-size:19px;line-height:1.5;">${index + 1}. ${escapeHtml(chapter.title)}</h2><ol style="margin:0;padding-left:22px;color:#45536b;font-size:15px;line-height:1.9;">${chapter.steps.map(step => `<li style="margin:0 0 10px;padding-left:4px;">${escapeHtml(step)}</li>`).join('')}</ol></section>`).join('');
}

function shell({ subject, status, title, content, actionUrl, unsubscribeUrl }) {
  const optout = unsubscribeUrl ? `<p style="margin:16px 0 0;color:#626f85;font-size:12px;line-height:1.7;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#626f85;">등록한 이용 종료일 알림 취소</a></p>` : '';
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
<p style="margin:0 0 10px;color:#626f85;font-size:14px;line-height:1.7;">${escapeHtml(PRICE_NOTICE)}</p>
<p style="margin:0 0 12px;color:#06112b;font-size:14px;font-weight:700;line-height:1.7;">${escapeHtml(PC_NOTICE)}</p>
<p style="margin:0;color:#626f85;font-size:13px;line-height:1.7;">${escapeHtml(BILLING_NOTICE)}</p>
</td></tr></table>
${optout}
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
    paragraphs = ['안내 서비스 50,000원 결제가 확인되었습니다. 여러 안내 링크를 오갈 필요 없이 아래 11단원을 순서대로 읽고 진행하세요.', '다운로드·고객 전용 발급 정보 확인·연결 시작은 아래 버튼 하나에서 진행합니다. 전용 링크와 접속 정보는 다른 사람에게 공유하지 마세요.'];
  }
  const guideText = kind === 'paid-guide' ? EMAIL_GUIDE_CHAPTERS.map((chapter, index) => `${index + 1}. ${chapter.title}\n${chapter.steps.map((step, stepIndex) => `  ${stepIndex + 1}) ${step}`).join('\n')}`) : [];
  const text = [definition.title, ...paragraphs, ...serviceNotes(kind), ...guideText, PRICE_NOTICE, PC_NOTICE, BILLING_NOTICE, `${definition.button}:\n${actionUrl}`, ...(unsubscribeUrl ? [`등록한 이용 종료일 알림 취소:\n${unsubscribeUrl}`] : [])].join('\n\n');
  return { subject: definition.subject, text, html: shell({ ...definition, content: paragraphs.map(paragraph).join('') + serviceSummary(kind) + (kind === 'paid-guide' ? inlineGuideHtml() : '') + actionButton(actionUrl, definition.button), actionUrl, unsubscribeUrl }) };
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
  const koreanDateMatch = text.match(/이용 종료일은\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  let expiryDate;
  if (dateMatch || koreanDateMatch) { try { expiryDate = validateExpiryDate(dateMatch?.[1] || `${koreanDateMatch[1]}-${koreanDateMatch[2].padStart(2, '0')}-${koreanDateMatch[3].padStart(2, '0')}`); } catch { /* Never treat an invalid legacy date as a scheduled reminder. */ } }
  const kind = action?.path === '/verify' ? 'verify' : action?.path === '/guide' ? 'paid-guide' : expiryDate ? 'expiry-reminder' : 'checkout';
  if (action) {
    let unsubscribeUrl;
    for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
      try { unsubscribeUrl = safeUrl(match[0], origin, '/unsubscribe'); break; } catch { /* Only the validated opt-out route can become a footer link. */ }
    }
    // Old queued messages and new messages get the same clean layout: one action,
    // no duplicated raw token URL, and the complete paid guide in the email body.
    const rendered = buildTransactionalMail({ kind, publicUrl: origin, actionUrl: action.url, ...(expiryDate ? { expiryDate } : {}), ...(unsubscribeUrl ? { unsubscribeUrl } : {}) });
    return { ...rendered, subject };
  }
  return { subject, text, html: shell({ subject, title: subject.replace(/^\[[^\]]+\]\s*/, ''), status: '이용 안내', content: paragraph(text) }) };
}
