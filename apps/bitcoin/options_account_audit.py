"""One-off, local Binance options account audit. Credentials never go to disk.

Run with pythonw for a masked local input dialog. Only the separate reader's
fixed GET allowlist can be used. Reports are outside every dashboard static root.
"""
from __future__ import annotations

import argparse
import calendar
import json
import os
import queue
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from account_audit_performance import (
    audit_json_default, modified_dietz, value_option_account,
)
from options_account_reader import ReadOnlyAPIError, ReadOnlyBinanceClient

BEIJING = timezone(timedelta(hours=8))
DAY_MS = 86_400_000
STORE = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "OptionsAccountAudit"
INTERNAL_BILL_TYPES = {"CONTRACT", "FEE", "EXERCISE_PNL", "EXERCISE_FEE", "LIQUIDATION_FEE"}
SOURCE_ACCOUNT = "https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/account"
SOURCE_TRADE = "https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/trade"


def dump_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                              default=audit_json_default, allow_nan=False), encoding="utf-8")
    os.replace(str(tmp), str(path))


def set_status(stage, **values):
    # No credentials, raw HTTP errors, signatures or request URLs in this file.
    dump_json(STORE / "latest-status.json", {
        "stage": stage, "updated_at": datetime.now(BEIJING).isoformat(), **values,
    })


def redact(value, secrets=()):
    if isinstance(value, dict):
        return {str(k): redact(v, secrets) for k, v in value.items()
                if str(k).lower().replace("_", "").replace("-", "") not in
                {"apikey", "apisecret", "secret", "secretkey", "signature", "authorization", "xmbxapikey"}}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value]
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
    return value


def fetch_window(client, path, start_ms, end_ms, time_field, base=None,
                 progress=lambda message: None, budget=None):
    """Split saturated windows rather than assuming ambiguous cursor ordering.

    Inclusive integer-millisecond windows are disjoint. A saturated single-ms
    leaf is explicitly incomplete. IDs are kept as strings, never float IDs.
    """
    budget = budget if budget is not None else [300]
    pending = [(int(start_ms), int(end_ms))]
    found, warnings, complete = {}, [], True
    while pending:
        if budget[0] <= 0:
            warnings.append("达到查询请求上限，历史记录未完整下载。")
            complete = False
            break
        lo, hi = pending.pop()
        params = dict(base or {}, startTime=lo, endTime=hi, limit=1000)
        budget[0] -= 1
        rows = client.get(path, params)
        if not isinstance(rows, list):
            raise ValueError("账户接口返回的数据结构与文档不一致。")
        if len(rows) >= 1000 and hi > lo:
            mid = (lo + hi) // 2
            pending.extend([(mid + 1, hi), (lo, mid)])
            progress("正在分段补齐满页历史记录……")
            continue
        if len(rows) >= 1000:
            complete = False
            warnings.append("同一毫秒的历史记录达到接口上限，不能确认完整。")
        for row in rows:
            if not isinstance(row, dict):
                complete = False
                warnings.append("接口出现无法识别的记录。")
                continue
            try:
                stamp = int(row[time_field])
            except (KeyError, TypeError, ValueError):
                complete = False
                warnings.append("部分记录缺少有效时间。")
                continue
            if not lo <= stamp <= hi:
                complete = False
                warnings.append("接口返回了请求时间范围之外的记录。")
                continue
            rid = row.get("id")
            if rid is None:
                complete = False
                warnings.append("部分记录缺少唯一ID，不能确认去重完整性。")
                rid = json.dumps(row, sort_keys=True, ensure_ascii=False)
            key = str(rid)
            if key in found and found[key] != row:
                complete = False
                warnings.append("同一ID的历史记录存在内容冲突。")
            found[key] = row
    return sorted(found.values(), key=lambda r: (int(r[time_field]), str(r.get("id", "")))), complete, sorted(set(warnings))


def percentage(value):
    return "不可计算" if value is None else f"{Decimal(str(value)) * 100:.4f}%"


def amount(value):
    return "未知" if value is None else f"{Decimal(str(value)):,.6f}"


