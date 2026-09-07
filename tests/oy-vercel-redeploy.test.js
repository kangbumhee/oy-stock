const test = require('node:test');
const assert = require('node:assert/strict');

test('redeploy uses active domain deployment and current production settings, never latest git commit', async () => {
  const { redeployProduction } = await import('../scripts/lib/oy-vercel-redeploy.mjs');
  const calls = [];
  const result = await redeployProduction({ token: 'test-only', projectId: 'prj_test', teamId: 'team_test', sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => calls.length === 1
        ? { projectId: 'prj_test', deploymentId: 'dpl_serving' } : { id: 'dpl_new', readyState: calls.length === 2 ? 'QUEUED' : 'READY' } };
    } });
  assert.equal(result.id, 'dpl_new');
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /deployments\/dpl_new\?teamId=team_test$/);
  assert.match(calls[0].url, /aliases\/olivestock.co.kr\?teamId=team_test/);
  assert.equal(calls[0].options.method, 'GET');
  assert.match(calls[1].url, /forceNew=1/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    name: 'oy-stock', project: 'prj_test', deploymentId: 'dpl_serving', target: 'production',
    withLatestCommit: false, projectSettings: { commandForIgnoringBuildStep: 'exit 1' },
  });
});

test('accepted deployments that later fail cannot report successful publication', async () => {
  const { redeployProduction } = await import('../scripts/lib/oy-vercel-redeploy.mjs');
  let calls = 0;
  await assert.rejects(redeployProduction({ projectId: 'prj_test', sleep: async () => {}, fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => calls === 1
      ? { projectId: 'prj_test', deploymentId: 'dpl_serving' }
      : { id: 'dpl_new', readyState: calls === 2 ? 'QUEUED' : 'ERROR' } };
  } }), { message: 'OY_VERCEL_REDEPLOY_FAILED' });
});

test('wrong project and failed provider responses cannot publish', async () => {
  const { redeployProduction } = await import('../scripts/lib/oy-vercel-redeploy.mjs');
  let calls = 0;
  await assert.rejects(redeployProduction({ projectId: 'prj_test', fetchImpl: async () => {
    calls++; return { ok: true, json: async () => ({ projectId: 'prj_other', deploymentId: 'dpl_other' }) };
  } }), { message: 'OY_VERCEL_PRODUCTION_MISMATCH' });
  assert.equal(calls, 1);
  await assert.rejects(redeployProduction({ fetchImpl: async () => ({ ok: false, status: 403 }) }),
    { message: 'OY_VERCEL_REDEPLOY_HTTP_403' });
});
