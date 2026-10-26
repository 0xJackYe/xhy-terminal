"""Local, same-origin shell for the existing Diet and Bitcoin services.

The overview only reads existing snapshots. It never starts a market worker,
changes an alert rule, sends a notification, or calls a trading API.
"""
import argparse
import concurrent.futures
import datetime as dt
import http.client
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
BEIJING = dt.timezone(dt.timedelta(hours=8))
NUTRIENTS = ("kcal", "protein", "carbs", "fat", "fiber", "saturatedFat")
MAX_RESPONSE = 8 * 1024 * 1024
MAX_BODY = 1_000_000
LINKS = {"diet": "/diet/", "wallet": "/btc/#wallet", "alerts": "/btc/#alerts"}


def iso_now():
    return dt.datetime.now(BEIJING).isoformat(timespec="seconds")


class Config:
    def __init__(self, port=8780, diet_port=4173, btc_port=8766, diet_root=None, options_root=None):
        self.port, self.diet_port, self.btc_port = port, diet_port, btc_port
        self.diet_root = Path(diet_root or os.environ.get("XHY_DIET_ROOT") or ROOT.parent / "Diet").resolve()
        self.options_root = Path(options_root or os.environ.get("XHY_OPTIONS_ROOT") or ROOT.parents[2] / "Desktop" / "options").resolve()


def read_local_json(port, path, timeout=3):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", path, headers={"Accept": "application/json", "Host": "127.0.0.1:%s" % port})
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE + 1)
        if response.status != 200 or len(data) > MAX_RESPONSE:
            raise ValueError("unavailable")
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError("invalid_response")
        return value
    finally:
        connection.close()


def nutrient_total(items):
    result = {}
    for key in NUTRIENTS:
        values = [(item.get("nutrition") or {}).get(key) for item in items]
        result[key] = round(sum(values), 1) if values and all(type(v) in (int, float) and math.isfinite(v) for v in values) else None
    return result


def summarize_day(day, date):
    meals = [m for m in (day or {}).get("meals", []) if m.get("status") == "eaten"]
    items = [item for meal in meals for item in meal.get("items", [])]
    return {"date": date, "recorded": bool(meals), "mealCount": len(meals), "itemCount": len(items),
            "totals": nutrient_total(items),
            "meals": [{key: meal.get(key) for key in ("id", "type", "title", "status")} for meal in meals]}


def diet_overview(config, today=None):
    today = today or dt.datetime.now(BEIJING).date()
    try:
        live = safe_read(config.diet_port, "/api/diary")
        diary = live.get("diary") if live else None
        if not isinstance(diary, dict):
            runtime_path = config.diet_root / ".local" / "runtime-diary.json"
            path = runtime_path if runtime_path.exists() else config.diet_root / "data" / "diary.json"
            if path.stat().st_size > MAX_RESPONSE:
                raise ValueError("invalid_diary")
            stored = json.loads(path.read_text(encoding="utf-8-sig"))
            diary = stored.get("diary") if path == runtime_path and isinstance(stored, dict) else stored
        if not isinstance(diary, dict) or diary.get("schemaVersion") != 1 or not isinstance(diary.get("days"), list):
            raise ValueError("invalid_diary")
        by_date = {day["date"]: day for day in diary["days"]}
        dates = [today - dt.timedelta(days=i) for i in reversed(range(7))]
        week_days = [summarize_day(by_date.get(date.isoformat()), date.isoformat()) for date in dates]
        current = week_days[-1]
        week_items = [item for date in dates for meal in by_date.get(date.isoformat(), {}).get("meals", [])
                      if meal.get("status") == "eaten" for item in meal.get("items", [])]
        return {"status": "online" if current["recorded"] else "empty", "error": None,
                "updatedAt": diary.get("updatedAt"), "date": today.isoformat(), "recorded": current["recorded"],
                "today": current,
                "week": {"startDate": dates[0].isoformat(), "endDate": today.isoformat(),
                         "recordedDays": sum(day["recorded"] for day in week_days),
                         "totals": nutrient_total(week_items), "days": week_days}}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return {"status": "offline", "error": "饮食日记暂时无法读取。", "updatedAt": None,
                "date": today.isoformat(), "recorded": False, "today": None, "week": None}


def safe_read(port, path):
    try:
        return read_local_json(port, path)
    except (OSError, ValueError, http.client.HTTPException):
        return None


