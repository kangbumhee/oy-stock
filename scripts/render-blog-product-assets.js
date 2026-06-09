const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { BLOG_PRODUCT_PROFILES, REVIEW_PHOTO_COUNT } = require('./blog-product-profiles');

const root = path.resolve(__dirname, '..');
const imageDir = path.join(root, 'public', 'images', 'blog');

const TARGET_IDS = ['torriden-dive-in-serum', 'mediheal-sun-serum', 'mediheal-gel-mask'];

const VISUALS = {
  'torriden-dive-in-serum': {
    kind: 'dropper',
    brand: 'Torriden',
    title: 'DIVE IN\nSerum',
    sub: 'HYDRATE & GLOW',
    accent: '#21aeea',
    accentDark: '#0962a6',
    second: '#83e8ff',
    soft: '#e8f8ff',
    warm: '#f1ff57',
    pageBg: 'linear-gradient(180deg,#0878c9 0%,#41c8ff 48%,#effcff 100%)',
    detailTitle: '+ 다이브인 세럼 더블 기획',
    detailSub: '투명한 블루 보틀이 청량한 수분 세럼',
    features: [
      ['블루 수분 보틀', '맑은 파란 용기가 한눈에 보이는 세럼'],
      ['스포이드 타입', '아침 루틴에 어울리는 촉촉한 분위기'],
      ['50ml 더블 기획', '증정 구성은 구매 화면에서 한 번 더 확인']
    ]
  },
  'mediheal-sun-serum': {
    kind: 'tube',
    brand: 'MEDIHEAL',
    title: 'MADECASSOSIDE\nMOISTURE\nSUN SERUM',
    sub: 'SPF 50+ PA++++',
    accent: '#31d8ce',
    accentDark: '#038c93',
    second: '#2475ff',
    soft: '#e8fbff',
    warm: '#ffe95c',
    pageBg: 'linear-gradient(180deg,#0c69ff 0%,#4fcfff 42%,#efffff 100%)',
    detailTitle: '+ 수분 선세럼 50+50g 기획',
    detailSub: '흰 튜브와 민트 포인트가 산뜻한 데일리 선케어',
    features: [
      ['민트 포인트 튜브', '파우치에 넣기 좋은 깔끔한 튜브형'],
      ['촉촉한 선케어 무드', '아침 루틴에 어울리는 산뜻한 느낌'],
      ['50+50g 기획', '구성은 구매 화면에서 한 번 더 확인']
    ]
  },
  'mediheal-gel-mask': {
    kind: 'mask',
    brand: 'MEDIHEAL',
    title: 'HYPER\nGEL MASK',
    sub: '4 TYPES',
    accent: '#ff7db5',
    accentDark: '#18248a',
    second: '#7ad8ff',
    soft: '#eef9ff',
    warm: '#bda2ff',
    pageBg: 'linear-gradient(180deg,#061789 0%,#184cff 48%,#d9fbff 100%)',
    detailTitle: '+ 8+1 하이퍼 겔마스크',
    detailSub: '핑크·보라·하늘색 옵션이 한눈에 보이는 촉촉한 겔마스크',
    features: [
      ['4가지 컬러 옵션', '콜라겐, PDRN, 마데카소사이드, 히알루론산 무드'],
      ['말랑한 겔 시트 느낌', '투명하고 촉촉한 홈케어팩 분위기'],
      ['8+1 기획', '옵션별 구성은 구매 전 다시 확인']
    ]
  }
};

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function productHtml(visual, variant = 0) {
  if (visual.kind === 'dropper') {
    const bottle = (className) => `<div class="serum-bottle ${className}">
      <div class="pipette"></div>
      <div class="serum-glass">
        <b>${htmlEscape(visual.brand)}</b>
        <strong>${htmlEscape(visual.title).replace(/\n/g, '<br>')}</strong>
        <i></i>
        <span>${htmlEscape(visual.sub)}</span>
      </div>
    </div>`;

    return `<div class="bottle-set variant-${variant % 4}">
      ${bottle('bottle-back')}
      ${bottle('bottle-front')}
      <div class="mini-tube"><b>Balanceful</b><span>20ml</span></div>
    </div>`;
  }

  if (visual.kind === 'mask') {
    const colors = ['#ff8fbd', '#a78cff', '#79dfff', '#5de1c7'];
    return `<div class="mask-stack variant-${variant % 4}">
      ${colors
        .map(
          (color, index) => `<div class="mask-pack pack-${index}" style="--pack:${color}">
          <b>${htmlEscape(visual.brand)}</b>
          <strong>${htmlEscape(visual.title).replace(/\n/g, '<br>')}</strong>
          <span>${htmlEscape(visual.sub)}</span>
          <i></i>
        </div>`
        )
        .join('')}
    </div>`;
  }

  const tube = (className) => `<div class="tube ${className}">
    <div class="tube-top"></div>
    <div class="tube-body">
      <b>${htmlEscape(visual.brand)}</b>
      <strong>${htmlEscape(visual.title).replace(/\n/g, '<br>')}</strong>
      <i></i>
      <span>${htmlEscape(visual.sub)}</span>
    </div>
    <div class="tube-cap"></div>
  </div>`;

  return `<div class="tube-set variant-${variant % 4}">
    ${tube('tube-back')}
    ${tube('tube-front')}
    <div class="mini-serum"><b>20612</b><span>10ml</span></div>
  </div>`;
}

