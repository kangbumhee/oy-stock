/**
 * 알림 (콘솔 + 선택 Slack). 민감 정보는 본문에 넣지 않는다.
 */

const SLACK_WEBHOOK = (process.env.SLACK_WEBHOOK_URL || '').trim();

export async function sendNotification({ title, body, urgency = 'normal' }) {
  const timestamp = new Date().toISOString();
  const message = `[${String(urgency).toUpperCase()}] ${title}\n${body}\n(${timestamp})`;

  console.log(`[NOTIFY] ${message}`);

  if (!SLACK_WEBHOOK) return;

  try {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message })
    });
  } catch (err) {
    console.error(`[NOTIFY] Slack 전송 실패: ${err.message}`);
  }
}
