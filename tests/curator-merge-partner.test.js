const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('merge cannot revive a newer old-account link over the configured partner result', () => {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'oy-partner-merge-'));
  const currentPartner = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const oldPartner = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const targetFile = path.join(directory, 'target.json');
  const generatedFile = path.join(directory, 'generated.json');
  try {
    fs.writeFileSync(targetFile, JSON.stringify({ links: {
      A000000111111: { affiliatePartnerId: oldPartner, shortenedUrl: 'https://oy.run/old', generatedAt: '2099-01-01T00:00:00Z' },
      A000000222222: { affiliatePartnerId: currentPartner, shortenedUrl: 'https://oy.run/current', generatedAt: '2026-01-01T00:00:00Z' }
    } }));
    fs.writeFileSync(generatedFile, JSON.stringify({ links: {
      A000000111111: { affiliatePartnerId: currentPartner, error: 'affiliate_link_unavailable', generatedAt: '2026-01-01T00:00:00Z' },
      A000000222222: { affiliatePartnerId: oldPartner, shortenedUrl: 'https://oy.run/stale-incoming', generatedAt: '2099-01-01T00:00:00Z' }
    } }));
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'merge-curator-links.mjs'), generatedFile, targetFile
    ], { encoding: 'utf8', env: { ...process.env, OLIVEYOUNG_AFFILIATE_REGISTER_ID: currentPartner }, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const merged = JSON.parse(fs.readFileSync(targetFile, 'utf8')).links;
    assert.equal(merged.A000000111111.affiliatePartnerId, currentPartner);
    assert.equal(merged.A000000111111.error, 'affiliate_link_unavailable');
    assert.equal(merged.A000000222222.shortenedUrl, 'https://oy.run/current');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), tempRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