def collect_account(client, start_ms, opening_equity=None, all_history=True,
                    progress=lambda message: None):
    warnings, errors = [], []
    progress("正在校准时间并读取当前账户、仓位……")
    client.sync_time()
    server_now = int(client.get("/eapi/v1/time")["serverTime"])
    if start_ms >= server_now:
        raise ValueError("统计起点必须早于现在。")
    # Keep within the documented three-calendar-month retention boundary.
    now_dt = datetime.fromtimestamp(server_now / 1000, BEIJING)
    month = now_dt.month - 3
    year = now_dt.year
    if month <= 0:
        year -= 1
        month += 12
    cutoff_dt = now_dt.replace(year=year, month=month,
                               day=min(now_dt.day, calendar.monthrange(year, month)[1]))
    cutoff_ms = int(cutoff_dt.timestamp() * 1000) + 60_000
    query_start = max(int(start_ms), cutoff_ms)
    requested_older = int(start_ms) < cutoff_ms
    if requested_older:
        warnings.append("请求起点超出近3个月接口保留范围；本次只能查询可见窗口。")
    account = client.get("/eapi/v1/marginAccount")
    positions = client.get("/eapi/v1/position")
    if not isinstance(account, dict) or not isinstance(positions, list):
        raise ValueError("账户或仓位返回格式不符合文档，已停止计算。")
    permissions = None
    try:
        permissions = client.get("/sapi/v1/account/apiRestrictions")
    except ReadOnlyAPIError as exc:
        warnings.append(f"Key权限信息未能读取（HTTP {exc.http_status}, code {exc.code}）；未修改权限。")
    progress("正在读取资金划转、费用及结算流水……")
    budget = [300]
    bills, bill_complete, notes = fetch_window(
        client, "/eapi/v1/bill", query_start, server_now, "createDate",
        {"currency": "USDT"}, progress, budget)
    warnings.extend(notes)
    exercises, exercise_complete = [], False
    try:
        exercises, exercise_complete, notes = fetch_window(
            client, "/eapi/v1/exerciseRecord", query_start, server_now,
            "createDate", progress=progress, budget=budget)
        warnings.extend(notes)
    except ReadOnlyAPIError as exc:
        errors.append({"component": "exerciseRecord", "http_status": exc.http_status, "code": exc.code})
        warnings.append("行权记录查询未完成；账单与已返回仓位仍保留。")
    symbols = {str(r.get("symbol")) for r in bills + exercises + positions if r.get("symbol")}
    trades, trade_complete = [], True
    for index, symbol in enumerate(sorted(symbols), 1):
        progress(f"正在核对成交记录 {index}/{len(symbols)}：{symbol}")
        try:
            rows, complete, notes = fetch_window(
                client, "/eapi/v1/userTrades", query_start, server_now,
                "time", {"symbol": symbol}, progress, budget)
            trades.extend(rows)
            trade_complete = trade_complete and complete
            warnings.extend(notes)
        except ReadOnlyAPIError as exc:
            trade_complete = False
            errors.append({"component": "userTrades", "symbol": symbol,
                           "http_status": exc.http_status, "code": exc.code})
            warnings.append(f"{symbol}的成交记录未完整读取。")
    if any(r.get("type") in INTERNAL_BILL_TYPES and not r.get("symbol") for r in bills):
        trade_complete = False
        warnings.append("旧账单部分缺少合约名，不能保证已发现全部历史合约。")
    # Refresh the endpoint valuation and extend the bill cutoff to match it.
    progress("正在核对期末权益和最后一段流水……")
    snapshot_start = int(client.get("/eapi/v1/time")["serverTime"])
    final_account = client.get("/eapi/v1/marginAccount")
    final_positions = client.get("/eapi/v1/position")
    snapshot_end = int(client.get("/eapi/v1/time")["serverTime"])
    snapshot_has_activity = False
    if snapshot_end > server_now:
        tail, tail_complete, notes = fetch_window(
            client, "/eapi/v1/bill", server_now + 1, snapshot_end, "createDate",
            {"currency": "USDT"}, progress, budget)
        bills.extend(tail)
        bill_complete = bill_complete and tail_complete
        warnings.extend(notes)
        if tail:
            trade_complete = False
            warnings.append("查询期间出现新账单，成交归因截至较早时点；已补齐资金流水。")
            snapshot_has_activity = any(int(r["createDate"]) >= snapshot_start for r in tail)
    if snapshot_has_activity:
        warnings.append("读取期末账户与仓位期间发生交易或资金变化，快照与流水无法精确对齐；本次不计算历史回报。")
    account, positions = final_account, final_positions
    if not isinstance(account, dict) or not isinstance(positions, list):
        raise ValueError("最终账户快照格式不符合文档。")
    assets = [v for v in account.get("asset", []) if v.get("asset") == "USDT"]
    usdt = assets[0] if len(assets) == 1 else {}
    selected_positions = [r for r in positions if r.get("quoteAsset") == "USDT"]
    marks_complete = len(selected_positions) == len(positions)
    for position in selected_positions:
        # Official crypto BTC/ETH stablecoin option unit is 1. Treat other
        # products as unverified rather than silently importing this multiplier.
        if str(position.get("symbol", "")).startswith(("BTC-", "ETH-")):
            position["unit"] = 1
        else:
            marks_complete = False
    valuation = value_option_account(usdt.get("marginBalance"), selected_positions,
                                     marks_complete=marks_complete)
    warnings.extend(valuation.get("warnings", []))
    api_equity, reconciled = None, False
    try:
        api_equity = Decimal(str(usdt["equity"]))
        if not api_equity.is_finite():
            raise ValueError()
        if valuation.get("valid"):
            difference = valuation["equity"] - api_equity
            tolerance = max(Decimal("0.02"), abs(api_equity) * Decimal("0.0001"))
            valuation["reconstruction_minus_api_equity"] = difference
            reconciled = abs(difference) <= tolerance
            if not reconciled:
                warnings.append("API权益与现金加带方向期权市值的重建值不一致，停止历史回报计算；需重查快照或核实账户口径。")
    except (KeyError, InvalidOperation, ValueError):
        api_equity = None
        warnings.append("API未提供有效有限权益，停止历史回报计算。")
    valuation["api_equity"] = api_equity
    valuation["api_equity_reconciled"] = reconciled
    snapshot_recent = 0 <= snapshot_end - snapshot_start <= 15_000
    if not snapshot_recent:
        warnings.append("期末账户与仓位读取跨度超过15秒或时序无效，估值时点不足以支持年化计算。")
    flows, bill_totals, unknown = [], defaultdict(Decimal), set()
    for row in bills:
        try:
            val = Decimal(str(row["amount"]))
            if not val.is_finite():
                raise ValueError()
        except (KeyError, InvalidOperation, ValueError):
            bill_complete = False
            warnings.append("账单包含无效金额，停止收益率计算。")
            continue
        kind = str(row.get("type", "UNKNOWN"))
        bill_totals[kind] += val
        if row.get("asset") != "USDT":
            unknown.add("NON_USDT")
        elif kind == "TRANSFER":
            flows.append({"timestamp_ms": int(row["createDate"]), "amount": val})
        elif kind not in INTERNAL_BILL_TYPES:
            unknown.add(kind)
    if unknown:
        warnings.append("存在待核实的流水类型，不能保证外部入金分类完整：" + ", ".join(sorted(unknown)))
    start_equity_valid = opening_equity is not None and not requested_older
    performance = modified_dietz(
        opening_equity if start_equity_valid else None,
        api_equity if reconciled and snapshot_recent and not snapshot_has_activity else None,
        flows, query_start, snapshot_end,
        flows_complete=bill_complete and not unknown)
    warnings.extend(performance.get("warnings", []))
    if opening_equity is None:
        warnings.append("未提供可核实的统计起点净值；1000 USDT预算不能替代真实起点净值。")
    if all_history:
        warnings.append("仅凭近3个月返回记录，不能证明首条可见记录就是第一笔交易；全历史完整性尚未确认。")
    warnings.append("账户和仓位为相邻GET快照，并非交易所原子快照；查询期间若有交易/划转，应重新核对。")
    return {
        "generated_at_beijing": datetime.now(BEIJING).isoformat(),
        "requested_start_ms": int(start_ms), "window_start_ms": query_start,
        "window_end_ms": snapshot_end, "snapshot_window_ms": [snapshot_start, snapshot_end],
        "snapshot_has_account_activity": snapshot_has_activity,
        "requested_all_history": all_history, "full_history_verified": False,
        "opening_equity_user_supplied": opening_equity,
        "account": account, "positions": positions, "valuation": valuation,
        "key_permissions": permissions, "bills": bills,
        "exercises": exercises, "trades": trades,
        "bill_totals_cashflow_not_profit": dict(bill_totals), "external_flows": flows,
        "coverage": {"bill_window_untruncated": bill_complete,
                     "exercise_window_untruncated": exercise_complete,
                     "discovered_symbols_trades_untruncated": trade_complete,
                     "all_historical_symbols_known": False,
                     "unknown_bill_types": sorted(unknown)},
        "performance": performance, "warnings": sorted(set(warnings)), "errors": errors,
        "sources": [SOURCE_ACCOUNT, SOURCE_TRADE,
                    "https://www.binance.com/en-PH/support/faq/detail/dbb171c4db1e4626863ec8bc545be46a"],
    }


