"""Local, mocked browser acceptance. No production accounts or payments are used."""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = 'http://127.0.0.1:8873'
PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / '.ai' / 'logs' / 'hidden-stock-browser'
OUT.mkdir(parents=True, exist_ok=True)
IMAGE = 'https://image.oliveyoung.co.kr/browser-fixture/product.png'
BROKEN_IMAGE = 'https://image.oliveyoung.co.kr/browser-fixture/missing.png'
IMAGE_BYTES = (PROJECT / 'public' / 'images' / 'blog' / 'oliveyoung-hot-item-stock-a000000255680-source.jpg').read_bytes()
option = dict(goodsNo='A000000255680', optionNumber='001', productId='8800289469145',
              goodsName='[청담샵화잘먹] 메디큐브 PDRN 핑크 콜라겐 글로우 젤리 미스트 100ml 더블기획 (+미스트 공병키링)',
              name='[한교동 콜라보] 본품2EA+공병키링', hidden=True,
              image=IMAGE)
options = [option,
           dict(option, goodsNo='A000000255681', optionNumber='002', productId='8800289469146', name='이미지 누락 옵션', image=''),
           dict(option, goodsNo='A000000255682', optionNumber='003', productId='8800289469147', name='이미지 오류 옵션', image=BROKEN_IMAGE)]
NEARBY_STORES = [
    {'code': 's2', 'name': '수량 미확인 테스트점', 'region': '경기', 'addr': '테스트 주소', 'qty': None, 'dist': 3.2},
    {'code': 's1', 'name': '가장 가까운 테스트점', 'region': '경기', 'addr': '테스트 주소', 'qty': 6, 'dist': 0.37},
    {'code': 's3', 'name': '중간 거리 테스트점', 'region': '경기', 'addr': '테스트 주소', 'qty': 0, 'dist': 1.4}]
NEARBY_STORES.extend({'code': f'near-{i}', 'name': f'추가 근처 테스트점 {i}', 'region': '경기',
                     'addr': '테스트 주소', 'qty': 1, 'dist': float(i)} for i in range(4, 26))


def button(root, action):
    prefix = '.hidden-stock-preview' if action == 'stores' else ''
    return root.locator(prefix + '[data-hidden-action="' + action + '"]')


def verify_image(locator):
    expect(locator).to_be_visible()
    locator.page.wait_for_function('(img) => img.complete && img.naturalWidth > 0', arg=locator.element_handle())
    assert locator.evaluate('(img) => img.naturalWidth === 550 && img.naturalHeight === 550'), 'fixture must decode the existing product photograph'


def verify_image_grid(root):
    cards = root.locator('.hidden-stock-option')
    expect(cards).to_have_count(3)
    expect(root.locator('.hidden-stock-options.grid')).to_have_count(1)
    expect(cards.locator('.card-body')).to_have_count(3)
    expect(cards.locator('.card-name')).to_have_text([entry['goodsName'] for entry in options])
    expect(cards.locator('.hidden-stock-card-option')).to_have_text([entry['name'] for entry in options])
    expect(cards.first.locator('.hidden-stock-card-price .price')).to_have_text('23,800원')
    expect(cards.first.locator('.hidden-stock-price-note')).to_have_text('온라인 상품 참고가')
    expect(cards.nth(1).locator('.hidden-stock-card-price')).to_have_text('매장 가격 확인 필요')
    expect(cards.nth(2).locator('.hidden-stock-card-price .price')).to_have_text('17,900원')
    expect(cards.nth(2).locator('.hidden-stock-price-note')).to_have_text('최근 수집 참고가')
    expect(cards.first.locator('.card-name')).to_be_visible()
    expect(cards.first.locator('.hidden-stock-card-option')).to_be_visible()
    expect(cards.first.locator('.hidden-stock-image span')).not_to_be_visible()
    image_button = button(root, 'stores').first
    expect(image_button).to_have_attribute('aria-label', re.compile(re.escape(option['name'])))
    expect(image_button).to_have_attribute('aria-haspopup', 'dialog')
    verify_image(cards.first.locator('img'))
    box = image_button.bounding_box()
    assert box and box['width'] >= 140 and abs(box['width'] - box['height']) < 2, box
    assert image_button.evaluate('(el) => getComputedStyle(el).paddingTop === "0px"'), 'image card must not retain text-button padding'
    body = cards.first.locator('.card-body').bounding_box()
    assert body and body['y'] >= box['y'] + box['height'] - 1, 'product name and price must appear below the photograph'
    expect(root.locator('.hidden-stock-image span:visible')).to_have_count(2)
    assert root.page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'free image grid horizontal overflow'
    return box


