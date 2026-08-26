import atexit
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:4191"
GOODS_NO = "A000000154189"
PAYMENT_ID = "oypa_" + "p" * 24
RETURN_PAYMENT_ID = "oypa_" + "r" * 24


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        public_dir = Path(__file__).resolve().parents[1] / "public"
        super().__init__(*args, directory=str(public_dir), **kwargs)

    def log_message(self, _format, *_args):
        pass


def start_static_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietStaticHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def close_server():
        server.shutdown()
        server.server_close()

    atexit.register(close_server)
    return server, close_server


def inactive_entitlement():
    return {
        "active": False,
        "lifetime": False,
        "expiresAt": None,
        "plan": {"amount": 30000, "currency": "KRW", "durationDays": 30, "autoRenew": False},
    }


def paid_entitlement(lifetime=False):
    return {
        "active": True,
        "lifetime": lifetime,
        "expiresAt": None if lifetime else "2026-09-25T12:00:00.000Z",
        "plan": {"amount": 30000, "currency": "KRW", "durationDays": 30, "autoRenew": False},
    }


def payment_contract(payment_id, mismatch=False):
    return {
        "success": True,
        "paymentId": payment_id,
        "idempotent": False,
        "expiresAt": "2026-08-26T13:00:00.000Z",
        "requestPayment": {
            "storeId": "store-olivestock-test",
            "channelKey": "channel-key-kakaopay-test",
            "paymentId": payment_id,
            "orderName": "올리브재고 가격 알림 30일 이용권",
            "totalAmount": 29999 if mismatch else 30000,
            "currency": "KRW",
            "payMethod": "EASY_PAY",
            "easyPay": {"easyPayProvider": "KAKAOPAY"},
            "redirectUrl": BASE_URL + "/?priceAlertPayment=complete",
            "noticeUrls": [BASE_URL + "/api/price-alerts/payment-webhook"],
            "products": [{"id": "price_alert_30d", "name": "올리브재고 가격 알림 30일 이용권", "amount": 30000, "quantity": 1}],
        },
        "plan": {"amount": 30000, "currency": "KRW", "durationDays": 30, "autoRenew": False},
    }