def write_report(result, directory):
    directory.mkdir(parents=True, exist_ok=True)
    dump_json(directory / "account-audit.json", result)
    valuation, perf = result["valuation"], result["performance"]
    start = datetime.fromtimestamp(result["window_start_ms"] / 1000, BEIJING)
    end = datetime.fromtimestamp(result["window_end_ms"] / 1000, BEIJING)
    lines = ["# 币安期权账户只读核对", "", f"生成时间：{result['generated_at_beijing']}", "",
             f"API可见统计窗口：{start:%Y-%m-%d %H:%M:%S} 至 {end:%Y-%m-%d %H:%M:%S}（北京时间）。",
             "", "使用固定GET查询，没有下单、撤单、划转或修改账户。API Key和Secret未保存。", "",
             "## 当前账户和仓位", "",
             f"按现金余额加带方向的期权市值核对的净值：{amount(valuation.get('equity'))} USDT。",
             f"API返回权益：{amount(valuation.get('api_equity'))} USDT；对账通过：{valuation.get('api_equity_reconciled', False)}。",
             "空头期权是负债，不能把卖开收到的权利金直接视为利润。", "",
             "|合约|方向|数量（带符号）|开仓均价|标记价|接口未实现盈亏|", "|---|---|---:|---:|---:|---:|"]
    for row in result["positions"]:
        lines.append("|" + "|".join(str(row.get(k, "未知")).replace("|", " ")
                     for k in ["symbol", "side", "quantity", "entryPrice", "markPrice", "unrealizedPNL"]) + "|")
    if not result["positions"]:
        lines.append("|当前接口未返回持仓||||||")
    lines += ["", "## 历史收益", "",
              "全历史完整性：未确认。接口仅有近3个月成交与流水窗口，首条可见记录不一定是第一笔交易。", "",
              f"本窗口剔除外部资金流后的净损益：{amount(perf.get('net_pnl'))} USDT。",
              f"Modified Dietz区间回报估算：{percentage(perf.get('period_return'))}。",
              f"简单年化折算：{percentage(perf.get('simple_annualized_return'))}。",
              f"复合年化折算：{percentage(perf.get('compound_annualized_return'))}。",
              "这是选定窗口的历史估算，不是未来收益承诺，也不是精确时间加权收益率。短于30天默认不年化。", "",
              "## 账单现金流分类（不是已实现利润表）", "", "|类型|净现金流USDT|", "|---|---:|"]
    for kind, val in sorted(result["bill_totals_cashflow_not_profit"].items()):
        lines.append(f"|{kind}|{amount(val)}|")
    lines += ["", "## 数据限制", ""] + ["- " + str(v) for v in result["warnings"]]
    lines += ["", "计算净损益使用期末净值−期初净值−外部净入金；没有真实期初净值时不填猜测的历史年化。",
              "", f"[官方账户接口]({SOURCE_ACCOUNT})、[仓位与成交接口]({SOURCE_TRADE})。", ""]
    report = directory / "账户仓位与历史收益.md"
    report.write_text("\n".join(lines), encoding="utf-8")
    return report


