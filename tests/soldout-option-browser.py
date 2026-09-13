"""Local mocked paid offline lookup for a selected online-sold-out SKU.

No login, payment or live stock requests. Stock quantities are fixtures; the repo
photograph is an unrelated local stand-in, not an image of the pictured lip item.
Start: python -m http.server 8875 --bind 127.0.0.1 --directory public
Run in another terminal: python tests/soldout-option-browser.py
"""
import copy
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / '.ai/logs/soldout-option-browser'
OUT.mkdir(parents=True, exist_ok=True)
ROOT = 'http://127.0.0.1:8875'
IMAGE = 'https://image.oliveyoung.co.kr/local-test/soldout-stand-in.jpg'
IMAGE_BYTES = (PROJECT / 'public/images/blog/oliveyoung-hot-item-stock-a000000255680-source.jpg').read_bytes()
GOODS = 'A000000227778'
SKU = '8809923821608'
NAME = '[최초기획/미니립증정] 투슬래시포 스컬프트 립 쉐이퍼 (기획/단품)'
SOLDOUT = dict(productId=SKU, optionNumber='008', name='[립칠러 미니 증정] 인 살몬',
               image=IMAGE, onlineQty=0, stores=[], totalStores=0, inStock=0,
               totalQty=0, storeLookupStatus='not_requested')
DETAIL = dict(success=True, goodsNo=GOODS, goodsName=NAME, thumbnail=IMAGE,
              source='live-online', inventoryScope='online', storeLookupStatus='pending',
              price=18700, originalPrice=22000, discountRate=15,
              updatedAt='2026-09-13T10:00:00Z', options=[
                  dict(SOLDOUT, productId='8809923821615', optionNumber='001', name='인 로즈', onlineQty=25),
                  SOLDOUT])
