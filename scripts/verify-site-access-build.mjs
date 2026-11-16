import fs from 'node:fs';
import assert from 'node:assert/strict';
import siteAccess from '../api/_site-access.js';

const publicOrigin = siteAccess.configuredPublicSiteOrigin();
assert.ok(publicOrigin, 'OY_PUBLIC_SITE_URL must be a valid non-retired HTTPS origin');
const publicHost = new URL(publicOrigin).hostname;
const retiredHosts = new Set(['oy-stock.vercel.app', 'olivestock.co.kr', 'www.olivestock.co.kr']);
function assertNoHostClosureBypass(routes, label, modernRedirects = false) {
  for (const [index, route] of (routes || []).entries()) {
    const location = Object.entries(route.headers || {}).find(([name]) => name.toLowerCase() === 'location')?.[1];
    const redirect = modernRedirects || location !== undefined || (route.status >= 300 && route.status < 400);
    if (!redirect) continue;
    const destination = route.destination || location || route.dest;
    if (typeof destination === 'string') {
      const destinationHost = new URL(destination, publicOrigin).hostname;
      assert.ok(!retiredHosts.has(destinationHost), `${label} route ${index} must not redirect to a retired domain`);
    }
    const canonicalHostOnly = route.has?.some((condition) => condition.type === 'host' && condition.value === publicHost);
    assert.ok(canonicalHostOnly, `${label} route ${index} must not bypass retired or unknown host closure`);
  }
}

const sourceConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
assert.equal(sourceConfig.proxy?.entrypoint, 'site-access-proxy.ts', 'Source config must require the site access proxy');
assert.equal(sourceConfig.builds, undefined, 'Source config must not restore legacy builds that omit the site access proxy');
assertNoHostClosureBypass(sourceConfig.redirects, 'Source redirect', true);
assertNoHostClosureBypass(sourceConfig.routes, 'Source legacy');

const config = JSON.parse(fs.readFileSync('.vercel/output/config.json', 'utf8'));
assertNoHostClosureBypass(config.routes, 'Build output');
const middleware = config.routes?.filter((route) => route.middlewarePath === 'site-access-proxy') || [];
assert.equal(middleware.length, 1, 'Site access middleware must be present exactly once');
assert.equal(middleware[0].src, '^/.*$', 'Site access middleware must cover every route');
assert.equal(middleware[0].override, true, 'Site access middleware must override static routes');
const gateIndex = config.routes.indexOf(middleware[0]);
for (const [index, route] of config.routes.entries()) {
  if (route.handle === 'filesystem' || route.dest || route.check) {
    assert.ok(index > gateIndex, `Route ${index} must not bypass site entry middleware`);
  }
}
const proxyDirectory = '.vercel/output/functions/site-access-proxy.func';
assert.ok(fs.existsSync(`${proxyDirectory}/.vc-config.json`));
assert.ok(fs.existsSync('.vercel/output/static/index.html'));
assert.ok(fs.existsSync('.vercel/output/static/sw.js'));
assert.equal(fs.readFileSync(`${proxyDirectory}/api/_site-access.js`, 'utf8'),
  fs.readFileSync(new URL('../api/_site-access.js', import.meta.url), 'utf8'),
  'Compiled proxy must include the current host-closure policy');
assert.match(fs.readFileSync(`${proxyDirectory}/site-access-proxy.js`, 'utf8'), /require\(["']\.\/api\/_site-access\.js["']\)/,
  'Compiled proxy must invoke the protected site access module');

const close = siteAccess.createSiteAccessHandler({
  configuredPublicSiteOrigin: () => publicOrigin,
  configuredSiteAccess: () => { throw new Error('Retired host must close before reading entry secrets'); },
  allowLocalhost: false
});
for (const host of [...retiredHosts, 'oy-stock-kbhs-projects-ee1427b6.vercel.app',
  'oy-stock-unique-deployment.vercel.app', 'unknown.example']) {
  for (const path of ['/', '/index.html', '/data/stock-detail.json', '/api/oliveyoung/search',
    '/api/oliveyoung/hot-ranking-history', '/sw.js', '/service-status', '/_entry']) {
    const result = await close(new Request(`https://${host}${path}`));
    assert.equal(result?.status, 410, `Retired/unknown host ${host}${path} must close`);
    assert.equal(result.headers.get('location'), null, 'Host closure must not disclose or redirect to the new site');
  }
}
assert.equal(await close(new Request(`${publicOrigin}/service-status`)), null, 'Canonical public status route must remain available');
console.log('Source member routing, all-alias host closure, current compiled proxy and protected static output verified.');
