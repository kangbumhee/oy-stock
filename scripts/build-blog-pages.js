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
const BLOG_ASSET_VERSION = '20260611-review-diary';
const MANUAL_REVIEW_ASSET_VERSION = '20260611-manual-review';
const MAX_SOURCE_GALLERY_IMAGES = 8;
const SOURCE_GALLERY_WINDOW = 5;
const REVIEW_PHOTO_COUNT = 18;

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

function reviewImageFileForPost(post) {
  return post && post.reviewImageFile ? post.reviewImageFile : '';
}

function reviewDetailFileForPost(post) {
  return post && post.reviewDetailFile ? post.reviewDetailFile : '';
}

function reviewGalleryFilesForPost(post) {
  return Array.isArray(post && post.reviewGalleryFiles) ? post.reviewGalleryFiles.filter(Boolean) : [];
}

function reviewImageSrc(post, base) {
  const file = reviewImageFileForPost(post);
  return file ? imageAssetSrc(`${base}${file}`) : '';
}

function reviewDetailSrc(post, base) {
  const file = reviewDetailFileForPost(post) || reviewImageFileForPost(post);
  return file ? imageAssetSrc(`${base}${file}`) : '';
}

function reviewGallerySrcs(post, base) {
  return reviewGalleryFilesForPost(post).map((file) => imageAssetSrc(`${base}${file}`));
}

function postImageSrc(post) {
  return reviewImageSrc(post, '../../images/blog/') || imageAssetSrc(`../../images/blog/${path.basename(post.image)}`);
}

function blogIndexImageSrc(post) {
  return reviewImageSrc(post, '../images/blog/') || imageAssetSrc(`../images/blog/${postCardImageFile(post)}`);
}

function homeImageSrc(post) {
  return reviewImageSrc(post, 'images/blog/') || imageAssetSrc(`images/blog/${postCardImageFile(post)}`);
}

function postCardImageFile(post) {
  const reviewFile = reviewImageFileForPost(post);
  if (reviewFile) return reviewFile;
  const profile = getBlogProductProfile(post);
  return profile && profile.detailFile ? profile.detailFile : path.basename(post.image);
}

function isManualReviewProfile(profile) {
  return Boolean(profile && profile.id === 'torriden-dive-in-serum');
}

function manualReviewAssetFilesForProfile(profile) {
  if (!isManualReviewProfile(profile) || !profile.assetPrefix) return null;
  const ext = profile.assetExt || 'png';
  const detail = profile.detailFile || `${profile.assetPrefix}-review-01.${ext}`;
  return {
    cover: detail,
    detail,
    photos: Array.from({ length: REVIEW_PHOTO_COUNT }, (_, index) =>
      `${profile.assetPrefix}-review-${String(index + 1).padStart(2, '0')}.${ext}`
    )
  };
}

function buildAlignedCaptions(post) {
  const shortName = post.shortName || post.cleanName || '올리브영 인기상품';
  return [
    ['첫 느낌', '상품페이지 대표 이미지에서 보이는 첫인상과 색감을 먼저 정리했어요.'],
    ['대표 이미지', '구매 화면에서 가장 먼저 보이는 상품 이미지를 카드처럼 보기 좋게 담았어요.'],
    ['패키지 톤', '배경과 함께 보면 패키지 색감과 전체 분위기가 더 잘 들어와요.'],
    ['상품명 확인', '비슷한 상품이 섞이지 않게 상품명과 기획 문구를 같이 보는 컷이에요.'],
    ['확대 포인트', '작은 글씨보다 전체 상품 인상을 먼저 보려고 크게 배치했어요.'],
    ['구성 체크', '단품, 기획, 증정 구성은 구매 화면에서 한 번 더 확인하는 게 좋아요.'],
    ['모바일 화면', '휴대폰으로 열어봤을 때 보이는 느낌도 같이 볼 수 있게 넣었어요.'],
    ['썸네일 느낌', '검색 목록에서 보일 첫인상을 생각해서 밝고 깔끔하게 정리했어요.'],
    ['색감 비교', '같은 상품 이미지도 카드 배치에 따라 느낌이 달라 보여요.'],
    ['옵션명 보기', '옵션이 여러 개인 상품은 이름 끝부분까지 보는 게 중요해요.'],
    ['재고 확인 전', '사진으로 마음이 가면 온라인 재고와 매장 재고를 바로 이어서 보면 돼요.'],
    ['오늘드림 체크', '급하게 필요하면 오늘드림 가능 여부까지 같이 보는 흐름이 편합니다.'],
    ['상품 화면 느낌', '상세 이미지의 분위기를 블로그 카드처럼 한 번 더 정리했어요.'],
    ['구매 전 메모', '가격, 쿠폰, 증정 구성은 마지막 구매 화면에서 다시 맞춰보면 좋아요.'],
    ['카드 컷', '상품 이미지가 너무 딱딱해 보이지 않게 카드형으로 배치했어요.'],
    ['이미지 한눈에', '대표컷과 보조컷을 같이 두면 상품 구분이 더 쉬워요.'],
    ['랭킹 체크', '조회수와 업로드 날짜도 같이 보이게 넣어 현재 흐름을 확인하기 좋아요.'],
    ['마무리', `${shortName} 찾을 때 헷갈리지 않게 대표 이미지를 중심으로 정리했어요.`]
  ];
}