def main():
    global BASE_URL
    static_server, close_static_server = start_static_server()
    BASE_URL = f"http://127.0.0.1:{static_server.server_port}"
    calls = []
    alert_bodies = []
    stored_alerts = []
    console_errors = []
    page_errors = []
    sdk_network_calls = []
    unexpected_external_calls = []
    screenshot = Path(tempfile.gettempdir()) / "olivestock-price-alert-mobile.png"
    state = {}

    def reset_state(**updates):
        state.clear()
        state.update({
            "entitlement": inactive_entitlement(),
            "payment_available": True,
            "promotion_available": True,
            "create_mode": "valid",
            "complete_status": "paid",
            "complete_statuses": [],
            "create_count": 0,
            "complete_count": 0,
            "promotion_count": 0,
            "payment_id": PAYMENT_ID,
            "idempotency_keys": [],
        })
        state.update(updates)

    def json_response(route, payload, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(payload, ensure_ascii=False))

    def handle_route(route):
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        if parsed.netloc == "www.googletagmanager.com":
            route.fulfill(
                status=200,
                content_type="text/javascript",
                body="window.__analyticsObservedLocation = window.location.href;",
            )
            return
        if parsed.netloc == urlparse(BASE_URL).netloc and path == "/":
            index_html = (Path(__file__).resolve().parents[1] / "public" / "index.html").read_text(
                encoding="utf-8"
            )
            # html2canvas is unrelated to these alert scenarios. Remove SRI only
            # from the test document so the empty, fully intercepted CDN stub is accepted.
            index_html = index_html.replace(
                ' integrity="sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H"',
                "",
            )
            route.fulfill(status=200, content_type="text/html", body=index_html)
            return
        if request.url.startswith("https://cdn.portone.io/"):
            sdk_network_calls.append(request.url)
            route.abort()
            return
        if path == "/api/price-alerts/entitlement":
            calls.append((request.method, path))
            json_response(route, {
                "success": True,
                "enabled": True,
                "paymentAvailable": state["payment_available"],
                "promotionAvailable": state["promotion_available"],
                "entitlement": state["entitlement"],
            })
            return
        if path == "/api/price-alerts/promotion":
            calls.append((request.method, path))
            state["promotion_count"] += 1
            state["entitlement"] = paid_entitlement(lifetime=True)
            json_response(route, {"success": True, "idempotent": False, "entitlement": state["entitlement"]})
            return
        if path == "/api/price-alerts/payment/create":
            calls.append((request.method, path))
            body = request.post_data_json or {}
            assert list(body.keys()) == ["idempotencyKey"]
            assert len(body["idempotencyKey"]) >= 20
            state["idempotency_keys"].append(body["idempotencyKey"])
            state["create_count"] += 1
            json_response(route, payment_contract(state["payment_id"], mismatch=state["create_mode"] == "mismatch"))
            return
        if path == "/api/price-alerts/payment/complete":
            calls.append((request.method, path))
            body = request.post_data_json or {}
            assert list(body.keys()) == ["paymentId"]
            state["complete_count"] += 1
            status = (
                state["complete_statuses"].pop(0)
                if state["complete_statuses"]
                else state["complete_status"]
            )
            if status == "paid":
                state["entitlement"] = paid_entitlement()
            json_response(route, {
                "success": True,
                "unknown": False,
                "paymentId": body.get("paymentId"),
                "status": status,
                "idempotent": False,
                "entitlement": state["entitlement"],
            })
            return
        if path == "/api/price-alerts/alerts":
            calls.append((request.method, path))
            if request.method == "GET":
                payload = {"success": True, "alerts": stored_alerts, "subscribed": bool(stored_alerts)}
            elif request.method == "POST":
                body = request.post_data_json or {}
                alert_bodies.append(body)
                option_number = body.get("optionNumber") or None
                alert_id = body.get("goodsNo") + ("::" + option_number if option_number else "")
                saved = {
                    "id": alert_id,
                    "alertId": alert_id,
                    "goodsNo": body.get("goodsNo"),
                    "goodsName": body.get("goodsName"),
                    "imageUrl": body.get("imageUrl", ""),
                    "optionNumber": option_number,
                    "optionName": body.get("optionName", ""),
                    "legacyItemNumber": body.get("legacyItemNumber"),
                    "targetPrice": body.get("targetPrice"),
                    "lastEvaluatedPrice": None,
                    "lastCheckedAt": None,
                    "enabled": True,
                }
                stored_alerts[:] = [item for item in stored_alerts if item.get("alertId") != alert_id]
                stored_alerts.append(saved)
                payload = {"success": True, "alert": saved}
            else:
                params = parse_qs(parsed.query)
                option_number = (params.get("optionNumber") or [""])[0]
                goods_no = (params.get("goodsNo") or [GOODS_NO])[0]
                alert_id = goods_no + ("::" + option_number if option_number else "")
                stored_alerts[:] = [item for item in stored_alerts if item.get("alertId") != alert_id]
                payload = {"success": True, "removed": True, "alertId": alert_id, "goodsNo": goods_no, "optionNumber": option_number or None}
            json_response(route, payload)
            return
        if path == "/api/stock":
            json_response(route, {
                "success": True,
                "goodsNo": GOODS_NO,
                "options": [
                    {"optionNumber": "OPT_1", "name": "웜 베이지", "productId": "LEGACY_1", "priceToPay": 16000, "soldOut": False},
                    {"optionNumber": "OPT_2", "name": '쿨 핑크\" onmouseover=\"window.__optionAttrInjected=1', "productId": "LEGACY_2", "priceToPay": 17000, "soldOut": True},
                ],
            })
            return
        if path == "/api/price-alerts/subscription":
            calls.append((request.method, path))
            json_response(route, {"success": True, "subscribed": True})
            return
        if path == "/api/price-alerts/public-key":
            json_response(route, {"success": True, "publicKey": "B" + "a" * 86, "checkIntervalMinutes": 60, "maxAlerts": 10})
            return
        if path.startswith("/api/"):
            json_response(route, {"success": True, "data": {"products": []}})
            return
        if parsed.netloc != urlparse(BASE_URL).netloc:
            unexpected_external_calls.append(request.url)
            route.fulfill(
                status=200,
                content_type=(
                    "text/javascript"
                    if request.url.startswith("https://cdn.jsdelivr.net/")
                    else "image/png"
                ),
                body="",
            )
            return
        route.continue_()

    def new_page(browser, sdk_mode="resolve", payment_attempt=None, url=BASE_URL):
        context = browser.new_context(viewport={"width": 516, "height": 862}, service_workers="block")
        init_payload = json.dumps({"mode": sdk_mode, "attempt": payment_attempt})
        context.add_init_script(
            """
            (() => {
              const { mode, attempt } = __INIT_PAYLOAD__;
              window.__sdkCalls = 0;
              window.__sdkRequests = [];
              window.__permissionRequests = 0;
              window.PortOne = {
                requestPayment: function (request) {
                  window.__sdkCalls += 1;
                  window.__sdkRequests.push(request);
                  if (mode === 'sync_once' && window.__sdkCalls === 1) {
                    throw new Error('mock before-handoff failure');
                  }
                  if (mode === 'async_throw') {
                    return Promise.reject(new Error('mock ambiguous provider failure'));
                  }
                  return Promise.resolve({});
                }
              };
              if (attempt) localStorage.setItem('oy_price_alert_payment_attempt_v1', JSON.stringify(attempt));
            })();
            """.replace("__INIT_PAYLOAD__", init_payload)
        )
        page = context.new_page()
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.route("**/*", handle_route)
        page.goto(url, wait_until="networkidle")
        page.evaluate(
            """
            if (typeof window.__sdkCalls !== 'number') window.__sdkCalls = 0;
            if (!Array.isArray(window.__sdkRequests)) window.__sdkRequests = [];
            if (typeof window.__permissionRequests !== 'number') window.__permissionRequests = 0;
            Storage.addFavorite({
              goodsNo: 'A000000154189',
              goodsName: '어노브 " onmouseover="window.__attrInjected=1',
              price: 16000,
              priceToPay: 16000,
              originalPrice: 16000,
              imageUrl: '/favicon-192x192.png'
            });
            PriceAlerts.ensurePushSubscription = function () {
              window.__permissionRequests += 1;
              return Promise.resolve(true);
            };
            void 0;
            """
        )
        return context, page

    def open_alert_modal(page):
        page.locator('[data-action="tabFavorites"]').click()
        toggle = page.locator(".price-alert-toggle:visible").first
        toggle.wait_for(state="visible", timeout=10000)
        assert toggle.get_attribute("onmouseover") is None
        toggle.hover()
        assert page.evaluate("window.__attrInjected") is None
        toggle.click()
        modal = page.locator("#price-alert-modal")
        assert modal.get_attribute("aria-hidden") == "false"
        return modal

    with sync_playwright() as playwright:
        print("e2e: launch", flush=True)
        browser = playwright.chromium.launch(headless=True)

        reset_state()
        context, page = new_page(browser)
        modal = open_alert_modal(page)
        page.locator("#price-alert-paywall:visible").wait_for(state="visible")
        assert "30,000원" in modal.inner_text()
        assert "자동결제 아님" in modal.inner_text()
        assert page.locator("#price-alert-setup").is_hidden()
        permission_count = page.evaluate("window.__permissionRequests")
        assert permission_count == 0
        print("e2e: unpaid gate precedes permission", flush=True)

        page.locator("#price-alert-promo-input").fill("E2E-DUMMY-CODE-NOT-A-REAL-SECRET")
        page.locator("#price-alert-promo-input").press("Enter")
        page.locator("#price-alert-setup:visible").wait_for(state="visible", timeout=10000)
        assert "평생 이용권 활성" in page.locator("#price-alert-entitlement-status").inner_text()
        assert state["promotion_count"] == 1
        assert page.evaluate("window.__permissionRequests") == 0
        assert "현재 공개 표시가" in modal.inner_text()
        assert "16,000원" in modal.inner_text()
        assert "60분마다 가격을 확인" in modal.inner_text()
        assert "쿠폰·회원·카드 할인 제외" in modal.inner_text()
        option_rows = page.locator(".price-alert-option:visible")
        option_rows.first.wait_for(state="visible", timeout=10000)
        assert option_rows.count() == 2
        assert "웜 베이지" in option_rows.nth(0).inner_text()
        assert "품절 · 등록 가능" in option_rows.nth(1).inner_text()
        assert option_rows.nth(1).get_attribute("onmouseover") is None
        option_rows.nth(1).hover()
        assert page.evaluate("window.__optionAttrInjected") is None

        page.locator("#price-alert-target-input").fill("15000")
        page.locator("#price-alert-save").click()
        page.wait_for_function("document.querySelector('.price-alert-toggle-target').textContent.includes('15,000원')")
        assert page.evaluate("window.__permissionRequests") == 1
        assert page.locator(".price-alert-manager-row:visible").count() == 1
        assert "웜 베이지" in page.locator(".price-alert-manager-row:visible").inner_text()

        page.locator(".price-alert-toggle:visible").first.click()
        page.locator('input[name="priceAlertOption"][value="OPT_2"]').wait_for(state="visible", timeout=10000)
        page.locator('input[name="priceAlertOption"][value="OPT_2"]').check()
        assert "17,000원 · 현재 품절" in page.locator("#price-alert-current-price").inner_text()
        page.locator("#price-alert-target-input").fill("14000")
        page.locator("#price-alert-save").click()
        page.wait_for_function("document.querySelectorAll('.price-alert-manager-row').length === 2")
        assert page.evaluate("window.__permissionRequests") == 2
        assert "2개 ON" in page.locator(".price-alert-toggle-target:visible").first.inner_text()
        manager_text = page.locator(".price-alert-manager:visible").inner_text()
        assert "웜 베이지" in manager_text
        assert "쿨 핑크" in manager_text
        page.screenshot(path=str(screenshot), full_page=True)

        page.locator('.price-alert-manager-edit[data-optionnumber="OPT_1"]:visible').click()
        page.locator("#price-alert-disable").click()
        page.wait_for_function("document.querySelectorAll('.price-alert-manager-row').length === 1")
        assert page.locator(".price-alert-toggle-state:visible").first.inner_text() == "ON"
        assert page.locator(".price-alert-manager-edit:visible").get_attribute("data-optionnumber") == "OPT_2"
        assert "쿨 핑크" in page.locator(".price-alert-manager-row:visible").inner_text()
        context.close()
        print("e2e: promo and two option alerts verified", flush=True)

        # Capacity/readiness is fail-closed per action without blocking a separate promo path.
        reset_state(payment_available=False, promotion_available=True)
        context, page = new_page(browser)
        open_alert_modal(page)
        page.wait_for_function(
            "document.querySelector('#price-alert-paywall-message').textContent.includes('수용량')"
        )
        assert page.locator("#price-alert-pay-button").is_disabled()
        assert page.locator("#price-alert-promo-button").is_enabled()
        assert page.evaluate("window.__sdkCalls") == 0
        context.close()
        print("e2e: payment readiness failed closed", flush=True)

        reset_state()
        context, page = new_page(browser)
        open_alert_modal(page)
        page.locator("#price-alert-pay-button").click()
        page.locator("#price-alert-setup:visible").wait_for(state="visible", timeout=10000)
        assert page.evaluate("window.__sdkCalls") == 1
        assert state["create_count"] == 1
        assert state["complete_count"] == 1
        assert page.evaluate("window.__sdkRequests[0].currency === 'KRW' && window.__sdkRequests[0].totalAmount === 30000")
        context.close()
        print("e2e: mocked PortOne unlocks exactly once", flush=True)

        reset_state(create_mode="mismatch")
        context, page = new_page(browser)
        open_alert_modal(page)
        page.locator("#price-alert-pay-button").click()
        page.wait_for_function("document.querySelector('#price-alert-paywall-message').textContent.includes('일치하지 않아')")
        assert page.evaluate("window.__sdkCalls") == 0
        assert state["create_count"] == 1
        assert state["complete_count"] == 0
        context.close()
        print("e2e: mismatched contract refused before SDK", flush=True)

        reset_state()
        context, page = new_page(browser, sdk_mode="async_throw")
        open_alert_modal(page)
        page.locator("#price-alert-pay-button").click()
        page.locator("#price-alert-setup:visible").wait_for(state="visible", timeout=10000)
        assert page.evaluate("window.__sdkCalls") == 1
        assert state["complete_count"] == 1
        context.close()
        print("e2e: thrown SDK still reconciled", flush=True)

        # A definite synchronous before-handoff failure may retry the same fenced payment.
        reset_state(complete_statuses=["pending", "paid"])
        context, page = new_page(browser, sdk_mode="sync_once")
        open_alert_modal(page)
        page.locator("#price-alert-pay-button").click()
        page.wait_for_function(
            "document.querySelector('#price-alert-paywall-message').textContent.includes('안전하게 다시 시도')"
        )
        attempt_after_failure = page.evaluate(
            "JSON.parse(localStorage.getItem('oy_price_alert_payment_attempt_v1'))"
        )
        assert attempt_after_failure["paymentId"] == PAYMENT_ID
        assert attempt_after_failure["providerInvoked"] is False
        page.locator("#price-alert-pay-button").click()
        page.locator("#price-alert-setup:visible").wait_for(state="visible", timeout=10000)
        assert page.evaluate("window.__sdkCalls") == 2
        assert state["create_count"] == 2
        assert state["complete_count"] == 2
        assert len(set(state["idempotency_keys"])) == 1
        context.close()
        print("e2e: definite before-handoff failure safely retried", flush=True)

        # An ambiguous rejected provider promise stays fenced; a second click reconciles only.
        reset_state(complete_status="pending")
        context, page = new_page(browser, sdk_mode="async_throw")
        open_alert_modal(page)
        page.locator("#price-alert-pay-button").click()
        page.wait_for_function("PriceAlerts.paymentBusy === false")
        page.locator("#price-alert-pay-button").click()
        page.wait_for_function("PriceAlerts.paymentBusy === false")
        assert page.evaluate("window.__sdkCalls") == 1
        assert state["create_count"] == 1
        assert state["complete_count"] == 2
        context.close()
        print("e2e: ambiguous handoff stayed fenced", flush=True)

        reset_state(payment_id=RETURN_PAYMENT_ID)
        return_attempt = {
            "idempotencyKey": "return-recovery-idempotency-key-0001",
            "paymentId": RETURN_PAYMENT_ID,
            "providerInvoked": True,
        }
        return_url = BASE_URL + "/?priceAlertPayment=complete&paymentId=" + RETURN_PAYMENT_ID + "&keep=safe"
        context, page = new_page(browser, payment_attempt=return_attempt, url=return_url)
        page.wait_for_function("PriceAlerts._hasActiveEntitlement() === true")
        assert state["complete_count"] == 1
        assert page.evaluate("window.__sdkCalls") == 0
        parsed_url = urlparse(page.url)
        assert "priceAlertPayment" not in parse_qs(parsed_url.query)
        assert "paymentId" not in parse_qs(parsed_url.query)
        assert parse_qs(parsed_url.query).get("keep") == ["safe"]
        analytics_url = page.evaluate("window.__analyticsObservedLocation")
        assert "priceAlertPayment" not in analytics_url
        assert "paymentId" not in analytics_url
        assert page.evaluate("localStorage.getItem('oy_price_alert_payment_attempt_v1')") is None
        context.close()
        print("e2e: matching return recovered and query stripped", flush=True)

        assert ("POST", "/api/price-alerts/alerts") in calls
        assert ("DELETE", "/api/price-alerts/alerts") in calls
        assert [body.get("optionNumber") for body in alert_bodies] == ["OPT_1", "OPT_2"]
        assert [body.get("targetPrice") for body in alert_bodies] == [15000, 14000]
        assert not sdk_network_calls, sdk_network_calls
        assert all(
            url.startswith("https://cdn.jsdelivr.net/")
            or url.startswith("https://image.oliveyoung.co.kr/")
            for url in unexpected_external_calls
        ), unexpected_external_calls
        assert not page_errors, page_errors
        assert not console_errors, console_errors
        browser.close()

    close_static_server()
    print(json.dumps({"ok": True, "viewport": "516x862", "screenshot": str(screenshot), "paymentScenarios": 8, "apiCalls": calls}, ensure_ascii=False))


if __name__ == "__main__":
    main()
