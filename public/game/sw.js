var C='olivestock-game-cache-v2';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(
  caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('olivestock-game-cache-')===0&&k!==C;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();})
);});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  // HTML/JSON(동적 콘텐츠)은 네트워크 우선 → 재배포 즉시 반영, 오프라인이면 캐시 폴백
  if(/\.html$|\.json$|\/$/.test(u.pathname)){
    e.respondWith(fetch(e.request).then(function(res){var cp=res.clone();caches.open(C).then(function(c){c.put(e.request,cp);});return res;}).catch(function(){return caches.match(e.request);}));
    return;
  }
  // 그 외(이미지/폰트 등)는 캐시 우선 + 백그라운드 갱신
  e.respondWith(caches.open(C).then(function(c){return c.match(e.request).then(function(r){
    var net=fetch(e.request).then(function(res){c.put(e.request,res.clone());return res;}).catch(function(){return r;});
    return r||net;});}));
});
