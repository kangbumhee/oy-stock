import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
UI_JS = ROOT / "public" / "js" / "ui.js"
GOODS_NO = "A000000227282"
SHORT_URL = "https://oy.run/e2eReady"
ORIGINAL_URL = (
    "https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo="
    + GOODS_NO
    + "&utm_source=shutter&utm_medium=affiliate&utm_content=OY_e2e"
)
SERVER_URL = (
    "https://olivestock.co.kr/api/oliveyoung/curator-redirect?goodsNo="
    + GOODS_NO
    + "&direct=1"
)
BASE_URL = "https://olivestock.co.kr/e2e-curator-link"


def run_case(browser, entry, expected_url):
    context = browser.new_context()
    context.route(
        BASE_URL,
        lambda route: route.fulfill(
            status=200,
            content_type="text/html; charset=utf-8",
            body="<!doctype html><title>fixture</title>",
        ),
    )
    context.route(
        expected_url,
        lambda route: route.fulfill(
            status=200,
            content_type="text/html; charset=utf-8",
            body="<!doctype html><title>target</title>",
        ),
    )
    page = context.new_page()
    page.goto(BASE_URL, wait_until="networkidle")
    page.set_content(
        """
        <!doctype html>
        <button data-action="buyNow" data-goodsno="A000000227282"
                data-original-label="바로구매"
                onclick="UI.openOliveYoungProduct(this)">바로구매</button>
        <script>
          window.CONFIG = {
            OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=',
            CURATOR_REDIRECT_PATH: '/api/oliveyoung/curator-redirect'
          };
        </script>
        """
    )
    page.add_script_tag(path=str(UI_JS))
    page.evaluate(
        "([goodsNo, curatorEntry]) => { UI._curatorLinksIndex[goodsNo] = curatorEntry; }",
        [GOODS_NO, entry],
    )

    with context.expect_page() as popup_info:
        page.get_by_role("button", name="바로구매").click()
    popup = popup_info.value
    popup.wait_for_url(expected_url)
    popup.wait_for_load_state("domcontentloaded")

    assert len(context.pages) == 2, f"expected one popup, got {len(context.pages) - 1}"
    assert popup.url == expected_url, f"expected {expected_url}, got {popup.url}"
    assert popup.evaluate("window.opener === null") is True
    context.close()


with sync_playwright() as playwright:
    chromium = playwright.chromium.launch(headless=True)
    run_case(
        chromium,
        {"shortenedUrl": SHORT_URL, "originalUrl": ORIGINAL_URL},
        SHORT_URL,
    )
    run_case(
        chromium,
        {"shortenedUrl": None, "originalUrl": ORIGINAL_URL},
        SERVER_URL,
    )
    chromium.close()

print(json.dumps({"ok": True, "cases": ["oy.run", "original-only"]}))
