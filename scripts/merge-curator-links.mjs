import fs from 'fs';

const generatedFile = process.argv[2];
const targetFile = process.argv[3];

if (!generatedFile || !targetFile) {
  console.error('Usage: node scripts/merge-curator-links.mjs <generated.json> <target.json>');
  process.exit(1);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function addGoodsNo(out, value) {
  const goodsNo = String(value || '').trim().toUpperCase();
  if (/^[AB]\d+$/.test(goodsNo)) out.add(goodsNo);
}

const requested = new Set();
String(process.env.CURATOR_GOODS_NOS || '')
  .split(/[\s,;]+/)
  .forEach((value) => addGoodsNo(requested, value));

const generated = readJson(generatedFile, { updatedAt: null, links: {} });
const target = readJson(targetFile, { updatedAt: null, links: {} });
const generatedLinks = generated.links || {};
const targetLinks = target.links || {};
const keys = requested.size ? Array.from(requested) : Object.keys(generatedLinks);

let mergedCount = 0;
for (const key of keys) {
  if (!generatedLinks[key]) continue;
  targetLinks[key] = generatedLinks[key];
  mergedCount += 1;
}

target.links = targetLinks;
if (mergedCount > 0) {
  target.updatedAt = generated.updatedAt || new Date().toISOString();
}

fs.writeFileSync(targetFile, JSON.stringify(target, null, 2) + '\n', 'utf8');
console.log(`Merged ${mergedCount} curator link entries into ${targetFile}`);
