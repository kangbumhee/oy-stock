// Local-only real UI fixture. No customer credentials, payments or external API calls.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../../public');
const assets = new Map([
  ['/css/style.css', 'text/css'], ['/js/storage.js', 'text/javascript'],
  ['/js/alerts.js', 'text/javascript'], ['/js/ui.js', 'text/javascript'],
  ['/js/hidden-stock.js', 'text/javascript']
]);
const html = `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>전국 재고 유료 권한 검증</title>
<link rel="stylesheet" href="/css/style.css"><body>
<aside style="position:fixed;z-index:999999;top:0;left:0;background:white;padding:8px">
<button id="free">무료 사용자</button><button id="paid">유료 사용자</button><button id="lifetime">평생 이용권</button>
<button id="expired">만료 처리</button><button id="reopen">상품 열기</button><output id="result">전국 요청: 0</output></aside>
<div id="popup-root"></div>
<script>var CONFIG={REALTIME_API:'/fixture-nearby',DEFAULT_LAT:37.6152,DEFAULT_LNG:126.7156,DEFAULT_LOCATION:'검증 위치'};
var App={_resumePendingOnlineEnrich:function(){}};</script>
<script src="/js/storage.js"></script><script src="/js/ui.js"></script>
<script src="/js/alerts.js"></script><script src="/js/hidden-stock.js"></script>
<script>
var nationwideCalls=0;
var detail={success:true,goodsNo:'A000000152475',goodsName:'로컬 검증 상품',price:21900,source:'live',inventoryScope:'store',storeLookupStatus:'ok',
 options:[{productId:'8809506312905',optionNumber:'001',name:'검증 옵션',onlineQty:12,storeLookupStatus:'ok',inStock:1,totalStores:1,totalQty:5,stores:[{name:'무료 근처 매장',qty:5,dist:1}]}]};
PriceAlerts.entitlementEnabled=true;PriceAlerts.paymentAvailable=true;
PriceAlerts._apiHeaders=function(){return {'X-Price-Alert-Device-Id':'local-fixture','X-Price-Alert-Device-Secret':'not-a-real-secret'};};
PriceAlerts.refreshEntitlement=function(){this._renderEntitlement();return Promise.resolve(this.entitlement);};
PriceAlerts._request=async function(url){
 if(!url.startsWith('/api/oliveyoung/hidden-stock?action=all-stores'))throw new Error('unexpected_fixture_request');
 nationwideCalls++;document.getElementById('result').textContent='전국 요청: '+nationwideCalls;
 var response=JSON.parse(JSON.stringify(detail));response.source='live-all';
 response.options[0].stores=[{name:'전국 재고 많은 매장',qty:44,region:'서울'},{name:'전국 재고 적은 매장',qty:3,region:'부산'}];
 response.options[0].totalStores=2;response.options[0].totalQty=47;response.options[0].inStock=2;return response;
};
function setMember(kind){PriceAlerts.closeModal();PriceAlerts.entitlement=kind==='free'?{active:false}:kind==='lifetime'?{active:true,lifetime:true}:{active:true,expiresAt:new Date(Date.now()+(kind==='expired'?-1000:86400000)).toISOString()};HiddenStock.onEntitlementChange();}
document.getElementById('free').onclick=function(){setMember('free');};
document.getElementById('paid').onclick=function(){setMember('paid');};
document.getElementById('lifetime').onclick=function(){setMember('lifetime');};
document.getElementById('expired').onclick=function(){setMember('expired');};
document.getElementById('reopen').onclick=function(){UI.showDetailPopup(detail,detail.goodsNo);};
document.addEventListener('click',function(e){if(e.target.closest('[data-action="closePriceAlert"]'))PriceAlerts.closeModal();});
PriceAlerts._ensureModal();HiddenStock.init();UI._bindPopupEvents();setMember('free');UI.showDetailPopup(detail,detail.goodsNo);
</script></body></html>`;
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:");
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  if (assets.has(pathname)) { res.setHeader('Content-Type', assets.get(pathname)); return res.end(fs.readFileSync(path.join(root, pathname))); }
  res.writeHead(404); res.end();
}).listen(4198, '127.0.0.1', () => console.log('Local national stock fixture: http://127.0.0.1:4198'));