function buildAlignedBlogCopy(post, profile) {
  const shortName = post.shortName || post.cleanName || '올리브영 인기상품';
  const rawName = post.rawName || shortName;
  const rankingText = post.rankingDateText
    ? `${post.rankingDateText} 기준`
    : '현재 기준';
  const rankText = post.rank ? `조회 인기 ${post.rank}위` : '조회가 많이 붙은';
  const viewText = post.viewCount ? `조회 ${formatNumber(post.viewCount)}회` : '조회 흐름';
  const base = buildBlogCopy(post, profile);
  const alignedVisual = base.visual
    ? {
        ...base.visual,
        detailTitle: shortName,
        detailSub: '올리브영 상품페이지 대표 이미지를 보기 좋게 정리한 컷',
        features: [
          ['대표 이미지', '상품페이지에서 확인한 이미지를 기준으로 정리했어요.'],
          ['상품명 확인', '상품명과 기획 문구를 같이 보면 비슷한 옵션이 덜 헷갈려요.'],
          ['구매 전 확인', '최종 옵션과 가격은 연결된 구매 화면에서 다시 확인해 주세요.']
        ]
      }
    : base.visual;
  return {
    ...base,
    title: base.title || `${shortName} 후기처럼 보기｜올리브영 재고`,
    description: `${shortName} 상품페이지 대표 이미지를 블로그 후기 카드처럼 정리하고, 옵션명·온라인 재고·매장 재고 확인 포인트까지 바로 이어볼 수 있게 모았습니다.`,
    heroLead:
      '상품페이지에서 확인한 대표 이미지를 카드와 모바일 화면 느낌으로 다시 정리했습니다. 사진 분위기를 본 뒤 옵션명과 재고를 같이 확인하면 편해요.',
    introBig: `${htmlEscape(shortName)}, <span class="soft-word">상품페이지 대표 이미지</span> 기준으로 먼저 느낌만 가볍게 봤어요.`,
    introBody:
      `${rankingText} ${rankText} 상품이에요. 아래 이미지는 올리브영 상품 이미지를 바탕으로 보기 좋게 다시 정리한 컷이라, 마음에 들면 상품명과 옵션을 맞춰 보고 재고를 확인하면 됩니다.`,
    moodNotes: [
      ['대표 이미지', `${htmlEscape(shortName)} 상품 화면에서 보이는 패키지와 색감을 중심으로 봤어요.`],
      ['조회 흐름', `${viewText} 기준으로 관심이 붙은 상품이라 재고 변동도 같이 보는 게 좋아요.`],
      ['구매 전', '옵션명, 기획 구성, 쿠폰, 배송 방식은 연결된 구매 화면에서 마지막으로 확인하면 됩니다.']
    ],
    photoTitle: `${shortName}, 상품 이미지로 먼저 보기`,
    photoLead:
      '아래 이미지는 올리브영 상품페이지 대표 이미지를 바탕으로 블로그 후기 카드처럼 다시 정리한 컷이에요. 실제 사용 장면을 설명하는 사진이 아니라, 구매 전 상품 구분과 분위기 확인을 돕는 이미지입니다.',
    shoppingTitle: '사진으로 마음이 가면 옵션명부터 맞춰봐요',
    shoppingParagraphs: [
      `${htmlEscape(rawName)}처럼 상품명이 길거나 기획 문구가 붙은 상품은 같은 라인 안에서도 구성 표현이 달라질 수 있어요.`,
      '이미지로 상품을 확인한 뒤에는 <span class="highlight">옵션명</span>, <span class="highlight">온라인 재고</span>, <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 실수가 적습니다.'
    ],
    checklist: [
      `${shortName} 상품명 먼저 맞춰보기`,
      '단품, 기획, 증정 구성 문구 확인하기',
      '온라인 재고와 가까운 매장 재고 같이 보기',
      '오늘드림이나 픽업 가능 여부까지 한 번에 열어두기'
    ],
    tipTitle: '대표 이미지를 확인했다면 재고는 바로 보는 게 좋아요',
    tipParagraph:
      '조회가 붙은 상품은 옵션별 재고가 빠르게 바뀔 수 있어요. 이미지로 원하는 상품이 맞다고 느껴지면 상품명과 재고를 바로 이어서 확인하는 흐름이 가장 편합니다.',
    tips: [
      ['1. 상품명 길게 검색', '브랜드명과 제품 타입까지 같이 넣으면 비슷한 상품이 덜 섞여요.'],
      ['2. 구성 문구 확인', '단품, 기획, 증정 구성이 다르면 원하는 상품이 달라질 수 있어요.'],
      ['3. 받을 방식 고르기', '온라인, 오늘드림, 매장 픽업 중 지금 제일 편한 쪽을 먼저 확인하면 됩니다.']
    ],
    captions: buildAlignedCaptions(post),
    ...(alignedVisual ? { visual: alignedVisual } : {})
  };
}

function buildReviewBlogCopy(post, profile) {
  const base = buildBlogCopy(post, profile);
  if (base && Array.isArray(base.captions) && base.captions.length) return base;
  return buildAlignedBlogCopy(post, profile);
}

function refreshPostCopy(post) {
  if (!post) return post;
  const profile = getBlogProductProfile(post) || buildAutoProductProfile(post);
  const postWithProfile = profile ? { ...post, profile } : post;
  const copy = buildReviewBlogCopy(postWithProfile, profile);
  const alignedProfile = profile ? { ...profile, ...copy, title: copy.title, description: copy.description } : null;
  return {
    ...postWithProfile,
    ...(alignedProfile ? { profile: alignedProfile } : {}),
    title: copy.title,
    description: copy.description
  };
}