def wallet_overview(portfolio, combined):
    if portfolio is None:
        return {"status": "offline", "error": "加密资产服务暂时无法连接。", "updatedAt": None,
                "stale": True, "complete": False, "totalUsd": None, "totalCny": None, "totalBtc": None,
                "btcHoldings": None, "assets": [], "locations": [], "sources": [], "scopeNote": None}
    stale = bool(portfolio.get("stale", True))
    complete = portfolio.get("complete") is True
    holdings = (combined.get("totals") or {}).get("btc") if isinstance(combined, dict) else None
    return {"status": "stale" if stale or not complete else "online", "error": None,
            "updatedAt": portfolio.get("updated_at"), "stale": stale, "complete": complete,
            "totalUsd": portfolio.get("total_usd"), "totalCny": portfolio.get("total_cny"),
            "totalBtc": portfolio.get("total_btc"), "btcHoldings": holdings,
            "btcHoldingsStale": combined.get("stale", True) if isinstance(combined, dict) else True,
            "assets": portfolio.get("assets", []), "locations": portfolio.get("locations", []),
            "sources": portfolio.get("sources", []), "scopeNote": portfolio.get("scope_note"),
            "thresholdUsd": portfolio.get("threshold_usd"), "excludedUsd": portfolio.get("excluded_usd"),
            "unpricedCurrencies": portfolio.get("unpriced_currencies", []),
            "liabilitiesUsd": portfolio.get("liabilities_usd"), "conversionQuotes": portfolio.get("conversion_quotes", {})}


def alerts_overview(terminal):
    market = terminal.get("market", {}) if terminal else {}
    settings = terminal.get("settings", {}) if terminal else {}
    live = market.get("status") == "live"
    timestamp = market.get("event_ms")
    try:
        updated = dt.datetime.fromtimestamp(timestamp / 1000, BEIJING).isoformat(timespec="seconds") if timestamp else None
    except (ValueError, TypeError, OverflowError):
        updated = None
    return {"status": "online" if live else "stale" if terminal else "offline", "stale": not live,
            "error": market.get("error") if terminal else "比特币价格警报服务暂时无法连接。",
            "updatedAt": updated, "price": market.get("price"), "priceCurrency": "USDT",
            "changePct": market.get("change_pct"), "rangePct": market.get("range_pct"), "changePeriod": "北京时间今日",
            "dayOpen": market.get("day_open"), "dayHigh": market.get("day_high"), "dayLow": market.get("day_low"),
            "connectionStatus": market.get("status", "offline"), "connected": market.get("connected", False),
            "enabled": settings.get("enabled"), "thresholds": settings.get("thresholds_pct", []),
            "metric": settings.get("metric"), "settings": settings,
            "recent": (terminal.get("alerts") or [])[-8:] if terminal else [],
            "storageError": terminal.get("storage_error") if terminal else None}


def build_overview(config):
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        diet_task = pool.submit(diet_overview, config)
        terminal_task = pool.submit(safe_read, config.btc_port, "/api/terminal")
        portfolio_task = pool.submit(safe_read, config.btc_port, "/api/wallet/portfolio")
        combined_task = pool.submit(safe_read, config.btc_port, "/api/wallet/combined")
        diet, terminal, portfolio, combined = [task.result() for task in (diet_task, terminal_task, portfolio_task, combined_task)]
    return {"updatedAt": iso_now(), "timezone": "Asia/Shanghai", "links": LINKS,
            "services": {"diet": {"status": "online" if probe_port(config.diet_port) else "offline", "url": LINKS["diet"]},
                         "btc": {"status": "online" if terminal else "offline", "url": "/btc/"}},
            "diet": diet, "wallet": wallet_overview(portfolio, combined), "alerts": alerts_overview(terminal)}


def probe_port(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=.25):
            return True
    except OSError:
        return False


# Match only actual local routes. Strings such as '/config' are suffixes added
# to an API base, '/address/' and '/api/v1/prices' belong to remote providers,
# and /"/g is a regex literal. None of those may gain the portal prefix.
ROOT_PATH = re.compile(r'''(["'`])/(?=(?:api/(?:terminal|wallet|market|events|focused-market|mark-watch|option-ai|parse-meals|diary-chat|diary|chat|ai-status)(?:[/?.$"'`])|(?:audio|data|assets)/|[A-Za-z0-9_.-]+\.(?:html|mjs|js|css|json|svg|png|jpe?g|webp|wav|woff2)(?:[?#/"'`])))''')
HTML_PATH = re.compile(r'''(\b(?:src|href|action|poster)\s*=\s*["'])/(?!/)''', re.IGNORECASE)
CSS_PATH = re.compile(r'''(url\(\s*)/(?!/)''', re.IGNORECASE)


