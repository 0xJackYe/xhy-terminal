"""Read the existing Windows stores and prepare a private, one-time cloud import.

This script never starts a service, sends an email, or changes the source stores.
Private output is always written inside cloud/.local (excluded by Git).
"""
import argparse
import base64
import datetime as dt
import json
from pathlib import Path
import secrets
import sys
import urllib.request


HERE = Path(__file__).resolve().parent


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diet", type=Path, default=HERE.parents[4] / "Diet")
    parser.add_argument("--bitcoin", type=Path, default=Path.home() / "Desktop" / "options")
    parser.add_argument("--local-btc-url", default="http://127.0.0.1:8766")
    args = parser.parse_args()
    # The original vault classes are imported solely for their read methods.
    sys.path.insert(0, str(args.bitcoin))
    from okx_wallet_service import OKXVault, identity
    from btc_cost_tracker import BTCCostTracker
    from alert_email import _dpapi

    output = HERE / ".local"
    output.mkdir(exist_ok=True)
    data = args.bitcoin / "terminal" / "data"
    okx = OKXVault(data / "okx-wallet").read()
    if not all(okx.get(k) for k in ("api_key", "secret_key", "passphrase")):
        raise RuntimeError("The original OKX read-only credential store is incomplete")
    account = identity(okx)
    ledger = OKXVault(data / "btc-cost")._read("ledger-" + account + ".protected.json", None)
    if ledger is None:
        raise RuntimeError("Original complete cost ledger could not be read")
    # Perform the same full validation as the local tracker, without constructing
    # a tracker/service or starting its refresh thread.
    validator = object.__new__(BTCCostTracker)
    validator._validate_state(ledger, account)
    policy = OKXVault(data / "btc-pnl")._read("policy-" + account + ".protected.json", {})
    rates = OKXVault(data / "btc-pnl")._read("public-rates.protected.json", {})
    short_history = OKXVault(data / "okx-wallet")._read("btc-ledger.protected.json", {})
    if short_history and short_history.get("identity") not in (account, account[:24]):
        raise RuntimeError("Short-term history belongs to another account")
    diary = load(args.diet / ".local" / "runtime-diary.json")
    backups = {}
    backup_dir = args.diet / ".local" / "runtime-diary.json.backups"
    for path in backup_dir.glob("*.json"):
        try:
            item = load(path)
            if isinstance(item.get("revision"), int) and item["revision"] < diary["revision"] and isinstance(item.get("diary"), dict):
                backups[item["revision"]] = item
        except (OSError, ValueError, TypeError):
            continue

    snapshots = {}
    for route, key in [("wallet/okx", "okx"), ("wallet/combined", "combined"), ("wallet/portfolio", "portfolio"),
                       ("wallet/btc-cost", "btc_cost"), ("wallet/btc-pnl", "btc_pnl"), ("terminal", "terminal")]:
        request = urllib.request.Request(args.local_btc_url.rstrip("/") + "/api/" + route, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            snapshots[key] = json.load(response)
    if snapshots["okx"].get("connection_id") != account[:24]:
        raise RuntimeError("Local wallet snapshot belongs to another account")
    chain = load(data / "bitcoin-balance-snapshot.json")
    if policy.get("wallet_address") and chain.get("address") != policy["wallet_address"]:
        raise RuntimeError("On-chain wallet snapshot address mismatch")
    alert_state = load(data / "terminal-alert-state.json")
    binance = OKXVault(data / "binance-wallet")._read("credentials.protected.json", {})
    if not all(binance.get(k) for k in ("api_key", "secret_key")):
        raise RuntimeError("The original Binance read-only credential store is incomplete")
    source_config = load(HERE.parent / "configs" / "api-credentials.json")
    deepseek = source_config.get("deepseek", {})
    if not deepseek.get("api_key"):
        raise RuntimeError("DeepSeek configuration is missing")
    secret_path = output / "runtime-secrets.json"
    cloud_secrets = load(secret_path) if secret_path.exists() else {}
    # Repeated preparation must not invalidate cookies or encrypted cloud config.
    for key in ("OWNER_ACCESS_KEY", "AUTH_SECRET", "CONFIG_ENCRYPTION_KEY"):
        cloud_secrets.setdefault(key, secrets.token_urlsafe(32))
    cloud_secrets.update({
        "OKX_API_KEY": okx["api_key"], "OKX_SECRET_KEY": okx["secret_key"], "OKX_PASSPHRASE": okx["passphrase"],
        "BINANCE_API_KEY": binance["api_key"], "BINANCE_SECRET_KEY": binance["secret_key"],
        "DEEPSEEK_API_KEY": deepseek["api_key"], "DEEPSEEK_MODEL": deepseek.get("model") or "deepseek-flash",
        "WALLET_ADDRESS": chain["address"],
    })
    email_config = load(data / "email-notifications" / "email-config.protected.json")
    code = _dpapi(base64.b64decode(email_config["protected_code"], validate=True), decrypt=True).decode("ascii")
    cloud_secrets.update({"SMTP_SENDER": email_config["email"], "SMTP_QQ_AUTH_CODE": code,
                          "SMTP_RECIPIENT": "oxjackye@qq.com", "SMTP_ENABLED": str(bool(email_config.get("enabled"))).lower()})
    write(secret_path, cloud_secrets)
    (output / "owner-access-key.txt").write_text(cloud_secrets["OWNER_ACCESS_KEY"] + "\n", encoding="utf-8")
    payload = {
        "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "diary": diary, "diary_backups": [backups[k] for k in sorted(backups)[-20:]],
        "cost_ledger": ledger, "historical_rates": rates, "policy": policy,
        "price_ledger": short_history.get("ledger"), "snapshots": snapshots,
        "chain_snapshot": chain, "alert_state": alert_state,
    }
    write(output / "migration.json", payload)
    print(json.dumps({"prepared": True, "diary_revision": diary["revision"],
                      "diary_dates": [x["date"] for x in diary["diary"]["days"]],
                      "receipts": len(diary.get("receipts", [])), "backups": len(payload["diary_backups"]),
                      "cost_records": len(ledger["records"]), "secret_count": len(cloud_secrets)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
