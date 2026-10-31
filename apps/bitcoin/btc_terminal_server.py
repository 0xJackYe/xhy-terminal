"""Local Bitcoin dashboard; optional mail credentials stay in a local vault."""
import argparse
import datetime as dt
import json
import math
import mimetypes
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from btc_alert import BtcAlertMonitor, retry_after_seconds
from dashboard_server import DashboardHandler, DashboardServer, MarketCache

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "terminal" / "dist"
WALLET = ROOT / "terminal" / "wallet"
DATA = ROOT / "terminal" / "data"
OPTIONS_STATIC = ROOT / "dashboard" / "dist"
ROUTES = {
    "/": STATIC / "index.html",
    "/index.html": STATIC / "index.html",
    "/terminal.css": STATIC / "terminal.css",
    "/terminal.js": STATIC / "terminal.js",
    "/okx-wallet.js": STATIC / "okx-wallet.js",
    "/okx-wallet.css": STATIC / "okx-wallet.css",
    "/combined-wallet.js": STATIC / "combined-wallet.js",
    "/combined-wallet.css": STATIC / "combined-wallet.css",
    "/btc-cost.js": STATIC / "btc-cost.js",
    "/btc-cost.css": STATIC / "btc-cost.css",
    "/crypto-portfolio.js": STATIC / "crypto-portfolio.js",
    "/crypto-portfolio.css": STATIC / "crypto-portfolio.css",
    "/wallet.html": WALLET / "wallet.html",
    "/audio/alert.wav": ROOT / "terminal" / "audio" / "alert.wav",
    "/audio/alert-2.wav": ROOT / "terminal" / "audio" / "alert-2.wav",
    "/audio/alert-3.wav": ROOT / "terminal" / "audio" / "alert-3.wav",
}
OPTIONS_ASSETS = ("styles.css", "anthropic.css", "payoff.css", "portfolio.css", "combo.css",
                  "payoff.js", "portfolio.js", "payoff-ui.js", "portfolio-ui.js", "app.js", "terminal-embed.js",
                  "risk-metrics.js", "risk-ui.js", "risk.css",
                  "sell-put-engine.js", "sell-put-ui.js", "sell-put.css",
                  "seller-screen-engine.js", "seller-screen-ui.js", "seller-screen.css",
                  "option-ai-ui.js", "option-ai.css")
ROUTES.update({"/" + name: OPTIONS_STATIC / name for name in OPTIONS_ASSETS})


