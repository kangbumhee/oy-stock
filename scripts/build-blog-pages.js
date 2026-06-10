const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildAutoProductProfile, buildBlogCopy, getBlogProductProfile } = require('./blog-product-profiles');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const blogDir = path.join(publicDir, 'blog');
const dataDir = path.join(publicDir, 'data');
const imageDir = path.join(publicDir, 'images', 'blog');

const SITE_URL = 'https://olivestock.co.kr';
const SITE_NAME = '올리브재고';
const GA_MEASUREMENT_ID = 'G-W7B566LXQ3';
const RANKING_URL = 'https://rts.ai.oliveyoung.co.kr/api/stats';
const MANIFEST_PATH = path.join(dataDir, 'blog-posts.json');
const BLOG_ASSET_VERSION = '20260610-source-images';
const MAX_SOURCE_GALLERY_IMAGES = 8;
const SOURCE_GALLERY_WINDOW = 5;

const CATEGORY_NAMES = {
  '10000010001': '스킨케어',
  '10000010002': '메이크업',
  '10000010003': '바디케어',
  '10000010009': '토너패드·마스크팩',
  '10000010010': '클렌징',
  '10000010011': '선케어',
  '10000010012': '네일',
  '10000020004': '헬스·위생용품',
  '10000030005': '생활용품'
};

const BRAND_SLUGS = [
  ['메디힐', 'mediheal'],
  ['토리든', 'torriden'],
  ['토니모리', 'tonymoly'],
  ['포들', 'foddle'],
  ['비오레', 'biore'],
  ['구달', 'goodal'],
  ['롬앤', 'romand'],
  ['클리오', 'clio'],
  ['바닐라코', 'banila-co'],
  ['웰라쥬', 'wellage'],
  ['아누아', 'anua'],
  ['라운드랩', 'round-lab'],
  ['페리페라', 'peripera']
];

const TYPE_SLUGS = [
  ['토너패드', 'toner-pad'],
  ['선세럼', 'sun-serum'],
  ['세럼', 'serum'],
  ['앰플', 'ampoule'],
  ['선크림', 'sunscreen'],
  ['마스크팩', 'mask-pack'],
  ['겔마스크', 'gel-mask'],
  ['틴트', 'tint'],
  ['립밤', 'lip-balm'],
  ['클렌징밤', 'cleansing-balm'],
  ['클렌저', 'cleanser'],
  ['수딩젤', 'soothing-gel'],
  ['스크럽', 'scrub']
];

function kstDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(value));
}

