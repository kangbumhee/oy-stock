module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'Method not allowed' }));
    return;
  }

  const q = req.query || {};
  const goodsNo = String(q.goodsNo || '').trim();
  const lat = q.lat != null && q.lat !== '' ? String(q.lat) : '37.5665';
  const lng = q.lng != null && q.lng !== '' ? String(q.lng) : '126.9780';

  if (!goodsNo) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'goodsNo 파라미터가 필요합니다' }));
    return;
  }

  const latN = parseFloat(lat) || 37.5665;
  const lonN = parseFloat(lng) || 126.978;
  const oyLink =
    'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' +
    encodeURIComponent(goodsNo);

  const gnEsc = goodsNo.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const consoleScript =
    '(async()=>{\n' +
    "  const goodsNo='" +
    gnEsc +
    "';\n" +
    '  const lat=' +
    latN +
    ';\n' +
    '  const lon=' +
    lonN +
    ';\n' +
    "  const base='/oystore/api';\n" +
    "  const h={'Content-Type':'application/json','Accept':'application/json','X-Requested-With':'XMLHttpRequest'};\n" +
    '  const post=async(p,b)=>{const r=await fetch(base+p,{method:\'POST\',credentials:\'include\',headers:h,body:JSON.stringify(b)});return r.json();};\n' +
    "\n  console.log('📦 상품 정보 조회중...');\n" +
    "  const info=await post('/stock/stock-goods-info-v3',{goodsNo});\n" +
    "  if(info.status!=='SUCCESS'){console.error('❌ 조회실패');return;}\n" +
    '  const gi=info.data.goodsInfo;\n' +
    "  console.log('상품:',gi.goodsName,'가격:',gi.priceToPay);\n" +
    '\n  let opts=[];\n' +
    '  if(+gi.itemCount>1){const o=await post(\'/stock/stock-goods-info-option\',{goodsNo});if(o.status===\'SUCCESS\')opts=o.data.goodsInfo?.availableItems||[];}\n' +
    "  if(!opts.length)opts=[{itemName:gi.goodsName,legacyItemNumber:gi.masterGoodsNumber}];\n" +
    '\n  for(const opt of opts){\n' +
    '    const pid=opt.legacyItemNumber;if(!pid)continue;\n' +
    "    const st=await post('/stock/stock-stores',{productId:String(pid),lat,lon,pageIdx:1,searchWords:'',mapLat:lat,mapLon:lon});\n" +
    "    if(st.status==='SUCCESS'){\n" +
    '      const stores=st.data.storeList||[];\n' +
    '      const inStock=stores.filter(s=>(s.remainQuantity||0)>0);\n' +
    "      console.log('\\n📍',opt.itemName,'→',inStock.length+'/'+stores.length,'매장 재고');\n" +
    "      inStock.slice(0,10).forEach(s=>console.log('  ',s.storeName,s.distance+'km','수량:'+s.remainQuantity));\n" +
    '    }\n' +
    '  }\n' +
    "  console.log('\\n✅ 완료');\n" +
    '})();';

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      success: true,
      _serverFallbackGuide: true,
      message:
        'Vercel 등 서버 IP에서는 올리브영 API가 차단되는 경우가 많습니다. GitHub Actions로 수집한 /data/stock*.json 캐시를 쓰거나, 아래 콘솔 스크립트를 상품 페이지에서 실행하세요.',
      goodsNo: goodsNo,
      oliveyoungLink: oyLink,
      consoleScript: consoleScript,
      guide: [
        '1. /data/stock.json · /data/stock-detail.json 캐시를 우선 확인하세요.',
        '2. 실시간 조회: 올리브영 상품 페이지 → F12 콘솔에 아래 스크립트 붙여넣기.',
        '3. 스캔 워크플로(매시간)와 상세 워크플로(2시간마다)가 데이터를 갱신합니다.'
      ]
    })
  );
};
