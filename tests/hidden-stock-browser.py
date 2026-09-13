"""Local, mocked browser acceptance. No production accounts or payments are used."""
import json
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = 'http://127.0.0.1:8873'
PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / '.ai' / 'logs' / 'hidden-stock-browser'
OUT.mkdir(parents=True, exist_ok=True)
IMAGE = 'https://image.oliveyoung.co.kr/browser-fixture/product.png'
BROKEN_IMAGE = 'https://image.oliveyoung.co.kr/browser-fixture/missing.png'
IMAGE_BYTES = (PROJECT / 'public' / 'favicon-192x192.png').read_bytes()
option = dict(goodsNo='A000000255680', optionNumber='001', productId='8800289469145',
              goodsName='브라우저 테스트용 미스트', name='한교동 숨김 옵션 테스트', hidden=True,
              image=IMAGE)
options = [option,
           dict(option, optionNumber='002', productId='8800289469146', name='이미지 누락 옵션', image=''),
           dict(option, optionNumber='003', productId='8800289469147', name='이미지 오류 옵션', image=BROKEN_IMAGE)]
NEARBY_STORES = [
    {'code': 's2', 'name': '수량 미확인 테스트점', 'region': '경기', 'addr': '테스트 주소', 'qty': None, 'dist': 3.2},
    {'code': 's1', 'name': '가장 가까운 테스트점', 'region': '경기', 'addr': '테스트 주소', 'qty': 6, 'dist': 0.37},
    {'code': 's3', 'name': '중간 거리 테스트점', 'region': '경기', 'addr': '테스트 주소', 'qty': 0, 'dist': 1.4}]
NEARBY_STORES.extend({'code': f'near-{i}', 'name': f'추가 근처 테스트점 {i}', 'region': '경기',
                     'addr': '테스트 주소', 'qty': 1, 'dist': float(i)} for i in range(4, 26))


def button(root, action):
    return root.locator('[data-hidden-action="' + action + '"]')


