"""Import the owner-provided API config into this checkout's local vaults."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent

def main():
    if sys.platform != 'win32':
        raise SystemExit('This credential vault uses Windows DPAPI. Run on Windows.')
    config = json.loads((ROOT / 'configs' / 'api-credentials.json').read_text(encoding='utf-8'))
    sys.path.insert(0, str(ROOT / 'apps' / 'bitcoin'))
    from okx_wallet_service import OKXVault
    from crypto_portfolio_service import BinanceVault
    from option_ai_service import KeyVault
    for label, vault, value in [('OKX', OKXVault(), config['okx']),
                                ('Binance', BinanceVault(), config['binance']),
                                ('DeepSeek', KeyVault(), config['deepseek']['api_key'])]:
        if vault.read():
            print(label + ': existing local configuration kept')
        elif value:
            vault.save(value)
            print(label + ': imported into local encrypted storage')
    return 0

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit('API configuration import failed. No credential values were logged.') from None
