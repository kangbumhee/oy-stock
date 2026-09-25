// Local-only browser fixture: no API calls, credentials, payments or real entitlements.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../../public');
const assets = new Map([
  ['/css/style.css', 'text/css'], ['/js/storage.js', 'text/javascript'],
  ['/js/alerts.js', 'text/javascript'], ['/js/membership.js', 'text/javascript']
]);
const html = `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>일일 이용권 팝업 로컬 검증</title>
<link rel="stylesheet" href="/css/style.css"><body>
<main style="max-width:600px;margin:40px auto;padding:20px"><h1>일일 팝업 로컬 검증</h1>
<p>테스트용 평생 이용권입니다. 실제 결제·회원정보 변경 없음.</p>
<button id="price-alert-membership-entry">내 이용권 확인</button>
<button id="next-day">다음 날로 이동 (테스트)</button><p id="result"></p></main>
<script>var CONFIG={};var UI={showSyncStatus:function(){}};
var RealDate=Date;var offset=Number(localStorage.getItem('fixture_day_offset')||0);
window.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[RealDate.now()+offset]));}static now(){return RealDate.now()+offset;}};</script>
<script src="/js/storage.js"></script><script src="/js/alerts.js"></script><script src="/js/membership.js"></script>
<script>
PriceAlerts.entitlementEnabled=true;PriceAlerts.entitlement={active:true,lifetime:true};
PriceAlerts.refreshEntitlement=function(){return Promise.resolve().then(function(){return Membership.onEntitlement();});};
Membership.trackVisit=function(){};
Membership.state={available:true,recoveryEnabled:true};Membership.account={verified:false};
PriceAlerts._ensureModal();PriceAlerts._bindMembershipEntry();Membership.mount();
document.addEventListener('click',function(e){if(e.target.closest('[data-action="closePriceAlert"]'))PriceAlerts.closeModal();});
document.getElementById('next-day').onclick=function(){PriceAlerts.closeModal();offset+=86400000;localStorage.setItem('fixture_day_offset',String(offset));run();};
async function run(){await Membership.onEntitlement();document.getElementById('result').textContent='기록된 한국 날짜: '+localStorage.getItem(Storage._key('membership_notice_day_v1'));}
window.addEventListener('focus',run);run();
</script></body></html>`;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:");
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  if (assets.has(pathname)) { res.setHeader('Content-Type', assets.get(pathname)); return res.end(fs.readFileSync(path.join(root, pathname))); }
  res.writeHead(404); res.end();
});
server.listen(4197, '127.0.0.1', () => console.log('Local membership fixture: http://127.0.0.1:4197'));
