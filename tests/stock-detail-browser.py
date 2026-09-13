"""Local mocked acceptance of ordinary stock detail lifecycle; never calls production.

The photographed products have their real goods/SKU identifiers and names, but all
stock counts, store names and times below are test fixtures. The local photograph
is an explicitly unrelated stand-in, because their own images are not in the repo.
Run with webapp-testing's with_server.py and a static public/ server on port 8874.
"""
import copy
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error, expect, sync_playwright

ROOT = 'http://127.0.0.1:8874'
PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / '.ai' / 'logs' / 'stock-detail-browser'
OUT.mkdir(parents=True, exist_ok=True)
IMAGE = 'https://image.oliveyoung.co.kr/local-test/stand-in.jpg'
IMAGE_BYTES = (PROJECT / 'public/images/blog/oliveyoung-hot-item-stock-a000000255680-source.jpg').read_bytes()
CREAM = 'A000000263782'
LIP = 'A000000227778'
FIXTURES = {
    CREAM: {
        'goodsName': '[산리오 특가/리뷰이벤트/헬로키티] 에스네이처 아쿠아 스쿠알란 수분크림 60ml 더블기획 (+헬로키티 키캡키링)',
        'price': 21900, 'originalPrice': 43000, 'discountRate': 49,
        'options': [dict(productId='8809506312905', optionNumber='001', name='수분크림 60ml 더블기획 (+헬로키티 키캡키링)', onlineQty=2644)]},
    LIP: {
        'goodsName': '[최초기획/미니립증정] 투슬래시포 스컬프트 립 쉐이퍼 (기획/단품)',
        'price': 18700, 'originalPrice': 22000, 'discountRate': 15,
        'options': [dict(productId='8809923821615', optionNumber='001', name='인 로즈', onlineQty=40),
                    dict(productId='8809923821608', optionNumber='008', name='[립칠러 미니 증정] 인 살몬', onlineQty=0),
                    dict(productId='8809923820045', optionNumber='003', name='아웃 테디', onlineQty=29)]}
}


def online(goods_no):
    result = copy.deepcopy(FIXTURES[goods_no])
    result.update(success=True, goodsNo=goods_no, thumbnail=IMAGE, source='live-online',
                  inventoryScope='online', storeLookupStatus='not_requested',
                  updatedAt='2026-09-13T07:30:00Z')
    for option in result['options']:
        option.update(image=IMAGE, stores=[], totalStores=0, inStock=0, totalQty=0,
                      storeLookupStatus='not_requested')
    return result


def nearby(goods_no, selected=0, qty=7, name='모의 김포사우점', partial=False):
    result = online(goods_no)
    result.update(source='live', inventoryScope='store',
                  storeLookupStatus='partial' if partial else 'ok')
    for index, option in enumerate(result['options']):
        if partial and index == selected:
            option.update(storeLookupStatus='unavailable', storeLookupError='UPSTREAM_RATE_LIMITED')
        else:
            option.update(storeLookupStatus='ok', totalStores=2, inStock=1, totalQty=qty,
                          stores=[dict(code='fixture-sa', name=name, dist=0.37, qty=qty),
                                  dict(code='fixture-pu', name='모의 풍무점', dist=1.4, qty=0)])
    return result


def national(goods_no, product_id):
    detail = nearby(goods_no, qty=13, name='모의 전국 재고점')
    detail['source'] = 'live-all'
    detail['options'] = [item for item in detail['options'] if item['productId'] == product_id]
    detail['options'][0].update(totalStores=4, inStock=2, totalQty=15,
        stores=[dict(code='fixture-n2', name='모의 전국 2개점', region='서울', qty=2),
                dict(code='fixture-nu', name='모의 수량 미확인점', region='경기', qty=None),
                dict(code='fixture-pu', name='모의 풍무점', region='경기', qty=0),
                dict(code='fixture-sa', name='모의 전국 재고점', region='경기', qty=13)])
    return detail


def assert_not_false_empty(popup):
    expect(popup.locator('.opt-panel.active .no-store')).not_to_have_text('주변 매장 재고 없음')
    expect(popup.locator('.opt-panel.active .opt-stock')).not_to_contain_text('주변 매장 재고 없음')
    expect(popup.locator('.popup-badge')).not_to_contain_text('주변 매장 전체 품절')


