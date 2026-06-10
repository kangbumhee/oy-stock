const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { BLOG_PRODUCT_PROFILES, REVIEW_PHOTO_COUNT } = require('./blog-product-profiles');

const root = path.resolve(__dirname, '..');
const imageDir = path.join(root, 'public', 'images', 'blog');

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fallbackVisual(profile) {
  return {
    kind: 'bottle',
    brand: 'OliveYoung Pick',
    title: 'HOT\nITEM',
    sub: 'POPULAR',
    accent: '#4fcfff',
    accentDark: '#0b7bc1',
    second: '#aee9ff',
    soft: '#effcff',
    warm: '#ffe774',
    pageBg: 'linear-gradient(180deg,#0e5bb6 0%,#4fcfff 48%,#effcff 100%)',
    detailTitle: '올리브영 인기상품',
    detailSub: '상세 페이지 방향을 참고해 재구성한 후기형 디테일 컷',
    features: [
      ['패키지', '브랜드와 제품 타입이 보이게 재구성했습니다.'],
      ['색감', '상세 썸네일의 톤을 참고해 분위기를 맞췄습니다.'],
      ['확인 포인트', '최종 옵션과 가격은 연결된 구매 화면에서 확인해 주세요.']
    ]
  };
}

function resolveVisual(profile) {
  return { ...fallbackVisual(profile), ...(profile && profile.visual ? profile.visual : {}) };
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
      <div class="mini-item"><b>${htmlEscape(visual.brand)}</b><span>${htmlEscape(visual.sub)}</span></div>
    </div>`;
  }

  if (visual.kind === 'pack') {
    const packColors = [visual.accent, visual.second, visual.warm, '#ffffff'];
    return `<div class="mask-stack variant-${variant % 4}">
      ${packColors
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

  if (visual.kind === 'jar' || visual.kind === 'padJar') {
    return `<div class="jar-wrap variant-${variant % 4}">
      <div class="jar-lid"></div>
      <div class="jar-body">
        <b>${htmlEscape(visual.brand)}</b>
        <strong>${htmlEscape(visual.title).replace(/\n/g, '<br>')}</strong>
        <span>${htmlEscape(visual.sub)}</span>
        <i></i>
      </div>
      ${
        visual.kind === 'padJar'
          ? '<div class="pad-stack"><span></span><span></span><span></span></div>'
          : '<div class="cream-swirl"></div>'
      }
    </div>`;
  }

  if (visual.kind === 'tint') {
    const tint = (className) => `<div class="tint ${className}">
      <div class="tint-cap"></div>
      <div class="tint-body">
        <b>${htmlEscape(visual.brand)}</b>
        <strong>${htmlEscape(visual.title).replace(/\n/g, '<br>')}</strong>
        <span>${htmlEscape(visual.sub)}</span>
      </div>
    </div>`;
    return `<div class="tint-set variant-${variant % 4}">
      ${tint('tint-back')}
      ${tint('tint-front')}
      <div class="swatch"></div>
    </div>`;
  }

  if (visual.kind === 'palette') {
    return `<div class="palette-wrap variant-${variant % 4}">
      <div class="palette-lid">
        <b>${htmlEscape(visual.brand)}</b>
        <strong>${htmlEscape(visual.title).replace(/\n/g, '<br>')}</strong>
      </div>
      <div class="palette-pan pan-a"></div>
      <div class="palette-pan pan-b"></div>
      <div class="palette-pan pan-c"></div>
      <div class="palette-pan pan-d"></div>
    </div>`;
  }

  if (visual.kind === 'pouch') {
    return `<div class="pouch-wrap variant-${variant % 4}">
      <div class="pouch-top"></div>
      <div class="pouch-body">
        <b>${htmlEscape(visual.brand)}</b>
        <strong>${htmlEscape(visual.title).replace(/\n/g, '<br>')}</strong>
        <span>${htmlEscape(visual.sub)}</span>
      </div>
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
    <div class="mini-item"><b>${htmlEscape(visual.brand)}</b><span>${htmlEscape(visual.sub)}</span></div>
  </div>`;
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
    .serum-glass{position:absolute;left:0;right:0;bottom:0;height:${Math.round(300 * scale)}px;border-radius:${Math.round(48 * scale)}px ${Math.round(48 * scale)}px ${Math.round(30 * scale)}px ${Math.round(30 * scale)}px;background:linear-gradient(135deg,rgba(255,255,255,.9),${visual.second} 20%,${visual.accent} 74%,rgba(255,255,255,.58));border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.94);box-shadow:inset 18px 0 32px rgba(255,255,255,.32),inset -18px 0 32px rgba(0,80,150,.16),0 22px 36px rgba(0,70,120,.18);overflow:hidden}
    .serum-glass:before{content:'';position:absolute;left:${Math.round(18 * scale)}px;right:${Math.round(18 * scale)}px;top:${Math.round(22 * scale)}px;height:${Math.round(32 * scale)}px;border-radius:999px;background:rgba(255,255,255,.55)}
    .serum-glass b,.jar-body b,.tube-body b,.tint-body b,.palette-lid b,.pouch-body b{position:absolute;left:0;right:0;text-align:center;font-size:${Math.round(18 * scale)}px;color:#1a2430;letter-spacing:.5px}
    .serum-glass b{top:${Math.round(72 * scale)}px}
    .serum-glass strong,.jar-body strong,.tube-body strong,.tint-body strong,.palette-lid strong,.pouch-body strong{position:absolute;left:${Math.round(18 * scale)}px;right:${Math.round(18 * scale)}px;font-size:${Math.round(17 * scale)}px;line-height:1.1;color:#1f3446}
    .serum-glass strong{top:${Math.round(118 * scale)}px}
    .serum-glass i{position:absolute;left:${Math.round(24 * scale)}px;right:${Math.round(24 * scale)}px;bottom:${Math.round(98 * scale)}px;height:${Math.max(1, Math.round(2 * scale))}px;background:rgba(0,75,130,.42)}
    .serum-glass span,.jar-body span,.tube-body span,.tint-body span,.pouch-body span{position:absolute;left:${Math.round(20 * scale)}px;right:${Math.round(20 * scale)}px;bottom:${Math.round(44 * scale)}px;font-size:${Math.round(12 * scale)}px;color:#17344a;font-weight:900;text-align:center}
    .mini-item{position:absolute;right:${Math.round(10 * scale)}px;bottom:${Math.round(52 * scale)}px;width:${Math.round(98 * scale)}px;height:${Math.round(140 * scale)}px;border-radius:${Math.round(20 * scale)}px;background:linear-gradient(180deg,#ffffff,${visual.soft});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.9);box-shadow:0 14px 28px rgba(0,80,120,.16);z-index:4;text-align:center}
    .mini-item b{display:block;margin-top:${Math.round(48 * scale)}px;font-size:${Math.round(11 * scale)}px;color:#173f4c}
    .mini-item span{display:block;margin-top:${Math.round(10 * scale)}px;padding:0 ${Math.round(6 * scale)}px;font-size:${Math.round(11 * scale)}px;color:${visual.accentDark};font-weight:900;line-height:1.2}
    .tube-set{position:absolute;left:50%;top:50%;width:${Math.round(350 * scale)}px;height:${Math.round(500 * scale)}px;transform:translate(-50%,-50%)}
    .tube{position:absolute;bottom:${Math.round(72 * scale)}px;width:${Math.round(126 * scale)}px;height:${Math.round(330 * scale)}px}
    .tube-front{left:${Math.round(126 * scale)}px;z-index:3;transform:rotate(3deg)}
    .tube-back{left:${Math.round(42 * scale)}px;z-index:2;transform:rotate(-5deg)}
    .tube-body{position:absolute;left:0;right:0;top:0;height:${Math.round(288 * scale)}px;border-radius:${Math.round(42 * scale)}px ${Math.round(42 * scale)}px ${Math.round(20 * scale)}px ${Math.round(20 * scale)}px;background:linear-gradient(90deg,#f9fbfa 0%,#fff 48%,#edf4f2 100%);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(170,190,195,.8);box-shadow:inset -16px 0 28px rgba(20,80,90,.08)}
    .tube-body b{top:${Math.round(38 * scale)}px}
    .tube-body strong{top:${Math.round(72 * scale)}px}
    .tube-body i{position:absolute;left:50%;top:${Math.round(144 * scale)}px;width:${Math.round(22 * scale)}px;height:${Math.round(92 * scale)}px;transform:translateX(-50%);background:${visual.accent};border-radius:${Math.round(12 * scale)}px}
    .tube-top{position:absolute;left:${Math.round(8 * scale)}px;right:${Math.round(8 * scale)}px;top:${Math.round(-20 * scale)}px;height:${Math.round(34 * scale)}px;border-radius:${Math.round(12 * scale)}px;background:repeating-linear-gradient(90deg,#fff,#fff ${Math.max(2, Math.round(4 * scale))}px,#dce7e7 ${Math.max(3, Math.round(5 * scale))}px,#dce7e7 ${Math.max(4, Math.round(7 * scale))}px);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(190,205,205,.8)}
    .tube-cap{position:absolute;left:${Math.round(24 * scale)}px;right:${Math.round(24 * scale)}px;bottom:0;height:${Math.round(82 * scale)}px;border-radius:${Math.round(12 * scale)}px ${Math.round(12 * scale)}px ${Math.round(32 * scale)}px ${Math.round(32 * scale)}px;background:linear-gradient(180deg,rgba(255,255,255,.72),${visual.accent});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(0,140,150,.36)}
    .jar-wrap{position:absolute;left:50%;top:50%;width:${Math.round(320 * scale)}px;height:${Math.round(410 * scale)}px;transform:translate(-50%,-50%)}
    .jar-lid{position:absolute;left:${Math.round(32 * scale)}px;right:${Math.round(32 * scale)}px;top:${Math.round(46 * scale)}px;height:${Math.round(86 * scale)}px;border-radius:${Math.round(42 * scale)}px ${Math.round(42 * scale)}px ${Math.round(18 * scale)}px ${Math.round(18 * scale)}px;background:linear-gradient(180deg,#fff,${visual.second});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.94);box-shadow:0 16px 30px rgba(40,70,90,.14)}
    .jar-body{position:absolute;left:0;right:0;bottom:${Math.round(36 * scale)}px;height:${Math.round(240 * scale)}px;border-radius:${Math.round(38 * scale)}px;background:linear-gradient(180deg,rgba(255,255,255,.92),${visual.soft});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(214,225,231,.92);box-shadow:0 20px 34px rgba(30,60,80,.16)}
    .jar-body b{top:${Math.round(44 * scale)}px}
    .jar-body strong{top:${Math.round(78 * scale)}px}
    .jar-body span{bottom:${Math.round(24 * scale)}px}
    .jar-body i{position:absolute;left:${Math.round(26 * scale)}px;right:${Math.round(26 * scale)}px;bottom:${Math.round(62 * scale)}px;height:${Math.round(48 * scale)}px;border-radius:999px;background:linear-gradient(90deg,${visual.accent},${visual.second})}
    .pad-stack{position:absolute;right:${Math.round(18 * scale)}px;top:${Math.round(6 * scale)}px;width:${Math.round(126 * scale)}px;height:${Math.round(126 * scale)}px}
    .pad-stack span{position:absolute;display:block;width:${Math.round(86 * scale)}px;height:${Math.round(86 * scale)}px;border-radius:${Math.round(22 * scale)}px;background:rgba(255,255,255,.94);border:${Math.max(1, Math.round(2 * scale))}px solid rgba(215,235,240,.9);box-shadow:0 14px 24px rgba(30,60,80,.12)}
    .pad-stack span:nth-child(1){right:0;top:0;transform:rotate(10deg)}
    .pad-stack span:nth-child(2){left:${Math.round(10 * scale)}px;top:${Math.round(18 * scale)}px;transform:rotate(-9deg)}
    .pad-stack span:nth-child(3){right:${Math.round(24 * scale)}px;top:${Math.round(32 * scale)}px;transform:rotate(2deg)}
    .cream-swirl{position:absolute;right:${Math.round(18 * scale)}px;top:${Math.round(16 * scale)}px;width:${Math.round(138 * scale)}px;height:${Math.round(92 * scale)}px;border-radius:50%;background:radial-gradient(circle at 50% 32%,rgba(255,255,255,.94),${visual.warm});box-shadow:0 16px 24px rgba(30,60,80,.14)}
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
    .tint-set{position:absolute;left:50%;top:50%;width:${Math.round(300 * scale)}px;height:${Math.round(420 * scale)}px;transform:translate(-50%,-50%)}
    .tint{position:absolute;bottom:${Math.round(58 * scale)}px;width:${Math.round(82 * scale)}px;height:${Math.round(260 * scale)}px}
    .tint-front{left:${Math.round(130 * scale)}px;z-index:3;transform:rotate(6deg)}
    .tint-back{left:${Math.round(70 * scale)}px;z-index:2;transform:rotate(-7deg)}
    .tint-cap{position:absolute;left:${Math.round(8 * scale)}px;right:${Math.round(8 * scale)}px;top:0;height:${Math.round(78 * scale)}px;border-radius:${Math.round(18 * scale)}px;background:linear-gradient(180deg,${visual.accentDark},#1b1c24)}
    .tint-body{position:absolute;left:0;right:0;bottom:0;height:${Math.round(196 * scale)}px;border-radius:${Math.round(18 * scale)}px;background:linear-gradient(180deg,rgba(255,255,255,.88),${visual.accent});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.9);box-shadow:0 18px 30px rgba(40,60,80,.18)}
    .tint-body b{top:${Math.round(24 * scale)}px}
    .tint-body strong{top:${Math.round(58 * scale)}px}
    .swatch{position:absolute;right:${Math.round(10 * scale)}px;bottom:${Math.round(24 * scale)}px;width:${Math.round(104 * scale)}px;height:${Math.round(74 * scale)}px;border-radius:${Math.round(26 * scale)}px;background:linear-gradient(90deg,${visual.accent},${visual.warm});box-shadow:0 18px 28px rgba(40,60,80,.18)}
    .palette-wrap{position:absolute;left:50%;top:50%;width:${Math.round(330 * scale)}px;height:${Math.round(320 * scale)}px;transform:translate(-50%,-50%)}
    .palette-lid{position:absolute;left:0;right:0;top:0;height:${Math.round(136 * scale)}px;border-radius:${Math.round(28 * scale)}px;background:linear-gradient(180deg,#fff,${visual.soft});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(240,235,225,.96);box-shadow:0 20px 34px rgba(30,60,80,.16)}
    .palette-lid b{top:${Math.round(22 * scale)}px}
    .palette-lid strong{top:${Math.round(56 * scale)}px;text-align:center}
    .palette-pan{position:absolute;bottom:0;width:${Math.round(138 * scale)}px;height:${Math.round(120 * scale)}px;border-radius:${Math.round(28 * scale)}px;border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.94);box-shadow:0 16px 30px rgba(30,60,80,.16)}
    .pan-a{left:0;background:linear-gradient(180deg,${visual.warm},#f6d8ae)}
    .pan-b{right:0;background:linear-gradient(180deg,${visual.accent},${visual.second})}
    .pan-c{left:${Math.round(26 * scale)}px;bottom:${Math.round(86 * scale)}px;width:${Math.round(110 * scale)}px;height:${Math.round(86 * scale)}px;background:#ffffff}
    .pan-d{right:${Math.round(26 * scale)}px;bottom:${Math.round(86 * scale)}px;width:${Math.round(110 * scale)}px;height:${Math.round(86 * scale)}px;background:linear-gradient(180deg,${visual.second},#ffffff)}
    .pouch-wrap{position:absolute;left:50%;top:50%;width:${Math.round(300 * scale)}px;height:${Math.round(380 * scale)}px;transform:translate(-50%,-50%)}
    .pouch-top{position:absolute;left:${Math.round(24 * scale)}px;right:${Math.round(24 * scale)}px;top:0;height:${Math.round(48 * scale)}px;border-radius:${Math.round(20 * scale)}px;background:linear-gradient(180deg,#fff,${visual.second});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(255,255,255,.94)}
    .pouch-body{position:absolute;left:0;right:0;top:${Math.round(24 * scale)}px;bottom:0;border-radius:${Math.round(30 * scale)}px;background:linear-gradient(180deg,#fff,${visual.soft});border:${Math.max(1, Math.round(2 * scale))}px solid rgba(240,235,225,.94);box-shadow:0 20px 34px rgba(30,60,80,.16)}
    .pouch-body b{top:${Math.round(62 * scale)}px}
    .pouch-body strong{top:${Math.round(96 * scale)}px;text-align:center}
  `;
}

function detailHtml(profile, visual) {
  const featureHtml = (visual.features || [])
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
    <div class="badge">리뷰형<br>컷</div>
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

async function renderProfileAssets(browser, profile) {
  const visual = resolveVisual(profile);
  await renderHtmlToPng(browser, detailHtml(profile, visual), path.join(imageDir, profile.detailFile), 1024, 1536);
  for (let index = 1; index <= REVIEW_PHOTO_COUNT; index += 1) {
    await renderHtmlToPng(
      browser,
      sceneHtml(profile, visual, index),
      path.join(imageDir, `${profile.assetPrefix}-review-${String(index).padStart(2, '0')}.png`),
      512,
      512
    );
  }
}

async function renderAssetsForProfiles(profiles) {
  await fs.mkdir(imageDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const profile of profiles) {
      await renderProfileAssets(browser, profile);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const targets = BLOG_PRODUCT_PROFILES.filter((profile) => profile.assetPrefix && profile.detailFile);
  await renderAssetsForProfiles(targets);
  targets.forEach((profile) => console.log(`rendered ${profile.id} assets`));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  renderAssetsForProfiles,
  renderProfileAssets
};