function kstDateTime(value = new Date()) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date(value))
    .replace(/\.\s?/g, '.')
    .replace(/\s/g, ' ')
    .trim();
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlEscape(value) {
  return htmlEscape(value).replace(/'/g, '&apos;');
}

function truncate(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function formatPostDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace(/-/g, '.');
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .format(date)
    .replace(/\.\s?/g, '.')
    .replace(/\.$/, '');
}

function stripPromoTags(name) {
  return String(name || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBadges(name) {
  return Array.from(String(name || '').matchAll(/\[([^\]]+)\]/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function goodsNoFromItem(item) {
  const raw = String((item && item.itemUrl) || '').trim();
  const match = raw.match(/goodsNo=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : raw;
}

function imageUrlFromItem(item) {
  const raw = String((item && item.imageUrl) || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://image.oliveyoung.co.kr/uploads/images/goods/550/${raw.replace(/^\/+/, '')}`;
}

function deriveBrand(name) {
  const text = String(name || '');
  const found = BRAND_SLUGS.find(([brand]) => text.includes(brand));
  return found ? found[0] : '';
}

function deriveType(name) {
  const text = String(name || '');
  const found = TYPE_SLUGS.find(([label]) => text.includes(label));
  return found ? found[0] : '인기상품';
}

function romanBrand(name) {
  const found = BRAND_SLUGS.find(([brand]) => name.includes(brand));
  return found ? found[1] : 'oliveyoung';
}

function typeSlug(name) {
  const found = TYPE_SLUGS.find(([label]) => name.includes(label));
  return found ? found[1] : 'hot-item';
}

function shortProductName(cleanName) {
  const type = deriveType(cleanName);
  const brand = deriveBrand(cleanName);
  if (brand && type !== '인기상품') {
    const idx = cleanName.indexOf(type);
    if (idx >= 0) {
      const head = cleanName.slice(0, idx + type.length);
      const withCount = cleanName.match(/(\d+\s?매|\d+\s?ml|\d+\s?mL|\d+\s?g)/);
      return truncate(`${head}${withCount ? ` ${withCount[1].replace(/\s/g, '')}` : ''}`, 34);
    }
  }
  return truncate(cleanName, 34);
}

function slugFor(item) {
  const goodsNo = goodsNoFromItem(item).toLowerCase();
  const name = stripPromoTags(item.itemName);
  const brand = romanBrand(name);
  const productType = typeSlug(name);
  const has200 = /200\s?매/.test(name) ? '-200' : '';
  return `${brand}-${productType}${has200}-stock-${goodsNo}`;
}

function normalizeRankItem(item, index, rankingUpdatedAt) {
  const rawName = String(item.itemName || '').trim();
  const cleanName = stripPromoTags(rawName);
  const shortName = shortProductName(cleanName);
  const brand = deriveBrand(cleanName);
  const categoryName = CATEGORY_NAMES[String(item.categoryId || '').slice(0, 11)] || '올리브영 인기상품';
  const badges = extractBadges(rawName);
  const goodsNo = goodsNoFromItem(item);
  const slug = slugFor(item);
  const rankingTime = rankingUpdatedAt || new Date().toISOString();
  const rankingDate = kstDate(rankingTime);
  const rankingDateText = kstDateTime(rankingTime);
  const title = `${shortName} 후기처럼 보기｜올리브영 재고`;
  const description = `${shortName}의 패키지 분위기와 구매 전 확인 포인트를 자연스럽게 보고 올리브영 재고와 구매 링크까지 바로 이어볼 수 있게 정리했습니다.`;

  return {
    slug,
    title,
    description,
    rawName,
    cleanName,
    shortName,
    brand,
    categoryName,
    badges,
    goodsNo,
    rank: Number(item.rank || index + 1),
    viewCount: Number(item.count || 0),
    itemId: String(item.itemId || item.id || ''),
    categoryId: String(item.categoryId || ''),
    publishedAt: rankingTime,
    modifiedAt: rankingTime,
    rankingDate,
    rankingDateText,
    query: shortName,
    image: `/images/blog/${slug}.png`,
    url: `/blog/${slug}/`,
    sourceImageUrl: imageUrlFromItem(item),
    source: 'oliveyoung-view-ranking'
  };
}

async function fetchViewRanking(limit) {
  const url = new URL(RANKING_URL);
  url.searchParams.set('type', 'view');
  url.searchParams.set('size', String(limit));

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`올리브영 인기순위 API 응답 실패: ${response.status}`);
  }

  const json = await response.json();
  if (!json || !Array.isArray(json.items) || json.items.length === 0) {
    throw new Error('올리브영 인기순위 API에 상품 데이터가 없습니다.');
  }

  return json.items.slice(0, limit).map((item, index) => normalizeRankItem(item, index, json.dateTime));
}

function analyticsTag() {
  return `  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${GA_MEASUREMENT_ID}');
  </script>`;
}

function faviconTags() {
  return `  <link rel="shortcut icon" href="${SITE_URL}/favicon.ico">
  <link rel="icon" type="image/png" sizes="48x48" href="${SITE_URL}/favicon-48x48.png">
  <link rel="apple-touch-icon" sizes="180x180" href="${SITE_URL}/apple-touch-icon.png">
  <link rel="manifest" href="${SITE_URL}/site.webmanifest">
  <meta name="theme-color" content="#193d22">`;
}

function absoluteUrl(urlPath) {
  return `${SITE_URL}${urlPath}`;
}

function imageAssetSrc(src) {
  if (/^https?:\/\//i.test(src)) return src;
  const separator = src.includes('?') ? '&' : '?';
  return `${src}${separator}v=${BLOG_ASSET_VERSION}`;
}

function sourceImageFileForPost(post) {
  return post && post.sourceImageFile ? post.sourceImageFile : '';
}

function sourceImageSrc(post, base) {
  const sourceFile = sourceImageFileForPost(post);
  if (sourceFile) return imageAssetSrc(`${base}${sourceFile}`);
  return post && post.sourceImageUrl ? post.sourceImageUrl : '';
}

function sourceGallerySrcs(post, base) {
  const files = Array.isArray(post && post.sourceGalleryFiles) ? post.sourceGalleryFiles : [];
  const sourceFile = sourceImageFileForPost(post);
  const uniqueFiles = Array.from(new Set([sourceFile, ...files].filter(Boolean)));
  return uniqueFiles.map((file) => imageAssetSrc(`${base}${file}`));
}

function postImageSrc(post) {
  return sourceImageSrc(post, '../../images/blog/') || imageAssetSrc(`../../images/blog/${path.basename(post.image)}`);
}

function blogIndexImageSrc(post) {
  return sourceImageSrc(post, '../images/blog/') || imageAssetSrc(`../images/blog/${postCardImageFile(post)}`);
}

function homeImageSrc(post) {
  return sourceImageSrc(post, 'images/blog/') || imageAssetSrc(`images/blog/${postCardImageFile(post)}`);
}

function postCardImageFile(post) {
  const profile = getBlogProductProfile(post);
  return profile && profile.detailFile ? profile.detailFile : path.basename(post.image);
}

function refreshPostCopy(post) {
  if (!post) return post;
  const profile = getBlogProductProfile(post) || buildAutoProductProfile(post);
  const postWithProfile = profile ? { ...post, profile } : post;
  const copy = buildBlogCopy(postWithProfile, profile);
  return {
    ...postWithProfile,
    title: copy.title,
    description: copy.description
  };
}

function blogReviewAssets(post) {
  const profile = getBlogProductProfile(post);
  if (!profile || !profile.assetPrefix || !profile.captions.length) return null;
  const base = '../../images/blog/';
  const ext = profile.assetExt || 'png';
  const realProductImage = sourceImageSrc(post, base);
  const realProductImages = sourceGallerySrcs(post, base);
  const captions = realProductImages.length
    ? profile.captions.slice(0, Math.max(1, Math.min(profile.captions.length, realProductImages.length)))
    : profile.captions;

  const photos = captions.map((caption, index) => ({
    src:
      realProductImages[index] ||
      realProductImage ||
      imageAssetSrc(`${base}${profile.assetPrefix}-review-${String(index + 1).padStart(2, '0')}.${ext}`),
    source: Boolean(realProductImages[index] || realProductImage),
    title: caption[0],
    caption: caption[1],
    alt: `${post.shortName} 후기형 사진 ${index + 1}`
  }));

  return {
    profile,
    detail: realProductImage || imageAssetSrc(`${base}${profile.detailFile}`),
    stock: postImageSrc(post),
    photos
  };
}

function blogPostTemplate(post, relatedPosts) {
  const pageUrl = absoluteUrl(post.url);
  const imageUrl = absoluteUrl(post.image);
  const visibleImage = postImageSrc(post);
  const reviewAssets = blogReviewAssets(post);
  const copy = buildBlogCopy(post, reviewAssets && reviewAssets.profile);
  const coverImage = reviewAssets ? reviewAssets.detail : visibleImage;
  const searchHref = `${SITE_URL}/?q=${encodeURIComponent(post.query)}&autoBuy=${encodeURIComponent(post.goodsNo)}`;
  const curatorHref = `${SITE_URL}/api/oliveyoung/curator-redirect?goodsNo=${encodeURIComponent(post.goodsNo)}`;
  const badge = post.badges.find((item) => item.includes('올영픽')) || post.badges[0] || '올리브영 인기상품';
  const moodNotes = copy.moodNotes
    .map((item) => `<div><b>${htmlEscape(item[0])}</b><span>${htmlEscape(item[1])}</span></div>`)
    .join('\n          ');
  const shoppingParagraphs = copy.shoppingParagraphs.map((item) => `<p>${item}</p>`).join('\n        ');
  const checklist = copy.checklist.map((item) => `<li>${htmlEscape(item)}</li>`).join('\n          ');
  const tips = copy.tips
    .map((item) => `<div><b>${htmlEscape(item[0])}</b><span>${htmlEscape(item[1])}</span></div>`)
    .join('\n          ');
  const photoDiary = reviewAssets
    ? `<section class="photo-diary" aria-labelledby="photo-diary-title">
          <div class="section-label">사진으로 쓱 보기</div>
          <h2 id="photo-diary-title">${htmlEscape(copy.photoTitle)}</h2>
          <p>${copy.photoLead}</p>
          <div class="photo-grid">
            ${reviewAssets.photos
              .map(
                (photo, index) => `<figure class="review-photo">
              <div class="photo-frame${photo.source ? ' source-frame' : ''}">
                <img src="${photo.src}" alt="${htmlEscape(photo.alt)}" loading="lazy">
              </div>
              <figcaption><b>${String(index + 1).padStart(2, '0')}</b><strong>${htmlEscape(photo.title)}</strong><span>${htmlEscape(photo.caption)}</span></figcaption>
            </figure>`
              )
              .join('\n            ')}
          </div>
        </section>`
    : '';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.description,
        image: {
          '@type': 'ImageObject',
          url: imageUrl,
          width: 1200,
          height: 630
        },
        author: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/favicon-192x192.png` }
        },
        datePublished: post.publishedAt,
        dateModified: post.modifiedAt,
        mainEntityOfPage: pageUrl,
        inLanguage: 'ko-KR',
        keywords: [
          post.shortName,
          `${post.shortName} 재고`,
          `${post.shortName} 올리브영`,
          '올리브영 재고확인',
          '올리브영 매장 재고',
          '올리브영 온라인 재고'
        ]
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: '재고 블로그', item: `${SITE_URL}/blog/` },
          { '@type': 'ListItem', position: 3, name: post.shortName, item: pageUrl }
        ]
      }
    ]
  };

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${htmlEscape(post.title)} | ${SITE_NAME}</title>
  <meta name="description" content="${htmlEscape(post.description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${pageUrl}">
${faviconTags()}
  <meta property="og:type" content="article">
  <meta property="og:locale" content="ko_KR">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${htmlEscape(post.title)}">
  <meta property="og:description" content="${htmlEscape(post.description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${htmlEscape(post.title)}">
  <meta name="twitter:description" content="${htmlEscape(post.description)}">
  <meta name="twitter:image" content="${imageUrl}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${analyticsTag()}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;background:#f5fbfc;color:#17232f;line-height:1.82}
    a{color:inherit}
    .wrap{max-width:980px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 22px 60px rgba(15,55,70,.08)}
    header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 24px;border-bottom:1px solid #d9eef1;background:#fff}
    .brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:900;color:#103040}
    .mark{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:#12c8d1;color:#fff;font-weight:900}
    nav{display:flex;gap:14px;font-size:13px;color:#4b6472;font-weight:800}
    nav a{text-decoration:none}
    .hero{padding:34px 24px 24px;background:linear-gradient(135deg,#ecfbff 0%,#ffffff 52%,#f5fff8 100%);border-bottom:1px solid #d9eef1}
    .kicker{display:inline-flex;margin-bottom:12px;padding:5px 11px;border-radius:999px;background:#dff8fb;color:#006c75;font-size:12px;font-weight:900}
    h1{max-width:820px;font-size:34px;line-height:1.25;letter-spacing:0;margin-bottom:12px;color:#152536;word-break:keep-all}
    .lead{max-width:760px;font-size:17px;color:#4a6472;font-weight:700}
    .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;color:#006c75;font-size:13px;font-weight:900}
    .meta span{border:1px solid #bdebf0;border-radius:999px;padding:4px 10px;background:#fff}
    main{padding:24px 24px 36px}
    .cover{display:block;width:100%;max-width:760px;height:auto;margin:0 auto 30px;border:1px solid #c9edf1;border-radius:8px;background:#fff}
    article{max-width:760px;margin:0 auto}
    article h2{font-size:25px;line-height:1.35;margin:34px 0 10px;color:#152536;word-break:keep-all}
    article p{font-size:16px;color:#334657;margin-bottom:13px}
    .section-label{display:inline-flex;margin:18px 0 8px;padding:4px 10px;border-radius:999px;background:#effbfc;color:#008892;font-size:12px;font-weight:900}
    .highlight{display:inline;padding:2px 5px;border-radius:6px;background:#cffafe;color:#006c75;font-weight:900}
    .big-line{font-size:21px!important;line-height:1.52!important;color:#152536!important;font-weight:900;word-break:keep-all}
    .soft-word{color:#00a9b7;font-weight:900}
    .intro-box{padding:20px;border:1px solid #b8eef3;border-radius:8px;background:linear-gradient(135deg,#f0fdff 0%,#fff 70%);margin:20px 0}
    .intro-box p:last-child{margin-bottom:0}
    .mood-note{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0 24px}
    .mood-note div{padding:14px;border:1px solid #c9edf1;border-radius:8px;background:#f8feff}
    .mood-note b{display:block;margin-bottom:4px;color:#008892;font-size:15px}
    .mood-note span{display:block;color:#4a6472;font-size:13px;font-weight:700;line-height:1.55}
    .fact{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:22px 0}
    .fact div{border:1px solid #c9edf1;border-radius:8px;padding:14px;background:#f8feff}
    .fact b{display:block;color:#006c75;margin-bottom:4px}
    .fact span{font-size:13px;color:#526b7a;font-weight:800}
    .detail-shot{margin:18px 0 24px}
    .detail-shot img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid #c9edf1;background:#eefbfc}
    figcaption{font-size:13px;color:#526b7a;line-height:1.55;margin-top:8px}
    .photo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px}
    .review-photo{min-width:0}
    .photo-frame{aspect-ratio:1/1;overflow:hidden;border-radius:8px;border:1px solid #c9edf1;background:#eefbfc}
    .photo-frame img{display:block;width:100%;height:100%;object-fit:cover}
    .photo-frame.source-frame{background:#fff}
    .photo-frame.source-frame img{object-fit:contain;padding:14px}
    .review-photo figcaption b{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-right:8px;border-radius:999px;background:#15c6d1;color:#fff;font-size:12px;vertical-align:top}
    .review-photo figcaption strong{display:inline;color:#008892;font-size:15px;margin-right:6px}
    .review-photo figcaption span{display:block;margin-top:5px;color:#4a6472}
    .checklist{padding:16px;border:1px solid #c9edf1;border-radius:8px;background:#f8feff;margin:18px 0}
    .checklist li{margin-left:18px;color:#334657}
    .tip-list{display:grid;gap:10px;margin:18px 0}
    .tip-list div{padding:14px;border-left:4px solid #15c6d1;background:#f8feff}
    .tip-list b{display:block;color:#152536;margin-bottom:4px}
    .cta{margin:32px 0;padding:24px;border-radius:8px;background:linear-gradient(135deg,#12364a 0%,#0f5660 100%);color:#fff}
    .cta h2{margin:0 0 8px;color:#fff;font-size:24px}
    .cta p{color:#e6f8fb}
    .cta-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
    .cta a{display:inline-flex;min-height:46px;align-items:center;justify-content:center;padding:0 17px;border-radius:8px;text-decoration:none;font-weight:900}
    .buy-link{background:#15c6d1;color:#fff;box-shadow:0 10px 24px rgba(21,198,209,.28)}
    .stock-link{background:#fff;color:#0f5660}
    .notice{font-size:13px!important;color:#607383!important;border-top:1px solid #d9eef1;padding-top:14px;margin-top:22px}
    .related{max-width:760px;margin:34px auto 0;padding-top:22px;border-top:1px solid #d9eef1}
    .related h2{font-size:21px;margin-bottom:12px}
    .related-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .related-grid a{padding:13px;border:1px solid #c9edf1;border-radius:8px;text-decoration:none;font-weight:900;color:#006c75;background:#fff}
    footer{padding:24px 22px;background:#143344;color:#e6f8fb;text-align:center;font-size:13px}
    @media(max-width:720px){
      header{align-items:flex-start;flex-direction:column}
      nav{flex-wrap:wrap}
      h1{font-size:28px}
      main,.hero{padding-left:16px;padding-right:16px}
      .fact,.photo-grid,.mood-note{grid-template-columns:1fr}
      .related-grid{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="/"><span class="mark">O</span><span>${SITE_NAME}</span></a>
      <nav>
        <a href="/">재고 검색</a>
        <a href="/blog/">재고 블로그</a>
        <a href="/guide/">검색 가이드</a>
      </nav>
    </header>
    <section class="hero">
      <span class="kicker">${htmlEscape(badge)}</span>
      <h1>${htmlEscape(post.title)}</h1>
      <p class="lead">${htmlEscape(copy.heroLead)}</p>
      <div class="meta">
        <span>조회 인기 ${post.rank}위</span>
        <span>${htmlEscape(post.categoryName)}</span>
        <span>${htmlEscape(post.rankingDateText)} 기준</span>
      </div>
    </section>
    <main>
      <img class="cover" src="${coverImage}" alt="${htmlEscape(post.shortName)} 올리브영 재고 확인 대표 이미지" fetchpriority="high">
      <article>
        <div class="intro-box">
          <p class="big-line">${copy.introBig}</p>
          <p>${htmlEscape(copy.introBody)}</p>
        </div>

        <section class="mood-note" aria-label="먼저 본 느낌">
          ${moodNotes}
        </section>

        <section class="fact" aria-label="상품 확인 요약">
          <div><b>조회 순위</b><span>${post.rank}위 · 조회 ${post.viewCount.toLocaleString('ko-KR')}회</span></div>
          <div><b>상품 구분</b><span>${htmlEscape(post.categoryName)}</span></div>
        </section>

        ${photoDiary}

        <div class="section-label">사기 전에 요것만</div>
        <h2>${htmlEscape(copy.shoppingTitle)}</h2>
        ${shoppingParagraphs}
        <ul class="checklist">
          ${checklist}
        </ul>

        <div class="section-label">재고 보는 순서</div>
        <h2>${htmlEscape(copy.tipTitle)}</h2>
        <p>${htmlEscape(copy.tipParagraph)}</p>
        <div class="tip-list">
          ${tips}
        </div>

        <section class="cta">
          <div class="section-label">마지막으로</div>
          <h2>살 거면 여기서 바로 이어가요</h2>
          <p>구매하러가기 버튼은 ${SITE_NAME}에 연결된 구매 링크로 이어집니다. 마음에 들면 바로 열어보고, 재고까지 한 번 더 보고 싶으면 아래 버튼으로 확인하면 됩니다.</p>
          <div class="cta-actions">
            <a class="buy-link" href="${curatorHref}" target="_blank" rel="noopener noreferrer">구매하러가기</a>
            <a class="stock-link" href="${searchHref}">재고 먼저 보고 구매하기</a>
          </div>
        </section>

        <p class="notice">본문 이미지는 올리브영 상품페이지의 실제 상품 이미지를 기준으로 배치했습니다. ${SITE_NAME}은 올리브영 공식 서비스가 아니며, 최종 가격·쿠폰·구매 가능 여부는 연결된 구매 화면에서 다시 확인해야 합니다.</p>
      </article>
      <section class="related" aria-labelledby="related-title">
        <h2 id="related-title">최근 재고 블로그</h2>
        <div class="related-grid">
          ${relatedPosts
            .filter((item) => item.slug !== post.slug)
            .slice(0, 4)
            .map((item) => `<a href="${item.url}">${htmlEscape(item.shortName || item.title)}</a>`)
            .join('\n          ') || '<a href="/blog/">재고 블로그 목록 보기</a>'}
        </div>
      </section>
    </main>
    <footer>${SITE_NAME} · 올리브영 재고확인과 인기상품 랭킹을 빠르게 비교하는 검색 도구</footer>
  </div>
</body>
</html>`;
}

function blogIndexTemplate(posts) {
  const description = '올리브영 인기상품, 올영픽, 품절·재입고 흐름을 바탕으로 매장·온라인 재고 확인 포인트를 정리한 올리브재고 블로그입니다.';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${SITE_NAME} 재고 블로그`,
    description,
    url: `${SITE_URL}/blog/`,
    inLanguage: 'ko-KR',
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    blogPost: posts.map((post) => ({
      '@type': 'BlogPosting',
      headline: post.title,
      url: absoluteUrl(post.url),
      image: absoluteUrl(post.image),
      datePublished: post.publishedAt
    }))
  };
  const cards = posts
    .map(
      (post) => `<a class="post-card" href="${post.url}">
        <img src="${blogIndexImageSrc(post)}" alt="${htmlEscape(post.shortName)} 제품 이미지" width="360" height="270" loading="lazy">
        <span class="category">${htmlEscape(post.categoryName || '올리브영 인기상품')}</span>
        <div class="card-meta">
          <span>업로드 ${htmlEscape(formatPostDate(post.publishedAt || post.rankingDate))}</span>
          <span>조회 ${formatNumber(post.viewCount)}회</span>
        </div>
        <strong>${htmlEscape(post.title)}</strong>
        <small>${htmlEscape(post.description)}</small>
      </a>`
    )
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>올리브영 재고 블로그 | ${SITE_NAME}</title>
  <meta name="description" content="${description}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${SITE_URL}/blog/">
${faviconTags()}
${analyticsTag()}
  <meta property="og:type" content="website">
  <meta property="og:locale" content="ko_KR">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="올리브영 재고 블로그 | ${SITE_NAME}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${SITE_URL}/blog/">
  <meta property="og:image" content="${posts[0] ? absoluteUrl(posts[0].image) : `${SITE_URL}/images/olivestock-og-image.svg`}">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;background:#f6f8f4;color:#172018;line-height:1.65}
    .wrap{max-width:1060px;margin:0 auto;background:#fff;min-height:100vh;padding:28px 20px}
    header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:26px}
    .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:#172018;font-weight:900}
    .mark{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:#193d22;color:#d7ff52}
    h1{font-size:34px;line-height:1.22;margin-bottom:10px}
    .lead{max-width:760px;color:#475569;font-weight:700}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:26px}
    .post-card{display:flex;flex-direction:column;gap:9px;padding:10px;border:1px solid #dfead8;border-radius:8px;background:#fff;text-decoration:none;color:#172018}
    .post-card img{width:100%;height:auto;aspect-ratio:4/3;object-fit:contain;object-position:center;border-radius:6px;background:#fff;padding:8px}
    .post-card .category{font-size:12px;color:#315b11;font-weight:900}
    .card-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:-2px}
    .card-meta span{display:inline-flex;align-items:center;border-radius:999px;background:#f0f8e9;color:#426031;padding:2px 8px;font-size:11px;font-weight:900;line-height:1.5}
    .post-card strong{font-size:16px;line-height:1.35;color:#193d22}
    .post-card small{font-size:13px;color:#64748b;font-weight:700}
    @media(max-width:860px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:560px){.grid{grid-template-columns:1fr}h1{font-size:28px}header{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <main class="wrap">
    <header>
      <a class="brand" href="/"><span class="mark">O</span><span>${SITE_NAME}</span></a>
      <a href="/">재고 검색으로 돌아가기</a>
    </header>
    <h1>올리브영 재고 블로그</h1>
    <p class="lead">${description}</p>
    <section class="grid" aria-label="재고 블로그 글 목록">
      ${cards || '<p>아직 생성된 블로그 글이 없습니다.</p>'}
    </section>
  </main>
</body>
</html>`;
}

function ogImageHtml(post) {
  const badge = post.badges.find((item) => item.includes('올영픽')) || '조회 인기 1위';
  const imageHeadline = post.shortName.replace('더마 ', '');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <style>
    *{box-sizing:border-box}
    body{margin:0;width:1200px;height:630px;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;background:#f7faf2;color:#15251b}
    .stage{position:relative;width:1200px;height:630px;overflow:hidden;background:linear-gradient(135deg,#f4ffe8 0%,#ffffff 58%,#eaf7ff 100%)}
    .band{position:absolute;left:0;right:0;bottom:0;height:154px;background:#193d22}
    .panel{position:absolute;left:72px;top:58px;width:760px;height:418px;border:2px solid #dfead8;border-radius:28px;background:rgba(255,255,255,.94);padding:44px 48px;box-shadow:0 22px 60px rgba(15,23,42,.12)}
    .brand{display:flex;align-items:center;gap:14px;font-size:26px;font-weight:900;color:#193d22;margin-bottom:34px}
    .mark{display:flex;align-items:center;justify-content:center;width:58px;height:58px;border-radius:16px;background:#193d22;color:#d7ff52;font-size:34px}
    .badge{display:inline-flex;align-items:center;height:42px;padding:0 18px;border-radius:999px;background:#d7ff52;color:#193d22;font-size:22px;font-weight:900;margin-bottom:20px}
    h1{font-size:52px;line-height:1.14;letter-spacing:0;margin:0;color:#15251b;word-break:keep-all}
    .sub{position:absolute;left:120px;bottom:50px;color:#eaf7df;font-size:30px;font-weight:900}
    .date{position:absolute;right:86px;bottom:54px;color:#d7ff52;font-size:25px;font-weight:900}
    .visual{position:absolute;right:96px;top:78px;width:270px;height:390px}
    .pad{position:absolute;left:30px;top:42px;width:210px;height:260px;border-radius:42px;background:#fff;border:2px solid #dfead8;box-shadow:0 24px 50px rgba(25,61,34,.16)}
    .pad:before{content:'';position:absolute;left:42px;top:38px;width:126px;height:126px;border-radius:50%;background:#e8f7da;border:18px solid #cfe3c0}
    .pad:after{content:'TONER\\A PAD';white-space:pre;position:absolute;left:0;right:0;bottom:48px;text-align:center;color:#193d22;font-size:30px;line-height:1.1;font-weight:900}
    .mini{position:absolute;right:0;bottom:0;width:150px;height:116px;border-radius:28px;background:#d7ff52;border:2px solid #193d22;box-shadow:0 18px 36px rgba(25,61,34,.15)}
    .mini:before{content:'재고\\A 확인';white-space:pre;position:absolute;inset:25px 0 0;text-align:center;color:#193d22;font-size:30px;line-height:1.05;font-weight:900}
    .rank{position:absolute;right:0;top:0;z-index:3;width:118px;height:118px;border-radius:32px;background:#193d22;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;font-size:36px;line-height:1.05;font-weight:900}
    .rank small{display:block;font-size:20px;color:#d7ff52}
  </style>
</head>
<body>
  <div class="stage">
    <div class="band"></div>
    <div class="panel">
      <div class="brand"><div class="mark">O</div><div>올리브재고 BLOG</div></div>
      <div class="badge">${htmlEscape(badge)}</div>
      <h1>${htmlEscape(imageHeadline)}<br>올리브영 재고 확인</h1>
    </div>
    <div class="visual">
      <div class="rank"><div><small>조회</small>${post.rank}위</div></div>
      <div class="pad"></div>
      <div class="mini"></div>
    </div>
    <div class="sub">온라인 · 매장 · 오늘드림 체크</div>
    <div class="date">${htmlEscape(post.rankingDate)}</div>
  </div>
</body>
</html>`;
}

async function renderOgImage(post) {
  await fs.mkdir(imageDir, { recursive: true });
  const htmlPath = path.join(imageDir, `${post.slug}.html`);
  const imagePath = path.join(imageDir, `${post.slug}.png`);
  await fs.writeFile(htmlPath, ogImageHtml(post), 'utf8');

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    await page.screenshot({ path: imagePath, type: 'png' });
  } finally {
    await browser.close();
    await fs.rm(htmlPath, { force: true });
  }
}

async function readManifest() {
  try {
    const data = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
    return Array.isArray(data.posts) ? data.posts : [];
  } catch {
    return [];
  }
}

async function writeManifest(posts) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    MANIFEST_PATH,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), posts }, null, 2)}\n`,
    'utf8'
  );
}

function imageExtensionFromSource(url, contentType = '') {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.(jpe?g|png|webp)$/);
    if (match) return match[1] === 'jpeg' ? '.jpg' : `.${match[1]}`;
  } catch {
    // Keep a stable jpg fallback when the CDN URL cannot be parsed.
  }

  return '.jpg';
}

function sourceImageFileName(post, sourceImageUrl, contentType) {
  return `${post.slug}-source${imageExtensionFromSource(sourceImageUrl, contentType)}`;
}

function withSourceImageFile(post, sourceImageFile) {
  return {
    ...post,
    sourceImageFile,
    sourceGalleryFiles: Array.isArray(post.sourceGalleryFiles) && post.sourceGalleryFiles.length
      ? Array.from(new Set([sourceImageFile, ...post.sourceGalleryFiles].filter(Boolean)))
      : [sourceImageFile],
    sourceGalleryCheckedAt: post.sourceGalleryCheckedAt || kstDate(),
    image: `/images/blog/${sourceImageFile}`
  };
}

function sourceImageVariantCandidates(sourceImageUrl) {
  const cleanUrl = String(sourceImageUrl || '').trim();
  const match = cleanUrl.match(/^(.*A\d{12})(\d+)(ko\.[a-z0-9]+(?:\?[^#]*)?)$/i);
  if (!match) return [cleanUrl].filter(Boolean);

  const [, prefix, rawNumber, suffix] = match;
  const current = Number(rawNumber);
  if (!Number.isFinite(current)) return [cleanUrl];

  const start = Math.max(1, current - SOURCE_GALLERY_WINDOW);
  const end = current + SOURCE_GALLERY_WINDOW;
  const variants = [cleanUrl];
  for (let value = start; value <= end; value += 1) {
    variants.push(`${prefix}${value}${suffix}`);
  }
  return Array.from(new Set(variants));
}

async function localFileExists(fileName) {
  try {
    await fs.access(path.join(imageDir, fileName));
    return true;
  } catch {
    return false;
  }
}

async function localSourceGalleryFiles(post, sourceImageFile) {
  try {
    const names = await fs.readdir(imageDir);
    const prefix = `${post.slug}-source-`;
    const localFiles = names
      .filter((name) => name.startsWith(prefix) && /\.(jpe?g|png|webp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return Array.from(new Set([sourceImageFile, ...localFiles].filter(Boolean))).slice(0, MAX_SOURCE_GALLERY_IMAGES);
  } catch {
    return [sourceImageFile];
  }
}

async function downloadSourceGalleryFiles(post, sourceImageUrl, sourceImageFile, options = {}) {
  const localFiles = await localSourceGalleryFiles(post, sourceImageFile);
  const existing = Array.isArray(post.sourceGalleryFiles)
    ? Array.from(new Set([sourceImageFile, ...post.sourceGalleryFiles, ...localFiles].filter(Boolean))).slice(
        0,
        MAX_SOURCE_GALLERY_IMAGES
      )
    : localFiles;
  if (options.probeGallery === false) return existing;
  if (post.sourceGalleryCheckedAt) {
    const checks = await Promise.all(existing.map(localFileExists));
    if (checks.every(Boolean)) return existing;
  }

  const files = [sourceImageFile];
  const candidates = sourceImageVariantCandidates(sourceImageUrl).filter((url) => url !== sourceImageUrl);
  for (const candidateUrl of candidates) {
    if (files.length >= MAX_SOURCE_GALLERY_IMAGES) break;
    try {
      const response = await fetch(candidateUrl, {
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: 'https://www.oliveyoung.co.kr/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
        }
      });
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('image/')) continue;

      const variant = candidateUrl.match(/A\d{12}(\d+)ko\./i);
      const variantId = variant ? variant[1] : String(files.length + 1).padStart(2, '0');
      const fileName = `${post.slug}-source-${variantId}${imageExtensionFromSource(candidateUrl, contentType)}`;
      const target = path.join(imageDir, fileName);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1024) continue;
      await fs.writeFile(target, buffer);
      files.push(fileName);
    } catch {
      // Some OliveYoung CDN numbers simply do not exist for a product.
    }
  }

  return files;
}

async function downloadSourceImage(post, options = {}) {
  if (!post.sourceImageUrl) {
    return post.sourceImageFile ? withSourceImageFile(post, post.sourceImageFile) : post;
  }

  try {
    const response = await fetch(post.sourceImageUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://www.oliveyoung.co.kr/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      }
    });

    if (!response.ok) {
      console.warn(`source image failed ${response.status}: ${post.sourceImageUrl}`);
      return post;
    }

    const contentType = response.headers.get('content-type') || '';
    const sourceImageFile = sourceImageFileName(post, post.sourceImageUrl, contentType);
    const target = path.join(imageDir, sourceImageFile);

    try {
      await fs.access(target);
    } catch {
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(target, buffer);
    }

    const sourceGalleryFiles = await downloadSourceGalleryFiles(post, post.sourceImageUrl, sourceImageFile, options);
    return withSourceImageFile({ ...post, sourceGalleryFiles, sourceGalleryCheckedAt: post.sourceGalleryCheckedAt || kstDate() }, sourceImageFile);
  } catch (error) {
    console.warn(`source image failed: ${post.sourceImageUrl} ${error.message}`);
    return post;
  }
}

async function fetchSearchSourceImage(post) {
  const keyword = post.cleanName || post.query || post.shortName || post.rawName || '';
  if (!keyword) return '';

  try {
    const url = new URL('https://mcp.aka.page/api/oliveyoung/products');
    url.searchParams.set('keyword', keyword);
    url.searchParams.set('size', '10');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      }
    });
    if (!response.ok) return '';

    const json = await response.json();
    const products = (json && json.data && Array.isArray(json.data.products) && json.data.products) || [];
    const goodsNo = String(post.goodsNo || '').toLowerCase();
    const found =
      products.find((item) => String(item.goodsNo || item.goodsNumber || '').toLowerCase() === goodsNo) ||
      products.find((item) => goodsNo && String(item.imageUrl || item.thumbnail || '').toLowerCase().includes(goodsNo)) ||
      products[0];

    return found ? String(found.imageUrl || found.thumbnail || '').trim() : '';
  } catch (error) {
    console.warn(`source image search failed: ${post.slug} ${error.message}`);
    return '';
  }
}

async function hydrateSourceImages(posts, rankingPosts, options = {}) {
  const byGoodsNo = new Map();
  for (const post of rankingPosts) {
    if (post.goodsNo && post.sourceImageUrl) byGoodsNo.set(String(post.goodsNo).toLowerCase(), post.sourceImageUrl);
  }

  const hydrated = [];
  for (const post of posts) {
    const goodsNo = String(post.goodsNo || '').toLowerCase();
    const sourceImageUrl = byGoodsNo.get(goodsNo) || post.sourceImageUrl || (await fetchSearchSourceImage(post));
    hydrated.push(await downloadSourceImage({ ...post, sourceImageUrl }, options));
  }

  return hydrated;
}

function mergePosts(existingPosts, generatedPosts) {
  const map = new Map();
  const entries = [
    ...existingPosts.filter(isSupportedBlogPost).map((post) => ({ post, generated: false })),
    ...generatedPosts.filter(isSupportedBlogPost).map((post) => ({ post, generated: true }))
  ];

  for (const entry of entries) {
    const key = canonicalPostKey(entry.post);
    const previous = map.get(key);
    if (!previous || shouldReplacePost(previous, entry)) {
      map.set(key, entry);
    }
  }

  return Array.from(map.values())
    .map((entry) => entry.post)
    .map(refreshPostCopy)
    .sort(sortBlogPosts);
}

function isSupportedBlogPost(post) {
  return Boolean(getBlogProductProfile(post) || buildAutoProductProfile(post));
}

function canonicalPostKey(post) {
  const profile = getBlogProductProfile(post);
  if (profile) {
    return `profile:${profile.id}:${normalizePostKey(post.shortName || post.query || post.cleanName || post.title)}`;
  }
  return `goods:${post.goodsNo || post.slug}`;
}

function normalizePostKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()[\]{}+·ㆍ|｜/\\_-]/g, '');
}

function shouldReplacePost(previous, next) {
  if (previous.generated !== next.generated) return next.generated;
  const prevRank = Number(previous.post.rank || 9999);
  const nextRank = Number(next.post.rank || 9999);
  if (prevRank !== nextRank) return nextRank < prevRank;

  const prevViews = Number(previous.post.viewCount || 0);
  const nextViews = Number(next.post.viewCount || 0);
  if (prevViews !== nextViews) return nextViews > prevViews;

  const prevDate = new Date(previous.post.modifiedAt || previous.post.publishedAt || 0).getTime();
  const nextDate = new Date(next.post.modifiedAt || next.post.publishedAt || 0).getTime();
  return nextDate > prevDate;
}

function sortBlogPosts(a, b) {
  const dateDelta = new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  if (dateDelta) return dateDelta;
  const rankDelta = Number(a.rank || 9999) - Number(b.rank || 9999);
  if (rankDelta) return rankDelta;
  return Number(b.viewCount || 0) - Number(a.viewCount || 0);
}

function managedBlock(start, end, content) {
  return `${start}\n${content.trimEnd()}\n${end}`;
}

function upsertBlock(text, start, end, content, beforeNeedle) {
  const block = managedBlock(start, end, content);
  const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (pattern.test(text)) return text.replace(pattern, block);
  const index = text.indexOf(beforeNeedle);
  if (index === -1) return `${text.trimEnd()}\n${block}\n`;
  return `${text.slice(0, index)}${block}\n${text.slice(index)}`;
}

async function updateHomeBlogBlock(posts) {
  const indexPath = path.join(publicDir, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');
  const latest = posts.slice(0, 3);
  const cards = latest
    .map(
      (post) => `<a class="blog-link-card" href="${post.url}">
          <img src="${homeImageSrc(post)}" alt="${htmlEscape(post.shortName)} 제품 이미지" width="360" height="270" loading="lazy">
          <span class="blog-link-category">${htmlEscape(post.categoryName || '올리브영 인기상품')}</span>
          <strong>${htmlEscape(post.shortName || post.title)}</strong>
          <small>업로드 ${htmlEscape(formatPostDate(post.publishedAt || post.rankingDate))} · 조회 ${formatNumber(post.viewCount)}회 · 인기 ${post.rank || ''}위</small>
        </a>`
    )
    .join('\n        ');
  const block = `    <section class="seo-blog-latest" id="blog-pages" aria-labelledby="blog-pages-title">
      <div class="seo-section-head">
        <span class="home-kicker">STOCK BLOG</span>
        <h2 id="blog-pages-title">오늘의 올리브영 재고 블로그</h2>
        <p>인기상품 랭킹과 재고 확인 포인트를 글로 정리했습니다.</p>
      </div>
      <div class="blog-link-grid">
        ${cards}
      </div>
      <a class="blog-more-link" href="/blog/">재고 블로그 전체 보기</a>
    </section>`;

  html = html.replace(/\n\s*<a class="main-tab guide-tab" href="\/blog\/">블로그<\/a>/g, '');
  html = html.replace(
    '<a class="main-tab guide-tab" href="#guide-pages">가이드</a>',
    '<a class="main-tab guide-tab" href="#guide-pages">가이드</a>\n      <a class="main-tab guide-tab" href="/blog/">블로그</a>'
  );
  html = upsertBlock(
    html,
    '    <!-- BLOG_POSTS_START -->',
    '    <!-- BLOG_POSTS_END -->',
    block,
    '    <section class="seo-faq"'
  );
  await fs.writeFile(indexPath, html, 'utf8');
}

async function updateSitemapXml(posts) {
  const file = path.join(publicDir, 'sitemap.xml');
  let xml = await fs.readFile(file, 'utf8');
  const urls = [
    { loc: `${SITE_URL}/blog/`, priority: '0.8', changefreq: 'daily', lastmod: kstDate() },
    ...posts.map((post) => ({
      loc: absoluteUrl(post.url),
      priority: '0.7',
      changefreq: 'weekly',
      lastmod: kstDate(post.modifiedAt || post.publishedAt)
    }))
  ];
  const content = urls
    .map(
      (url) => `  <url>
    <loc>${xmlEscape(url.loc)}</loc>
    <lastmod>${url.lastmod}</lastmod>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`
    )
    .join('\n');
  xml = upsertBlock(xml, '  <!-- BLOG_URLS_START -->', '  <!-- BLOG_URLS_END -->', content, '</urlset>');
  await fs.writeFile(file, xml, 'utf8');
}

async function updateRssXml(posts) {
  const file = path.join(publicDir, 'rss.xml');
  let rss = await fs.readFile(file, 'utf8');
  const now = new Date().toUTCString();
  rss = rss.replace(/<lastBuildDate>.*?<\/lastBuildDate>/, `<lastBuildDate>${now}</lastBuildDate>`);
  const content = posts
    .map(
      (post) => `    <item>
      <title>${xmlEscape(post.title)}</title>
      <link>${absoluteUrl(post.url)}</link>
      <guid>${absoluteUrl(post.url)}</guid>
      <description>${xmlEscape(post.description)}</description>
      <pubDate>${new Date(post.publishedAt || Date.now()).toUTCString()}</pubDate>
    </item>`
    )
    .join('\n');
  rss = upsertBlock(rss, '    <!-- BLOG_ITEMS_START -->', '    <!-- BLOG_ITEMS_END -->', content, '  </channel>');
  await fs.writeFile(file, rss, 'utf8');
}

async function updateSiteMapHtml(posts) {
  const file = path.join(publicDir, 'site-map.html');
  let html = await fs.readFile(file, 'utf8');
  const content = `      <li><a href="/blog/">재고 블로그</a></li>
${posts.map((post) => `      <li><a href="${post.url}">${htmlEscape(post.shortName || post.title)}</a></li>`).join('\n')}`;
  html = upsertBlock(html, '      <!-- BLOG_LINKS_START -->', '      <!-- BLOG_LINKS_END -->', content, '    </ul>');
  await fs.writeFile(file, html, 'utf8');
}

function readNumberArg(name, fallback, max) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    const parsed = Number.parseInt(process.argv[index + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, max);
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseArgs() {
  const daily = hasFlag('--daily');
  const limit = readNumberArg('--limit', daily ? 50 : 1, 50);
  const scanLimit = readNumberArg('--scan-limit', Math.max(limit, daily ? 100 : 20), 100);

  return {
    daily,
    limit,
    scanLimit: Math.max(scanLimit, limit),
    newOnly: daily || hasFlag('--new-only'),
    refreshExistingOnly: hasFlag('--refresh-existing-only'),
    skipIfNoNew:
      (daily || hasFlag('--skip-if-no-new')) &&
      !hasFlag('--refresh-existing') &&
      !hasFlag('--refresh-existing-only')
  };
}

function existingPostKeys(posts) {
  const goodsNos = new Set();
  const slugs = new Set();
  const canonicalKeys = new Set();

  for (const post of posts) {
    if (post.goodsNo) goodsNos.add(String(post.goodsNo).toLowerCase());
    if (post.slug) slugs.add(String(post.slug).toLowerCase());
    canonicalKeys.add(canonicalPostKey(post));
  }

  return { goodsNos, slugs, canonicalKeys };
}

function isAlreadyWrittenPost(post, keys) {
  const goodsNo = String(post.goodsNo || '').toLowerCase();
  const slug = String(post.slug || '').toLowerCase();
  return (
    (goodsNo && keys.goodsNos.has(goodsNo)) ||
    (slug && keys.slugs.has(slug)) ||
    keys.canonicalKeys.has(canonicalPostKey(post))
  );
}

async function prepareGeneratedPosts(rankingPosts, existingPosts, args) {
  const existingKeys = existingPostKeys(existingPosts);
  const freshPosts = args.newOnly
    ? rankingPosts.filter((post) => !isAlreadyWrittenPost(post, existingKeys))
    : rankingPosts.slice();

  const selected = [];
  for (const post of freshPosts) {
    const manualProfile = getBlogProductProfile(post);
    const autoProfile = manualProfile ? null : buildAutoProductProfile(post);
    const profile = manualProfile || autoProfile;
    if (!profile) continue;
    selected.push(
      refreshPostCopy({
        ...post,
        profile,
        publishedAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
      })
    );
    if (selected.length >= args.limit) break;
  }
  return selected;
}

async function main() {
  const args = parseArgs();
  const existingPosts = await readManifest();
  const rankingPosts = await fetchViewRanking(args.scanLimit);
  const generatedPosts = args.refreshExistingOnly
    ? []
    : await prepareGeneratedPosts(rankingPosts, existingPosts, args);

  if (args.skipIfNoNew && generatedPosts.length === 0) {
    console.log('generated 0 blog post(s): no new supported popular products found.');
    return;
  }

  await fs.mkdir(blogDir, { recursive: true });
  await fs.mkdir(imageDir, { recursive: true });
  const posts = (
    await hydrateSourceImages(mergePosts(existingPosts, generatedPosts), rankingPosts, {
      probeGallery: !args.refreshExistingOnly
    })
  ).filter((post) => post.sourceImageFile);

  for (const post of posts) {
    const dir = path.join(blogDir, post.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.html'), blogPostTemplate(post, posts), 'utf8');
  }

  await fs.writeFile(path.join(blogDir, 'index.html'), blogIndexTemplate(posts), 'utf8');
  await writeManifest(posts);
  await updateHomeBlogBlock(posts);
  await updateSitemapXml(posts);
  await updateRssXml(posts);
  await updateSiteMapHtml(posts);

  console.log(`generated ${generatedPosts.length} blog post(s):`);
  for (const post of generatedPosts) {
    console.log(`- ${post.title}`);
    console.log(`  ${post.url}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
