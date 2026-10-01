"""Synthetic browser checks; no server, credentials, or real network requests.

Run: python tests/curator-redirect-browser.py
Requires Python Playwright and its Chromium browser.
"""

import json
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HOST = "https://curator-fixture.invalid"
GOODS = "A000000267668"
PAGE_URL = f"{HOST}/api/oliveyoung/curator-redirect?goodsNo={GOODS}&noTrigger=1&noLive=1"
READY_URL = "https://oy.run/browser-fixture"
PENDING = {"ready": False, "pending": True, "unavailable": False}


def render_pending_html():
    """Exercise the real handler with an entirely synthetic fetch transport."""
    script = r"""
const assert = require('node:assert/strict');
process.env.CURATOR_LINKS_API_URL = 'https://fixture.invalid/curator-links';
process.env.DISABLE_CURATOR_WORKFLOW_QUEUE = '1';
process.env.DISABLE_LIVE_CURATOR_LINKS = '1';
global.fetch = async (input, init = {}) => {
  assert.equal(String(input), 'https://fixture.invalid/curator-links');
  assert.equal(init.method || 'GET', 'GET');
  assert.equal(init.headers.Authorization, undefined);
  return new Response(JSON.stringify({ updatedAt: '2026-10-01T00:00:00Z', links: {} }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
const handler = require('./api/oliveyoung/curator-redirect.js');
const output = { headers: {} };
const res = {
  statusCode: 200,
  setHeader(name, value) { output.headers[name.toLowerCase()] = value; },
  end(html) { output.status = this.statusCode; output.html = html; }
};
handler({
  method: 'GET',
  headers: { host: 'curator-fixture.invalid', 'x-forwarded-proto': 'https' },
  query: { goodsNo: 'A000000267668', noTrigger: '1', noLive: '1' }
}, res).then(() => process.stdout.write(JSON.stringify(output))).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
"""
    # Do not inherit project credentials or configured service endpoints.
    environment = {
        name: value for name, value in os.environ.items()
        if name.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}
    }
    result = subprocess.run(
        ["node", "-e", script], cwd=ROOT, env=environment,
        check=True, capture_output=True, text=True, encoding="utf-8", timeout=20,
    )
    rendered = json.loads(result.stdout)
    assert rendered["status"] == 200
    assert rendered["headers"]["cache-control"] == "no-store"
    assert 'id="retry"' in rendered["html"]
    return rendered["html"]


class Fixture:
    def __init__(self, browser, html, responses=None, hold=False, width=1280):
        self.context = browser.new_context(viewport={"width": width, "height": 850})
        self.page = self.context.new_page()
        self.responses = list(responses or [])
        self.hold = hold
        self.held = []
        self.polls = []
        self.navigations = []
        self.unexpected = []
        self.errors = []
        self.html = html
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.context.route("**/*", self.route)
        self.page.add_init_script("""(() => {
          const original = window.fetch.bind(window);
          window.__fetchStats = {started: 0, active: 0, maxActive: 0, aborted: 0};
          window.fetch = (input, init) => {
            const s = window.__fetchStats;
            s.started++; s.active++; s.maxActive = Math.max(s.maxActive, s.active);
            if (!init || init.cache !== 'no-store' || !init.signal) {
              throw new Error('Poll must use no-store and an AbortSignal');
            }
            init.signal.addEventListener('abort', () => s.aborted++, {once: true});
            return original(input, init).finally(() => s.active--);
          };
        })();""")
        now = datetime.now(timezone.utc)
        self.page.clock.install(time=now)
        self.page.clock.pause_at(now + timedelta(seconds=1))
        self.page.goto(PAGE_URL, wait_until="networkidle")
        expect(self.page.get_by_role("heading", name="상품페이지로 이동중")).to_be_visible()
        assert self.page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        expect(self.page.get_by_role("button", name="지금 다시 확인")).to_be_visible()

    def route(self, route):
        url = route.request.url
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if url == READY_URL:
            self.navigations.append(url)
            route.fulfill(status=200, content_type="text/html", body="<h1>Fixture destination</h1>")
        elif parsed.netloc == "curator-fixture.invalid" and parsed.path == "/api/oliveyoung/curator-redirect":
            if query.get("format") != ["json"]:
                route.fulfill(status=200, content_type="text/html", body=self.html)
                return
            self.polls.append(url)
            assert query.get("goodsNo") == [GOODS]
            assert query.get("noTrigger") == ["1"]
            assert query.get("noLive") == ["1"]
            assert query.get("refresh") == ["1"]
            if self.hold:
                self.held.append(route)
            else:
                payload = self.responses.pop(0) if self.responses else PENDING
                route.fulfill(status=200, json=payload)
        elif parsed.netloc == "curator-fixture.invalid" and parsed.path == "/favicon.ico":
            route.fulfill(status=204)
        else:
            self.unexpected.append(url)
            route.abort()

    def advance(self, milliseconds):
        self.page.clock.run_for(milliseconds)

    def flush(self):
        self.page.wait_for_function("window.__fetchStats.active === 0")
        # Flush JSON parsing and the subsequent promise callbacks as well.
        self.page.evaluate("() => new Promise(resolve => queueMicrotask(resolve))")

    def stats(self):
        return self.page.evaluate("window.__fetchStats")

    def close(self):
        errors = list(self.errors)
        unexpected = list(self.unexpected)
        # An aborted browser fetch can still leave a deferred Playwright route
        # waiting for its handler. Complete those routes before closing context.
        for route in self.held:
            route.abort()
        self.held.clear()
        self.context.close()
        assert not errors, errors
        assert not unexpected, unexpected


