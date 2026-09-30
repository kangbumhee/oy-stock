import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatchPurchaseAlert, sendPurchaseAlert } from '../private-orders/lib/order-alerts.mjs';

const workflow = readFileSync(new URL('../.github/workflows/oy-purchase-alert.yml', import.meta.url), 'utf8');
const senderPath = fileURLToPath(new URL('../private-orders/lib/order-alerts.mjs', import.meta.url));
const emailStepName = 'Send purchase reconnect email';
const metadata = {
  incidentId: '7736fc84-d6ed-49a1-811c-5caab698a010',
  reason: 'reconnect_required',
  detectedAt: '2026-10-01T01:00:00.000Z',
};
const mailEnv = {
  ALERT_EMAIL_FROM: 'sender@example.test',
  ALERT_EMAIL_PASSWORD: 'SYNTHETIC-SMTP-PASSWORD',
  ALERT_EMAIL_TO: 'owner@example.test',
  OY_PURCHASE_ALERT_ID: metadata.incidentId,
  OY_PURCHASE_ALERT_REASON: metadata.reason,
  OY_PURCHASE_ALERT_DETECTED_AT: metadata.detectedAt,
};

test('workflow keeps the delivery step contract and propagates real sender failures', () => {
  const steps = workflow.split(/^      - /m).slice(1);
  const emailSteps = steps.filter(step => step.startsWith(`name: ${emailStepName}\n`)
    || step.startsWith(`name: ${emailStepName}\r\n`));
  assert.equal(emailSteps.length, 1);
  assert.match(emailSteps[0], /^        run: node private-orders\/lib\/order-alerts\.mjs --send-email\r?$/m);
  assert.doesNotMatch(workflow, /continue-on-error\s*:\s*true/);
  assert.doesNotMatch(emailSteps[0], /\|\|\s*(?:true|:)|exit\s+0/);
});

test('successful real alerts publish a notice and summary without forcing a failed run', () => {
  const summary = workflow.split(/^      - /m).find(step => step.includes('GITHUB_STEP_SUMMARY'));
  assert.ok(summary, 'successful alerts need a visible workflow summary');
  assert.match(summary, /^        if:.*success\(\).*inputs\.reason != 'connection_test'/m);
  assert.match(summary, /::notice::/);
  assert.doesNotMatch(summary, /::error::/);
  assert.doesNotMatch(workflow, /\bexit\s+[1-9]\d*\b/);
});

test('dispatcher recognizes delivery for successful runs and earlier intentionally failed runs without a rerun', async () => {
  for (const conclusion of ['success', 'failure']) {
    const calls = [];
    const result = await dispatchPurchaseAlert({ metadata, env: { GITHUB_REPO: 'synthetic-owner/synthetic-repo' },
      delivery: { dispatchAttempted: true, runId: 101, attempts: 1 },
      runProcess: async (_command, args) => {
        calls.push(args);
        if (args[0] === 'api') return { stdout: JSON.stringify({
          display_title: `OY purchase alert ${metadata.incidentId}`,
          path: '.github/workflows/oy-purchase-alert.yml', status: 'completed', conclusion, run_attempt: 1,
        }) };
        if (args[1] === 'view') return { stdout: JSON.stringify({ jobs: [{
          steps: [{ name: emailStepName, conclusion: 'success' }],
        }] }) };
        assert.fail('delivered alerts must not dispatch or rerun');
      },
    });
    assert.equal(result.status, 'sent');
    assert.equal(calls.length, 2);
  }
});

test('SMTP rejection remains an error and closes the transport without exposing provider details', async () => {
  let closed = false;
  await assert.rejects(sendPurchaseAlert({ env: mailEnv,
    createTransport: () => ({
      async sendMail() { throw new Error('SYNTHETIC-PRIVATE-SMTP-DETAIL'); },
      close() { closed = true; },
    }),
  }), { message: 'ORDER_ALERT_SMTP_FAILED', code: 'ORDER_ALERT_SMTP_FAILED' });
  assert.equal(closed, true);
});

test('sender CLI exits with failure when mail is unconfigured, without attempting SMTP', () => {
  // No host environment is inherited: validation stops before loading a mail transport.
  const run = spawnSync(process.execPath, [senderPath, '--send-email'], {
    env: { ...mailEnv, ALERT_EMAIL_PASSWORD: '' }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'ORDER_ALERT_EMAIL_FAILED\n');
});

test('connection test mail explicitly says it is not an account error or reconnect request', async () => {
  let message;
  const result = await sendPurchaseAlert({ env: { ...mailEnv, OY_PURCHASE_ALERT_REASON: 'connection_test' },
    createTransport: () => ({ async sendMail(value) { message = value; }, close() {} }),
  });
  assert.deepEqual(result, { sent: true, reason: 'connection_test' });
  assert.match(message.subject, /테스트/);
  assert.match(message.text, /이 메일 자체가 계정 오류를 뜻하지 않으며 재연결할 필요는 없습니다/);
  assert.doesNotMatch(message.text, /SYNTHETIC-SMTP-PASSWORD/);
});