NEARBY = [dict(code='test-far', name='모의 인살몬 먼 매장', qty=2, dist=1.4, region='경기', addr='모의 주소'),
          dict(code='test-near', name='모의 인살몬 가까운 매장', qty=4, dist=0.37, region='경기', addr='모의 주소')]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width in [390, 1440]:
        state = {'paid': False, 'storeRequests': [], 'optionsRequests': 0}
        errors = []
        context = browser.new_context(viewport={'width': width, 'height': 960}, service_workers='block')
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))

        def intercept(route):
            url = urlsplit(route.request.url)
            path, query = url.path, parse_qs(url.query)
            if route.request.url == IMAGE:
                return route.fulfill(content_type='image/jpeg', body=IMAGE_BYTES)
            if url.hostname not in ['127.0.0.1', 'localhost']:
                return route.fulfill(content_type='application/javascript', body='')
            if path.startswith('/data/'):
                return route.fulfill(json={'products': {}, 'links': {}, 'summary': {'total': 0}})
            if path == '/api/price-alerts/entitlement':
                return route.fulfill(json={'success': True, 'enabled': True, 'paymentAvailable': True,
                    'promotionAvailable': True, 'entitlement': {'active': state['paid'], 'lifetime': state['paid'], 'expiresAt': None}})
            if path == '/api/oliveyoung/hidden-stock':
                if query.get('action') == ['options']:
                    state['optionsRequests'] += 1
                    return route.fulfill(json={'success': True, 'options': [], 'nextCursor': None,
                                              'coverage': {'complete': False, 'reason': 'fixture'}})
                assert query.get('action') == ['stores'], query
                assert state['paid'], 'A free browser must never send the protected inventory request'
                assert query['goodsNo'] == [GOODS] and query['productId'] == [SKU], query
                assert query['lat'] == ['37.6152'] and query['lng'] == ['126.7156'], query
                state['storeRequests'].append(query)
                scope = query['scope'][0]
                assert scope in ['nearby', 'national'], query
                stores = copy.deepcopy(NEARBY)
                if scope == 'national':
                    stores.append(dict(code='test-national', name='모의 인살몬 전국 많은 매장', qty=16,
                                       dist=19, region='서울', addr='모의 주소'))
                return route.fulfill(json={'success': True, 'stores': stores, 'nextCursor': None,
                    'scope': scope, 'coverage': {'complete': True, 'scope': scope}})
            if path.startswith('/api/'):
                return route.fulfill(json={'success': True, 'products': [], 'alerts': [], 'data': {}, 'summary': {}})
            return route.continue_()

        page.route('**/*', intercept)
        page.goto(ROOT, wait_until='networkidle')
        page.evaluate('''(detail) => {
            App.lat=37.6152; App.lng=126.7156; App.locationName='테스트 김포 사우';
            UI.showDetailPopup(detail, detail.goodsNo);
        }''', DETAIL)
        popup = page.locator('#popup-root')
        active = popup.locator('.opt-panel.active')
        expect(active.locator('[data-hidden-action="normal-stores"]')).to_have_attribute('data-scope', 'national')
        expect(active.locator('[data-hidden-action="normal-stores"]')).to_have_text('전국 매장 전체 이어서 조회 · 이용권')
        popup.locator('.opt-tab[data-idx="1"]').click()
        expect(active.locator('.opt-name')).to_have_text(SOLDOUT['name'])
        expect(active.locator('.opt-stock')).to_contain_text('온라인 품절')
        cta = active.locator('[data-hidden-action="normal-stores"]')
        expect(cta).to_have_attribute('data-scope', 'nearby')
        expect(cta).to_have_attribute('data-productid', SKU)
        expect(cta).to_have_text('온라인 품절 옵션 · 근처 매장 재고 확인 · 이용권')
        expect(active).to_contain_text('온라인 품절과 매장 재고는 별개입니다')
        assert cta.evaluate('(button) => !!(button.compareDocumentPosition(button.closest(".opt-panel").querySelector(".no-store")) & Node.DOCUMENT_POSITION_FOLLOWING)'), 'Sold-out paid CTA must be before ordinary store rows/pending state'
        assert not state['storeRequests'] and state['optionsRequests'] == 0
        page.locator('.popup-content').evaluate('(element) => {element.scrollTop = 0}')
        page.locator('.popup-content').screenshot(path=str(OUT / f'soldout-cta-{width}.png'))

        cta.click()
        access = page.locator('#price-alert-modal')
        expect(access).to_be_visible()
        expect(page.locator('#price-alert-title')).to_have_text('유료 이용자만 사용 가능합니다')
        page.wait_for_function('PriceAlerts.entitlementLoading === false')
        assert not state['storeRequests'], 'Paywall display must not fetch premium inventory'
        page.screenshot(path=str(OUT / f'soldout-access-{width}.png'))
        page.keyboard.press('Escape')
        expect(access).not_to_be_visible()
        expect(cta).to_be_focused()
        expect(active.locator('.opt-name')).to_have_text(SOLDOUT['name'])
        assert not state['storeRequests']

        # A mocked entitlement grant must resume this exact SKU in nearby, not nationwide scope.
        cta.click()
        expect(access).to_be_visible()
        page.wait_for_function('PriceAlerts.entitlementLoading === false')
        state['paid'] = True
        page.evaluate('PriceAlerts.refreshEntitlement({silent:true})')
        expect(access).not_to_be_visible()
        dialog = page.locator('#hidden-stock-panel')
        expect(dialog.locator('#hidden-stock-panel-title')).to_have_text('근처 매장 재고')
        expect(dialog.locator('.hidden-stock-selected h4')).to_have_text(SOLDOUT['name'])
        expect(dialog.locator('.hidden-stock-stores strong')).to_have_text(
            ['모의 인살몬 가까운 매장', '모의 인살몬 먼 매장'])
        assert len(state['storeRequests']) == 1 and state['storeRequests'][0]['scope'] == ['nearby']
        footer = dialog.locator('.hidden-stock-national-footer [data-hidden-action="national-stores"]')
        expect(footer).to_have_text('전국 재고 조회')
        assert footer.evaluate('(button) => !!(button.compareDocumentPosition(document.querySelector("#hidden-stock-panel .hidden-stock-stores")) & Node.DOCUMENT_POSITION_PRECEDING)')
        assert state['optionsRequests'] == 0, 'SKU lookup must not depend on hidden-option discovery results'
        page.screenshot(path=str(OUT / f'soldout-paid-nearby-{width}.png'))

        footer.click()
        expect(dialog.locator('#hidden-stock-panel-title')).to_have_text('전국 매장 재고')
        expect(dialog.locator('.hidden-stock-stores strong').first).to_have_text('모의 인살몬 전국 많은 매장')
        assert len(state['storeRequests']) == 2 and state['storeRequests'][-1]['scope'] == ['national']
        assert all(request['productId'] == [SKU] for request in state['storeRequests'])
        page.screenshot(path=str(OUT / f'soldout-paid-national-{width}.png'))
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(cta).to_be_focused()
        expect(active.locator('.opt-name')).to_have_text(SOLDOUT['name'])
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
        assert not errors, errors
        print(json.dumps({'width': width, 'result': 'PASS', 'protectedRequests': len(state['storeRequests']),
                          'nearbyScope': state['storeRequests'][0]['scope'], 'selectedSku': SKU,
                          'pageErrors': errors, 'liveRequests': 0}))
        context.close()
    browser.close()