def screenshot(page, width, label):
    page.locator('#popup-root .popup-content').screenshot(path=str(OUT / f'{label}-{width}.png'))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width in [390, 1440]:
        state = {'online': [], 'nearby': [], 'national': [], 'held': [], 'external': []}
        errors = []
        context = browser.new_context(viewport={'width': width, 'height': 960}, service_workers='block')
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))

        def intercept(route):
            url = urlsplit(route.request.url)
            path, query = url.path, parse_qs(url.query)
            if route.request.url == IMAGE:
                return route.fulfill(status=200, content_type='image/jpeg', body=IMAGE_BYTES)
            if url.hostname not in ['127.0.0.1', 'localhost']:
                state['external'].append(url.hostname)
                return route.fulfill(status=200, content_type='application/javascript', body='')
            if path.startswith('/data/'):
                return route.fulfill(json={'products': {}, 'links': {}, 'items': [], 'summary': {'total': 0}})
            if path == '/api/stock':
                goods_no = query['goodsNo'][0]
                assert goods_no in FIXTURES, query
                assert query['lat'][0] == '37.6152' and query['lng'][0] == '126.7156', query
                if query.get('onlineOnly') == ['true']:
                    state['online'].append(query)
                    return route.fulfill(json=online(goods_no))
                state['nearby'].append(query)
                state['held'].append((route, goods_no, 'nearby'))
                return
            if path == '/api/stock-all':
                goods_no = query['goodsNo'][0]
                state['national'].append(query)
                state['held'].append((route, goods_no, 'national'))
                return
            if path.startswith('/api/'):
                return route.fulfill(json={'success': True, 'enabled': True, 'entitlement': {'active': False},
                    'alerts': [], 'products': [], 'options': [], 'data': {}, 'summary': {}})
            return route.continue_()

        def wait_held(kind, goods_no, start=0):
            page.wait_for_function("() => document.querySelector('#popup-root .popup-content') !== null")
            for _ in range(100):
                matches = [item for item in state['held'][start:] if item[1:] == (goods_no, kind)]
                if matches:
                    return matches[0]
                page.wait_for_timeout(25)
            raise AssertionError(f'Expected held {kind} request for {goods_no}; state={state}')

        def open_card(goods_no):
            index = list(FIXTURES).index(goods_no)
            page.locator(f'#product-list .card-name[data-action="showDetail"][data-index="{index}"]').click()

        def close_popup():
            page.locator('#popup-root .popup-header [data-action="closePopup"]').click()
            expect(page.locator('#popup-root .popup-content')).to_have_count(0)

        page.route('**/*', intercept)
        page.goto(ROOT, wait_until='networkidle')
        # Seed public list metadata only; all lifecycle requests still use real application fetch code.
        page.evaluate('''(fixtures) => {
            CONFIG.REALTIME_API = '/api/stock';
            CONFIG.STOCK_RETRY_COOLDOWN_MS = 150;
            CONFIG.STOCK_DETAIL_FETCH_TIMEOUT_MS = 15000;
            CONFIG.STOCK_ONLINE_FIRST_TIMEOUT_MS = 5000;
            App.lat = 37.6152; App.lng = 126.7156;
            App.detailData = {products: {}};
            App.products = Object.entries(fixtures).map(([goodsNo, p]) => ({goodsNo, goodsNumber: goodsNo,
                goodsName:p.goodsName, priceToPay:p.price, originalPrice:p.originalPrice, discountRate:p.discountRate}));
            UI.renderProducts(App.products, App.detailData);
        }''', FIXTURES)
        popup = page.locator('#popup-root')
        assert page.locator('#product-list .card-name[data-action="showDetail"]').count() == 2

        # The exact pictured cream: online-only must remain pending, not sold out.
        open_card(CREAM)
        first = wait_held('nearby', CREAM)
        expect(popup.locator('.opt-panel.active .opt-stock')).to_contain_text('2,644')
        expect(popup.locator('.opt-panel.active')).to_contain_text('조회 중')
        assert_not_false_empty(popup)
        assert not state['national'], 'Opening detail must not prefetch nationwide inventory'
        screenshot(page, width, 'online-pending')
        first[0].fulfill(status=429, json={'success': False, 'error': 'UPSTREAM_RATE_LIMITED',
                                       'message': '모의 올리브영 요청 제한', 'retryAfter': 0})
        retry = popup.locator('[data-action="retryStoreStock"]').first
        expect(retry).to_be_visible()
        expect(popup).to_contain_text('품절 여부는 미확인입니다')
        assert_not_false_empty(popup)
        page.wait_for_timeout(350)
        expect(popup).to_contain_text('품절 여부는 미확인입니다')
        screenshot(page, width, 'nearby-unavailable')
        assert len(state['nearby']) == 1, 'Failure must not auto-retry or start a request loop'
        start = len(state['held'])
        retry.click(timeout=10000)
        second = wait_held('nearby', CREAM, start)
        second[0].fulfill(json=nearby(CREAM))
        expect(popup.locator('.opt-panel.active .store-name')).to_have_text(['모의 김포사우점', '모의 풍무점'])
        expect(popup.locator('.opt-panel.active .store-right').first).to_contain_text('7')
        expect(popup.locator('.opt-panel.active [data-action="loadAllStockOpt"]')).to_have_attribute('data-productid', '8809506312905')
        assert not state['national'], 'Successful nearby response must not prefetch nationwide inventory'
        screenshot(page, width, 'nearby-retry-success')
        close_popup()

        # Selected lip SKU survives the online-first full response, including a partial failure.
        start = len(state['held'])
        open_card(LIP)
        lip_request = wait_held('nearby', LIP, start)
        popup.locator('.opt-tab[data-idx="1"]').click()
        expect(popup.locator('.opt-panel.active .opt-name')).to_have_text('[립칠러 미니 증정] 인 살몬')
        assert_not_false_empty(popup)
        assert not state['national'], 'Switching option must not prefetch nationwide inventory'
        lip_request[0].fulfill(json=nearby(LIP, selected=1, partial=True))
        expect(popup.locator('.opt-tab.active')).to_have_attribute('data-idx', '1')
        expect(popup.locator('.opt-panel.active .opt-name')).to_have_text('[립칠러 미니 증정] 인 살몬')
        expect(popup.locator('.opt-panel.active')).to_contain_text('미확인')
        assert_not_false_empty(popup)
        screenshot(page, width, 'partial-selected-option')
        start = len(state['held'])
        popup.locator('[data-action="retryStoreStock"]').first.click(timeout=10000)
        lip_retry = wait_held('nearby', LIP, start)
        lip_retry[0].fulfill(json=nearby(LIP, selected=1, qty=5, name='모의 인살몬 재고점'))
        expect(popup.locator('.opt-panel.active .opt-name')).to_have_text('[립칠러 미니 증정] 인 살몬')
        expect(popup.locator('.opt-panel.active .store-name').first).to_have_text('모의 인살몬 재고점')
        assert not state['national']

        # Nationwide is user initiated and tied to the current SKU. Failure is never empty stock.
        start = len(state['held'])
        all_button = popup.locator('.opt-panel.active [data-action="loadAllStockOpt"]')
        all_button.click()
        all_request = wait_held('national', LIP, start)
        assert state['national'][-1]['productId'] == ['8809923821608'], state['national']
        all_request[0].fulfill(status=503, json={'success': False, 'error': 'UPSTREAM_UNAVAILABLE',
                                              'message': '모의 전국 재고 응답 지연', 'retryAfter': 0})
        expect(all_button).not_to_have_class(re.compile(r'\bloading\b'))
        expect(popup.locator('#all-stock-panel')).to_have_count(0)
        expect(all_button).to_contain_text(re.compile('실패|미확인|다시'))
        expect(popup).not_to_contain_text('0/0매장')
        screenshot(page, width, 'national-unavailable')
        start = len(state['held'])
        page.wait_for_timeout(200)
        all_button.click(timeout=10000)
        all_retry = wait_held('national', LIP, start)
        # A 200 response containing option metadata is not successful store evidence.
        unavailable = national(LIP, '8809923821608')
        unavailable['storeLookupStatus'] = 'unavailable'
        unavailable['options'][0].update(storeLookupStatus='unavailable', stores=[], totalQty=0, totalStores=0, inStock=0)
        all_retry[0].fulfill(json=unavailable)
        expect(all_button).not_to_have_class(re.compile(r'\bloading\b'))
        expect(popup.locator('#all-stock-panel')).to_have_count(0)
        expect(all_button).to_contain_text('미확인')
        expect(popup).not_to_contain_text('0/0매장')
        start = len(state['held'])
        page.wait_for_timeout(200)
        all_button.click(timeout=10000)
        all_retry = wait_held('national', LIP, start)
        all_retry[0].fulfill(json=national(LIP, '8809923821608'))
        expect(popup.locator('#all-stock-panel')).to_contain_text('모의 전국 재고점')
        expect(popup.locator('#all-stock-panel .store-name')).to_have_text(
            ['모의 전국 재고점', '모의 전국 2개점', '모의 풍무점', '모의 수량 미확인점'])
        expect(popup.locator('#all-stock-panel .store-right').last).to_have_text('재고 미확인')
        assert state['national'][-1]['productId'] == ['8809923821608']
        close_popup()

        # Same goods and coordinates share in-flight work; only the new popup owns rendering.
        start = len(state['held'])
        open_card(CREAM)
        shared = wait_held('nearby', CREAM, start)
        count = len(state['nearby'])
        close_popup()
        open_card(CREAM)
        expect(popup.locator('.opt-panel.active .opt-stock')).to_contain_text('2,644')
        page.wait_for_timeout(100)
        assert len(state['nearby']) == count, 'Same goods reopening must reuse its in-flight request'
        shared[0].fulfill(json=nearby(CREAM, qty=17, name='모의 최신 세션 재고점'))
        expect(popup.locator('.opt-panel.active .store-name').first).to_have_text('모의 최신 세션 재고점')
        screenshot(page, width, 'same-goods-reopen-safe')
        close_popup()

        # Completion for an older/different goods must never overwrite the current selection.
        start = len(state['held'])
        open_card(CREAM)
        stale = wait_held('nearby', CREAM, start)
        close_popup()
        start = len(state['held'])
        open_card(LIP)
        current = wait_held('nearby', LIP, start)
        popup.locator('.opt-tab[data-idx="1"]').click()
        current[0].fulfill(json=nearby(LIP, qty=17, name='모의 현재 상품 재고점'))
        expect(popup.locator('.opt-panel.active .store-name').first).to_have_text('모의 현재 상품 재고점')
        try:
            stale[0].fulfill(json=nearby(CREAM, qty=1, name='모의 이전 세션 재고점'))
        except Error as error:
            assert re.search('closed|cancel|abort', str(error), re.I), str(error)
        page.wait_for_timeout(150)
        expect(popup.locator('.opt-panel.active .store-name').first).to_have_text('모의 현재 상품 재고점')
        expect(popup.locator('.opt-panel.active .opt-name')).to_have_text('[립칠러 미니 증정] 인 살몬')
        expect(popup).not_to_contain_text('모의 이전 세션 재고점')

        # A national request from a closed popup must not insert a panel into a reopened popup.
        popup.locator('.opt-tab[data-idx="2"]').click()
        start = len(state['held'])
        popup.locator('.opt-panel.active [data-action="loadAllStockOpt"]').click()
        stale_national = wait_held('national', LIP, start)
        close_popup()
        start = len(state['held'])
        open_card(LIP)
        new_lip = wait_held('nearby', LIP, start)
        new_lip[0].fulfill(json=nearby(LIP, qty=4, name='모의 다시 연 재고점'))
        expect(popup.locator('.opt-panel.active .store-name').first).to_have_text('모의 다시 연 재고점')
        stale_national[0].fulfill(json=national(LIP, '8809923820045'))
        page.wait_for_timeout(100)
        expect(popup.locator('#all-stock-panel')).to_have_count(0)
        expect(popup.locator('.opt-panel.active .store-name').first).to_have_text('모의 다시 연 재고점')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'page horizontal overflow'
        assert not errors, errors
        screenshot(page, width, 'stale-completion-safe')
        print(json.dumps({'width': width, 'result': 'PASS', 'onlineRequests': len(state['online']),
                          'nearbyRequests': len(state['nearby']), 'nationalRequests': len(state['national']),
                          'pageErrors': errors, 'productionRequests': 0,
                          'image': 'unrelated local photograph stand-in; inventory is mocked'}))
        context.close()
    browser.close()