def verify_image(locator):
    expect(locator).to_be_visible()
    expect(locator).to_have_attribute('width', '72')
    expect(locator).to_have_attribute('height', '72')
    locator.page.wait_for_function('(img) => img.complete && img.naturalWidth > 0', arg=locator.element_handle())


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width in [360, 390, 1440]:
        state = {'paid': False, 'deny': False, 'hidden_calls': 0, 'public_calls': 0,
                 'nearby_calls': 0, 'national_calls': 0, 'store_requests': [], 'images': 0}
        context = browser.new_context(viewport={'width': width, 'height': 900}, service_workers='block')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def intercept(route):
            url = urlsplit(route.request.url)
            path, query = url.path, parse_qs(url.query)
            if route.request.url == IMAGE:
                state['images'] += 1
                return route.fulfill(status=200, content_type='image/png', body=IMAGE_BYTES)
            if route.request.url == BROKEN_IMAGE:
                return route.fulfill(status=404, content_type='text/plain', body='fixture image unavailable')
            if url.hostname not in ['127.0.0.1', 'localhost']:
                return route.fulfill(status=200, content_type='application/javascript', body='')
            if path.startswith('/data/'):
                return route.fulfill(json={'products': {}, 'links': {}, 'summary': {'total': 0}})
            if path == '/api/price-alerts/entitlement':
                return route.fulfill(json={'success': True, 'enabled': True, 'paymentAvailable': True,
                    'promotionAvailable': True, 'entitlement': {'active': state['paid'], 'lifetime': state['paid'], 'expiresAt': None}})
            if path == '/api/oliveyoung/hidden-stock':
                state['hidden_calls'] += 1
                assert 'cursor' not in query or query['cursor'][0], 'empty cursor breaks gateway'
                action = query['action'][0]
                if action in ['search', 'options']:
                    state['public_calls'] += 1
                    assert 'x-price-alert-device-secret' not in route.request.headers
                    assert 'x-price-alert-device-id' not in route.request.headers
                    if action == 'options':
                        assert 'cursor' not in query
                    return route.fulfill(json={'success': True, 'options': options, 'nextCursor': None,
                        'coverage': {'complete': False, 'reason': 'indexed_public_options'}})
                assert action == 'stores'
                state['store_requests'].append(query)
                if state['deny']:
                    return route.fulfill(status=402, json={'success': False, 'error': 'entitlement_required'})
                assert state['paid'], 'free browser must not request premium inventory'
                assert query['productId'][0] == option['productId'], 'access grant must resume the selected SKU'
                assert float(query['lat'][0]) == 37.6152
                assert float(query['lng'][0]) == 126.7156
                scope = query['scope'][0]
                if scope == 'nearby':
                    state['nearby_calls'] += 1
                    assert 'cursor' not in query
                    return route.fulfill(json={'success': True, 'stores': NEARBY_STORES, 'option': option,
                        'nextCursor': None, 'scope': 'nearby', 'coverage': {'complete': True, 'scope': 'nearby'}})
                assert scope == 'national'
                state['national_calls'] += 1
                has_cursor = 'cursor' in query
                stores = ([dict(NEARBY_STORES[1], region='경기'),
                           {'code': 's4', 'name': '전국 수량 미확인 테스트점', 'region': '서울', 'qty': None},
                           {'code': 's6', 'name': '전국 재고 2개 가까운점', 'region': '경기', 'qty': 2, 'dist': 0.02}]
                          if not has_cursor else
                          [dict(NEARBY_STORES[1], region='경기'),
                           {'code': 's5', 'name': '전국 제주 테스트점', 'region': '제주', 'qty': 0},
                           {'code': 's7', 'name': '전국 최대 재고 테스트점', 'region': '서울', 'qty': 19, 'dist': 55},
                           {'code': 's8', 'name': '전국 재고 2개 먼점', 'region': '경기', 'qty': 2, 'dist': 3}])
                return route.fulfill(json={'success': True, 'stores': stores, 'option': option,
                    'nextCursor': None if has_cursor else 'fixture-next', 'scope': 'national',
                    'coverage': {'complete': has_cursor, 'scope': 'national'}})
            if path.startswith('/api/'):
                return route.fulfill(json={'success': True, 'alerts': [], 'products': [],
                    'data': {'inventory': {'totalCount': 0, 'products': []}, 'products': []}, 'summary': {}})
            return route.continue_()

        page.route('**/*', intercept)
        page.goto(ROOT, wait_until='networkidle')
        # Set a selected test location, not the browser's real geolocation.
        page.evaluate("App.lat=37.6152; App.lng=126.7156; App.locationName='테스트 김포 사우';")
        assert page.locator('#search-form').count() == 1
        page.locator('#search-input').fill('한교동')
        page.locator('#search-form button[type=submit]').click()
        premium = page.locator('#hidden-stock-search')
        expect(premium).to_be_visible()
        expect(premium.get_by_text(option['name'], exact=True)).to_be_visible()
        expect(premium.get_by_text(option['goodsName'], exact=True)).to_have_count(3)
        verify_image(premium.locator('.hidden-stock-image img').first)
        expect(premium.locator('.hidden-stock-image span:visible')).to_have_count(2)
        assert state['public_calls'] > 0 and not state['store_requests']
        premium.scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f'free-{width}.png'))
        button(premium, 'stores').first.click()
        expect(page.locator('#price-alert-modal')).to_be_visible()
        expect(page.locator('#price-alert-title')).to_have_text('매장 재고 · 가격 알림 이용권')
        expect(page.locator('#price-alert-target-input')).to_be_disabled()
        assert not state['store_requests'], 'opening the payment dialog must not request inventory'
        page.screenshot(path=str(OUT / f'access-{width}.png'))
        page.locator('#price-alert-modal .price-alert-close').click()
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        expect(premium.get_by_text(option['name'], exact=True)).to_be_visible()
        verify_image(premium.locator('.hidden-stock-image img').first)

        # Product-level option details also remain public, including when a payment is cancelled.
        page.evaluate("UI.showDetailPopup({goodsName:'기존 일반 재고 팝업 테스트',thumbnail:'',price:10000,options:[],source:'vendor-delivery'},'A000000255680')")
        normal_popup = page.locator('#popup-root')
        button(normal_popup, 'options').click()
        dialog = page.locator('#hidden-stock-panel')
        expect(dialog.get_by_text(option['name'], exact=True)).to_be_visible()
        verify_image(dialog.locator('.hidden-stock-image img').first)
        assert not state['store_requests']
        page.screenshot(path=str(OUT / f'free-product-options-{width}.png'))
        button(dialog, 'stores').first.click()
        expect(page.locator('#price-alert-modal')).to_be_visible()
        assert not state['store_requests']
        page.locator('#price-alert-modal .price-alert-close').click()
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        expect(dialog.get_by_text(option['name'], exact=True)).to_be_visible()
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(normal_popup.get_by_text('기존 일반 재고 팝업 테스트', exact=True)).to_be_visible()
        expect(button(normal_popup, 'options')).to_be_focused()
        normal_popup.locator('[data-action="closePopup"]').filter(has_text='✕').click()

        # A mocked local grant resumes the selected inventory request. No real payment is made.
        button(premium, 'stores').first.click()
        expect(page.locator('#price-alert-modal')).to_be_visible()
        page.wait_for_function('PriceAlerts.entitlementLoading === false')
        state['paid'] = True
        page.evaluate('PriceAlerts.refreshEntitlement({silent:true})')
        expect(premium.get_by_text(option['name'], exact=True)).to_be_visible()
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        verify_image(premium.locator('.hidden-stock-image img').first)
        expect(premium.locator('.hidden-stock-image span:visible')).to_have_count(2)
        assert state['national_calls'] == 0
        page.screenshot(path=str(OUT / f'options-{width}.png'))
        expect(dialog.get_by_text('가장 가까운 테스트점', exact=True)).to_be_visible()
        expect(dialog.get_by_text('수량 확인 불가', exact=True)).to_be_visible()
        expect(dialog.get_by_text('조회 시점 재고 0개', exact=True)).to_be_visible()
        expect(dialog.get_by_text('테스트 김포 사우', exact=False)).to_be_visible()
        expect(dialog.locator('.hidden-stock-stores strong')).to_have_count(10)
        expect(dialog.locator('.hidden-stock-stores li:nth-child(-n+3) strong')).to_have_text([
            '가장 가까운 테스트점', '중간 거리 테스트점', '수량 미확인 테스트점'])
        verify_image(dialog.locator('.hidden-stock-image img').first)
        assert state['nearby_calls'] == 1 and state['national_calls'] == 0
        expect(button(dialog, 'national-stores')).to_have_text('전국 재고 조회')
        assert button(dialog, 'national-stores').evaluate('(button) => button.compareDocumentPosition(document.querySelector("#hidden-stock-panel .hidden-stock-stores")) & Node.DOCUMENT_POSITION_PRECEDING')
        page.screenshot(path=str(OUT / f'nearby-{width}.png'))
        button(dialog, 'nearby-more').click()
        expect(dialog.locator('.hidden-stock-stores strong')).to_have_count(20)
        assert state['nearby_calls'] == 1 and state['national_calls'] == 0, 'cached nearby rows must not trigger another API call'
        button(dialog, 'nearby-more').click()
        expect(dialog.locator('.hidden-stock-stores strong')).to_have_count(25)
        expect(button(dialog, 'nearby-more')).to_have_count(0)
        assert state['nearby_calls'] == 1 and state['national_calls'] == 0
        button(dialog, 'national-stores').click()
        expect(dialog.get_by_text('전국 제주 테스트점', exact=True)).to_be_visible()
        assert state['national_calls'] == 2
        expect(dialog.get_by_text('가장 가까운 테스트점', exact=True)).to_have_count(1)
        expect(dialog.get_by_text('수량 확인 불가', exact=True)).to_be_visible()
        expect(dialog.get_by_text('조회 시점 재고 0개', exact=True)).to_be_visible()
        expect(dialog.locator('.hidden-stock-stores strong')).to_have_text([
            '전국 최대 재고 테스트점', '가장 가까운 테스트점', '전국 재고 2개 가까운점',
            '전국 재고 2개 먼점', '전국 제주 테스트점', '전국 수량 미확인 테스트점'])
        dialog.locator('.hidden-stock-dialog').evaluate('(element) => { element.scrollTop = 0; }')
        page.screenshot(path=str(OUT / f'national-{width}.png'))
        button(dialog, 'back-nearby').click()
        expect(dialog.get_by_text('중간 거리 테스트점', exact=True)).to_be_visible()
        expect(dialog.get_by_text('전국 제주 테스트점', exact=True)).to_have_count(0)
        expect(dialog.locator('.hidden-stock-stores li:nth-child(-n+3) strong')).to_have_text([
            '가장 가까운 테스트점', '중간 거리 테스트점', '수량 미확인 테스트점'])
        assert state['national_calls'] == 2
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
        assert page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)').find(option['productId']) == -1
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(button(premium, 'stores').first).to_be_focused()

        # Open hidden options on top of an existing normal inventory popup.
        page.evaluate("UI.showDetailPopup({goodsName:'기존 일반 재고 팝업 테스트',thumbnail:'',price:10000,options:[],source:'vendor-delivery'},'A000000255680')")
        normal_popup = page.locator('#popup-root')
        button(normal_popup, 'options').click()
        expect(dialog.get_by_text(option['name'], exact=True)).to_be_visible()
        button(dialog, 'stores').first.click()
        expect(dialog.get_by_text('가장 가까운 테스트점', exact=True)).to_be_visible()
        button(dialog, 'back-options').click()
        expect(dialog.get_by_text(option['name'], exact=True)).to_be_visible()
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(normal_popup.get_by_text('기존 일반 재고 팝업 테스트', exact=True)).to_be_visible()
        expect(button(normal_popup, 'options')).to_be_focused()
        normal_popup.locator('[data-action="closePopup"]').filter(has_text='✕').click()

        # API revocation removes private inventory without erasing public photos and descriptions.
        state['deny'] = True
        button(premium, 'stores').first.click()
        expect(page.locator('#hidden-stock-panel')).to_have_count(0)
        expect(premium.get_by_text(option['name'], exact=True)).to_be_visible()
        verify_image(premium.locator('.hidden-stock-image img').first)
        expect(page.locator('.hidden-stock-stores')).to_have_count(0)

        # Expiration of an already-open nested inventory restores only its public option list.
        state['deny'] = False
        state['paid'] = True
        page.evaluate('PriceAlerts.refreshEntitlement({silent:true})')
        page.evaluate("UI.showDetailPopup({goodsName:'기존 일반 재고 팝업 테스트',thumbnail:'',price:10000,options:[],source:'vendor-delivery'},'A000000255680')")
        button(normal_popup, 'options').click()
        expect(dialog.get_by_text(option['name'], exact=True)).to_be_visible()
        button(dialog, 'stores').first.click()
        expect(dialog.get_by_text('가장 가까운 테스트점', exact=True)).to_be_visible()
        state['paid'] = False
        page.evaluate('PriceAlerts.refreshEntitlement({silent:true})')
        expect(dialog.locator('.hidden-stock-stores')).to_have_count(0)
        expect(dialog.get_by_text(option['name'], exact=True)).to_be_visible()
        verify_image(dialog.locator('.hidden-stock-image img').first)
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        normal_popup.locator('[data-action="closePopup"]').filter(has_text='✕').click()
        storage = page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)')
        assert option['productId'] not in storage and '전국 최대 재고 테스트점' not in storage
        assert not errors, errors
        print(json.dumps({'width': width, 'result': 'PASS', 'hiddenCalls': state['hidden_calls'],
                          'publicCalls': state['public_calls'],
                          'nearbyCalls': state['nearby_calls'], 'nationalCalls': state['national_calls'],
                          'decodedImages': state['images'], 'pageErrors': errors}))
        context.close()
    browser.close()