def strict_json_object(pairs):
    """Reject ambiguous settings instead of silently keeping a duplicate key."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("请求不允许重复 JSON 字段。")
        result[key] = value
    return result


def invalid_json_constant(value):
    raise ValueError("请求包含无效的 JSON 数字。")


def replay_recent_email_alerts(monitor, email_service, now_ms=None):
    """Retry only durable recent alerts after a temporary local outbox lock.

    The service additionally checks its enable time and deduplicates alert IDs.
    This is invoked outside the market-data lock by a separate small worker.
    """
    if email_service is None:
        return
    try:
        snapshot = monitor.read()
    except Exception:
        return
    if snapshot.get("storage_error"):
        return
    now = int(time.time() * 1000) if now_ms is None else now_ms
    for alert in snapshot.get("alerts", [])[-100:]:
        if not isinstance(alert, dict) or alert.get("kind") != "market":
            continue
        stamp = alert.get("local_at_ms", alert.get("at_ms"))
        if (isinstance(stamp, bool) or not isinstance(stamp, (int, float))
                or not math.isfinite(stamp) or not -2000 <= now - stamp <= 15 * 60 * 1000):
            continue
        try:
            email_service.enqueue(alert)
        except Exception:
            # The next pass retries a busy local store; SMTP delivery and its
            # uncertain-result policy remain entirely owned by the outbox.
            pass


# Fields the portal overview reads from the live stream (?view=market).
MARKET_VIEW_KEYS = ("market", "settings", "revision", "instance_id", "server_time_ms")


def market_view(value):
    """The live quote, alert rules and recent alerts, without the chart history."""
    view = {key: value[key] for key in MARKET_VIEW_KEYS if key in value}
    view["alerts"] = (value.get("alerts") or [])[-8:]
    return view


def history_delta(value, sent):
    """Send the per-minute chart history in full once, then only its newest points.

    Between one-second snapshots only the latest minute changes, so resending up to
    1,441 points every second costs about 90 KB/s per open page. When the earlier
    points this connection already holds are unchanged, the snapshot carries
    ``history_tail`` (the replaced last minute and any new one) instead; any other
    change (day rollover, trimming, a REST bootstrap) resends the full history.
    Returns the snapshot to send and the history the client now holds."""
    history = value.get("history")
    if not isinstance(history, list):
        return value, sent
    if sent and history and len(sent) <= len(history) <= len(sent) + 1 and history[:len(sent) - 1] == sent[:-1]:
        delta = dict(value)
        del delta["history"]
        delta["history_tail"] = history[len(sent) - 1:]
        return delta, history
    return value, history


def embedded_options_html():
    """Keep the original options page and attach only a same-origin frame bridge."""
    markup = (OPTIONS_STATIC / "index.html").read_text(encoding="utf-8")
    markup = markup.replace('href="/" aria-label="BTC 期权看板首页"',
                            'href="/options.html" aria-label="BTC 期权看板首页"')
    return markup.replace("</body>", '<script src="/terminal-embed.js"></script>\n</body>').encode("utf-8")


class ProxyError(Exception):
    def __init__(self, message, status=502, retry_after=None):
        super().__init__(message)
        self.status, self.retry_after = status, retry_after


class WalletProxy:
    """A fixed-provider, cached, public-data relay for this wallet only."""
    def __init__(self, address, opener=urllib.request.urlopen, clock=time.monotonic):
        self.address, self.opener, self.clock = address, opener, clock
        self._lock = threading.Lock()
        self._cache = {}
        self._backoff = {}
        self._requests = {}

    def target(self, params):
        if any(len(values) != 1 for values in params.values()):
            raise ValueError("不允许重复参数。")
        resource = params.get("resource", [""])[0]
        allowed = {
            "address": {"resource", "address"},
            "transactions": {"resource", "address", "cursor"},
            "history": {"resource"}, "quote": {"resource"},
            "fx": {"resource", "from", "to"},
        }
        if resource not in allowed or not set(params) <= allowed[resource]:
            raise ValueError("未知的余额数据请求。")
        if resource in ("address", "transactions"):
            if params.get("address", [""])[0] != self.address or not self.address:
                raise ValueError("只允许读取当前终端的钱包地址。")
            base = "https://mempool.space/api/address/" + self.address
            if resource == "transactions":
                cursor = params.get("cursor", [""])[0]
                if cursor and not re.fullmatch(r"[0-9a-fA-F]{64}", cursor):
                    raise ValueError("交易游标无效。")
                base += "/txs/chain" + ("/" + cursor if cursor else "")
            return "mempool", base, 60
        if resource == "history":
            return "mempool", "https://mempool.space/api/v1/historical-price?currency=USD", 300
        if resource == "quote":
            return "mempool", "https://mempool.space/api/v1/prices", 30
        dates = []
        for key in ("from", "to"):
            value = params.get(key, [""])[0]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError("汇率日期无效。")
            dates.append(dt.date.fromisoformat(value))
        if dates[0] > dates[1] or (dates[1] - dates[0]).days > 3660:
            raise ValueError("汇率日期范围无效。")
        query = urllib.parse.urlencode({"from": str(dates[0]), "to": str(dates[1]),
                                       "base": "USD", "quotes": "CNY", "providers": "ecb"})
        return "frankfurter", "https://api.frankfurter.dev/v2/rates?" + query, 3600

    def read(self, params):
        provider, url, ttl = self.target(params)
        with self._lock:
            request_lock = self._requests.setdefault(url, threading.Lock())
        # Identical requests share a result; a slow FX provider cannot hold up
        # the independent address, transaction and price requests.
        with request_lock:
            with self._lock:
                now = self.clock()
                cached = self._cache.get(url)
                if cached and now - cached[0] < ttl:
                    return cached[1]
                retry = self._backoff.get(provider, 0) - now
                if retry > 0:
                    raise ProxyError("数据源限流，稍后重试。", 503, int(retry) + 1)
            request = urllib.request.Request(url, headers={"User-Agent": "LocalBitcoinTerminal/1.0", "Accept": "application/json"})
            # Brief network resets should not break an entire synchronized
            # address snapshot. Retry one GET within a shared time budget;
            # malformed data, authorization errors and rate limits never retry.
            deadline = self.clock() + 18
            for attempt in range(2):
                remaining = deadline - self.clock()
                if remaining <= 0:
                    raise ProxyError("余额数据源查询超时，保留现有快照。")
                try:
                    with self.opener(request, timeout=min(12, remaining)) as response:
                        payload = response.read(8 * 1024 * 1024 + 1)
                    if len(payload) > 8 * 1024 * 1024:
                        raise ProxyError("余额数据响应超过上限。")
                    json.loads(payload)
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code in (418, 429):
                        delay = math.ceil(max(30, retry_after_seconds(
                            exc.headers.get("Retry-After"),
                            default=3600 if exc.code == 418 else 60)))
                        with self._lock:
                            self._backoff[provider] = max(
                                self._backoff.get(provider, 0), self.clock() + delay)
                        if exc.fp is not None:
                            exc.close()
                        raise ProxyError("数据源限流，保留现有快照。", 503, delay) from exc
                    if exc.fp is not None:
                        exc.close()
                    if attempt == 0 and 500 <= exc.code < 600 and self.clock() < deadline:
                        continue
                    raise ProxyError("余额数据源暂时不可用（HTTP %s）。" % exc.code) from exc
                except OSError as exc:
                    if attempt == 0 and self.clock() < deadline:
                        continue
                    raise ProxyError("余额数据源连接失败，保留现有快照。") from exc
                except ValueError as exc:
                    raise ProxyError("余额数据源格式异常，保留现有快照。") from exc
            with self._lock:
                self._cache[url] = (self.clock(), payload)
            return payload


class TerminalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, monitor, wallet_proxy, options_cache=None, email_service=None, ai_service=None, okx_service=None, combined_service=None, cost_service=None):
        self.monitor, self.wallet_proxy = monitor, wallet_proxy
        self.cache = options_cache
        self.email_service = email_service
        self.ai_service = ai_service
        self.okx_service = okx_service
        self.combined_service = combined_service
        self.cost_service = cost_service
        self.pnl_service = None
        self.portfolio_service = None
        self.stopping = threading.Event()
        super().__init__(address, TerminalHandler)


class TerminalHandler(BaseHTTPRequestHandler):
    server_version = "BitcoinTerminal/2.0"
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except (ConnectionError, TimeoutError):
            # A closed browser also closes a keep-alive request socket. This
            # is a normal client lifecycle, not an application exception.
            self.close_connection = True

    def log_message(self, fmt, *args):
        pass

    def respond(self, status, payload, content_type="application/json; charset=utf-8", retry_after=None):
        if status >= 400:
            # Consume a bounded, already-sent rejected request body before
            # closing. Otherwise Windows can reset the socket and discard the
            # JSON error response while the client is still writing its body.
            if self.command == "POST" and not getattr(self, "_body_consumed", False):
                try:
                    rejected_length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    rejected_length = 0
                budget = rejected_length if 0 < rejected_length <= 65536 else 65536
                previous_timeout = self.connection.gettimeout()
                try:
                    self.connection.settimeout(.15)
                    while budget:
                        chunk = self.rfile.read1(min(8192, budget))
                        if not chunk:
                            break
                        budget -= len(chunk)
                except OSError:
                    pass
                finally:
                    self._body_consumed = True
                    self.connection.settimeout(previous_timeout)
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        if self.close_connection:
            self.send_header("Connection", "close")
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except OSError:
            # Navigating away can close an in-flight response; the next page
            # request still uses the same healthy server and market workers.
            self.close_connection = True

    def json(self, status, value, **kwargs):
        self.respond(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"), **kwargs)

    def local(self):
        # Exact host/port validation also blocks DNS rebinding.
        port = self.server.server_address[1]
        valid = {"127.0.0.1:%s" % port, "localhost:%s" % port}
        if port == 80:
            valid |= {"127.0.0.1", "localhost"}
        host = self.headers.get("Host", "").lower()
        if len(self.headers.get_all("Host", [])) != 1 or host not in valid:
            self.json(403, {"error": "终端仅允许本机访问。"})
            return False
        origin = self.headers.get("Origin")
        if len(self.headers.get_all("Origin", [])) > 1 or (origin is not None and origin != "http://" + host):
            self.json(403, {"error": "不允许其他网站读取或修改本机终端。"})
            return False
        return True

    def do_GET(self):
        if not self.local():
            return
        from option_ai_http import handle_ai
        if handle_ai(self):
            return
        from okx_wallet_http import handle_okx
        if handle_okx(self):
            return
        from crypto_portfolio_http import handle_portfolio
        if handle_portfolio(self):
            return
        from btc_cost_http import handle_btc_cost
        if handle_btc_cost(self):
            return
        from btc_pnl_service import handle_btc_pnl
        if handle_btc_pnl(self):
            return
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/terminal":
            self.json(200, self.server.monitor.read())
        elif url.path == "/api/terminal/email":
            if self.server.email_service is None:
                self.json(503, {"error": "邮件提醒服务尚未启动。"})
            else:
                try:
                    status = self.server.email_service.read_public()
                    queue_error = self.server.monitor.read().get("email_queue_error")
                    if queue_error:
                        status["last_error"] = queue_error
                    self.json(200, status)
                except Exception:
                    # Provider/storage exceptions must neither leak private
                    # details nor interrupt unrelated terminal requests.
                    self.json(503, {"error": "邮件状态暂时无法读取，请稍后重试。"})
        elif url.path == "/api/terminal/audio-status":
            from native_audio_diagnostics import get_audio_status
            self.json(200, get_audio_status())
        elif url.path == "/api/terminal/events":
            self.events()
        elif url.path == "/api/focused-market":
            if self.server.cache is None:
                self.json(503, {"error": "期权行情尚未启动。"})
                return
            try:
                query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
                if set(query) != {"symbols"} or len(query["symbols"]) != 1:
                    raise ValueError("请提供一组需要读取的合约。")
                symbols = query["symbols"][0].split(",")
                if not 1 <= len(symbols) <= 8 or any(not symbol for symbol in symbols):
                    raise ValueError("每次可读取 1 至 8 个有效 BTC 期权合约。")
                self.json(200, self.server.cache.read_focused(symbols))
            except ValueError as exc:
                self.json(400, {"error": str(exc)})
        elif url.path == "/api/mark-watch":
            if self.server.cache is None:
                self.json(503, {"error": "期权行情尚未启动。"})
                return
            try:
                query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
                if set(query) != {"symbols"} or len(query["symbols"]) != 1:
                    raise ValueError("请提供一组需要同步的合约。")
                symbols = query["symbols"][0].split(",")
                if not 1 <= len(symbols) <= 8 or any(not symbol for symbol in symbols):
                    raise ValueError("每次可关注 1 至 8 个有效 BTC 期权合约。")
                self.json(200, {"accepted": self.server.cache.watch_marks(symbols)})
            except ValueError as exc:
                self.json(400, {"error": str(exc)})
        elif url.path in ("/api/market", "/api/events"):
            if self.server.cache is None:
                self.json(503, {"error": "期权行情尚未启动。"})
                return
            if url.path == "/api/events":
                DashboardHandler._events(self)
            else:
                if urllib.parse.parse_qs(url.query).get("refresh") == ["1"]:
                    self.server.cache.request_refresh()
                self.json(200, self.server.cache.read())
        elif url.path == "/options.html":
            self.respond(200, embedded_options_html(), "text/html; charset=utf-8")
        elif url.path == "/api/wallet/combined":
            if self.server.combined_service is None:
                self.json(503, {"error": "合计钱包服务尚未启动。"})
            elif url.query:
                self.json(400, {"error": "合计钱包不接受查询参数。"})
            else:
                # Select both caches under one active account context. Reads
                # never trigger exchange requests or accounting in HTTP threads.
                okx = self.server.okx_service
                if okx is not None:
                    with okx.lock:
                        view = self.server.combined_service.read_public()
                        if self.server.pnl_service is not None:
                            view['lifetime_pnl'] = self.server.pnl_service.read_public()
                else:
                    view = self.server.combined_service.read_public()
                self.json(200, view)
        elif url.path == "/api/wallet/proxy":
            try:
                params = urllib.parse.parse_qs(url.query, keep_blank_values=True)
                payload = self.server.wallet_proxy.read(params)
                self.respond(200, payload)
            except ValueError as exc:
                self.json(400, {"error": str(exc)})
            except ProxyError as exc:
                self.json(exc.status, {"error": str(exc)}, retry_after=exc.retry_after)
        else:
            path = urllib.parse.unquote(url.path)
            candidate = ROUTES.get(path)
            if not candidate or not candidate.is_file():
                self.json(404, {"error": "页面不存在。"})
                return
            # The built-in table is sufficient for local assets; guess_type()
            # cold-starts a Windows registry scan on the first HTTP request.
            suffix = candidate.suffix.lower()
            content_type = mimetypes.types_map.get(suffix, "application/octet-stream")
            if suffix == ".js":
                content_type = "text/javascript"
            elif suffix == ".wav":
                content_type = "audio/wav"
            if content_type.startswith("text/"):
                content_type += "; charset=utf-8"
            self.respond(200, candidate.read_bytes(), content_type)

    def do_POST(self):
        if not self.local():
            return
        from option_ai_http import handle_ai
        if handle_ai(self):
            return
        from okx_wallet_http import handle_okx
        if handle_okx(self):
            return
        from crypto_portfolio_http import handle_portfolio
        if handle_portfolio(self):
            return
        path = urllib.parse.urlsplit(self.path).path
        if path not in ("/api/terminal/settings", "/api/terminal/test", "/api/terminal/silence",
                        "/api/terminal/email/settings", "/api/terminal/email/test"):
            self.json(405, {"error": "此路径不支持写入。"})
            return
        if (len(self.headers.get_all("X-Terminal-Request", [])) != 1
                or len(self.headers.get_all("Content-Type", [])) != 1
                or self.headers.get("X-Terminal-Request") != "1"
                or self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
            self.json(403, {"error": "请通过终端页面操作。"})
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("不支持流式请求体。")
            if len(self.headers.get_all("Content-Length", [])) != 1:
                raise ValueError("请求必须提供唯一的请求体长度。")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("请求体大小无效。")
            self.connection.settimeout(5)
            request_body = self.rfile.read(length)
            self._body_consumed = True
            body = json.loads(request_body, object_pairs_hook=strict_json_object,
                              parse_constant=invalid_json_constant)
            if not isinstance(body, dict):
                raise ValueError("请求必须是对象。")
            if path.startswith("/api/terminal/email/"):
                if self.server.email_service is None:
                    self.json(503, {"error": "邮件提醒服务尚未启动。"})
                    return
                if path == "/api/terminal/email/settings":
                    if set(body) - {"email", "authorization_code", "enabled"}:
                        raise ValueError("不支持的邮件设置。")
                    self.server.email_service.configure(**body)
                elif body:
                    raise ValueError("测试邮件操作不接受参数。")
                else:
                    self.server.email_service.enqueue_test()
                self.json(200, self.server.email_service.read_public())
                return
            if path == "/api/terminal/settings":
                self.server.monitor.configure(body)
            elif path == '/api/terminal/test' and body:
                if set(body) != {'sound_level'} or type(body['sound_level']) is not int or body['sound_level'] not in (1, 2, 3):
                    raise ValueError('请指定 1、2 或 3 档铃声。')
                self.server.monitor.test_alarm(sound_level=body['sound_level'])
            elif body:
                raise ValueError("该操作不接受参数。")
            elif path == "/api/terminal/test":
                self.server.monitor.test_alarm()
            else:
                self.server.monitor.silence()
            self.json(200, self.server.monitor.read())
        except (ValueError, TypeError, TimeoutError) as exc:
            self.json(400, {"error": str(exc)})
        except RuntimeError:
            self.json(503, {"error": "监控正在停止，请重新启动比特币终端。"})
        except (OSError, sqlite3.Error):
            # Never echo a private configuration path or provider response.
            self.json(503, {"error": "邮件配置暂未保存，请检查本机存储后重试。"})

    def events(self):
        view = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("view", [""])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.close_connection = True
        try:
            self.connection.settimeout(10)
            self.wfile.write(b"retry: 2000\n\n")
            sent = None
            while not self.server.stopping.is_set():
                value = self.server.monitor.read()
                if view == "market":
                    value = market_view(value)
                else:
                    value, sent = history_delta(value, sent)
                payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
                # Detection runs per trade; browser charts update once per second.
                self.wfile.write(b"event: snapshot\ndata: " + payload + b"\n\n")
                self.wfile.flush()
                self.server.stopping.wait(1)
        except (OSError, TimeoutError):
            pass

    def unsupported(self):
        self.json(405, {"error": "此操作不受支持。"})

    def do_DELETE(self):
        if not self.local():
            return
        from option_ai_http import handle_ai
        if not handle_ai(self):
            self.unsupported()

    do_PUT = do_PATCH = do_OPTIONS = do_HEAD = unsupported


def wallet_address():
    snapshot = DATA / "bitcoin-balance-snapshot.json"
    if not snapshot.is_file():
        raise ValueError("缺少钱包初始快照。请先生成余额页面。")
    data = json.loads(snapshot.read_text(encoding="utf-8-sig"))
    address = data.get("address", "")
    if not re.fullmatch(r"[a-zA-Z0-9]{26,90}", address):
        raise ValueError("钱包快照地址无效。")
    return address


def main():
    parser = argparse.ArgumentParser(description="本机 BTC 价格警报、期权看板和钱包走势终端。")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--legacy-options-port", type=int, default=8765,
                        help="旧期权看板的兼容端口，设为 0 可关闭。")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间。")
    if not 0 <= args.legacy_options_port <= 65535:
        parser.error("兼容端口必须在 0 到 65535 之间。")
    if any(not path.is_file() for path in ROUTES.values()):
        parser.error("缺少终端页面文件，请先构建余额页面。")
    try:
        from alert_email import EmailAlertService
        email_service = EmailAlertService(DATA / "email-notifications")
    except Exception:
        # A notification vault/database problem must not take down quotes,
        # local alarms, or the rest of the trading dashboard.
        email_service = None
        print("邮件提醒暂未启动，请检查本机存储；行情和本机警报继续运行。", flush=True)
    monitor = BtcAlertMonitor(state_path=DATA / "terminal-alert-state.json",
                              alert_sink=email_service.enqueue if email_service is not None else None)
    options_cache = MarketCache()
    try:
        from option_ai_service import OptionAIService
        ai_service = OptionAIService(options_cache.read)
    except Exception:
        ai_service = None
        print("AI 筛选暂未启动；行情、本机警报及钱包继续运行。", flush=True)
    try:
        from okx_wallet_service import OKXWalletService
        okx_service = OKXWalletService()
    except Exception:
        okx_service = None
    try:
        server = TerminalServer(("127.0.0.1", args.port), monitor, WalletProxy(wallet_address()), options_cache,
                                email_service=email_service, ai_service=ai_service, okx_service=okx_service)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    legacy_server = None
    if args.legacy_options_port and args.legacy_options_port != args.port:
        try:
            legacy_server = DashboardServer(("127.0.0.1", args.legacy_options_port), options_cache,
                                             ai_service=ai_service)
        except OSError:
            print("旧期权兼容端口已被占用，三个模块仍可通过统一终端访问。", flush=True)
        else:
            threading.Thread(target=legacy_server.serve_forever, name="options-compatibility", daemon=True).start()
    if email_service is not None:
        try:
            email_service.start()
        except Exception:
            server.email_service = None
            monitor._alert_sink = None
            try:
                email_service.stop()
            except Exception:
                pass
            email_service = None
            print("邮件提醒暂未启动；行情和本机警报继续运行。", flush=True)
    replay_recent_email_alerts(monitor, email_service)
    monitor.start()
    if email_service is not None:
        def reconcile_email_queue():
            while not server.stopping.wait(5):
                replay_recent_email_alerts(monitor, email_service)
        threading.Thread(target=reconcile_email_queue, name="btc-alert-email-reconcile", daemon=True).start()
    # Both the integrated page and optional old URL share this one market cache.
    options_cache.start()
    if ai_service is not None:
        ai_service.start_discovery()
    if okx_service is not None:
        okx_service.start()
        try:
            from btc_cost_tracker import BTCCostTracker
            server.cost_service = BTCCostTracker(okx_service)
            server.cost_service.start()
        except Exception:
            server.cost_service = None
        try:
            from combined_wallet_service import CombinedWalletService
            server.combined_service = CombinedWalletService(okx_service, server.wallet_proxy)
            server.combined_service.start()
        except Exception:
            server.combined_service = None
        if server.cost_service is not None and server.combined_service is not None:
            try:
                from btc_pnl_service import BTCPnLService
                server.pnl_service = BTCPnLService(server.cost_service, server.combined_service)
                server.pnl_service.start()
            except Exception:
                server.pnl_service = None
        try:
            from crypto_portfolio_service import CryptoPortfolioService
            server.portfolio_service = CryptoPortfolioService(okx_service, server.combined_service)
            server.portfolio_service.start()
        except Exception:
            server.portfolio_service = None
    url = "http://127.0.0.1:%s/" % args.port
    print("比特币终端：" + url, flush=True)
    print("价格警报按网页中保存的分档阈值触发。保持此程序运行及电脑开机联网。", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已关闭比特币监控。")
    finally:
        server.stopping.set()
        if server.pnl_service is not None:
            server.pnl_service.stop()
        if server.cost_service is not None:
            server.cost_service.stop()
        if server.portfolio_service is not None:
            server.portfolio_service.stop()
        if server.combined_service is not None:
            server.combined_service.stop()
        if okx_service is not None:
            okx_service.stop()
        if ai_service is not None:
            ai_service.stop()
        monitor.stop()
        if email_service is not None:
            try:
                email_service.stop()
            except Exception:
                pass
        options_cache.stop()
        if legacy_server is not None:
            legacy_server.shutdown()
            legacy_server.server_close()
        server.server_close()
    return 0


if __name__ == "__main__":
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
