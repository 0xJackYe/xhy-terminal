"""Validate the prepared cloud import in an isolated in-memory SQLite database."""
import json
from decimal import Decimal, localcontext, ROUND_HALF_UP
from pathlib import Path
import sqlite3

base = Path(__file__).resolve().parent / ".local"
source = json.loads((base / "migration.json").read_text("utf-8"))
db = sqlite3.connect(":memory:")
db.executescript((base / "migration.sql").read_text("utf-8"))
row = db.execute("SELECT revision,diary_json,undo_json FROM diet_state WHERE owner='terminal-owner'").fetchone()
assert row[0] == source["diary"]["revision"]
assert json.loads(row[1]) == source["diary"]["diary"]
if source["diary"].get("undo"):
    assert json.loads(row[2]) == {"diary": source["diary"]["undo"]["diary"]}
else:
    assert row[2] is None
receipts = {r[0]: json.loads(r[1]) for r in db.execute("SELECT request_id,receipt_json FROM diet_receipts")}
assert receipts == {r["requestId"]: r for r in source["diary"].get("receipts", [])[-64:]}
assert db.execute("SELECT count(*) FROM diet_backups").fetchone()[0] == len(source["diary_backups"])
actual = {r[0]: json.loads(r[1]) for r in db.execute("SELECT id,record_json FROM finance_trades")}
assert actual == {r["id"]: r for r in source["cost_ledger"]["records"]}
kv = {r[0]: json.loads(r[1]) for r in db.execute("SELECT key,value FROM finance_kv")}
assert kv["chain_snapshot"] == source["chain_snapshot"]
assert kv["cost_meta"]["identity"] == source["cost_ledger"]["identity"]
assert kv["historical_rates"] == source["historical_rates"]
assert kv["policy"] == source["policy"]
assert kv["price_ledger"] == source["price_ledger"]
for name in ("okx", "combined", "portfolio", "btc_cost", "btc_pnl"):
    assert kv[name] == source["snapshots"][name]
assert db.execute("SELECT count(*) FROM sqlite_master WHERE name='migration_payloads'").fetchone()[0] == 0
with localcontext() as ctx:
    ctx.prec = 96
    ctx.rounding = ROUND_HALF_UP
    inventory, cost = Decimal(0), Decimal(0)
    for trade in sorted(actual.values(), key=lambda x: (x["at_ms"], int(x["bill_id"]))):
        qty = Decimal(trade["btc_net"])
        if trade["side"] == "buy":
            amount = Decimal(trade["quote_amount"])
            if trade["quote_ccy"] != "USDT":
                key = trade["quote_ccy"] + ":" + str(trade["at_ms"] // 60000 * 60000)
                raw = source["historical_rates"][key]
                amount *= Decimal(raw["close"] if isinstance(raw, dict) else raw)
            inventory += qty
            cost += amount
        else:
            cost = Decimal(0) if -qty == inventory else cost - cost * (-qty) / inventory
            inventory += qty
    assert inventory == Decimal(kv["cost_book"]["inventory"])
    assert abs(cost - Decimal(kv["cost_book"]["cost"])) < Decimal("1e-80")
    assert inventory == Decimal(source["snapshots"]["btc_cost"]["summary"]["net_bought_btc"])
    assert abs(cost - Decimal(source["snapshots"]["btc_pnl"]["metrics"]["remaining_cost"])) < Decimal("1e-60")
print(json.dumps({"verified": True, "diary_revision": row[0], "diary_days": len(source["diary"]["diary"]["days"]),
                  "receipts": len(receipts), "cost_records": len(actual), "cost_calculation_matches": True,
                  "alerts": db.execute("SELECT count(*) FROM market_alerts").fetchone()[0]}))