def verify_exact_price_refresh(page, root, keep_dialog=False):
    before = page.evaluate('''(fixture) => {
        const focused = document.activeElement;
        const image = document.querySelector('#hidden-stock-search .hidden-stock-preview');
        const dialog = document.querySelector('#hidden-stock-panel');
        App.detailData.products[fixture.goodsNo] = {goodsNo: fixture.goodsNo, options: [{
            productId: fixture.productId, optionNumber: fixture.optionNumber, priceToPay: 21900
        }]};
        UI.updateCardBadge(fixture.goodsNo, App.detailData.products[fixture.goodsNo]);
        return {sameFocus: document.activeElement === focused,
            sameImage: document.querySelector('#hidden-stock-search .hidden-stock-preview') === image,
            hadDialog: !!dialog, sameDialog: document.querySelector('#hidden-stock-panel') === dialog};
    }''', option)
    expect(root.locator('.hidden-stock-option').first.locator('.price')).to_have_text('21,900원')
    expect(root.locator('.hidden-stock-option').first.locator('.hidden-stock-price-note')).to_have_text('온라인 옵션 참고가')
    assert before['sameFocus'] and before['sameImage'], before
    if keep_dialog:
        assert before['hadDialog'] and before['sameDialog'], before
        expect(page.locator('#hidden-stock-panel .hidden-stock-stores strong')).to_have_count(10)
    page.evaluate('''(goodsNo) => {
        delete App.detailData.products[goodsNo];
        UI.updateCardBadge(goodsNo, null);
    }''', option['goodsNo'])
    expect(root.locator('.hidden-stock-option').first.locator('.price')).to_have_text('23,800원')
    expect(root.locator('.hidden-stock-option').first.locator('.hidden-stock-price-note')).to_have_text('온라인 상품 참고가')


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
                return route.fulfill(status=200, content_type='image/jpeg', body=IMAGE_BYTES)
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
        expect(button(premium, 'stores')).to_have_count(3)
        page.wait_for_load_state('networkidle')
        # Normal search and cached product prices are independent public data, not invented hidden-option prices.
        page.evaluate('''(fixture) => {
            App.products = [{goodsNo: fixture.goodsNo, goodsNumber: fixture.goodsNo, goodsName: fixture.goodsName,
                imageUrl: fixture.image, priceToPay: 23800}];
            App.detailData = {products: {'A000000255682': {price: 17900, options: []}}};
            HiddenStock.refreshCardPrices();
        }''', option)
        expect(premium.locator('#hidden-stock-search-title')).to_have_text('온라인에 없는 매장 상품')
        expect(premium.locator('.hidden-stock-reference-note')).to_have_text('표시 가격은 참고가이며, 실제 옵션·매장 가격과 다를 수 있습니다.')
        expect(premium.get_by_text('온라인몰 미노출·과거 판매 옵션을 모았습니다. 현재 매장 재고 조회는 유료 이용자 전용입니다.', exact=True)).to_be_visible()
        # Compare the new image cards against the existing product renderer at the same viewport.
        ordinary_fixture = page.evaluate('''(image) => {
            UI.renderProducts(Array.from({length: 6}, (_, i) => ({
                goodsNo: 'A00000025568' + i, goodsName: '일반 상품 크기 비교용', imageUrl: image, priceToPay: 27900
            })), {products: {}});
            const card = document.querySelector('#product-list .card-img').getBoundingClientRect();
            const grid = getComputedStyle(document.querySelector('#product-list .grid'));
            const name = getComputedStyle(document.querySelector('#product-list .card-name'));
            const price = getComputedStyle(document.querySelector('#product-list .price'));
            return {box: {width: card.width, height: card.height}, gap: grid.gap, columns: grid.gridTemplateColumns.split(' ').length,
                nameSize: name.fontSize, priceSize: price.fontSize, nameClamp: name.webkitLineClamp};
        }''', IMAGE)
        ordinary = ordinary_fixture['box']
        assert ordinary and ordinary['width'] > 140
        grid_style = ordinary_fixture
        # Normal product content is removed only from this controlled local fixture so free-grid screenshots stay focused.
        page.evaluate('document.querySelector("#product-list").innerHTML = ""')
        hidden_box = verify_image_grid(premium)
        hidden_grid = premium.locator('.hidden-stock-options').evaluate('(el) => ({gap:getComputedStyle(el).gap,columns:getComputedStyle(el).gridTemplateColumns.split(" ").length})')
        assert hidden_grid['gap'] == grid_style['gap'], (hidden_grid, grid_style)
        assert hidden_grid['columns'] == grid_style['columns'], (hidden_grid, grid_style)
        assert abs(hidden_box['width'] - ordinary['width']) < 2, (hidden_box, ordinary)
        name_style = premium.locator('.card-name').first.evaluate('(element) => ({size: getComputedStyle(element).fontSize, clamp: getComputedStyle(element).webkitLineClamp})')
        price_size = premium.locator('.card-price .price').first.evaluate('(element) => getComputedStyle(element).fontSize')
        assert name_style == {'size': ordinary_fixture['nameSize'], 'clamp': ordinary_fixture['nameClamp']}, (name_style, ordinary_fixture)
        assert price_size == ordinary_fixture['priceSize'], (price_size, ordinary_fixture)
        assert state['public_calls'] > 0 and not state['store_requests']
        premium.scroll_into_view_if_needed()
        premium.evaluate('(element) => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - 200)')
        page.screenshot(path=str(OUT / f'free-product-cards-{width}.png'))
        premium.locator('.hidden-stock-image img').first.click()
        expect(page.locator('#price-alert-modal')).to_be_visible()
        expect(page.locator('#price-alert-title')).to_have_text('유료 이용자만 사용 가능합니다')
        expect(page.locator('#price-alert-target-input')).to_be_disabled()
        assert not state['store_requests'], 'opening the payment dialog must not request inventory'
        page.screenshot(path=str(OUT / f'access-{width}.png'))
        page.locator('#price-alert-modal .price-alert-close').click()
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        verify_image_grid(premium)

        # Clicking the conventional product-name button uses the same access boundary as the photograph.
        premium.locator('.card-name').first.click()
        expect(page.locator('#price-alert-modal')).to_be_visible()
        expect(page.locator('#price-alert-title')).to_have_text('유료 이용자만 사용 가능합니다')
        assert not state['store_requests']
        page.keyboard.press('Escape')
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        expect(premium.locator('.card-name').first).to_be_focused()

        # Keyboard users enter the same paid-only dialog, stay within it, and return to the exact image.
        image_control = button(premium, 'stores').nth(1)
        image_control.focus()
        page.keyboard.press('Enter')
        access = page.locator('#price-alert-modal')
        expect(access).to_be_visible()
        close_access = access.locator('.price-alert-close')
        expect(close_access).to_be_focused()
        page.wait_for_function('PriceAlerts.entitlementLoading === false')
        access_controls = access.locator('button:visible:enabled, input:visible:enabled, select:visible:enabled, textarea:visible:enabled, a[href]:visible, [tabindex="0"]:visible')
        assert access_controls.count() >= 4, 'paywall must expose its close, form, and help controls'
        access_controls.last.focus()
        page.keyboard.press('Tab')
        expect(access_controls.first).to_be_focused()
        page.keyboard.press('Shift+Tab')
        expect(access_controls.last).to_be_focused()
        page.evaluate('PriceAlerts.loading = true')
        page.keyboard.press('Escape')
        expect(access).to_be_visible()
        page.evaluate('PriceAlerts.loading = false')
        page.keyboard.press('Escape')
        expect(access).not_to_be_visible()
        expect(image_control).to_be_focused()
        verify_image_grid(premium)
        assert not state['store_requests'], 'keyboard preview access must not fetch inventory'
        verify_exact_price_refresh(page, premium)
        expect(image_control).to_be_focused()
        assert not state['store_requests'], 'public price updates must not fetch paid inventory'

        # Product-level option details also remain public, including when a payment is cancelled.
        page.evaluate("UI.showDetailPopup({goodsName:'기존 일반 재고 팝업 테스트',thumbnail:'',price:10000,options:[],source:'vendor-delivery'},'A000000255680')")
        normal_popup = page.locator('#popup-root')
        button(normal_popup, 'options').click()
        dialog = page.locator('#hidden-stock-panel')
        verify_image_grid(dialog)
        assert not state['store_requests']
        page.screenshot(path=str(OUT / f'free-product-options-{width}.png'))
        nested_image_control = button(dialog, 'stores').nth(1)
        nested_image_control.focus()
        page.keyboard.press('Enter')
        expect(page.locator('#price-alert-modal')).to_be_visible()
        assert not state['store_requests']
        expect(page.locator('#price-alert-modal .price-alert-close')).to_be_focused()
        page.keyboard.press('Escape')
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        expect(nested_image_control).to_be_focused()
        verify_image_grid(dialog)
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
        verify_image_grid(premium)
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        assert state['national_calls'] == 0
        page.screenshot(path=str(OUT / f'options-{width}.png'))
        expect(dialog.get_by_text('가장 가까운 테스트점', exact=True)).to_be_visible()
        expect(dialog.get_by_text('수량 확인 불가', exact=True)).to_be_visible()
        expect(dialog.get_by_text('조회 시점 재고 0개', exact=True)).to_be_visible()
        expect(dialog.get_by_text('테스트 김포 사우', exact=False)).to_be_visible()
        expect(dialog.locator('.hidden-stock-stores strong')).to_have_count(10)
        expect(dialog.locator('.hidden-stock-stores li:nth-child(-n+3) strong')).to_have_text([
            '가장 가까운 테스트점', '중간 거리 테스트점', '수량 미확인 테스트점'])
        verify_exact_price_refresh(page, premium, keep_dialog=True)
        verify_image(dialog.locator('.hidden-stock-image img').first)
        expect(dialog.get_by_text(option['goodsName'], exact=True)).to_be_visible()
        expect(dialog.get_by_text(option['name'], exact=True)).to_be_visible()
        expect(dialog.locator('[role="dialog"]')).to_have_attribute('aria-modal', 'true')
        popup_image = dialog.locator('.hidden-stock-selected img').first.bounding_box()
        assert popup_image and popup_image['width'] >= 100 and popup_image['height'] >= 100, popup_image
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'paid inventory popup horizontal overflow'
        assert state['nearby_calls'] == 1 and state['national_calls'] == 0
        expect(button(dialog, 'national-stores')).to_have_text('전국 재고 조회')
        assert button(dialog, 'national-stores').evaluate('(button) => button.compareDocumentPosition(document.querySelector("#hidden-stock-panel .hidden-stock-stores")) & Node.DOCUMENT_POSITION_PRECEDING')
        dialog.locator('.hidden-stock-dialog').evaluate('(element) => { element.scrollTop = 0; }')
        page.screenshot(path=str(OUT / f'paid-popup-{width}.png'))
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
        verify_image_grid(dialog)
        button(dialog, 'stores').first.click()
        expect(dialog.get_by_text('가장 가까운 테스트점', exact=True)).to_be_visible()
        button(dialog, 'back-options').click()
        verify_image_grid(dialog)
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(normal_popup.get_by_text('기존 일반 재고 팝업 테스트', exact=True)).to_be_visible()
        expect(button(normal_popup, 'options')).to_be_focused()
        normal_popup.locator('[data-action="closePopup"]').filter(has_text='✕').click()

        # API revocation removes private inventory without erasing public photos and descriptions.
        state['deny'] = True
        button(premium, 'stores').first.click()
        expect(page.locator('#hidden-stock-panel')).to_have_count(0)
        verify_image_grid(premium)
        expect(page.locator('.hidden-stock-stores')).to_have_count(0)

        # Expiration of an already-open nested inventory restores only its public option list.
        state['deny'] = False
        state['paid'] = True
        page.evaluate('PriceAlerts.refreshEntitlement({silent:true})')
        page.evaluate("UI.showDetailPopup({goodsName:'기존 일반 재고 팝업 테스트',thumbnail:'',price:10000,options:[],source:'vendor-delivery'},'A000000255680')")
        button(normal_popup, 'options').click()
        verify_image_grid(dialog)
        button(dialog, 'stores').first.click()
        expect(dialog.get_by_text('가장 가까운 테스트점', exact=True)).to_be_visible()
        state['paid'] = False
        page.evaluate('PriceAlerts.refreshEntitlement({silent:true})')
        expect(dialog.locator('.hidden-stock-stores')).to_have_count(0)
        verify_image_grid(dialog)
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        normal_popup.locator('[data-action="closePopup"]').filter(has_text='✕').click()
        storage = page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)')
        assert option['productId'] not in storage and '전국 최대 재고 테스트점' not in storage
        assert not errors, errors
        print(json.dumps({'width': width, 'result': 'PASS', 'hiddenCalls': state['hidden_calls'],
                          'publicCalls': state['public_calls'],
                          'nearbyCalls': state['nearby_calls'], 'nationalCalls': state['national_calls'],
                          'decodedImages': state['images'], 'ordinaryImageWidth': ordinary['width'],
                          'hiddenImageWidth': hidden_box['width'], 'popupImageWidth': popup_image['width'],
                          'pageErrors': errors}))
        context.close()
    browser.close()