def run_gui(check_layout=False):
    import tkinter as tk
    from tkinter import messagebox, ttk

    root = tk.Tk()
    if check_layout:
        root.withdraw()
    root.title("币安期权 · 本机只读查询")
    root.geometry("740x690")
    root.minsize(700, 670)
    frame = ttk.Frame(root, padding=24)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="查询当前仓位与历史收益", font=("Microsoft YaHei UI", 16)).pack(anchor="w")
    ttk.Label(frame, text="密钥仅在本次程序内存中使用，发送至币安签名GET接口；不写入聊天或报告。\n请使用仅有查询权限的Key。现有期权看板的公开行情接口不能读取私人账户。",
              wraplength=660, justify="left").pack(anchor="w", pady=(10, 16))
    key_var, secret_var = tk.StringVar(), tk.StringVar()
    for label, var in [("API Key", key_var), ("API Secret（HMAC类型）", secret_var)]:
        ttk.Label(frame, text=label).pack(anchor="w")
        entry = ttk.Entry(frame, textvariable=var, show="●", width=80)
        entry.pack(fill="x", pady=(4, 12))
    ttk.Label(frame, text="统计目标：从第一笔期权交易开始；API先查询最近90天。\n若更早已有交易，需要官方账单及当时净值才能补齐全历史。",
              wraplength=650, justify="left").pack(anchor="w", pady=(0, 12))
    default_start = (datetime.now(BEIJING) - timedelta(days=90)).strftime("%Y-%m-%d %H:%M")
    start_var = tk.StringVar(value=default_start)
    equity_var = tk.StringVar()
    ttk.Label(frame, text="查询起点（北京时间，YYYY-MM-DD HH:MM，可调整至最近90天内）").pack(anchor="w")
    ttk.Entry(frame, textvariable=start_var).pack(fill="x", pady=(4, 10))
    ttk.Label(frame, text="该起点的真实期权账户净值 USDT（可留空；不是保证金预算）").pack(anchor="w")
    ttk.Entry(frame, textvariable=equity_var).pack(fill="x", pady=(4, 8))
    ttk.Label(frame, text="没有起点净值也能查询仓位和账单；程序会把历史年化标为暂不可算。",
              wraplength=650).pack(anchor="w", pady=(0, 10))
    status = tk.StringVar(value="等待本机输入。程序没有下单、撤单或划转功能。")
    ttk.Label(frame, textvariable=status, wraplength=660, justify="left").pack(anchor="w", pady=8)
    events = queue.Queue()
    state = {"busy": False, "report": None}

    def worker(key, secret, start_ms, opening):
        client = None
        try:
            client = ReadOnlyBinanceClient(key, secret)
            result = collect_account(client, start_ms, opening, True,
                                     lambda msg: events.put(("progress", msg)))
            result = redact(result, (key, secret))
            folder = STORE / datetime.now(BEIJING).strftime("%Y%m%d-%H%M%S")
            report = write_report(result, folder)
            set_status("complete", report_path=str(report), data_path=str(folder / "account-audit.json"))
            events.put(("complete", str(report)))
        except ReadOnlyAPIError as exc:
            text = f"币安查询失败：HTTP {exc.http_status}，code {exc.code}。{str(exc)}"
            text = redact(text, (key, secret))
            set_status("error", message=text)
            events.put(("error", text))
        except Exception as exc:
            # Do not stringify arbitrary exceptions; they can embed signed URLs.
            text = "查询未完成（" + type(exc).__name__ + "）。未执行任何交易。"
            set_status("error", message=text)
            events.put(("error", text))
        finally:
            if client is not None:
                client.close()
            key = secret = None

    def submit():
        if state["busy"]:
            return
        key, secret = key_var.get().strip(), secret_var.get().strip()
        if not key or not secret:
            messagebox.showinfo("还缺少凭据", "请在本机窗口输入配套API Key和Secret；不要发到聊天里。")
            return
        try:
            start_ms = int(datetime.strptime(start_var.get().strip(), "%Y-%m-%d %H:%M").replace(tzinfo=BEIJING).timestamp() * 1000)
            opening = Decimal(equity_var.get().strip()) if equity_var.get().strip() else None
            if opening is not None and (not opening.is_finite() or opening < 0):
                raise ValueError()
        except (ValueError, InvalidOperation):
            messagebox.showinfo("请检查输入", "起点请用YYYY-MM-DD HH:MM；净值须为真实非负数字或留空。")
            return
        key_var.set("")
        secret_var.set("")
        state["busy"] = True
        button.configure(state="disabled")
        status.set("开始只读查询……")
        set_status("querying")
        threading.Thread(target=worker, args=(key, secret, start_ms, opening), daemon=True).start()
        key = secret = None

    def poll():
        try:
            while True:
                kind, message = events.get_nowait()
                if kind == "progress":
                    status.set(message)
                    set_status("querying", message=message)
                else:
                    state["busy"] = False
                    button.configure(state="normal")
                    if kind == "complete":
                        state["report"] = message
                        status.set("查询完成，报告已保存到本机：\n" + message)
                        open_button.configure(state="normal")
                    else:
                        status.set(message)
        except queue.Empty:
            pass
        root.after(250, poll)

    buttons = ttk.Frame(frame)
    buttons.pack(fill="x", pady=8)
    button = ttk.Button(buttons, text="只读查询（不下单）", command=submit)
    button.pack(side="left")
    open_button = ttk.Button(buttons, text="打开本机报告", state="disabled",
                             command=lambda: os.startfile(state["report"]))
    open_button.pack(side="left", padx=12)
    if check_layout:
        root.update_idletasks()
        required = frame.winfo_reqheight()
        actual = root.winfo_height()
        print(json.dumps({"required_content_height": required,
                          "configured_window_height": actual,
                          "all_controls_fit": required <= actual}, ensure_ascii=True))
        root.destroy()
        if required > actual:
            raise ValueError("Window too short for controls")
        return
    set_status("waiting_for_local_credentials")
    poll()
    root.mainloop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local read-only Binance options audit")
    parser.add_argument("--check-ui", action="store_true", help="Offline layout check; no credentials or network")
    args = parser.parse_args()
    run_gui(check_layout=args.check_ui)
