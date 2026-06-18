const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BLOG_PRODUCT_PROFILES, REVIEW_PHOTO_COUNT, getBlogProductProfile } = require('./blog-product-profiles');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const imageDir = path.join(publicDir, 'images', 'blog');
const manifestPath = path.join(publicDir, 'data', 'blog-posts.json');
const MANUAL_REVIEW_ASSET_VERSION = '20260611-manual-review';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function fail(message) {
  throw new Error(message);
}

function readManifestPosts() {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return Array.isArray(raw) ? raw : raw.posts || [];
}

function exists(file) {
  return fs.existsSync(file);
}

function fileSize(file) {
  return fs.statSync(file).size;
}

function pngDimensions(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    fail(`${path.basename(file)} is not a PNG file`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function hashFile(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function captionsFromProfile(profile) {
  return Array.isArray(profile && profile.captions) ? profile.captions : [];
}

function countMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

function createContactSheet(slug, files) {
  const output = path.join(root, `tmp-${slug}-manual-review-sheet.html`);
  const cells = files
    .map((file, index) => {
      const rel = path.relative(root, path.join(imageDir, file)).replace(/\\/g, '/');
      return `<figure><img src="${rel}" alt="${file}"><figcaption>${String(index + 1).padStart(2, '0')} ${file}</figcaption></figure>`;
    })
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>${slug} manual review sheet</title>
<style>
body{margin:20px;font-family:Arial,sans-serif;background:#f5f5f2;color:#222}
.grid{display:grid;grid-template-columns:repeat(6,160px);gap:14px}
figure{margin:0;background:white;padding:8px;border:1px solid #ddd}
img{display:block;width:144px;height:144px;object-fit:cover}
figcaption{margin-top:6px;font-size:11px;line-height:1.35}
</style><h1>${slug}</h1><div class="grid">${cells}</div>`;
  fs.writeFileSync(output, html, 'utf8');
  return output;
}

function verify(slug) {
  if (!slug) fail('Usage: node scripts/verify-manual-review-post.js --slug <slug>');

  const posts = readManifestPosts();
  const post = posts.find((item) => item.slug === slug);
  if (!post) fail(`manifest post not found: ${slug}`);
  if (post.reviewAssetVersion !== MANUAL_REVIEW_ASSET_VERSION) {
    fail(`${slug} reviewAssetVersion is ${post.reviewAssetVersion || '(empty)'}, expected ${MANUAL_REVIEW_ASSET_VERSION}`);
  }

  const profile = getBlogProductProfile(post);
  if (!profile) fail(`manual profile not found for ${slug}`);
  if (profile.assetPrefix !== slug) fail(`profile assetPrefix ${profile.assetPrefix} does not match slug ${slug}`);
  if ((profile.assetExt || 'png') !== 'png') fail(`profile assetExt must be png for ${slug}`);

  const expectedDetail = `${slug}-detail-page-01.png`;
  if (profile.detailFile !== expectedDetail) {
    fail(`profile detailFile must be ${expectedDetail}, got ${profile.detailFile || '(empty)'}`);
  }

  const detailPath = path.join(imageDir, expectedDetail);
  if (!exists(detailPath)) fail(`missing detail image: ${expectedDetail}`);
  const detailDim = pngDimensions(detailPath);
  if (detailDim.width < 600 || detailDim.height < 600) fail(`detail image too small: ${expectedDetail}`);

  const reviewFiles = Array.from({ length: REVIEW_PHOTO_COUNT }, (_, index) =>
    `${slug}-review-${String(index + 1).padStart(2, '0')}.png`
  );
  for (const file of reviewFiles) {
    const fullPath = path.join(imageDir, file);
    if (!exists(fullPath)) fail(`missing review image: ${file}`);
    const dim = pngDimensions(fullPath);
    if (dim.width < 600 || dim.height < 600) fail(`review image too small: ${file} ${dim.width}x${dim.height}`);
    if (fileSize(fullPath) < 20 * 1024) fail(`review image file is suspiciously small: ${file}`);
  }

  const hashes = new Set(reviewFiles.map((file) => hashFile(path.join(imageDir, file))));
  if (hashes.size < 12) fail(`review gallery has too few distinct image files: ${hashes.size}`);

  const obsoleteJpgs = fs
    .readdirSync(imageDir)
    .filter((name) => name.startsWith(`${slug}-review-`) && /\.(jpe?g)$/i.test(name));
  if (obsoleteJpgs.length) fail(`obsolete JPG review assets still exist: ${obsoleteJpgs.join(', ')}`);

  const sourceFiles = fs
    .readdirSync(imageDir)
    .filter((name) => name.startsWith(`${slug}-source`) && /\.(png|jpe?g|webp)$/i.test(name));
  if (!sourceFiles.length && !/^https:\/\/image\.oliveyoung\.co\.kr\//i.test(String(post.sourceImageUrl || ''))) {
    fail(`no OliveYoung source image evidence found for ${slug}`);
  }

  const captions = captionsFromProfile(profile);
  if (captions.length !== REVIEW_PHOTO_COUNT) fail(`profile must have ${REVIEW_PHOTO_COUNT} captions, got ${captions.length}`);
  const bannedCaptionText = /(상품페이지 대표 이미지|카드처럼 정리|실제로 사용해봤|제가.*써봤|구매해서 써)/;
  captions.forEach((caption, index) => {
    const title = stripTags(caption[0]);
    const body = stripTags(caption[1]);
    if (!title || !body) fail(`caption ${index + 1} is empty`);
    if (bannedCaptionText.test(`${title} ${body}`)) fail(`caption ${index + 1} contains banned wording`);
  });

  const htmlPath = path.join(publicDir, 'blog', slug, 'index.html');
  if (!exists(htmlPath)) fail(`missing blog HTML: public/blog/${slug}/index.html`);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const galleryCount = countMatches(html, /class="review-photo"/g);
  if (galleryCount !== REVIEW_PHOTO_COUNT) fail(`HTML gallery count is ${galleryCount}, expected ${REVIEW_PHOTO_COUNT}`);
  if (new RegExp(`${slug}-review-\\d{2}\\.jpe?g`, 'i').test(html)) fail('HTML references JPG review-gallery assets');
  if (!html.includes(expectedDetail)) fail(`HTML does not reference detail image ${expectedDetail}`);

  const result = {
    ok: true,
    slug,
    goodsNo: post.goodsNo || '',
    sourceFiles: sourceFiles.length,
    sourceImageUrl: post.sourceImageUrl || '',
    galleryCount,
    uniqueReviewImages: hashes.size,
    detailFile: expectedDetail
  };

  if (hasFlag('--contact-sheet')) {
    result.contactSheet = path.relative(root, createContactSheet(slug, reviewFiles)).replace(/\\/g, '/');
  }

  return result;
}

try {
  const result = verify(readArg('--slug'));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
