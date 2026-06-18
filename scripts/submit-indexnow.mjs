import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const host = 'olivestock.co.kr';
const key = '2d7c96e7a8b341fa84dbd6e89a830518';
const keyLocation = `https://${host}/${key}.txt`;
const sitemapPath = path.resolve(import.meta.dirname, '..', 'public', 'sitemap.xml');
const siteOrigin = `https://${host}`;

function readStringArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index === process.argv.length - 1) return '';
  return String(process.argv[index + 1] || '').trim();
}

function readMultiStringArg(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== flag) continue;
    const value = String(process.argv[index + 1] || '').trim();
    if (value) values.push(value);
  }
  return values;
}

function slugToUrl(slug) {
  const clean = String(slug || '').trim().replace(/^\/+|\/+$/g, '');
  return clean ? `${siteOrigin}/blog/${clean}/` : '';
}

function sitemapUrls() {
  const sitemap = fs.readFileSync(sitemapPath, 'utf8');
  return [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
}

const argUrls = readMultiStringArg('--url');
const argSlugs = readMultiStringArg('--slug');
const homepage = readStringArg('--include');
const urlList = Array.from(
  new Set(
    [
      ...argUrls,
      ...argSlugs.map(slugToUrl),
      ...(homepage === 'home' ? [`${siteOrigin}/`] : []),
      ...((argUrls.length || argSlugs.length || homepage) ? [] : sitemapUrls())
    ].filter(Boolean)
  )
);

const payload = JSON.stringify({
  host,
  key,
  keyLocation,
  urlList
});

const endpoints = [
  { name: 'Naver', hostname: 'searchadvisor.naver.com', path: '/indexnow' },
  { name: 'IndexNow', hostname: 'api.indexnow.org', path: '/indexnow' },
  { name: 'Bing', hostname: 'www.bing.com', path: '/indexnow' }
];

function submit(endpoint) {
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: endpoint.hostname,
        path: endpoint.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          const ok = [200, 202].includes(response.statusCode);
          resolve({
            endpoint: endpoint.name,
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
            submitted: urlList.length,
            ok,
            body
          });
        });
      }
    );

    request.on('error', (error) => {
      resolve({
        endpoint: endpoint.name,
        ok: false,
        error: error.message,
        submitted: urlList.length
      });
    });

    request.write(payload);
    request.end();
  });
}

const results = [];
for (const endpoint of endpoints) {
  results.push(await submit(endpoint));
}

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
