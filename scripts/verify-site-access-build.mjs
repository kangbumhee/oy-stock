import fs from 'node:fs';
import assert from 'node:assert/strict';

const retiredHosts = new Set(['olivestock.co.kr', 'www.olivestock.co.kr']);
function assertNoRetiredMemberRedirect(routes, label) {
  for (const [index, route] of (routes || []).entries()) {
    const location = Object.entries(route.headers || {}).find(([name]) => name.toLowerCase() === 'location')?.[1];
    const destination = route.destination || location;
    if (typeof destination !== 'string') continue;
    let destinationHost;
    try { destinationHost = new URL(destination, 'https://oy-stock.vercel.app').hostname; }
    catch { continue; } // The Vercel config validator rejects malformed destinations.
    if (!retiredHosts.has(destinationHost)) continue;
    // Only redirects explicitly restricted to a retired host may point there.
    // Global, member-host and regex/unknown host rules must fail closed.
    const retiredHostOnly = route.has?.some((condition) => condition.type === 'host' && retiredHosts.has(condition.value));
    assert.ok(retiredHostOnly, `${label} route ${index} must not redirect the member site to a retired domain`);
  }
}

const sourceConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
assert.equal(sourceConfig.proxy?.entrypoint, 'site-access-proxy.ts', 'Source config must require the site access proxy');
assert.equal(sourceConfig.builds, undefined, 'Source config must not restore legacy builds that omit the site access proxy');
assertNoRetiredMemberRedirect(sourceConfig.redirects, 'Source redirect');
assertNoRetiredMemberRedirect(sourceConfig.routes, 'Source legacy');

const config = JSON.parse(fs.readFileSync('.vercel/output/config.json', 'utf8'));
assertNoRetiredMemberRedirect(config.routes, 'Build output');
const middleware = config.routes?.filter((route) => route.middlewarePath === 'site-access-proxy') || [];
assert.equal(middleware.length, 1, 'Site access middleware must be present exactly once');
assert.equal(middleware[0].src, '^/.*$', 'Site access middleware must cover every route');
assert.equal(middleware[0].override, true, 'Site access middleware must override static routes');
const gateIndex = config.routes.indexOf(middleware[0]);
for (const [index, route] of config.routes.entries()) {
  // A terminating custom rewrite placed first bypasses middleware entirely.
  // Header/redirect-only rules may precede it; files and destination rewrites may not.
  if (route.handle === 'filesystem' || route.dest || route.check) {
    assert.ok(index > gateIndex, `Route ${index} must not bypass site entry middleware`);
  }
}
assert.ok(fs.existsSync('.vercel/output/functions/site-access-proxy.func/.vc-config.json'));
assert.ok(fs.existsSync('.vercel/output/static/index.html'));
assert.ok(fs.existsSync('.vercel/output/static/sw.js'));
console.log('Source member routing, site entry middleware and protected static output verified.');
