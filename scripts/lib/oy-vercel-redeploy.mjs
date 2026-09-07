// Redeploy the version actually serving the production domain. Git hooks may be
// disabled, and main can differ from the last manually published release.
export async function redeployProduction({ token, projectId, teamId, fetchImpl = fetch }) {
  const query = new URLSearchParams();
  if (teamId) query.set('teamId', teamId);
  async function request(path, body) {
    const response = await fetchImpl(`https://api.vercel.com${path}?${query}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`OY_VERCEL_REDEPLOY_HTTP_${response.status}`);
    return response.json();
  }
  const alias = await request('/v4/aliases/olivestock.co.kr');
  if (alias.projectId !== projectId || !/^dpl_[a-zA-Z0-9]+$/.test(alias.deploymentId || '')) {
    throw new Error('OY_VERCEL_PRODUCTION_MISMATCH');
  }
  query.set('forceNew', '1');
  const deployment = await request('/v13/deployments', {
    name: 'oy-stock', project: projectId, deploymentId: alias.deploymentId,
    target: 'production', withLatestCommit: false,
    projectSettings: { commandForIgnoringBuildStep: 'exit 1' },
  });
  if (!deployment.id || ['ERROR', 'CANCELED'].includes(deployment.readyState)) {
    throw new Error('OY_VERCEL_REDEPLOY_REJECTED');
  }
  return { id: deployment.id };
}
