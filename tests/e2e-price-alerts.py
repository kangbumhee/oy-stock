import atexit
import json
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


BASE_URL = "http://127.0.0.1:4191"
GOODS_NO = "A000000154189"
PAYMENT_ID = "oypa_" + "p" * 24
RETURN_PAYMENT_ID = "oypa_" + "r" * 24
RECOVERED_DEVICE = {"deviceId": "recovered-member-device-0001", "deviceSecret": "s" * 43}


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
        "expiresAt": None if lifetime else (datetime.now(timezone.utc) + timedelta(days=12)).isoformat(),
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
            "noticeUrls": [BASE_URL + "/api/price-alerts/payment/webhook"],
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
    expected_error_paths = set()
    screenshot = Path(tempfile.gettempdir()) / "olivestock-price-alert-mobile.png"
    membership_screenshots = {
        mode: Path(tempfile.gettempdir()) / f"olivestock-membership-{mode}-mobile.png"
        for mode in ("unpaid", "paid", "lifetime")
    }
    state = {}
    deferred_entitlements = []

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
            "account_verified": True,
            "account_available": True,
            "account_get_error": None,
            "account_email": "verified@example.test",
            "account_actions": [],
            "visit_ids": [],
            "recovery_count": 0,
            "verified_count": 0,
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
        if path == "/api/price-alerts/account":
            calls.append((request.method, path))
            if request.method == "GET":
                if state["account_get_error"]:
                    expected_error_paths.add(path)
                    json_response(route, {"success": False, "error": state["account_get_error"]}, status=401)
                    return
                json_response(route, {
                    "success": True, "recoveryEnabled": True,
                    "available": state["account_available"],
                    "emailRequired": not state["account_verified"],
                    "account": {"verified": state["account_verified"], "email": state["account_email"] if state["account_verified"] else None},
                    "entitlement": state["entitlement"],
                })
                return
            body = request.post_data_json or {}
            action = body.get("action")
            state["account_actions"].append(action)
            if action == "record-visit":
                assert set(body) == {"action", "visitId"}
                assert 20 <= len(body["visitId"]) <= 80
                state["visit_ids"].append(body["visitId"])
                json_response(route, {"success": True})
            elif action in ("request-verification", "request-recovery"):
                assert set(body) == {"action", "email"}
                json_response(route, {"success": True, "sent": True, "expiresInSeconds": 900, "resendAfterSeconds": 60})
            elif action == "verify-email":
                assert set(body) == {"action", "email", "code"}
                assert body["code"] == "E2E-EMAIL-VERIFICATION-KEY"
                state["account_verified"] = True
                state["account_email"] = body["email"]
                state["verified_count"] += 1
                json_response(route, {"success": True, "account": {"verified": True, "email": body["email"]}, "entitlement": state["entitlement"]})
            elif action == "recover":
                assert set(body) == {"action", "email", "code"}
                assert body["code"] == "E2E-RECOVERY-KEY"
                state["account_get_error"] = None
                state["account_verified"] = True
                state["account_email"] = body["email"]
                state["entitlement"] = paid_entitlement()
                state["recovery_count"] += 1
                state["alerts"] = []
                json_response(route, {"success": True, "account": {"verified": True, "email": body["email"]},
                                      "entitlement": state["entitlement"], "credentials": RECOVERED_DEVICE})
            else:
                raise AssertionError(f"Unexpected account action: {action}")
            return
        if path == "/api/price-alerts/entitlement":
            calls.append((request.method, path))
            payload = {
                "success": True,
                "enabled": True,
                "paymentAvailable": state["payment_available"],
                "promotionAvailable": state["promotion_available"],
                "entitlement": dict(state["entitlement"]),
            }
            if state.pop("defer_entitlement", False):
                deferred_entitlements.append((route, payload))
                return
            json_response(route, payload)
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
            assert state["account_verified"], "unverified email must not create a payment"
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
                current_alerts = state.get("alerts", stored_alerts)
                payload = {"success": True, "alerts": current_alerts, "subscribed": bool(current_alerts)}
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

    def new_page(browser, sdk_mode="resolve", payment_attempt=None, url=BASE_URL, viewport=None):
        context = browser.new_context(viewport=viewport or {"width": 516, "height": 862}, service_workers="block")
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
        def console_message(message):
            if message.type != "error":
                return
            if ("status of 401" in message.text and
                    urlparse(message.location.get("url", "")).path in expected_error_paths):
                return
            console_errors.append(message.text)
        page.on("console", console_message)
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

        # A pass can be purchased directly from the homepage without inventing a product alert.
        reset_state()
        context, page = new_page(browser, viewport={"width": 390, "height": 844})
        entry = page.get_by_role("button", name="카카오페이로 30일 이용권 구매", exact=True)
        entry.click()
        modal = page.get_by_role("dialog", name="올리브재고 30일 이용권", exact=True)
        modal.wait_for(state="visible")
        page.wait_for_function("PriceAlerts.entitlementLoading === false")
        assert page.evaluate("PriceAlerts.modalState.membershipOnly === true && !PriceAlerts.modalState.goodsNo")
        assert page.locator("#price-alert-paywall").is_visible()
        assert page.locator("#price-alert-pay-button").is_enabled()
        assert page.locator("#price-alert-target-input").is_disabled()
        assert page.locator("#price-alert-target-input").get_attribute("required") is None
        assert page.locator("#price-alert-setup").is_hidden()
        assert page.locator("#price-alert-membership-summary").is_hidden()
        assert "30,000원" in modal.inner_text()
        assert "한 브라우저에서만 사용할 수 있습니다" in modal.inner_text()
        assert page.evaluate("window.__permissionRequests") == 0
        assert page.evaluate("window.__sdkCalls") == 0
        assert state["create_count"] == 0
        assert len(alert_bodies) == 0
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(membership_screenshots["unpaid"]))
        print("e2e: homepage opens unpaid membership checkout without a product", flush=True)

        page.get_by_role("button", name="카카오페이로 30일 이용권 결제", exact=True).click()
        page.locator("#price-alert-membership-summary").wait_for(state="visible")
        assert modal.is_visible()
        assert page.locator("#price-alert-paywall").is_hidden()
        assert page.locator("#price-alert-setup").is_hidden()
        expect(page.locator("#price-alert-entitlement-status")).to_contain_text("이용권 만료")
        assert "가격 알림" in page.locator("#price-alert-membership-summary").inner_text()
        assert "온라인 미노출 옵션의 근처·전국 매장 재고 조회" in page.locator("#price-alert-membership-summary").inner_text()
        assert page.evaluate("window.__sdkCalls") == 1
        assert state["create_count"] == 1
        assert state["complete_count"] == 1
        assert page.evaluate("localStorage.getItem('oy_price_alert_payment_attempt_v1')") is None
        assert page.evaluate("window.__permissionRequests") == 0
        assert len(alert_bodies) == 0
        page.screenshot(path=str(membership_screenshots["paid"]))
        modal.get_by_role("button", name="닫기", exact=True).click()
        assert page.locator("#price-alert-membership-entry").inner_text() == "내 이용권 확인"
        assert page.locator("#price-alert-membership-entry").evaluate("el => el === document.activeElement")
        # Management remains available from another tab and returns safely to search.
        page.locator('[data-action="tabFavorites"]').click()
        page.get_by_role("button", name="내 이용권 확인", exact=True).click()
        page.locator("#price-alert-membership-summary").wait_for(state="visible")
        page.locator("#price-alert-membership-use").click()
        page.wait_for_function("App.currentTab === 'search' && document.activeElement.id === 'search-input'")
        assert page.locator("#price-alert-modal").is_hidden()
        assert page.evaluate("window.__sdkCalls") == 1
        context.close()
        print("e2e: paid homepage membership stays visible and reopens without a second checkout", flush=True)

        reset_state()
        context, page = new_page(browser, viewport={"width": 390, "height": 844})
        page.get_by_role("button", name="카카오페이로 30일 이용권 구매", exact=True).click()
        page.locator("#price-alert-promo-input").fill("E2E-DUMMY-CODE-NOT-A-REAL-SECRET")
        page.locator("#price-alert-promo-input").press("Enter")
        page.locator("#price-alert-membership-summary").wait_for(state="visible")
        expect(page.locator("#price-alert-entitlement-status")).to_contain_text("평생 이용권 활성")
        assert page.locator("#price-alert-promo-input").input_value() == ""
        assert page.locator("#price-alert-paywall").is_hidden()
        assert page.locator("#price-alert-setup").is_hidden()
        assert state["promotion_count"] == 1
        assert state["create_count"] == 0
        assert page.evaluate("window.__sdkCalls") == 0
        assert len(alert_bodies) == 0
        page.screenshot(path=str(membership_screenshots["lifetime"]))
        page.locator("#price-alert-modal .price-alert-close").click()
        page.get_by_role("button", name="내 이용권 확인", exact=True).click()
        page.locator("#price-alert-membership-summary").wait_for(state="visible")
        expect(page.locator("#price-alert-entitlement-status")).to_contain_text("평생 이용권 활성")
        context.close()
        print("e2e: homepage promotion preserves lifetime membership without charging", flush=True)

        reset_state(account_verified=False)
        context, page = new_page(browser, viewport={"width": 390, "height": 844})
        page.get_by_role("button", name="카카오페이로 30일 이용권 구매", exact=True).click()
        page.locator("#membership-enroll").wait_for(state="visible")
        page.locator("#price-alert-pay-button").click()
        page.wait_for_function("document.querySelector('#membership-message').textContent.includes('결제 전에 이메일 인증')")
        assert state["create_count"] == 0
        assert page.evaluate("window.__sdkCalls") == 0
        page.locator("#membership-email").fill("member@example.test")
        page.locator("#membership-email-send").click()
        page.wait_for_function("document.querySelector('#membership-message').textContent.includes('인증 안내를 보냈습니다')")
        assert "request-verification" in state["account_actions"]
        page.locator("#membership-email-code").fill("E2E-EMAIL-VERIFICATION-KEY")
        page.locator("#membership-email-verify").click()
        page.wait_for_function("Membership.busy === false && Membership.account.verified === true")
        assert state["verified_count"] == 1
        assert page.locator("#membership-enroll").is_hidden()
        assert "member@example.test" in page.locator("#membership-email-status").inner_text()
        assert page.locator("#membership-email-code").input_value() == ""
        page.locator("#price-alert-pay-button").click()
        page.locator("#price-alert-membership-summary").wait_for(state="visible")
        assert state["create_count"] == 1
        assert page.evaluate("window.__sdkCalls") == 1
        assert state["complete_count"] == 1
        assert len(alert_bodies) == 0
        context.close()
        print("e2e: unverified payment blocked; inbox verification permits checkout", flush=True)

        for account_error, stale_entitlement in ((None, False), ("device_auth_failed", False), (None, True)):
            reset_state(account_verified=False, account_get_error=account_error)
            context, page = new_page(browser, viewport={"width": 390, "height": 844})
            page.get_by_role("button", name="카카오페이로 30일 이용권 구매", exact=True).click()
            old_credentials = page.evaluate("Storage.getPriceAlertDevice()")
            page.evaluate("""
              window.__workerAuthMessages = [];
              PriceAlerts._serviceWorkerRegistration = () => Promise.resolve({ active: {
                postMessage: message => window.__workerAuthMessages.push(message)
              }});
              Storage.setPriceAlertPaymentAttempt({
                idempotencyKey: 'old-browser-pending-payment-0001',
                paymentId: 'oypa_old_browser_payment_1234567890', providerInvoked: true
              });
              Storage.setPriceAlertStore({ items: { old: { id: 'old', goodsNo: 'old-product', enabled: true } }, subscribed: true });
            """)
            page.locator("#membership-recovery summary").click()
            page.locator("#membership-recovery-email").fill("recover@example.test")
            if account_error:
                assert page.locator("#membership-email-send").is_disabled()
                assert page.locator("#membership-email-verify").is_disabled()
                assert "다른 브라우저" in page.locator("#membership-email-status").inner_text()
            assert page.locator("#membership-recovery-send").is_enabled()
            page.locator("#membership-recovery-send").click()
            page.wait_for_function("document.querySelector('#membership-message').textContent.includes('등록된 주소라면 복구 키')")
            page.locator("#membership-recovery-code").fill("E2E-RECOVERY-KEY")
            page.locator("#membership-recover").click()
            assert "기존 브라우저 사용 해제에 동의" in page.locator("#membership-message").inner_text()
            assert state["recovery_count"] == 0
            if stale_entitlement:
                state["defer_entitlement"] = True
                with page.expect_request("**/api/price-alerts/entitlement"):
                    page.evaluate("void PriceAlerts.refreshEntitlement({ silent: true })")
                for _ in range(20):
                    if deferred_entitlements:
                        break
                    page.wait_for_timeout(25)
                assert len(deferred_entitlements) == 1
            page.locator("#membership-transfer-confirm").check()
            page.locator("#membership-recover").click()
            if stale_entitlement:
                page.wait_for_function("Storage.getPriceAlertDevice().deviceId === 'recovered-member-device-0001'")
                for pending_route, payload in deferred_entitlements:
                    json_response(pending_route, payload)
                deferred_entitlements.clear()
            page.wait_for_function("Membership.busy === false && Storage.getPriceAlertDevice().deviceId === 'recovered-member-device-0001'")
            page.wait_for_function("document.querySelector('#membership-message').textContent.includes('이 브라우저로 복구했습니다')")
            credentials = page.evaluate("Storage.getPriceAlertDevice()")
            assert credentials["deviceId"] == RECOVERED_DEVICE["deviceId"]
            assert credentials["deviceSecret"] == RECOVERED_DEVICE["deviceSecret"]
            assert credentials["deviceSecret"] != old_credentials["deviceSecret"]
            assert page.evaluate("localStorage.getItem(Storage._key('price_alert_payment_attempt_v1'))") is None
            assert page.evaluate("Storage.getPriceAlertItems()") == []
            assert page.evaluate("Storage.getPriceAlertStore().subscribed") is False
            assert page.evaluate("window.__workerAuthMessages.some(m => m.type === 'PRICE_ALERT_DEVICE_AUTH' && m.deviceId === 'recovered-member-device-0001' && m.deviceSecret === 's'.repeat(43))")
            assert page.locator("#membership-recovery-code").input_value() == ""
            assert not page.locator("#membership-transfer-confirm").is_checked()
            assert page.locator("#price-alert-membership-summary").is_visible()
            assert "알림 허용을 다시 설정" in page.locator("#membership-message").inner_text()
            assert state["recovery_count"] == 1
            assert state["create_count"] == 0
            assert page.evaluate("window.__sdkCalls") == 0
            context.close()
        print("e2e: recovery requires transfer consent, rotates credentials and push auth, and rejects stale entitlement responses", flush=True)

        for lifetime in (False, True):
            reset_state(entitlement=paid_entitlement(lifetime=lifetime))
            context, page = new_page(browser, viewport={"width": 390, "height": 844})
            page.locator("#price-alert-membership-summary").wait_for(state="visible")
            title = page.locator("#price-alert-title").inner_text()
            if lifetime:
                assert title == "평생 이용권 사용 중입니다"
            else:
                assert "유료 이용기간" in title and "일 남았어요" in title
                assert "NaN" not in title
            assert page.locator("#price-alert-paywall").is_hidden()
            page.locator("#price-alert-modal .price-alert-close").click()
            previous_visits = len(state["visit_ids"])
            page.evaluate("window.dispatchEvent(new Event('focus')); Membership.trackVisit()")
            page.wait_for_function("PriceAlerts.entitlementLoading === false")
            assert page.locator("#price-alert-modal").is_hidden()
            assert len(state["visit_ids"]) == previous_visits
            page.reload(wait_until="networkidle")
            page.wait_for_function("PriceAlerts.entitlementLoading === false")
            assert page.locator("#price-alert-modal").is_hidden(), "automatic membership notice is once per Korean day"
            page.locator("#price-alert-membership-entry").click()
            page.locator("#price-alert-membership-summary").wait_for(state="visible")
            assert len(set(state["visit_ids"])) == 1, "reload must retain the same visit id for backend deduplication"
            assert state["create_count"] == 0
            assert page.evaluate("window.__sdkCalls") == 0
            context.close()
        print("e2e: active visits show daily notice once, preserve manual access and deduplicate focus/reload visits", flush=True)

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
        expect(page.locator("#price-alert-entitlement-status")).to_contain_text("평생 이용권 활성")
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
        context, page = new_page(browser, payment_attempt=return_attempt, url=return_url, viewport={"width": 390, "height": 844})
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
        page.get_by_role("button", name="내 이용권 확인", exact=True).click()
        page.locator("#price-alert-membership-summary").wait_for(state="visible")
        expect(page.locator("#price-alert-entitlement-status")).to_contain_text("이용권 만료")
        assert page.locator("#price-alert-paywall").is_hidden()
        assert page.locator("#price-alert-setup").is_hidden()
        assert page.evaluate("window.__sdkCalls") == 0
        assert state["create_count"] == 0
        assert state["complete_count"] == 1
        context.close()
        print("e2e: matching mobile return recovered, query stripped and membership accessible", flush=True)

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
    print(json.dumps({"ok": True, "viewports": ["516x862", "390x844"], "screenshot": str(screenshot), "membershipScreenshots": {mode: str(file) for mode, file in membership_screenshots.items()}, "paymentScenarios": 17, "apiCalls": calls}, ensure_ascii=False))


if __name__ == "__main__":
    main()