function blogReviewAssets(post) {
  const profile = getBlogProductProfile(post);
  if (!profile || !profile.assetPrefix) return null;
  const base = '../../images/blog/';
  const ext = profile.assetExt || 'png';
  const manualFiles = manualReviewAssetFilesForProfile(profile);
  const useManualAssets = Boolean(manualFiles && post.reviewAssetVersion === MANUAL_REVIEW_ASSET_VERSION);
  const generatedReviewImages = useManualAssets
    ? manualFiles.photos.map((file) => imageAssetSrc(`${base}${file}`))
    : reviewGallerySrcs(post, base);
  const generatedDetail = useManualAssets ? imageAssetSrc(`${base}${manualFiles.detail}`) : reviewDetailSrc(post, base);
  const copy = buildReviewBlogCopy(post, profile);
  const alignedCaptions =
    useManualAssets && Array.isArray(profile.captions) && profile.captions.length
      ? profile.captions
      : Array.isArray(copy.captions) && copy.captions.length
        ? copy.captions
        : buildAlignedCaptions(post);
  const captions = generatedReviewImages.length
    ? alignedCaptions.slice(0, Math.max(1, Math.min(alignedCaptions.length, generatedReviewImages.length)))
    : alignedCaptions;

  const photos = captions.map((caption, index) => ({
    src:
      generatedReviewImages[index] ||
      generatedDetail ||
      imageAssetSrc(`${base}${profile.assetPrefix}-review-${String(index + 1).padStart(2, '0')}.${ext}`),
    source: false,
    title: caption[0],
    caption: caption[1],
    alt: `${post.shortName} 후기형 사진 ${index + 1}`
  }));

  return {
    profile,
    detail: generatedDetail || imageAssetSrc(`${base}${profile.detailFile}`),
    stock: postImageSrc(post),
    photos
  };
}

