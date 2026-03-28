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

  const goodsNo = (req.query && req.query.goodsNo) || '';
  if (!goodsNo) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'goodsNo required' }));
    return;
  }

  const oyUrl =
    'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNo);

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    const r = await fetch(oyUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9'
      },
      signal: controller.signal
    });
    clearTimeout(t);

    if (!r.ok) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, message: 'OY page ' + r.status, oyUrl }));
      return;
    }

    const html = await r.text();
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const pageProps = nextData && nextData.props && nextData.props.pageProps;
        if (pageProps) {
          const candidates = [
            pageProps.goodsDetail && pageProps.goodsDetail.optionList,
            pageProps.goodsDetail && pageProps.goodsDetail.itemList,
            pageProps.optionList,
            pageProps.itemList,
            pageProps.dehydratedState &&
              pageProps.dehydratedState.queries &&
              pageProps.dehydratedState.queries[0] &&
              pageProps.dehydratedState.queries[0].state &&
              pageProps.dehydratedState.queries[0].state.data &&
              pageProps.dehydratedState.queries[0].state.data.optionList
          ].filter(Boolean);

          for (let i = 0; i < candidates.length; i++) {
            const list = candidates[i];
            if (Array.isArray(list) && list.length > 0) {
              const options = list.map(function (item) {
                return {
                  optionName: item.optNm || item.itemNm || item.optionName || item.name || '',
                  price: item.priceToPay || item.salePrice || item.price || '',
                  discount: item.discountRate || item.dcRate || '',
                  todayDelivery: item.o2oYn === 'Y' || item.todayDelivery === true,
                  soldOut:
                    item.soldOutYn === 'Y' ||
                    item.soldOut === true ||
                    item.stockQty === 0 ||
                    item.stockQty === '0',
                  image: item.imageUrl || item.imgUrl || item.image || '',
                  itemNo: item.itemNo || item.itemNumber || ''
                };
              });
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ success: true, source: 'nextData', options }));
              return;
            }
          }
        }
      } catch (parseErr) {
        // fall through
      }
    }

    const hasOptionUI = html.indexOf('OptionSelector_option-item-btn') !== -1;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        success: false,
        message: 'JS rendering required',
        hasOptionUI: hasOptionUI,
        goodsNo: goodsNo,
        oyUrl: oyUrl
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: e.message || 'options error' }));
  }
};
