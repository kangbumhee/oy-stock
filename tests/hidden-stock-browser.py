"""Local, mocked browser acceptance. No production accounts or payments are used."""
import json
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = 'http://127.0.0.1:8873'
OUT = Path(__file__).resolve().parents[1] / '.ai' / 'logs' / 'hidden-stock-browser'
OUT.mkdir(parents=True, exist_ok=True)
option = dict(goodsNo='A000000255680', optionNumber='001', productId='8800289469145',
              goodsName='브라우저 테스트용 미스트', name='한교동 숨김 옵션 테스트', hidden=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width in [390, 1440]:
        state = {'paid': False, 'deny': False, 'hidden_calls': 0, 'store_calls': 0}
        context = browser.new_context(viewport={'width': width, 'height': 900}, service_workers='block')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def intercept(route):
            url = urlsplit(route.request.url)
            path, query = url.path, parse_qs(url.query)
            if url.hostname not in ['127.0.0.1', 'localhost']:
                return route.fulfill(status=200, content_type='application/javascript', body='')
            if path.startswith('/data/'):
                return route.fulfill(json={'products': {}, 'links': {}, 'summary': {'total': 0}})
            if path == '/api/price-alerts/entitlement':
                return route.fulfill(json={'success': True, 'enabled': True, 'paymentAvailable': True,
                    'promotionAvailable': True, 'entitlement': {'active': state['paid'], 'lifetime': state['paid'], 'expiresAt': None}})
            if path == '/api/oliveyoung/hidden-stock':
                state['hidden_calls'] += 1
                if state['deny']:
                    return route.fulfill(status=402, json={'success': False, 'error': 'entitlement_required'})
                assert state['paid'], 'free browser must not request premium data'
                assert 'cursor' not in query or query['cursor'][0], 'empty cursor breaks gateway'
                action = query['action'][0]
                if action in ['search', 'options']:
                    if action == 'options':
                        assert 'cursor' not in query
                    return route.fulfill(json={'success': True, 'options': [option], 'nextCursor': None,
                        'coverage': {'complete': False, 'reason': 'indexed_public_options'}})
                state['store_calls'] += 1
                has_cursor = 'cursor' in query
                stores = ([{'code': 's1', 'name': '테스트 서울점', 'region': '서울', 'addr': '테스트 주소', 'qty': 6},
                           {'code': 's2', 'name': '수량 미확인 테스트점', 'region': '서울', 'qty': None}]
                          if not has_cursor else
                          [{'code': 's1', 'name': '테스트 서울점', 'region': '서울', 'qty': 6},
                           {'code': 's3', 'name': '테스트 제주점', 'region': '제주', 'qty': 0}])
                return route.fulfill(json={'success': True, 'stores': stores, 'option': option,
                    'nextCursor': None if has_cursor else 'fixture-next', 'coverage': {'complete': has_cursor}})
            if path.startswith('/api/'):
                return route.fulfill(json={'success': True, 'alerts': [], 'products': [],
                    'data': {'inventory': {'totalCount': 0, 'products': []}, 'products': []}, 'summary': {}})
            return route.continue_()

        page.route('**/*', intercept)
        page.goto(ROOT, wait_until='networkidle')
        # Discover the actual rendered controls before interacting.
        assert page.locator('#search-form').count() == 1
        page.locator('#search-input').fill('한교동')
        page.locator('#search-form button[type=submit]').click()
        premium = page.locator('#hidden-stock-search')
        expect(premium).to_be_visible()
        expect(premium.get_by_role('button', name='이용권 확인 / 프로모션 입력')).to_be_visible()
        assert state['hidden_calls'] == 0
        assert option['name'] not in page.content()
        premium.scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f'free-{width}.png'))
        premium.get_by_role('button', name='이용권 확인 / 프로모션 입력').click()
        expect(page.locator('#price-alert-modal')).to_be_visible()
        expect(page.locator('#price-alert-title')).to_have_text('숨겨진 옵션 · 가격 알림 이용권')
        expect(page.locator('#price-alert-target-input')).to_be_disabled()
        page.screenshot(path=str(OUT / f'access-{width}.png'))
        # Local API fixture simulates an existing lifetime entitlement; no payment.
        state['paid'] = True
        page.evaluate('PriceAlerts.refreshEntitlement({silent:true})')
        expect(premium.get_by_text(option['name'], exact=True)).to_be_visible()
        expect(page.locator('#price-alert-modal')).not_to_be_visible()
        premium.get_by_role('button', name='이 옵션 전국 매장 재고 확인').click()
        dialog = page.locator('#hidden-stock-panel')
        expect(dialog.get_by_text('테스트 서울점', exact=True)).to_be_visible()
        expect(dialog.get_by_text('수량 확인 불가', exact=True)).to_be_visible()
        dialog.get_by_role('button', name='남은 전국 범위 연속 조회').click()
        expect(dialog.get_by_text('테스트 제주점', exact=True)).to_be_visible()
        assert dialog.get_by_text('테스트 서울점', exact=True).count() == 1
        expect(dialog.get_by_text('조회 시점 재고 0개', exact=True)).to_be_visible()
        page.screenshot(path=str(OUT / f'stores-{width}.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
        assert page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)').find(option['productId']) == -1
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        # API revocation wins over a stale client entitlement and clears all content.
        state['deny'] = True
        premium.get_by_role('button', name='이 옵션 전국 매장 재고 확인').click()
        expect(page.locator('#hidden-stock-panel')).to_have_count(0)
        expect(premium.get_by_text(option['name'], exact=True)).to_have_count(0)
        assert not errors, errors
        print(json.dumps({'width': width, 'result': 'PASS', 'hiddenCalls': state['hidden_calls'],
                          'storeCalls': state['store_calls'], 'pageErrors': errors}))
        context.close()
    browser.close()