function detailHtml(profile, visual) {
  const featureHtml = visual.features
    .map(
      (item) => `<div class="feature">
        <b>${htmlEscape(item[0])}</b>
        <span>${htmlEscape(item[1])}</span>
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <style>
    *{box-sizing:border-box}
    body{margin:0;width:1024px;height:1536px;overflow:hidden;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;color:#102033;background:#eef8fb}
    .page{position:relative;width:1024px;height:1536px;overflow:hidden;background:${visual.pageBg}}
    .shine{position:absolute;left:-180px;top:-80px;width:700px;height:700px;border-radius:999px;background:radial-gradient(circle,rgba(255,255,255,.68),rgba(255,255,255,0) 62%)}
    .brand{position:absolute;left:72px;top:70px;color:#fff;font-size:42px;font-weight:900;letter-spacing:4px;text-shadow:0 8px 20px rgba(0,0,0,.16)}
    .badge{position:absolute;right:84px;top:78px;width:176px;height:176px;border-radius:999px;background:${visual.warm};display:flex;align-items:center;justify-content:center;text-align:center;color:#0a2a46;font-size:38px;line-height:1.04;font-weight:900;box-shadow:0 18px 38px rgba(0,0,0,.18);transform:rotate(-4deg)}
    .product-zone{position:absolute;right:72px;top:235px;width:435px;height:650px}
    .copy{position:absolute;left:68px;top:280px;width:470px;color:#fff}
    .copy h1{font-size:54px;line-height:1.16;margin:0 0 22px;word-break:keep-all;text-shadow:0 10px 24px rgba(0,0,0,.18)}
    .copy p{font-size:26px;line-height:1.45;font-weight:800;margin:0;color:rgba(255,255,255,.94);word-break:keep-all}
    .feature-wrap{position:absolute;left:68px;right:68px;bottom:100px;display:grid;gap:24px}
    .feature{min-height:150px;padding:30px 34px;border-radius:28px;background:rgba(255,255,255,.9);box-shadow:0 18px 42px rgba(7,38,80,.15)}
    .feature b{display:block;font-size:34px;color:#132d42;margin-bottom:10px}
    .feature span{display:block;font-size:24px;line-height:1.45;color:#42566c;font-weight:800;word-break:keep-all}
    .line{position:absolute;left:68px;right:68px;bottom:54px;height:6px;border-radius:999px;background:rgba(255,255,255,.72)}
    ${visualCss(visual, 'detail')}
  </style>
</head>
<body>
  <div class="page">
    <div class="shine"></div>
    <div class="brand">${htmlEscape(visual.brand)}</div>
    <div class="badge">올영<br>PICK</div>
    <div class="copy">
      <h1>${htmlEscape(visual.detailTitle)}</h1>
      <p>${htmlEscape(visual.detailSub)}</p>
    </div>
    <div class="product-zone">${productHtml(visual, 0)}</div>
    <div class="feature-wrap">${featureHtml}</div>
    <div class="line"></div>
  </div>
</body>
</html>`;
}

function sceneHtml(profile, visual, index) {
  const caption = profile.captions[index - 1] || ['', ''];
  const scene = (index - 1) % 6;
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <style>
    *{box-sizing:border-box}
    body{margin:0;width:512px;height:512px;overflow:hidden;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;background:#f7fbfc;color:#183247}
    .photo{position:relative;width:512px;height:512px;overflow:hidden;background:linear-gradient(135deg,#ffffff 0%,${visual.soft} 58%,#f6f3ed 100%)}
    .photo:before{content:'';position:absolute;left:0;right:0;bottom:0;height:185px;background:linear-gradient(180deg,rgba(255,255,255,.2),rgba(216,226,225,.82))}
    .window{position:absolute;left:34px;top:28px;width:150px;height:190px;border-radius:80px 80px 12px 12px;background:linear-gradient(180deg,rgba(255,255,255,.9),rgba(188,230,255,.45));box-shadow:inset 0 0 0 1px rgba(255,255,255,.7)}
    .plant{position:absolute;left:20px;top:55px;width:90px;height:170px}
    .plant span{position:absolute;display:block;width:58px;height:22px;border-radius:70% 10% 70% 10%;background:#5a9b67;transform-origin:right center}
    .plant span:nth-child(1){left:16px;top:20px;transform:rotate(-32deg)}
    .plant span:nth-child(2){left:0;top:58px;transform:rotate(24deg)}
    .plant span:nth-child(3){left:18px;top:92px;transform:rotate(-18deg)}
    .mirror{position:absolute;right:24px;top:38px;width:150px;height:150px;border-radius:999px;background:linear-gradient(145deg,#eaf8ff,#fff);border:10px solid rgba(255,255,255,.72);box-shadow:0 16px 38px rgba(60,90,105,.14)}
    .towel{position:absolute;right:30px;bottom:42px;width:150px;height:72px;border-radius:18px;background:repeating-linear-gradient(0deg,#fff,#fff 6px,#eef4f5 7px,#eef4f5 10px);box-shadow:0 16px 30px rgba(80,98,105,.16)}
    .pouch{position:absolute;left:42px;bottom:48px;width:150px;height:92px;border-radius:28px;background:#eef5f5;border:2px solid rgba(255,255,255,.8);box-shadow:0 14px 28px rgba(60,80,90,.14)}
    .dropper{position:absolute;right:78px;bottom:135px;width:38px;height:120px;border-radius:20px;background:linear-gradient(180deg,#e9fdff,#c4f2f4);border:2px solid rgba(255,255,255,.9);box-shadow:0 12px 24px rgba(50,80,90,.14)}
    .dropper:before{content:'';position:absolute;left:7px;top:-28px;width:24px;height:36px;border-radius:14px;background:#f6f6f2}
    .hand{position:absolute;left:28px;bottom:56px;width:210px;height:110px;border-radius:70px 80px 55px 75px;background:linear-gradient(135deg,#efc1a6,#d89e84);box-shadow:0 16px 30px rgba(120,80,60,.16);transform:rotate(8deg)}
    .hand:before{content:'';position:absolute;left:20px;top:-16px;width:150px;height:50px;border-radius:40px;background:rgba(246,205,186,.86)}
    .caption-chip{position:absolute;left:22px;top:20px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.82);color:${visual.accentDark};font-weight:900;font-size:14px;box-shadow:0 8px 18px rgba(30,70,90,.08)}
    .note{position:absolute;left:24px;right:24px;bottom:20px;padding:13px 16px;border-radius:20px;background:rgba(255,255,255,.82);box-shadow:0 12px 30px rgba(30,70,90,.10);font-size:18px;font-weight:900;color:#1b3345;line-height:1.3;word-break:keep-all}
    .product-wrap{position:absolute;left:145px;top:104px;width:250px;height:290px;filter:drop-shadow(0 26px 30px rgba(30,70,90,.22));transform:rotate(${scene % 2 ? '-4deg' : '3deg'}) scale(${scene === 2 ? '.9' : '1'})}
    .scene-1 .product-wrap{left:110px;top:96px;transform:rotate(-9deg) scale(.94)}
    .scene-2 .product-wrap{left:192px;top:126px;transform:rotate(8deg) scale(.78)}
    .scene-3 .product-wrap{left:86px;top:120px;transform:rotate(-3deg) scale(.96)}
    .scene-4 .product-wrap{left:165px;top:92px;transform:rotate(1deg) scale(1.03)}
    .scene-5 .product-wrap{left:132px;top:88px;transform:rotate(-7deg) scale(.92)}
    .scene-0 .hand,.scene-1 .pouch,.scene-2 .window,.scene-3 .mirror,.scene-4 .plant,.scene-5 .dropper{display:block}
    .photo:not(.scene-0) .hand,.photo:not(.scene-1) .pouch,.photo:not(.scene-2) .window,.photo:not(.scene-3) .mirror,.photo:not(.scene-4) .plant,.photo:not(.scene-5) .dropper{display:none}
    ${visualCss(visual, 'photo')}
  </style>
</head>
<body>
  <div class="photo scene-${scene}">
    <div class="caption-chip">${String(index).padStart(2, '0')} ${htmlEscape(caption[0])}</div>
    <div class="window"></div>
    <div class="plant"><span></span><span></span><span></span></div>
    <div class="mirror"></div>
    <div class="towel"></div>
    <div class="pouch"></div>
    <div class="dropper"></div>
    <div class="hand"></div>
    <div class="product-wrap">${productHtml(visual, index)}</div>
    <div class="note">${htmlEscape(caption[1])}</div>
  </div>
</body>
</html>`;
}

function visualCss(visual, mode) {
  const scale = mode === 'detail' ? 1.45 : 0.72;
  return `
    .bottle-set{position:absolute;left:50%;top:50%;width:${Math.round(390 * scale)}px;height:${Math.round(500 * scale)}px;transform:translate(-50%,-50%)}
    .serum-bottle{position:absolute;bottom:${Math.round(56 * scale)}px;width:${Math.round(142 * scale)}px;height:${Math.round(330 * scale)}px}
    .bottle-front{left:${Math.round(150 * scale)}px;z-index:3;transform:rotate(8deg)}
    .bottle-back{left:${Math.round(58 * scale)}px;z-index:2;transform:rotate(-8deg)}
    .pipette{position:absolute;left:50%;top:${Math.round(-74 * scale)}px;width:${Math.round(46 * scale)}px;height:${Math.round(100 * scale)}px;transform:translateX(-50%);border-radius:${Math.round(24 * scale)}px ${Math.round(24 * scale)}px ${Math.round(12 * scale)}px ${Math.round(12 * scale)}px;background:linear-gradient(180deg,#fff,#eef6f7);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(195,215,220,.9);box-shadow:0 12px 22px rgba(0,70,120,.12)}
    .pipette:before{content:'';position:absolute;left:50%;bottom:${Math.round(-64 * scale)}px;width:${Math.round(12 * scale)}px;height:${Math.round(72 * scale)}px;transform:translateX(-50%);border-radius:999px;background:rgba(255,255,255,.78)}
    .serum-glass{position:absolute;left:0;right:0;bottom:0;height:${Math.round(300 * scale)}px;border-radius:${Math.round(48 * scale)}px ${Math.round(48 * scale)}px ${Math.round(30 * scale)}px ${Math.round(30 * scale)}px;background:linear-gradient(135deg,rgba(255,255,255,.88),${visual.second} 22%,${visual.accent} 74%,rgba(255,255,255,.55));border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.92);box-shadow:inset 18px 0 32px rgba(255,255,255,.32),inset -18px 0 32px rgba(0,80,150,.16),0 22px 36px rgba(0,70,120,.18);overflow:hidden}
    .serum-glass:before{content:'';position:absolute;left:${Math.round(18 * scale)}px;right:${Math.round(18 * scale)}px;top:${Math.round(22 * scale)}px;height:${Math.round(32 * scale)}px;border-radius:999px;background:rgba(255,255,255,.55)}
    .serum-glass b{position:absolute;left:0;right:0;top:${Math.round(72 * scale)}px;text-align:center;font-size:${Math.round(24 * scale)}px;color:#111;letter-spacing:.4px}
    .serum-glass strong{position:absolute;left:${Math.round(22 * scale)}px;right:${Math.round(18 * scale)}px;top:${Math.round(122 * scale)}px;font-size:${Math.round(18 * scale)}px;line-height:1.1;color:#183040}
    .serum-glass i{position:absolute;left:${Math.round(24 * scale)}px;right:${Math.round(24 * scale)}px;bottom:${Math.round(98 * scale)}px;height:${Math.max(1, Math.round(2 * scale))}px;background:rgba(0,75,130,.42)}
    .serum-glass span{position:absolute;left:${Math.round(20 * scale)}px;right:${Math.round(20 * scale)}px;bottom:${Math.round(52 * scale)}px;font-size:${Math.round(13 * scale)}px;color:#16344b;font-weight:900}
    .mini-tube{position:absolute;right:${Math.round(14 * scale)}px;bottom:${Math.round(52 * scale)}px;width:${Math.round(82 * scale)}px;height:${Math.round(166 * scale)}px;border-radius:${Math.round(22 * scale)}px ${Math.round(22 * scale)}px ${Math.round(14 * scale)}px ${Math.round(14 * scale)}px;background:linear-gradient(180deg,#eef9ea 0%,#c9f6e3 58%,#fff 100%);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.9);box-shadow:0 14px 28px rgba(0,80,120,.16);z-index:4;text-align:center;color:#173f4c;font-weight:900}
    .mini-tube b{display:block;margin:${Math.round(54 * scale)}px ${Math.round(8 * scale)}px 0;font-size:${Math.round(11 * scale)}px}
    .mini-tube span{display:block;font-size:${Math.round(12 * scale)}px;color:${visual.accentDark}}
    .tube-set{position:absolute;left:50%;top:50%;width:${Math.round(350 * scale)}px;height:${Math.round(500 * scale)}px;transform:translate(-50%,-50%)}
    .tube{position:absolute;bottom:${Math.round(72 * scale)}px;width:${Math.round(126 * scale)}px;height:${Math.round(330 * scale)}px}
    .tube-front{left:${Math.round(126 * scale)}px;z-index:3;transform:rotate(3deg)}
    .tube-back{left:${Math.round(42 * scale)}px;z-index:2;transform:rotate(-5deg)}
    .tube-body{position:absolute;left:0;right:0;top:0;height:${Math.round(288 * scale)}px;border-radius:${Math.round(42 * scale)}px ${Math.round(42 * scale)}px ${Math.round(20 * scale)}px ${Math.round(20 * scale)}px;background:linear-gradient(90deg,#f9fbfa 0%,#fff 48%,#edf4f2 100%);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(170,190,195,.8);box-shadow:inset -16px 0 28px rgba(20,80,90,.08)}
    .tube-body b{position:absolute;left:0;right:0;top:${Math.round(38 * scale)}px;text-align:center;font-size:${Math.round(16 * scale)}px;color:#222;letter-spacing:.6px}
    .tube-body strong{position:absolute;left:${Math.round(16 * scale)}px;right:${Math.round(16 * scale)}px;top:${Math.round(74 * scale)}px;text-align:left;font-size:${Math.round(16 * scale)}px;line-height:1.12;color:#25313a}
    .tube-body i{position:absolute;left:50%;top:${Math.round(142 * scale)}px;width:${Math.round(22 * scale)}px;height:${Math.round(92 * scale)}px;transform:translateX(-50%);background:${visual.accent};border-radius:${Math.round(12 * scale)}px}
    .tube-body span{position:absolute;left:0;right:0;bottom:${Math.round(34 * scale)}px;text-align:center;font-size:${Math.round(15 * scale)}px;color:#2d3840;font-weight:800}
    .tube-top{position:absolute;left:${Math.round(8 * scale)}px;right:${Math.round(8 * scale)}px;top:${Math.round(-20 * scale)}px;height:${Math.round(34 * scale)}px;border-radius:${Math.round(12 * scale)}px;background:repeating-linear-gradient(90deg,#fff,#fff ${Math.max(2, Math.round(4 * scale))}px,#dce7e7 ${Math.max(3, Math.round(5 * scale))}px,#dce7e7 ${Math.max(4, Math.round(7 * scale))}px);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(190,205,205,.8)}
    .tube-cap{position:absolute;left:${Math.round(24 * scale)}px;right:${Math.round(24 * scale)}px;bottom:0;height:${Math.round(82 * scale)}px;border-radius:${Math.round(12 * scale)}px ${Math.round(12 * scale)}px ${Math.round(32 * scale)}px ${Math.round(32 * scale)}px;background:linear-gradient(180deg,rgba(255,255,255,.72),${visual.accent});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(0,140,150,.36)}
    .mini-serum{position:absolute;right:${Math.round(12 * scale)}px;bottom:${Math.round(58 * scale)}px;width:${Math.round(104 * scale)}px;height:${Math.round(150 * scale)}px;border-radius:${Math.round(18 * scale)}px;background:linear-gradient(180deg,#1a1f22 ${Math.round(28 * scale)}px,${visual.accent} ${Math.round(28 * scale)}px,${visual.accent} 100%);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.9);box-shadow:0 18px 30px rgba(0,0,0,.18);z-index:4;color:#08363b;text-align:center;font-weight:900}
    .mini-serum:before{content:'';position:absolute;left:50%;top:${Math.round(-44 * scale)}px;width:${Math.round(30 * scale)}px;height:${Math.round(48 * scale)}px;transform:translateX(-50%);border-radius:${Math.round(18 * scale)}px ${Math.round(18 * scale)}px 0 0;background:#111}
    .mini-serum b{display:block;margin-top:${Math.round(58 * scale)}px;font-size:${Math.round(20 * scale)}px;color:#07333b}
    .mini-serum span{display:block;font-size:${Math.round(12 * scale)}px;color:#fff}
    .mask-stack{position:absolute;left:50%;top:50%;width:${Math.round(430 * scale)}px;height:${Math.round(430 * scale)}px;transform:translate(-50%,-50%)}
    .mask-pack{position:absolute;width:${Math.round(190 * scale)}px;height:${Math.round(272 * scale)}px;border-radius:${Math.round(14 * scale)}px;background:linear-gradient(180deg,#fff 0%,#fff 42%,var(--pack) 43%,#fff 100%);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(180,185,205,.9);box-shadow:0 22px 36px rgba(12,20,80,.18);overflow:hidden}
    .mask-pack b{position:absolute;left:${Math.round(20 * scale)}px;top:${Math.round(22 * scale)}px;font-size:${Math.round(17 * scale)}px;color:#111;letter-spacing:.6px}
    .mask-pack strong{position:absolute;left:${Math.round(20 * scale)}px;right:${Math.round(16 * scale)}px;top:${Math.round(62 * scale)}px;font-size:${Math.round(18 * scale)}px;line-height:1.12;color:#283040}
    .mask-pack span{position:absolute;right:${Math.round(14 * scale)}px;top:${Math.round(14 * scale)}px;width:${Math.round(48 * scale)}px;height:${Math.round(48 * scale)}px;border-radius:999px;background:${visual.accentDark};color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;font-size:${Math.round(13 * scale)}px;font-weight:900}
    .mask-pack i{position:absolute;left:${Math.round(28 * scale)}px;right:${Math.round(28 * scale)}px;bottom:${Math.round(28 * scale)}px;height:${Math.round(110 * scale)}px;border-radius:50%;background:radial-gradient(circle at 45% 38%,rgba(255,255,255,.95),rgba(255,255,255,.42) 42%,var(--pack) 72%);box-shadow:inset 0 0 25px rgba(255,255,255,.65)}
    .pack-0{left:${Math.round(18 * scale)}px;top:${Math.round(70 * scale)}px;z-index:4;transform:rotate(-4deg)}
    .pack-1{left:${Math.round(112 * scale)}px;top:${Math.round(50 * scale)}px;z-index:3;transform:rotate(3deg)}
    .pack-2{left:${Math.round(205 * scale)}px;top:${Math.round(74 * scale)}px;z-index:2;transform:rotate(7deg)}
    .pack-3{left:${Math.round(280 * scale)}px;top:${Math.round(95 * scale)}px;z-index:1;transform:rotate(10deg)}
  `;
}

async function renderHtmlToPng(browser, html, outputPath, width, height) {
  const tempPath = path.join(imageDir, `${path.basename(outputPath, '.png')}.html`);
  await fs.writeFile(tempPath, html, 'utf8');
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.goto(pathToFileURL(tempPath).href, { waitUntil: 'networkidle' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await page.close();
    await fs.rm(tempPath, { force: true });
  }
}

async function main() {
  await fs.mkdir(imageDir, { recursive: true });
  const targets = BLOG_PRODUCT_PROFILES.filter((profile) => TARGET_IDS.includes(profile.id));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const profile of targets) {
      const visual = VISUALS[profile.id];
      if (!visual) continue;
      await renderHtmlToPng(
        browser,
        detailHtml(profile, visual),
        path.join(imageDir, profile.detailFile),
        1024,
        1536
      );
      for (let index = 1; index <= REVIEW_PHOTO_COUNT; index += 1) {
        await renderHtmlToPng(
          browser,
          sceneHtml(profile, visual, index),
          path.join(imageDir, `${profile.assetPrefix}-review-${String(index).padStart(2, '0')}.png`),
          512,
          512
        );
      }
      console.log(`rendered ${profile.id} assets`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
