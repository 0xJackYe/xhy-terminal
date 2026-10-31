"""A dependency-free CMD companion for the local personal terminal.

Uses the same loopback API and durable diary as the website. No credentials,
trading calls, alert changes, or independent market workers live in this client.
"""
import argparse
import ctypes
import datetime as dt
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import unicodedata
import uuid

ROOT = Path(__file__).resolve().parent
BEIJING = dt.timezone(dt.timedelta(hours=8))
DELHI = dt.timezone(dt.timedelta(hours=5, minutes=30))
try:
    from zoneinfo import ZoneInfo
    DENVER = ZoneInfo("America/Denver")
except Exception:  # Windows has no time zone database unless the tzdata package is installed.
    DENVER = None
SHIFT_START, SHIFT_END = 23, 7  # Beijing hours of the night shift
SETTINGS = ROOT / ".local" / "cli-settings.json"
MAX_RESPONSE = 8 * 1024 * 1024
STATUS = {"online": "已连接", "empty": "暂无记录", "stale": "数据延迟", "offline": "未连接"}
PALETTES = {
    "dark": {"bg": (25, 25, 24), "fg": (242, 240, 233), "muted": (185, 181, 169), "accent": (237, 164, 133), "good": (161, 201, 165), "bad": (245, 165, 160)},
    "light": {"bg": (250, 249, 246), "fg": (32, 32, 29), "muted": (92, 87, 78), "accent": (151, 65, 38), "good": (43, 101, 49), "bad": (165, 38, 40)},
}


def plain(value):
    """Data cannot inject terminal commands, colors, or invisible C0/C1 controls."""
    text = str(value if value is not None else "—")
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    return "".join(c for c in text if c == "\n" or (unicodedata.category(c) not in ("Cc", "Cf", "Cs")))


def cell_width(value):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in plain(value))


def wrap_cells(value, width):
    width = max(2, width)
    lines = []
    for paragraph in plain(value).replace("\t", "    ").split("\n"):
        row, used = "", 0
        for char in paragraph:
            size = 0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in "WF" else 1
            if used + size > width:
                lines.append(row)
                row, used = "", 0
            row += char
            used += size
        lines.append(row)
    return lines


def number(value, digits=2):
    if isinstance(value, bool) or value is None or value == "" or not isinstance(value, (int, float, str)):
        return "—"
    try:
        value = float(value)
    except ValueError:
        return "—"
    if not math.isfinite(value):
        return "—"
    return f"{value:,.{digits}f}".rstrip("0").rstrip(".") if digits else f"{value:,.0f}"


def money(value, currency="$ "):
    return currency + number(value) if number(value) != "—" else "—"


def diary_today():
    """Diary days run on UTC+0 (they change at 08:00 Beijing time)."""
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def mountain_offset(utc):
    """Mountain Time's UTC offset in hours: -6 from the second Sunday of March to the
    first Sunday of November (US rules since 2007, switching at 02:00 local), else -7."""
    utc = utc.astimezone(dt.timezone.utc)

    def sunday_from(month, day):
        start = dt.date(utc.year, month, day)
        return start + dt.timedelta(days=(6 - start.weekday()) % 7)

    begins = dt.datetime.combine(sunday_from(3, 8), dt.time(9), dt.timezone.utc)
    ends = dt.datetime.combine(sunday_from(11, 1), dt.time(8), dt.timezone.utc)
    return -6 if begins <= utc < ends else -7


def denver_time(moment):
    if DENVER is not None:
        return moment.astimezone(DENVER)
    return moment.astimezone(dt.timezone(dt.timedelta(hours=mountain_offset(moment))))