def rewrite_asset(data, content_type, prefix):
    """Keep each original app's root-relative resources inside its namespace."""
    if not any(kind in content_type for kind in ("text/html", "javascript", "text/css")):
        return data
    try:
        text = data.decode("utf-8")
    except UnicodeError:
        return data
    text = ROOT_PATH.sub(lambda match: match.group(1) + prefix + "/", text)
    if "text/html" in content_type:
        # Run before/without a generic string replacement: HTML can contain
        # inline JavaScript and its remote-provider path comparisons.
        text = HTML_PATH.sub(lambda match: match.group(1) + prefix + "/", text)
        # The API/file rewrite above already handles quoted asset attributes.
        text = text.replace(prefix + prefix + "/", prefix + "/")
        # Scope the local theme bridge to this portal's proxied copy. Original
        # Diet/Bitcoin files and their independent origins remain untouched.
        # Load synchronously before the app's deferred scripts to avoid a bright
        # frame while a saved dark theme is restored and disable the options tab.
        if re.search(r"<head(?:\s[^>]*)?>", text, re.IGNORECASE):
            text = re.sub(r"(<head(?:\s[^>]*)?>)",
                          r'\1<script src="/theme-bridge.js" data-xhy-embed></script>',
                          text, count=1, flags=re.IGNORECASE)
    if "text/css" in content_type:
        text = CSS_PATH.sub(lambda match: match.group(1) + prefix + "/", text)
    return text.encode("utf-8")


class TerminalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config):
        self.config = config
        self.overview_lock = threading.Lock()
        self.overview_cache = None
        self.overview_at = 0
        self.dependency_lock = threading.Lock()
        self.dependencies_starting = False
        super().__init__(("127.0.0.1", config.port), Handler)

    def overview(self):
        with self.overview_lock:
            if self.overview_cache is None or time.monotonic() - self.overview_at >= 3:
                self.overview_cache = build_overview(self.config)
                self.overview_at = time.monotonic()
            return self.overview_cache

    def ensure_dependencies_async(self):
        with self.dependency_lock:
            if self.dependencies_starting:
                return False
            self.dependencies_starting = True

        def run():
            from services import ensure_dependencies
            try:
                ensure_dependencies(self.config)
            finally:
                with self.dependency_lock:
                    self.dependencies_starting = False

        threading.Thread(target=run, name="xhy-local-services", daemon=True).start()
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "XHYTerminal/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def respond(self, status, data, content_type="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except OSError:
                self.close_connection = True

    def json(self, status, value):
        self.respond(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))

    def local(self):
        valid = {"127.0.0.1:%s" % self.server.server_port, "localhost:%s" % self.server.server_port}
        host = self.headers.get("Host", "").lower()
        if len(self.headers.get_all("Host", [])) != 1 or host not in valid:
            self.close_connection = True
            self.json(403, {"error": "个人终端只允许本机访问。"})
            return False
        origin = self.headers.get("Origin")
        if len(self.headers.get_all("Origin", [])) > 1 or (origin and origin != "http://" + host):
            self.close_connection = True
            self.json(403, {"error": "请在个人终端内提交请求。"})
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.close_connection = True
            self.json(403, {"error": "不允许其他网站访问本机终端。"})
            return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.local():
            return
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        if path == "/api/health":
            self.json(200, {"app": "xhy-terminal", "version": 1, "timezone": "Asia/Shanghai"})
        elif path == "/api/overview":
            self.json(200, self.server.overview())
        elif path == "/btc/options.html":
            self.respond(308, b"", extra={"Location": "/btc/#alerts"})
        elif path in ("/diet", "/btc"):
            self.respond(308, b"", extra={"Location": path + "/" + ("?" + parsed.query if parsed.query else "")})
        elif path.startswith(("/diet/", "/btc/")):
            self.proxy()
        else:
            self.static(path)

    def do_POST(self):
        if not self.local():
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/services/ensure":
            if self.headers.get("X-Terminal-Request") != "1" or self.headers.get("Content-Length", "0") != "0" or self.headers.get("Transfer-Encoding"):
                self.close_connection = True
                self.json(403, {"error": "请通过本机启动器恢复服务。"})
                return
            self.json(202, {"started": self.server.ensure_dependencies_async()})
        elif path.startswith(("/diet/", "/btc/")):
            self.proxy()
        else:
            self.close_connection = True
            self.json(405, {"error": "此接口不支持该操作。"})

    def do_DELETE(self):
        # Preserve the existing options AI's cancel-job action. Diet edits use
        # its validated POST operations and do not expose arbitrary deletion.
        if not self.local():
            return
        if (not urllib.parse.urlsplit(self.path).path.startswith("/btc/")
                or self.headers.get("Transfer-Encoding")
                or self.headers.get("Content-Length", "0") != "0"):
            self.close_connection = True
            self.json(405, {"error": "此接口不支持该操作。"})
            return
        self.proxy()

    def static(self, path):
        decoded = urllib.parse.unquote(path)
        name = "index.html" if decoded == "/" else decoded.lstrip("/")
        # Only public UI assets are exposed; project code and local logs are not.
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", name) or ".." in name.split("/") or name.startswith("."):
            self.json(404, {"error": "页面不存在。"})
            return
        public = (ROOT / "frontend").resolve()
        candidate = (public / name).resolve()
        if public not in candidate.parents or not candidate.is_file() or candidate.suffix.lower() not in (".html", ".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".webp", ".ico", ".woff2"):
            self.json(404, {"error": "页面不存在。"})
            return
        content_type = {".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml"}.get(candidate.suffix.lower()) or mimetypes.types_map.get(candidate.suffix.lower(), "application/octet-stream")
        if content_type.startswith("text/"):
            content_type += "; charset=utf-8"
        self.respond(200, candidate.read_bytes(), content_type)

    def proxy(self):
        parsed = urllib.parse.urlsplit(self.path)
        prefix = "/diet" if parsed.path.startswith("/diet/") else "/btc"
        port = self.server.config.diet_port if prefix == "/diet" else self.server.config.btc_port
        upstream_path = parsed.path[len(prefix):] + ("?" + parsed.query if parsed.query else "")
        body = None
        if self.command == "POST":
            lengths = self.headers.get_all("Content-Length", [])
            try:
                if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
                    raise ValueError()
                length = int(lengths[0])
                if not 0 <= length <= MAX_BODY:
                    raise ValueError()
                self.connection.settimeout(10)
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError()
            except (ValueError, OSError):
                self.close_connection = True
                self.json(400, {"error": "请求内容无效或过大。"})
                return
        origin = "http://127.0.0.1:%s" % port
        headers = {"Host": "127.0.0.1:%s" % port, "Accept-Encoding": "identity"}
        for key in ("Content-Type", "Accept", "X-Terminal-Request", "Last-Event-ID"):
            if self.headers.get(key):
                headers[key] = self.headers[key]
        if self.headers.get("Origin"):
            headers["Origin"] = origin
        if self.headers.get("Referer"):
            headers["Referer"] = origin + upstream_path
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=150)
        try:
            connection.request(self.command, upstream_path, body=body, headers=headers)
            response = connection.getresponse()
            content_type = response.getheader("Content-Type", "application/octet-stream")
            if "text/event-stream" in content_type:
                self.send_response(response.status)
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                while True:
                    chunk = response.read1(16384)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                return
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise ValueError("response_too_large")
            data = rewrite_asset(data, content_type, prefix)
            extra = {}
            location = response.getheader("Location")
            if location and location.startswith("/") and not location.startswith("//"):
                extra["Location"] = prefix + location
            self.respond(response.status, data, content_type, extra)
        except (OSError, ValueError, http.client.HTTPException):
            if not self.close_connection:
                self.json(502, {"error": {"code": "SERVICE_UNAVAILABLE", "message": "饮食日记暂未连接，请稍后重试。" if prefix == "/diet" else "比特币终端暂未连接，请稍后重试。"}})
        finally:
            connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="本机个人总终端")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--diet-port", type=int, default=4173)
    parser.add_argument("--btc-port", type=int, default=8766)
    parser.add_argument("--diet-root")
    parser.add_argument("--options-root")
    parser.add_argument("--no-dependencies", action="store_true")
    args = parser.parse_args(argv)
    if any(not 1 <= port <= 65535 for port in (args.port, args.diet_port, args.btc_port)):
        parser.error("端口必须在1到65535之间。")
    config = Config(args.port, args.diet_port, args.btc_port, args.diet_root, args.options_root)
    server = TerminalServer(config)
    if not args.no_dependencies:
        server.ensure_dependencies_async()
    print("个人终端：http://127.0.0.1:%s" % config.port, flush=True)
    try:
        server.serve_forever(poll_interval=.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
