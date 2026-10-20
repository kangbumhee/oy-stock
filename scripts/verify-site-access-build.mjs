import fs from 'node:fs';
import assert from 'node:assert/strict';

const config = JSON.parse(fs.readFileSync('.vercel/output/config.json', 'utf8'));
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
console.log('Site entry middleware and protected static output verified.');