function blogPostTemplate(post, relatedPosts) {
  const pageUrl = absoluteUrl(post.url);
  const imageUrl = absoluteUrl(post.image);
  const visibleImage = postImageSrc(post);
  const reviewAssets = blogReviewAssets(post);
  const copy = buildReviewBlogCopy(post, reviewAssets && reviewAssets.profile);
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
    .post-card img{width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;object-position:center;border-radius:6px;background:#fff}
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

function safeHex(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}

function reviewPalette(post) {
  const profile = getBlogProductProfile(post) || post.profile || buildAutoProductProfile(post) || {};
  const visual = profile.visual || {};
  const visualProfile = profile.visualProfile || {};
  const palette = visualProfile.palette || {};
  return {
    accent: safeHex(palette.accent || visual.accent, '#35c7d0'),
    accentDark: safeHex(palette.accentDark || visual.accentDark, '#087883'),
    second: safeHex(palette.second || visual.second, '#b8eef3'),
    soft: safeHex(palette.soft || visual.soft, '#f2fdff'),
    warm: safeHex(palette.warm || visual.warm, '#ffe88a')
  };
}

function reviewAssetFilesForPost(post) {
  return {
    cover: `${post.slug}-review-cover.jpg`,
    detail: `${post.slug}-review-detail.jpg`,
    photos: Array.from({ length: REVIEW_PHOTO_COUNT }, (_, index) =>
      `${post.slug}-review-${String(index + 1).padStart(2, '0')}.jpg`
    )
  };
}

async function reviewAssetFilesExist(files) {
  const names = Array.from(new Set([files.cover, files.detail, ...files.photos].filter(Boolean)));
  const checks = await Promise.all(names.map((name) => localFileExists(name)));
  return checks.every(Boolean);
}

function withReviewAssetFiles(post, files) {
  return {
    ...post,
    reviewImageFile: files.cover,
    reviewDetailFile: files.detail,
    reviewGalleryFiles: files.photos,
    reviewAssetVersion: BLOG_ASSET_VERSION,
    image: `/images/blog/${files.cover}`
  };
}

function withManualReviewAssetFiles(post, profile, files) {
  return {
    ...post,
    profile,
    reviewImageFile: files.cover,
    reviewDetailFile: files.detail,
    reviewGalleryFiles: files.photos,
    reviewAssetVersion: MANUAL_REVIEW_ASSET_VERSION,
    image: `/images/blog/${files.cover}`
  };
}

async function sourceEntriesForReview(post) {
  const files = Array.from(
    new Set([...(Array.isArray(post.sourceGalleryFiles) ? post.sourceGalleryFiles : []), post.sourceImageFile].filter(Boolean))
  );
  const entries = [];
  for (const file of files) {
    const fullPath = path.join(imageDir, file);
    try {
      await fs.access(fullPath);
      entries.push({
        file,
        url: pathToFileURL(fullPath).href
      });
    } catch {
      // The source manifest can outlive a deleted local file; skip that stale reference.
    }
  }
  return entries;
}

function pickSource(entries, index) {
  if (!entries.length) return null;
  return entries[((index % entries.length) + entries.length) % entries.length];
}

function reviewCaptionFor(post, index) {
  const profile = getBlogProductProfile(post) || post.profile || buildAutoProductProfile(post);
  const copy = buildReviewBlogCopy(post, profile);
  const captions = Array.isArray(copy.captions) && copy.captions.length ? copy.captions : buildAlignedCaptions(post);
  return captions[index % captions.length] || ['상품 이미지', '상품페이지 대표 이미지를 보기 좋게 정리했어요.'];
}

function reviewSceneHtml(post, entries, mode, index = 0) {
  const palette = reviewPalette(post);
  const profile = getBlogProductProfile(post) || post.profile || buildAutoProductProfile(post);
  const copy = buildReviewBlogCopy(post, profile);
  const caption = reviewCaptionFor(post, index);
  const main = pickSource(entries, index) || entries[0];
  const sideA = pickSource(entries, index + 1) || main;
  const sideB = pickSource(entries, index + 2) || main;
  const scene = index % 6;
  const title = truncate(post.shortName || post.title, mode === 'cover' ? 34 : 26);
  const subtitle = mode === 'detail' ? copy.photoTitle : caption[0];
  const dimensions = {
    cover: [1200, 630],
    detail: [900, 1200],
    photo: [720, 720]
  }[mode];
  const [width, height] = dimensions;
  const rankText = post.rank ? `인기 ${post.rank}위` : '인기상품';
  const viewsText = post.viewCount ? `조회 ${formatNumber(post.viewCount)}회` : '재고 체크';
  const dateText = formatPostDate(post.publishedAt || post.rankingDate);
  const mainUrl = htmlEscape(main.url);
  const sideAUrl = htmlEscape(sideA.url);
  const sideBUrl = htmlEscape(sideB.url);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <style>
    *{box-sizing:border-box}
    body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;color:#16252f;background:#f8fbfa}
    .scene{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:
      radial-gradient(circle at 14% 18%,rgba(255,255,255,.95),rgba(255,255,255,0) 24%),
      linear-gradient(135deg,${palette.soft} 0%,#fff 46%,${palette.second} 100%)}
    .scene:before{content:'';position:absolute;inset:0;opacity:.16;background-image:radial-gradient(circle,rgba(20,60,70,.22) 1px,transparent 1.2px);background-size:18px 18px}
    .desk{position:absolute;left:-8%;right:-8%;bottom:-10%;height:34%;background:linear-gradient(180deg,#ffffff 0%,#edf3f2 100%);box-shadow:0 -18px 60px rgba(34,68,76,.08);transform:rotate(${scene % 2 ? '-1.5deg' : '1.2deg'})}
    .window{position:absolute;right:${mode === 'photo' ? '34px' : '72px'};top:${mode === 'photo' ? '34px' : '72px'};width:${mode === 'photo' ? '118px' : '176px'};height:${mode === 'photo' ? '156px' : '220px'};border-radius:999px;background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(255,255,255,.15));border:1px solid rgba(255,255,255,.78)}
    .plant{position:absolute;left:${mode === 'detail' ? '54px' : '38px'};top:${mode === 'cover' ? '42px' : '66px'};width:120px;height:150px;opacity:.72}
    .plant i{position:absolute;left:55px;bottom:0;width:12px;height:118px;border-radius:999px;background:#6ea77f}
    .plant b{position:absolute;display:block;width:58px;height:26px;border-radius:58px 6px;background:#7fbe93;transform-origin:left center}
    .plant b:nth-child(2){left:58px;top:24px;transform:rotate(-28deg)}
    .plant b:nth-child(3){left:48px;top:58px;transform:rotate(30deg)}
    .plant b:nth-child(4){left:58px;top:90px;transform:rotate(-16deg)}
    .polaroid{position:absolute;background:#fff;border-radius:22px;padding:22px 22px 70px;box-shadow:0 34px 80px rgba(27,60,70,.22);border:1px solid rgba(214,231,232,.95)}
    .polaroid img{display:block;width:100%;height:100%;object-fit:contain;background:#fff;border-radius:12px}
    .main-card{left:${mode === 'cover' ? '78px' : mode === 'detail' ? '78px' : '70px'};top:${mode === 'cover' ? '80px' : mode === 'detail' ? '92px' : '92px'};width:${mode === 'cover' ? '490px' : mode === 'detail' ? '560px' : '410px'};height:${mode === 'cover' ? '420px' : mode === 'detail' ? '650px' : '410px'};transform:rotate(${scene % 2 ? '-2.4deg' : '2.2deg'});z-index:3}
    .main-card .memo{position:absolute;left:26px;right:26px;bottom:18px;font-size:${mode === 'photo' ? '24px' : '28px'};line-height:1.25;font-weight:900;color:${palette.accentDark};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .phone{position:absolute;right:${mode === 'cover' ? '92px' : mode === 'detail' ? '70px' : '48px'};bottom:${mode === 'cover' ? '74px' : mode === 'detail' ? '92px' : '76px'};width:${mode === 'cover' ? '250px' : mode === 'detail' ? '255px' : '176px'};height:${mode === 'cover' ? '420px' : mode === 'detail' ? '456px' : '300px'};border-radius:34px;background:#15212a;padding:14px;box-shadow:0 28px 70px rgba(20,40,52,.28);z-index:4;transform:rotate(${scene % 3 === 0 ? '4deg' : '-3deg'})}
    .phone-screen{position:relative;width:100%;height:100%;border-radius:24px;background:#fff;overflow:hidden;padding:18px 15px}
    .phone-screen img{width:100%;height:47%;object-fit:contain;background:#fafafa;border-radius:14px}
    .phone-screen h3{margin:12px 0 8px;font-size:${mode === 'photo' ? '15px' : '20px'};line-height:1.18;color:#16252f;word-break:keep-all}
    .phone-screen p{margin:0;font-size:${mode === 'photo' ? '12px' : '15px'};line-height:1.35;color:#61717d;font-weight:800}
    .phone-screen em{position:absolute;left:15px;right:15px;bottom:16px;height:42px;border-radius:14px;background:${palette.accent};color:#052e34;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:${mode === 'photo' ? '14px' : '17px'};font-weight:900}
    .side-card{position:absolute;width:${mode === 'cover' ? '220px' : mode === 'detail' ? '238px' : '178px'};height:${mode === 'cover' ? '250px' : mode === 'detail' ? '282px' : '190px'};border-radius:18px;background:#fff;padding:12px;box-shadow:0 22px 48px rgba(27,60,70,.16);z-index:2;border:1px solid rgba(214,231,232,.85)}
    .side-card img{width:100%;height:100%;object-fit:cover;border-radius:12px}
    .side-a{right:${mode === 'cover' ? '338px' : mode === 'detail' ? '92px' : '40px'};top:${mode === 'cover' ? '56px' : mode === 'detail' ? '608px' : '28px'};transform:rotate(${scene % 2 ? '5deg' : '-5deg'})}
    .side-b{left:${mode === 'cover' ? '500px' : mode === 'detail' ? '590px' : '60px'};bottom:${mode === 'cover' ? '54px' : mode === 'detail' ? '112px' : '42px'};transform:rotate(${scene % 2 ? '-6deg' : '6deg'})}
    .hand{position:absolute;left:${mode === 'photo' ? '10px' : '610px'};bottom:${mode === 'photo' ? '-40px' : '-36px'};width:${mode === 'photo' ? '220px' : '250px'};height:${mode === 'photo' ? '180px' : '210px'};border-radius:80px 80px 30px 30px;background:linear-gradient(135deg,#f6c7aa,#e8a887);opacity:${scene === 1 || scene === 3 ? '.88' : '.42'};transform:rotate(${scene % 2 ? '12deg' : '-10deg'});z-index:1}
    .chip{position:absolute;left:${mode === 'cover' ? '86px' : '74px'};top:${mode === 'cover' ? '44px' : '46px'};display:flex;gap:10px;z-index:6}
    .chip span{display:inline-flex;align-items:center;height:${mode === 'photo' ? '34px' : '42px'};padding:0 16px;border-radius:999px;background:rgba(255,255,255,.86);border:1px solid rgba(255,255,255,.96);color:${palette.accentDark};font-size:${mode === 'photo' ? '14px' : '18px'};font-weight:900;box-shadow:0 10px 28px rgba(20,70,80,.1)}
    .title-box{position:absolute;right:${mode === 'cover' ? '92px' : '62px'};top:${mode === 'cover' ? '86px' : mode === 'detail' ? '54px' : '520px'};width:${mode === 'cover' ? '472px' : mode === 'detail' ? '690px' : '610px'};z-index:5;padding:${mode === 'photo' ? '18px 22px' : '26px 30px'};border-radius:24px;background:rgba(255,255,255,.86);box-shadow:0 24px 60px rgba(20,60,70,.14);backdrop-filter:blur(8px)}
    .title-box h1{margin:0 0 8px;font-size:${mode === 'cover' ? '42px' : mode === 'detail' ? '40px' : '27px'};line-height:1.18;color:#16252f;word-break:keep-all}
    .title-box p{margin:0;font-size:${mode === 'cover' ? '22px' : mode === 'detail' ? '22px' : '18px'};line-height:1.42;color:#506574;font-weight:800;word-break:keep-all}
    .sticker{position:absolute;right:${mode === 'photo' ? '34px' : '72px'};top:${mode === 'photo' ? '210px' : '300px'};width:${mode === 'photo' ? '116px' : '148px'};height:${mode === 'photo' ? '116px' : '148px'};border-radius:999px;background:${palette.warm};display:flex;align-items:center;justify-content:center;text-align:center;color:#112831;font-size:${mode === 'photo' ? '22px' : '28px'};line-height:1.05;font-weight:900;box-shadow:0 18px 40px rgba(20,40,52,.16);transform:rotate(-7deg);z-index:6}
    .detail-list{position:absolute;left:86px;right:86px;bottom:68px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px;z-index:6}
    .detail-list div{min-height:118px;border-radius:22px;background:rgba(255,255,255,.9);padding:22px;box-shadow:0 18px 42px rgba(20,60,70,.13)}
    .detail-list b{display:block;color:${palette.accentDark};font-size:24px;margin-bottom:4px}
    .detail-list span{display:block;color:#526574;font-size:18px;line-height:1.4;font-weight:800}
    .photo .title-box{display:${mode === 'photo' ? 'block' : 'none'}}
    .cover .detail-list,.photo .detail-list{display:none}
    .detail .side-b{display:none}
    .detail .title-box{top:56px;right:70px}
    .detail .main-card{top:210px}
    .detail .side-a{top:690px}
    .photo .main-card{top:${scene % 2 ? '86px' : '72px'};left:${scene % 3 === 0 ? '54px' : '88px'};transform:rotate(${scene % 2 ? '2.8deg' : '-2.2deg'})}
    .photo .phone{display:${scene === 2 || scene === 5 ? 'block' : 'none'}}
    .photo .side-a{display:${scene === 0 || scene === 4 ? 'block' : 'none'}}
    .photo .side-b{display:${scene === 1 || scene === 3 ? 'block' : 'none'}}
    .photo .sticker{display:${scene === 0 || scene === 5 ? 'flex' : 'none'}}
  </style>
</head>
<body>
  <div class="scene ${mode}">
    <div class="desk"></div>
    <div class="window"></div>
    <div class="plant"><i></i><b></b><b></b><b></b></div>
    <div class="chip"><span>${htmlEscape(rankText)}</span><span>${htmlEscape(viewsText)}</span><span>${htmlEscape(dateText)}</span></div>
    <div class="polaroid main-card">
      <img src="${mainUrl}" alt="">
      <div class="memo">${htmlEscape(caption[0])}</div>
    </div>
    <div class="side-card side-a"><img src="${sideAUrl}" alt=""></div>
    <div class="side-card side-b"><img src="${sideBUrl}" alt=""></div>
    <div class="hand"></div>
    <div class="phone">
      <div class="phone-screen">
        <img src="${mainUrl}" alt="">
        <h3>${htmlEscape(title)}</h3>
        <p>${htmlEscape(caption[1])}</p>
        <em>재고 바로 보기</em>
      </div>
    </div>
    <div class="title-box">
      <h1>${htmlEscape(title)}</h1>
      <p>${htmlEscape(subtitle)} · 구매 전 느낌만 빠르게 봐요.</p>
    </div>
    <div class="sticker">오늘<br>체크</div>
    <div class="detail-list">
      <div><b>색감</b><span>패키지 톤이 한눈에 들어오게 정리했어요.</span></div>
      <div><b>구성</b><span>옵션과 기획 문구는 구매 화면에서 한 번 더 확인해요.</span></div>
      <div><b>재고</b><span>온라인, 오늘드림, 근처 매장을 같이 보면 편합니다.</span></div>
    </div>
  </div>
</body>
</html>`;
}

function reviewSceneHtmlV2(post, entries, mode, index = 0) {
  const palette = reviewPalette(post);
  const profile = getBlogProductProfile(post) || post.profile || buildAutoProductProfile(post);
  const copy = buildReviewBlogCopy(post, profile);
  const caption = reviewCaptionFor(post, index);
  const visual = (copy && copy.visual) || (profile && profile.visual) || {};
  const rawKind = String(visual.kind || '').toLowerCase();
  const kind = rawKind.replace(/[^a-z0-9-]/g, '') || 'bottle';
  const main = pickSource(entries, mode === 'cover' ? 0 : index + 1) || entries[0];
  const sideA = pickSource(entries, index + 2) || main;
  const sideB = pickSource(entries, index + 3) || main;
  const scene = index % 8;
  const title = truncate(post.shortName || post.title, mode === 'cover' ? 36 : 28);
  const dimensions = {
    cover: [1200, 630],
    detail: [900, 1200],
    photo: [720, 720]
  }[mode];
  const [width, height] = dimensions;
  const rankText = post.rank ? `인기 ${post.rank}위` : '인기상품';
  const viewsText = post.viewCount ? `조회 ${formatNumber(post.viewCount)}회` : '조회 체크';
  const dateText = formatPostDate(post.publishedAt || post.rankingDate);
  const mainUrl = htmlEscape(main.url);
  const sideAUrl = htmlEscape(sideA.url);
  const sideBUrl = htmlEscape(sideB.url);
  const noteText = truncate(caption[1] || copy.heroLead || '사진으로 먼저 분위기를 보고 재고를 확인해요.', mode === 'photo' ? 82 : 96);
  const featureItems = (
    (copy.visual && Array.isArray(copy.visual.features) && copy.visual.features.length ? copy.visual.features : null) ||
    (Array.isArray(copy.moodNotes) && copy.moodNotes.length ? copy.moodNotes : null) ||
    [
      ['색감', '패키지 톤을 먼저 봐요.'],
      ['구성', '기획 문구는 다시 확인해요.'],
      ['재고', '온라인과 매장을 같이 봐요.']
    ]
  ).slice(0, 3);
  const featuresHtml = featureItems
    .map((item) => `<div><b>${htmlEscape(item[0])}</b><span>${htmlEscape(item[1])}</span></div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <style>
    *{box-sizing:border-box}
    body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;color:#182a34;background:#f7fbf8}
    .scene{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:
      radial-gradient(circle at 18% 12%,rgba(255,255,255,.92),rgba(255,255,255,0) 26%),
      linear-gradient(140deg,${palette.soft} 0%,#fff 45%,${palette.second} 100%)}
    .scene:before{content:'';position:absolute;inset:0;opacity:.12;background-image:radial-gradient(circle,rgba(20,70,78,.22) 1px,transparent 1.4px);background-size:20px 20px}
    .wall-line{position:absolute;left:-6%;right:-6%;top:34%;height:2px;background:rgba(84,116,124,.12);transform:rotate(${scene % 2 ? '-1deg' : '1deg'})}
    .counter{position:absolute;left:-10%;right:-10%;bottom:-8%;height:${mode === 'detail' ? '39%' : '35%'};background:linear-gradient(180deg,#fff 0%,#eff6f3 100%);box-shadow:0 -20px 68px rgba(31,72,78,.1);transform:rotate(${scene % 2 ? '.8deg' : '-1deg'})}
    .mirror{position:absolute;right:${mode === 'photo' ? '38px' : '74px'};top:${mode === 'photo' ? '44px' : '62px'};width:${mode === 'photo' ? '164px' : '232px'};height:${mode === 'photo' ? '220px' : '292px'};border-radius:999px;background:linear-gradient(180deg,rgba(255,255,255,.74),rgba(255,255,255,.16));border:1px solid rgba(255,255,255,.9);box-shadow:inset 0 0 0 14px rgba(255,255,255,.22)}
    .soft-shadow{position:absolute;left:${mode === 'cover' ? '126px' : mode === 'detail' ? '126px' : '88px'};bottom:${mode === 'cover' ? '66px' : mode === 'detail' ? '150px' : '58px'};width:${mode === 'cover' ? '540px' : mode === 'detail' ? '570px' : '430px'};height:70px;border-radius:999px;background:rgba(26,70,78,.16);filter:blur(18px);transform:rotate(${scene % 2 ? '2deg' : '-2deg'})}
    .main-product{position:absolute;z-index:4;left:${mode === 'cover' ? '86px' : mode === 'detail' ? '110px' : '82px'};top:${mode === 'cover' ? '86px' : mode === 'detail' ? '160px' : '94px'};width:${mode === 'cover' ? '510px' : mode === 'detail' ? '560px' : '410px'};height:${mode === 'cover' ? '380px' : mode === 'detail' ? '590px' : '380px'};display:flex;align-items:center;justify-content:center;padding:${mode === 'photo' ? '22px' : '30px'};border-radius:${mode === 'photo' ? '34px' : '42px'};background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.9);box-shadow:0 34px 90px rgba(23,64,72,.18);backdrop-filter:blur(8px);transform:rotate(${scene % 2 ? '-1.4deg' : '1.4deg'})}
    .main-product img{max-width:100%;max-height:100%;object-fit:contain;mix-blend-mode:multiply;filter:drop-shadow(0 24px 28px rgba(18,54,62,.16))}
    .side-product{position:absolute;z-index:3;width:${mode === 'cover' ? '250px' : mode === 'detail' ? '240px' : '182px'};height:${mode === 'cover' ? '230px' : mode === 'detail' ? '246px' : '178px'};display:flex;align-items:center;justify-content:center;padding:16px;border-radius:26px;background:rgba(255,255,255,.82);border:1px solid rgba(224,238,237,.92);box-shadow:0 22px 58px rgba(22,60,70,.13)}
    .side-product img{max-width:100%;max-height:100%;object-fit:contain;mix-blend-mode:multiply}
    .side-a{right:${mode === 'cover' ? '360px' : mode === 'detail' ? '76px' : '38px'};top:${mode === 'cover' ? '58px' : mode === 'detail' ? '646px' : '54px'};transform:rotate(${scene % 2 ? '5deg' : '-5deg'})}
    .side-b{left:${mode === 'cover' ? '502px' : mode === 'detail' ? '570px' : '54px'};bottom:${mode === 'cover' ? '58px' : mode === 'detail' ? '122px' : '48px'};transform:rotate(${scene % 2 ? '-6deg' : '6deg'})}
    .badge-row{position:absolute;left:${mode === 'photo' ? '58px' : '82px'};top:${mode === 'photo' ? '44px' : '42px'};display:flex;gap:10px;z-index:8}
    .badge-row span{height:${mode === 'photo' ? '34px' : '42px'};display:inline-flex;align-items:center;padding:0 15px;border-radius:999px;background:rgba(255,255,255,.88);border:1px solid rgba(255,255,255,.96);box-shadow:0 10px 28px rgba(16,60,68,.1);font-size:${mode === 'photo' ? '14px' : '18px'};font-weight:900;color:${palette.accentDark};white-space:nowrap}
    .note{position:absolute;z-index:7;right:${mode === 'cover' ? '70px' : mode === 'detail' ? '62px' : '44px'};bottom:${mode === 'cover' ? '76px' : mode === 'detail' ? '54px' : '38px'};width:${mode === 'cover' ? '480px' : mode === 'detail' ? '770px' : '500px'};padding:${mode === 'photo' ? '20px 24px' : '26px 30px'};border-radius:28px;background:rgba(255,255,255,.9);box-shadow:0 26px 72px rgba(20,60,70,.16);backdrop-filter:blur(10px)}
    .note h1{margin:0 0 10px;font-size:${mode === 'cover' ? '41px' : mode === 'detail' ? '42px' : '27px'};line-height:1.18;letter-spacing:0;color:#142832;word-break:keep-all}
    .note strong{color:${palette.accentDark}}
    .note p{margin:0;font-size:${mode === 'cover' ? '21px' : mode === 'detail' ? '22px' : '18px'};line-height:1.44;color:#526775;font-weight:800;word-break:keep-all}
    .caption-pin{position:absolute;z-index:8;left:${mode === 'photo' ? '92px' : '122px'};bottom:${mode === 'photo' ? '94px' : mode === 'detail' ? '388px' : '82px'};min-width:${mode === 'photo' ? '178px' : '220px'};padding:16px 20px;border-radius:22px;background:${palette.warm};color:#172c36;font-size:${mode === 'photo' ? '22px' : '28px'};font-weight:900;box-shadow:0 18px 42px rgba(30,70,78,.15);transform:rotate(${scene % 2 ? '-4deg' : '4deg'})}
    .prop{position:absolute;z-index:2;box-shadow:0 20px 44px rgba(31,72,78,.1)}
    .towel{right:${mode === 'photo' ? '72px' : '120px'};bottom:${mode === 'photo' ? '116px' : '122px'};width:${mode === 'photo' ? '170px' : '230px'};height:${mode === 'photo' ? '76px' : '92px'};border-radius:46px;background:repeating-linear-gradient(90deg,#fff 0 8px,#edf5f2 8px 16px)}
    .pouch{left:${mode === 'photo' ? '42px' : '560px'};top:${mode === 'photo' ? '452px' : '366px'};width:${mode === 'photo' ? '184px' : '250px'};height:${mode === 'photo' ? '126px' : '156px'};border-radius:34px;background:linear-gradient(145deg,#f4d6bd,#f8efe2);transform:rotate(${scene % 2 ? '9deg' : '-7deg'})}
    .dropper{right:${mode === 'photo' ? '56px' : '154px'};top:${mode === 'photo' ? '308px' : '282px'};width:28px;height:${mode === 'photo' ? '180px' : '230px'};border-radius:18px;background:linear-gradient(180deg,#1f2b34 0 18%,rgba(255,255,255,.86) 18% 100%);transform:rotate(${scene % 2 ? '-10deg' : '8deg'})}
    .pad{right:${mode === 'photo' ? '132px' : '234px'};top:${mode === 'photo' ? '298px' : '292px'};width:${mode === 'photo' ? '142px' : '190px'};height:${mode === 'photo' ? '142px' : '190px'};border-radius:24px;background:repeating-linear-gradient(45deg,#fff 0 5px,#edf6f5 5px 9px);transform:rotate(${scene % 2 ? '12deg' : '-10deg'})}
    .swatch{left:${mode === 'photo' ? '422px' : '730px'};top:${mode === 'photo' ? '300px' : '350px'};width:${mode === 'photo' ? '170px' : '220px'};height:34px;border-radius:999px;background:linear-gradient(90deg,${palette.warm},${palette.accent},${palette.accentDark});opacity:.72;transform:rotate(-8deg)}
    .dropper,.pad,.swatch{display:none}
    .features{position:absolute;z-index:7;left:70px;right:70px;bottom:54px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
    .features div{min-height:120px;padding:20px 22px;border-radius:24px;background:rgba(255,255,255,.9);box-shadow:0 18px 46px rgba(20,60,70,.12)}
    .features b{display:block;margin-bottom:7px;color:${palette.accentDark};font-size:23px}
    .features span{display:block;color:#526775;font-size:18px;line-height:1.38;font-weight:800;word-break:keep-all}
    .photo .features,.cover .features{display:none}
    .detail .note{top:56px;bottom:auto}
    .detail .caption-pin{display:none}
    .detail .main-product{top:210px}
    .detail .side-b{display:none}
    .photo .note{display:${scene === 0 || scene === 3 || scene === 6 ? 'block' : 'none'}}
    .photo .badge-row span:nth-child(2),.photo .badge-row span:nth-child(3){display:none}
    .photo .side-a{display:${scene === 1 || scene === 4 ? 'flex' : 'none'}}
    .photo .side-b{display:${scene === 2 || scene === 5 ? 'flex' : 'none'}}
    .photo .main-product{left:${scene % 3 === 0 ? '64px' : '96px'};top:${scene % 2 ? '108px' : '86px'}}
    .scene-1 .main-product,.scene-5 .main-product{transform:rotate(-2deg)}
    .scene-2 .main-product,.scene-6 .main-product{transform:rotate(2.6deg)}
    .kind-tint .swatch,.kind-palette .swatch{display:block}
    .kind-padjar .pad,.kind-jar .pad,.kind-pack .pad{display:block}
    .kind-pack .pad{border-radius:18px;width:${mode === 'photo' ? '150px' : '205px'};height:${mode === 'photo' ? '200px' : '260px'}}
    .kind-dropper .dropper,.kind-tube .dropper{display:block}
  </style>
</head>
<body>
  <div class="scene ${mode} kind-${kind} scene-${scene}">
    <div class="wall-line"></div>
    <div class="counter"></div>
    <div class="mirror"></div>
    <div class="soft-shadow"></div>
    <div class="prop towel"></div>
    <div class="prop pouch"></div>
    <div class="prop dropper"></div>
    <div class="prop pad"></div>
    <div class="prop swatch"></div>
    <div class="badge-row"><span>${htmlEscape(rankText)}</span><span>${htmlEscape(viewsText)}</span><span>${htmlEscape(dateText)}</span></div>
    <div class="main-product"><img src="${mainUrl}" alt=""></div>
    <div class="side-product side-a"><img src="${sideAUrl}" alt=""></div>
    <div class="side-product side-b"><img src="${sideBUrl}" alt=""></div>
    <div class="caption-pin">${htmlEscape(caption[0])}</div>
    <div class="note">
      <h1>${htmlEscape(title)} <strong>후기처럼 보기</strong></h1>
      <p>${htmlEscape(noteText)}</p>
    </div>
    <div class="features">${featuresHtml}</div>
  </div>
</body>
</html>`;
}

async function renderReviewHtml(browser, html, outputPath, width, height) {
  const tempPath = path.join(imageDir, `${path.basename(outputPath, path.extname(outputPath))}.html`);
  await fs.writeFile(tempPath, html, 'utf8');
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.goto(pathToFileURL(tempPath).href, { waitUntil: 'load' });
    await page
      .waitForFunction(
        () => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
        { timeout: 10000 }
      )
      .catch(() => {});
    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 88 });
  } finally {
    await page.close();
    await fs.rm(tempPath, { force: true });
  }
}

async function renderReviewAssetsForPost(browser, post) {
  const manualProfile = getBlogProductProfile(post);
  const manualFiles = manualReviewAssetFilesForProfile(manualProfile);
  if (manualFiles && (await reviewAssetFilesExist(manualFiles))) {
    return withManualReviewAssetFiles(post, manualProfile, manualFiles);
  }

  const files = reviewAssetFilesForPost(post);
  if (post.reviewAssetVersion === BLOG_ASSET_VERSION && (await reviewAssetFilesExist(files))) {
    return withReviewAssetFiles(post, files);
  }

  const entries = await sourceEntriesForReview(post);
  if (!entries.length) return post;

  await renderReviewHtml(
    browser,
    reviewSceneHtmlV2(post, entries, 'cover', 0),
    path.join(imageDir, files.cover),
    1200,
    630
  );
  await renderReviewHtml(
    browser,
    reviewSceneHtmlV2(post, entries, 'detail', 1),
    path.join(imageDir, files.detail),
    900,
    1200
  );

  for (let index = 0; index < REVIEW_PHOTO_COUNT; index += 1) {
    await renderReviewHtml(
      browser,
      reviewSceneHtmlV2(post, entries, 'photo', index),
      path.join(imageDir, files.photos[index]),
      720,
      720
    );
  }

  return withReviewAssetFiles(post, files);
}

async function renderReviewAssetsForPosts(posts) {
  if (!posts.length) return posts;

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const rendered = [];
  try {
    for (const post of posts) {
      rendered.push(await renderReviewAssetsForPost(browser, post));
      console.log(`review assets ready: ${post.slug}`);
    }
  } finally {
    await browser.close();
  }
  return rendered;
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
  let posts = (
    await hydrateSourceImages(mergePosts(existingPosts, generatedPosts), rankingPosts, {
      probeGallery: !args.refreshExistingOnly
    })
  ).filter((post) => post.sourceImageFile);
  posts = posts.map(refreshPostCopy);
  posts = (await renderReviewAssetsForPosts(posts)).filter((post) => post.reviewImageFile);

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
