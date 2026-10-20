import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/verify-site-access-build.mjs', import.meta.url));
const sourceConfig = () => ({ version: 2, proxy: { entrypoint: 'site-access-proxy.ts' } });
const gate = () => ({ src: '^/.*$', middlewarePath: 'site-access-proxy', override: true, continue: true });
const buildConfig = () => ({ version: 3, routes: [gate(), { handle: 'filesystem' }] });

function verify(t, source = sourceConfig(), output = buildConfig(), missingArtifact = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oy-site-access-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, value) => {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  write('vercel.json', JSON.stringify(source));
  write('.vercel/output/config.json', JSON.stringify(output));
  for (const name of ['functions/site-access-proxy.func/.vc-config.json', 'static/index.html', 'static/sw.js']) {
    if (name !== missingArtifact) write(`.vercel/output/${name}`, '{}');
  }
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
}

function rejected(result, message) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
}

test('current source and complete all-path protected output pass the deployment guard', (t) => {
  const current = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const result = verify(t, current);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Source member routing/);
});

test('member-host and global modern redirects to retired domains are rejected', (t) => {
  for (const has of [undefined, [{ type: 'host', value: 'oy-stock.vercel.app' }]]) {
    const source = sourceConfig();
    source.redirects = [{ source: '/:path*', destination: 'https://olivestock.co.kr/:path*', ...(has ? { has } : {}) }];
    rejected(verify(t, source), /must not redirect the member site to a retired domain/);
  }
});

test('the previous legacy member-host 307 regression is rejected', (t) => {
  const source = sourceConfig();
  source.routes = [{ src: '/(.*)', has: [{ type: 'host', value: 'oy-stock.vercel.app' }],
    status: 307, headers: { Location: 'https://olivestock.co.kr/$1' } }];
  rejected(verify(t, source), /Source legacy.*must not redirect/);
});

test('case-insensitive build Location headers cannot bypass the source routing check', (t) => {
  const output = buildConfig();
  output.routes.unshift({ src: '/(.*)', status: 307, headers: { location: '//WWW.OLIVESTOCK.CO.KR/$1' } });
  rejected(verify(t, sourceConfig(), output), /Build output.*must not redirect/);
});

test('explicit retired-host-only cleanup redirects remain allowed', (t) => {
  const source = sourceConfig();
  source.redirects = [{ source: '/:path*', has: [{ type: 'host', value: 'www.olivestock.co.kr' }],
    destination: 'https://olivestock.co.kr/:path*' }];
  const result = verify(t, source);
  assert.equal(result.status, 0, result.stderr);
});

test('missing source proxy and legacy builds are rejected before deployment', (t) => {
  rejected(verify(t, { version: 2 }), /Source config must require the site access proxy/);
  rejected(verify(t, { ...sourceConfig(), builds: [] }), /must not restore legacy builds/);
});

test('missing middleware, terminating routes before it and absent artifacts are rejected', (t) => {
  rejected(verify(t, sourceConfig(), { version: 3, routes: [] }), /middleware must be present exactly once/);
  rejected(verify(t, sourceConfig(), { version: 3, routes: [{ src: '/data/(.*)', dest: '/data/$1' }, gate()] }), /must not bypass site entry middleware/);
  rejected(verify(t, sourceConfig(), buildConfig(), 'static/sw.js'), /AssertionError/);
});