def utc_label(moment):
    minutes = int(moment.utcoffset().total_seconds() // 60)
    hours, rest = divmod(abs(minutes), 60)
    return "UTC" + ("-" if minutes < 0 else "+") + str(hours) + (f":{rest:02d}" if rest else "")


def work_status(now=None):
    """The night shift runs 23:00-07:00 Beijing time on Monday to Friday nights. A shift
    belongs to the day it starts: Friday's ends on Saturday morning, and Saturday and
    Sunday nights are free. Returns (working, label)."""
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(BEIJING)
    started = now.date() if now.hour >= SHIFT_START else now.date() - dt.timedelta(days=1) if now.hour < SHIFT_END else None
    if started is not None and started.weekday() < 5:
        return True, "工作中"
    return False, "周末" if now.weekday() >= 5 else "休息"


def date_value(value):
    try:
        if dt.date.fromisoformat(value).isoformat() != value:
            raise ValueError
        return value
    except (ValueError, TypeError):
        raise ValueError("日期请用 YYYY-MM-DD，例如 2026-10-26。") from None


def diary_hash(snapshot):
    return hashlib.sha256(json.dumps(snapshot.get("diary"), sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


class APIError(Exception):
    def __init__(self, message, status=0):
        super().__init__(plain(message))
        self.status = status


class API:
    def __init__(self, port=8780):
        if not 1 <= port <= 65535:
            raise ValueError("端口必须在 1 到 65535 之间。")
        self.port = port

    def request(self, path, payload=None):
        if path not in ("/api/overview", "/diet/api/diary", "/diet/api/diary-chat", "/diet/api/diary/undo"):
            raise ValueError("只允许本机个人终端接口。")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=75 if payload is not None else 12)
        headers = {"Accept": "application/json", "Origin": f"http://127.0.0.1:{self.port}", "X-Terminal-Request": "1"}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            connection.request("POST" if payload is not None else "GET", path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise APIError("返回内容过大，未能读取。")
            try:
                result = json.loads(data)
            except (ValueError, UnicodeError):
                raise APIError("本机服务没有返回有效数据。", response.status) from None
            if not isinstance(result, dict):
                raise APIError("本机数据格式不正确。", response.status)
            if response.status != 200:
                error = result.get("error")
                message = error.get("message") if isinstance(error, dict) else error
                raise APIError(message or "本机服务暂时不可用。", response.status)
            return result
        except (OSError, http.client.HTTPException):
            raise APIError("连接中断或等待超时；如刚提交日记，保存结果尚未确认，请用 /retry 查询同一请求。") from None
        finally:
            connection.close()


class Console:
    def __init__(self, theme="dark", color=False, stream=None, width=None):
        self.theme, self.color = theme, color
        self.stream = stream or sys.stdout
        self.fixed_width = width

    @property
    def width(self):
        return max(12, min(104, self.fixed_width or shutil.get_terminal_size((88, 28)).columns - 1))

    def colorize(self, text, tone="fg"):
        if not self.color:
            return text
        p = PALETTES[self.theme]
        return "\033[48;2;%s;%s;%sm\033[38;2;%s;%s;%sm%s\033[0m" % (*p["bg"], *p[tone], text)

    def line(self, text="", tone="fg"):
        for row in wrap_cells(text, self.width):
            self.stream.write(self.colorize(row + " " * (self.width - cell_width(row)), tone).rstrip(" ") + "\n")
        self.stream.flush()

    def box(self, title, rows):
        inner = self.width - 4
        self.line("╭" + "─" * (self.width - 2) + "╮", "accent")
        for index, text in enumerate([title, "", *rows]):
            for row in wrap_cells(text, inner):
                self.line("│ " + row + " " * (inner - cell_width(row)) + " │", "accent" if index == 0 else "fg")
        self.line("╰" + "─" * (self.width - 2) + "╯", "accent")

    def clear(self):
        if self.color:
            p = PALETTES[self.theme]
            self.stream.write("\033[48;2;%s;%s;%sm\033[2J\033[H" % p["bg"])

    def prompt(self):
        text = "你 › "
        if self.color:
            p = PALETTES[self.theme]
            text = "\033[48;2;%s;%s;%sm\033[38;2;%s;%s;%sm%s" % (*p["bg"], *p["fg"], text)
        try:
            return input(text)
        finally:
            if self.color:
                self.stream.write("\033[0m")


def enable_ansi(stream):
    if not stream.isatty():
        return False
    if os.name != "nt":
        return True
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetStdHandle.argtypes = [ctypes.c_ulong]
        kernel.GetStdHandle.restype = ctypes.c_void_p
        kernel.GetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.SetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        handle = kernel.GetStdHandle(-11 & 0xFFFFFFFF)
        mode = ctypes.c_ulong()
        return bool(kernel.GetConsoleMode(handle, ctypes.byref(mode)) and kernel.SetConsoleMode(handle, mode.value | 4))
    except (OSError, AttributeError):
        return False


def load_settings():
    try:
        value = json.loads(SETTINGS.read_text(encoding="utf-8"))
        return {"theme": value.get("theme") if value.get("theme") in PALETTES else "dark"}
    except (OSError, ValueError, AttributeError):
        return {"theme": "dark"}


class Terminal:
    def __init__(self, api, console, settings=None):
        self.api, self.out = api, console
        self.settings = settings or {"theme": console.theme}
        self.snapshot, self.history, self.pending = None, [], None
        self.record_date = diary_today()
        self.own_undo = None

    def preference(self, key, value):
        self.settings[key] = value
        try:
            SETTINGS.parent.mkdir(parents=True, exist_ok=True)
            SETTINGS.write_text(json.dumps(self.settings), encoding="utf-8")
        except OSError:
            self.out.line("本次设置已生效，暂时无法记住下次偏好。", "muted")

    def header(self, now=None):
        now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(BEIJING)
        gmt, denver, delhi = now.astimezone(dt.timezone.utc), denver_time(now), now.astimezone(DELHI)
        self.out.box("XHY  /  个人终端", [
            "饮食日记  ·  加密资产  ·  比特币价格警报",
            f"北京 UTC+8  {now:%Y-%m-%d %H:%M:%S}",
            f"GMT / UTC+0  {gmt:%Y-%m-%d %H:%M:%S}",
            f"丹佛 {utc_label(denver)}  {denver:%Y-%m-%d %H:%M:%S}",
            f"新德里 UTC+5:30  {delhi:%Y-%m-%d %H:%M:%S}",
            f"夜班 北京时间 23:00–次日07:00 · 周一至周五 · {work_status(now)[1]}",
            "常规作息 07:00 入睡，15:00–16:00 起床；饮食日记按 UTC+0 换日。",
        ])

    def read_diary(self):
        snapshot = self.api.request("/diet/api/diary")
        if not isinstance(snapshot.get("diary"), dict) or not isinstance(snapshot["diary"].get("days"), list) or not isinstance(snapshot.get("revision"), int):
            raise APIError("日记数据格式不正确。")
        if self.own_undo and (snapshot["revision"], diary_hash(snapshot)) != self.own_undo:
            self.own_undo = None
        self.snapshot = snapshot
        return snapshot

    def overview(self, section="overview"):
        data = self.api.request("/api/overview")
        if section == "overview":
            self.header()
        if section in ("overview", "diet"):
            diet = data.get("diet") or {}
            day = diet.get("today") or {}
            totals = day.get("totals") or {}
            self.out.box("01 / 饮食日记  ·  " + STATUS.get(diet.get("status"), "未连接"), [
                f"{diet.get('date') or diary_today()} UTC  ·  {number(day.get('mealCount'), 0)} 餐  ·  {number(totals.get('kcal'), 0)} kcal",
                "蛋白质 " + number(totals.get("protein"), 1) + " g  /  碳水 " + number(totals.get("carbs"), 1) + " g  /  脂肪 " + number(totals.get("fat"), 1) + " g",
                "过去七天已记录 " + number((diet.get("week") or {}).get("recordedDays"), 0) + " 天",
                diet.get("error") or "用 /diet 日期查看，直接说话即可和饮食 AI 对话。",
            ])
        if section in ("overview", "wallet"):
            wallet = data.get("wallet") or {}
            rows = ["总估值 " + money(wallet.get("totalUsd")) + "  /  " + money(wallet.get("totalCny"), "¥ "),
                    "BTC 实际持仓 " + number(wallet.get("btcHoldings"), 8) + " BTC  ·  总资产折合 " + number(wallet.get("totalBtc"), 8) + " BTC"]
            for asset in wallet.get("assets") or []:
                rows.append(f"{asset.get('ccy', '—')}  {number(asset.get('quantity'), 8)}  /  {money(asset.get('usd_value'))}")
            if not wallet.get("complete"):
                rows.append("当前估值不完整，部分账户或资产暂未计入。")
            rows += [wallet.get("error") or wallet.get("scopeNote") or "以已连接的钱包和账户为准。", "更新时间 " + str(wallet.get("updatedAt") or "尚未同步")]
            self.out.box("02 / 加密资产  ·  " + STATUS.get(wallet.get("status"), "未连接"), rows)
        if section in ("overview", "alerts"):
            alerts = data.get("alerts") or {}
            range_mode = alerts.get("metric") in ("day_range", "amplitude")
            rows = ["BTC / USDT  " + money(alerts.get("price")),
                    ("今日振幅 " if range_mode else "今日涨跌 ") + number(alerts.get("rangePct") if range_mode else alerts.get("changePct")) + "%  ·  北京自然日",
                    "日内最低 " + money(alerts.get("dayLow")) + "  /  最高 " + money(alerts.get("dayHigh")),
                    "价格警报 " + ("已开启" if alerts.get("enabled") is True else "已暂停" if alerts.get("enabled") is False else "未读取"),
                    "阈值 " + " / ".join(number(v) + "%" for v in (alerts.get("thresholds") or []))]
            for alert in (alerts.get("recent") or [])[-5:]:
                if isinstance(alert, dict):
                    message = alert.get("message") or alert.get("text")
                    if not message:
                        kind = "测试" if alert.get("kind") == "test" else "上涨" if alert.get("direction") == "up" else "下跌" if alert.get("direction") == "down" else "行情"
                        try:
                            at = dt.datetime.fromtimestamp(float(alert.get("at_ms")) / 1000, BEIJING).strftime("%m-%d %H:%M")
                        except (ValueError, TypeError, OverflowError, OSError):
                            at = "时间未记录"
                        message = f"{at} · {kind} · 阈值 {number(alert.get('threshold_pct'))}% · 价格 {money(alert.get('price'))}"
                    rows.append("最近警报 " + str(message))
            rows += [alerts.get("error") or ("行情延迟，显示最近快照。" if alerts.get("stale") else "行情已连接。"),
                     "更新时间 " + str(alerts.get("updatedAt") or "尚未同步")]
            self.out.box("03 / 比特币价格警报  ·  " + STATUS.get(alerts.get("status"), "未连接"), rows)
        self.out.line("总览快照 " + str(data.get("updatedAt") or "—") + " · /refresh 更新", "muted")

    def diet(self, date=None):
        selected = date_value(date or self.record_date)
        snapshot = self.read_diary()
        self.record_date = selected
        day = next((d for d in snapshot["diary"]["days"] if d.get("date") == selected), None)
        rows = ["默认记录日期 " + selected + " · 版本 " + str(snapshot["revision"])]
        if day:
            rows.append(day.get("title") or "饮食记录")
            if day.get("note"):
                rows.append(day["note"])
            for meal in day.get("meals") or []:
                rows.append("")
                rows.append(("已吃" if meal.get("status") == "eaten" else "计划") + " / " + str(meal.get("title") or meal.get("type") or "餐食"))
                for item in meal.get("items") or []:
                    rows.append("  " + str(item.get("name") or "食物") + "  " + number(item.get("amount")) + str(item.get("unit") or "") + "  ·  " + number((item.get("nutrition") or {}).get("kcal"), 0) + " kcal")
                    if item.get("basis"):
                        rows.append("    称重依据 " + str(item["basis"]))
            if not day.get("meals"):
                rows.append("这一天暂无餐食。")
        else:
            rows.append("这一天暂无记录，可直接输入吃过的内容。")
        rows.append("AI " + ("已配置" if snapshot.get("apiConfigured") else "未配置") + " · " + ("本机保存，与网页共用" if snapshot.get("persistence") == "local" else "存储暂不可用"))
        self.out.box("饮食日记 / " + selected, rows)

    def chat(self, text):
        text = text.strip()
        if not text or len(text) > 4000:
            raise ValueError("请输入 1–4,000 字的饮食问题或修改要求。")
        if self.pending:
            if self.pending["path"] == "/diet/api/diary-chat" and self.pending["text"] == text:
                return self.retry()
            self.out.line("上次提交的保存结果尚未确认。请先输入 /retry，避免重复记录。", "bad")
            return
        if not self.snapshot:
            self.read_diary()
        if self.snapshot.get("persistence") != "local":
            raise APIError("日记存储暂不可用，未发送修改。")
        history = self.history[-24:]
        while len(json.dumps(history, ensure_ascii=False)) > 45000:
            history = history[2:]
        payload = {"text": text, "recordDate": self.record_date, "expectedRevision": self.snapshot["revision"],
                   "requestId": str(uuid.uuid4()), "history": history, "draftDays": []}
        self.pending = {"path": "/diet/api/diary-chat", "payload": payload, "text": text}
        self.retry()

    def retry(self):
        if not self.pending:
            self.out.line("没有待确认的提交。可以直接继续对话。", "muted")
            return
        pending = self.pending
        self.out.line("正在处理日记，请稍候…", "muted")
        try:
            result = self.api.request(pending["path"], pending["payload"])
            if not isinstance(result.get("diary"), dict) or not isinstance(result.get("revision"), int):
                raise APIError("保存结果尚未确认。请用 /retry 重试同一请求。")
        except APIError as error:
            if error.status == 409:
                self.pending = None
                self.read_diary()
                self.out.line("日记已在另一处变化；已刷新，本次没有自动重发。请确认后重新输入你的要求。", "bad")
                return
            if error.status in (400, 403, 413, 415, 422):
                self.pending = None
            raise
        previous_revision = pending["payload"]["expectedRevision"]
        self.snapshot = result
        self.pending = None
        if pending["path"].endswith("/undo"):
            self.own_undo, self.history = None, []
        else:
            self.history.extend([{"role": "user", "content": pending["text"]}, {"role": "assistant", "content": str(result.get("reply") or "")[:5000]}])
            self.history = self.history[-24:]
            if result.get("saved") and result.get("canUndo"):
                self.own_undo = (result["revision"], diary_hash(result))
            elif self.own_undo and self.own_undo[0] == previous_revision:
                self.own_undo = (result["revision"], diary_hash(result))
            else:
                self.own_undo = None
        rows = [result.get("reply") or "已处理。", ""]
        rows += [f"{c.get('date', '')} · {c.get('action', '')} · {c.get('title', '')}" for c in result.get("changes") or []]
        rows.append(("已保存到本机日记" if result.get("saved") else "已回复，日记内容未修改") + " · 版本 " + str(result["revision"]))
        self.out.box("食光 AI", rows)

    def undo(self):
        if self.pending:
            self.out.line("请先用 /retry 确认上次提交结果。", "bad")
            return
        if not self.own_undo:
            self.out.line("本次 CMD 会话没有可以撤销的修改。", "muted")
            return
        self.read_diary()
        if not self.own_undo:
            self.out.line("日记已有后续变化，不能从这里撤销其他页面的修改。", "bad")
            return
        self.pending = {"path": "/diet/api/diary/undo", "text": "撤销最近修改", "payload": {
            "recordDate": self.record_date, "expectedRevision": self.snapshot["revision"], "requestId": str(uuid.uuid4()), "draftDays": []}}
        self.retry()

    def help(self):
        self.out.box("命令 / COMMANDS", [
            "/overview 或 /refresh  总览快照；/wallet  钱包；/alerts  价格警报",
            "/diet [YYYY-MM-DD]  查看饮食，并设置默认记录日期",
            "/chat 你的话  或直接输入自然语言，与 AI 多轮对话、修改日记",
            "/retry  确认上次中断的提交，沿用同一请求编号防止重复",
            "/undo  撤销本次会话最后一次修改；其他地方更新后不可撤销",
            "/new  清空对话上下文；不会删除日记",
            "/theme light|dark  白天 / 黑夜模式",
            "/clear  清屏；/help  帮助；/quit  退出 CMD 客户端",
            "例：把 2026-10-24 早餐的牛奶改成 200 毫升。",
            "网页继续可用：http://127.0.0.1:" + str(self.api.port) + "/",
            "行情与警报显示当前快照；本界面不会修改警报规则。",
        ])

    def dispatch(self, text):
        text = text.strip()
        if not text:
            return True
        if not text.startswith("/"):
            self.chat(text)
            return True
        command, _, argument = text.partition(" ")
        command, argument = command.lower(), argument.strip()
        if command in ("/quit", "/exit", "/q"):
            return False
        if command in ("/overview", "/refresh", "/wallet", "/alerts"):
            if command == "/refresh" and self.snapshot:
                self.read_diary()
            self.overview("overview" if command == "/refresh" else command[1:])
        elif command == "/diet":
            self.diet(argument or None)
        elif command == "/chat":
            if argument:
                self.chat(argument)
            else:
                self.out.line("直接输入想查询或修改的饮食内容，按 Enter 发送。", "muted")
        elif command == "/retry":
            self.retry()
        elif command == "/undo":
            self.undo()
        elif command == "/new":
            if self.pending:
                self.out.line("请先用 /retry 确认上次提交结果，再开始新对话。", "bad")
            else:
                self.history = []
                self.out.line("已开始新对话，日记内容保持保存。", "good")
        elif command == "/theme" and argument in PALETTES:
            self.out.theme = argument
            self.preference("theme", argument)
            self.out.clear()
            self.header()
            self.out.line("已切换白天模式。" if argument == "light" else "已切换黑夜模式。", "good")
        elif command == "/clear":
            self.out.clear()
            self.header()
        elif command == "/help":
            self.help()
        else:
            self.out.line("未识别的命令或参数。输入 /help 查看用法。", "bad")
        return True


def wait_dependencies(api, timeout=22):
    """Portal starts/reuses children; this client only waits for their identity."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = api.request("/api/overview")
        services = last.get("services") or {}
        if all((services.get(name) or {}).get("status") == "online" for name in ("diet", "btc")):
            return
        time.sleep(.4)


def main(argv=None):
    parser = argparse.ArgumentParser(description="本机个人终端 CMD 客户端，与网页共用数据")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--once", choices=("overview", "wallet", "alerts", "diet"), help="只读显示一次后退出")
    parser.add_argument("--date", type=date_value, help="饮食默认日期 YYYY-MM-DD（按 UTC+0 划分）")
    parser.add_argument("--theme", choices=("light", "dark"))
    parser.add_argument("--no-color", action="store_true", help="纯文本输出，不使用 ANSI 控制码")
    parser.add_argument("--no-start", action="store_true", help="只连接已有服务，供自动化或诊断")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间。")
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    settings = load_settings()
    console = Console(args.theme or settings["theme"], not args.no_color and not os.environ.get("NO_COLOR") and enable_ansi(sys.stdout))
    api = API(args.port)
    terminal = Terminal(api, console, settings)
    terminal.record_date = args.date or diary_today()
    try:
        if not args.no_start:
            from launch import ensure_portal
            if not args.once:
                console.line("正在连接本机个人终端…", "muted")
            ensure_portal(args.port)
            wait_dependencies(api)
        if args.once == "diet":
            terminal.diet()
        elif args.once:
            terminal.overview(args.once)
        else:
            console.clear()
            terminal.overview()
            console.line("直接输入自然语言与饮食 AI 对话。/help 帮助 · /quit 退出", "accent")
            while True:
                try:
                    if not terminal.dispatch(console.prompt()):
                        break
                except (APIError, ValueError) as error:
                    console.line(str(error), "bad")
                except EOFError:
                    break
            if terminal.pending:
                console.line("上次日记提交结果尚未确认。再次编辑前请在网页核对是否已保存。", "bad")
        return 0
    except (APIError, RuntimeError, ValueError) as error:
        console.line(str(error), "bad")
        return 1
    except KeyboardInterrupt:
        console.line("已退出。若 AI 提交被中断，请在网页核对保存结果。", "muted")
        return 0
    finally:
        if console.color:
            sys.stdout.write("\033[0m")


if __name__ == "__main__":
    raise SystemExit(main())