def pending_to_ready(browser, html, width):
    f = Fixture(browser, html, responses=[PENDING, {"ready": True, "shortenedUrl": READY_URL}], width=width)
    try:
        f.advance(3000)
        f.flush()
        assert len(f.polls) == 1 and not f.navigations
        f.advance(5000)
        expect(f.page).to_have_url(READY_URL)
        expect(f.page.get_by_role("heading", name="Fixture destination")).to_be_visible()
        assert f.navigations == [READY_URL]
        assert len(f.polls) == 2
    finally:
        f.close()


def hung_fetch(browser, html):
    f = Fixture(browser, html, hold=True)
    try:
        f.advance(3000)
        f.page.wait_for_function("window.__fetchStats.active === 1")
        f.advance(29999)
        expect(f.page.locator("#spinner")).to_be_visible()
        f.advance(1)
        expect(f.page.locator("#status")).to_contain_text("응답이 늦어지고")
        expect(f.page.locator("#spinner")).to_be_hidden()
        expect(f.page.locator("#retry")).to_be_enabled()
        f.flush()
        assert f.stats()["aborted"] == 1
        f.advance(180000)
        assert len(f.polls) == 1
        f.hold = False
        f.page.locator("#retry").click()
        f.flush()
        assert len(f.polls) == 2
    finally:
        f.close()


def finite_wait_and_retry(browser, html):
    f = Fixture(browser, html, width=390)
    try:
        f.advance(3000)
        f.flush()
        for _ in range(23):
            f.advance(5000)
            f.flush()
        f.advance(4999)
        f.flush()
        expect(f.page.locator("#spinner")).to_be_visible()
        f.advance(1)
        expect(f.page.locator("#status")).to_contain_text("링크 준비가 지연")
        expect(f.page.locator("#spinner")).to_be_hidden()
        expect(f.page.locator("#retry")).to_be_enabled()
        stopped_count = len(f.polls)
        f.advance(180000)
        assert len(f.polls) == stopped_count
        f.page.locator("#retry").click()
        f.flush()
        assert len(f.polls) == stopped_count + 1
        expect(f.page.locator("#spinner")).to_be_visible()
        assert f.stats()["maxActive"] == 1
    finally:
        f.close()


def unavailable_stops(browser, html):
    f = Fixture(browser, html, responses=[{"ready": False, "unavailable": True, "queueStatus": "발급 불가 fixture"}])
    try:
        f.advance(3000)
        f.flush()
        expect(f.page.locator("#status")).to_have_text("발급 불가 fixture")
        expect(f.page.locator("#spinner")).to_be_hidden()
        expect(f.page.locator("#retry")).to_be_disabled()
        f.advance(180000)
        assert len(f.polls) == 1 and not f.navigations
    finally:
        f.close()


def rapid_retry_single_request(browser, html):
    f = Fixture(browser, html, hold=True)
    try:
        # Also exercise clicking before the initial three-second timer fires.
        f.page.locator("#retry").click()
        f.page.wait_for_function("window.__fetchStats.active === 1")
        f.page.evaluate("() => { for (let i = 0; i < 20; i++) document.querySelector('#retry').dispatchEvent(new Event('click')); }")
        f.advance(3000)
        assert len(f.polls) == 1
        assert f.stats()["maxActive"] == 1
        f.held.pop().fulfill(status=200, json=PENDING)
        f.flush()
        f.hold = False
        f.advance(5000)
        f.flush()
        assert len(f.polls) == 2
        assert f.stats()["maxActive"] == 1
    finally:
        f.close()


def invalid_ready_urls_do_not_navigate(browser, html):
    invalid = ["http://oy.run/insecure", "https://oy.run.evil.invalid/link", "https://oy.run/", "javascript:alert(1)"]
    f = Fixture(browser, html, responses=[{"ready": True, "shortenedUrl": url} for url in invalid])
    try:
        f.advance(3000)
        f.flush()
        for _ in invalid[1:]:
            f.advance(5000)
            f.flush()
        assert len(f.polls) == len(invalid)
        assert f.page.url == PAGE_URL and not f.navigations
    finally:
        f.close()


def main():
    html = render_pending_html()
    checks = [
        ("desktop pending to ready", lambda b: pending_to_ready(b, html, 1280)),
        ("mobile pending to ready", lambda b: pending_to_ready(b, html, 390)),
        ("hung request stops after 30 seconds and can retry", lambda b: hung_fetch(b, html)),
        ("pending stops after 120 seconds and can retry", lambda b: finite_wait_and_retry(b, html)),
        ("unavailable stops polling", lambda b: unavailable_stops(b, html)),
        ("rapid retry never overlaps requests", lambda b: rapid_retry_single_request(b, html)),
        ("unsafe ready URLs never navigate", lambda b: invalid_ready_urls_do_not_navigate(b, html)),
    ]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, check in checks:
                check(browser)
                print(f"PASS {name}")
        finally:
            browser.close()
    print(f"PASS {len(checks)} synthetic browser checks; no production network or server startup")


if __name__ == "__main__":
    main()
