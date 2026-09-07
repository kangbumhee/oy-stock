import nodemailer from 'nodemailer';
import { pathToFileURL } from 'node:url';
import { validateAlertMetadata } from './lib/oy-login-health.mjs';

export async function sendLoginAlert({ env = process.env, createTransport = nodemailer.createTransport } = {}) {
  const metadata = validateAlertMetadata({
    reason: env.OY_LOGIN_ALERT_REASON, source: env.OY_LOGIN_ALERT_SOURCE, detectedAt: env.OY_LOGIN_ALERT_DETECTED_AT,
  });
  const from = String(env.ALERT_EMAIL_FROM || '').trim();
  const pass = String(env.ALERT_EMAIL_PASSWORD || '').trim();
  const to = String(env.ALERT_EMAIL_TO || '').trim();
  if (!from || !pass || !to || /[\0\r\n]/.test(from + pass + to) || from.length > 320 || to.length > 1024) {
    throw new Error('OY_LOGIN_ALERT_EMAIL_NOT_CONFIGURED');
  }
  const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') ? env.GITHUB_REPOSITORY : '';
  const runId = /^\d+$/.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : '';
  const runUrl = repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : '';
  const reconnect = metadata.reason === 'reconnect_required';
  const time = new Date(metadata.detectedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const text = [
    reconnect ? '올리브영 로그인 또는 운영 사이트의 큐레이터 인증이 만료되었거나 연결되지 않았습니다.'
      : metadata.source === 'daily_refresh' ? '올리브영 자동 갱신 또는 운영 서버 반영에 실패했습니다.' : '올리브영 로그인 또는 운영 서버 인증 확인이 3회 연속 실패했습니다. 로컬 로그인이 정상이면 재로그인 없이 서버 반영을 복구해야 합니다.',
    `감지 시각: ${time} (한국 시간)`,
    '',
    '자동 갱신 PC에서 올리브영 계정 설정을 확인하고 갱신을 다시 실행해 주세요.',
    '계정이나 API 키를 변경하려면 프로젝트 폴더에서 다음 명령을 실행하세요:',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/oy-login-secrets.ps1',
    '',
    '다시 갱신: npm.cmd run refresh:oy-cookie:chrome',
    '추가 인증이 필요한 경우 직접 인증한 뒤 갱신을 다시 실행해 주세요.',
    '일일 갱신과 15분 상태 확인은 계속 예약되어 있습니다. 같은 장애의 반복 알림은 정상 복구가 확인될 때까지 생략합니다.',
    runUrl ? `실행 내역: ${runUrl}` : '',
    '',
    '이 알림에는 계정 ID, 비밀번호, API 키, 쿠키 또는 CAPTCHA 정답이 포함되지 않습니다.',
  ].filter(Boolean).join('\n');
  let transporter;
  try {
    transporter = createTransport({ service: 'gmail', auth: { user: from, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    await transporter.sendMail({ from, to, subject: reconnect ? '[oy-stock] 올리브영 로그인 재연결 필요' : '[oy-stock] 올리브영 자동 갱신 / 상태 확인 실패', text });
    return { sent: true, reason: metadata.reason };
  } catch { throw new Error('OY_LOGIN_ALERT_SMTP_FAILED'); }
  finally { try { transporter?.close?.(); } catch { } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await sendLoginAlert();
    console.log('OY_LOGIN_ALERT_EMAIL_SENT');
  } catch {
    console.error('OY_LOGIN_ALERT_EMAIL_FAILED');
    process.exitCode = 1;
  }
}
