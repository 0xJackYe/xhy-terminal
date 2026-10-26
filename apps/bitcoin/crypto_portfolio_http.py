"""Protected local Binance credential configuration and cached portfolio read."""
import json
import urllib.parse
from okx_wallet_service import WalletError


def handle_portfolio(handler):
    url = urllib.parse.urlsplit(handler.path)
    if url.path not in ('/api/wallet/portfolio', '/api/wallet/binance/config'):
        return False
    service = getattr(handler.server, 'portfolio_service', None)
    handler.close_connection = True
    try:
        if service is None:
            raise WalletError('unavailable', '投资组合服务尚未启动。', 503)
        if url.query:
            raise ValueError()
        if url.path == '/api/wallet/portfolio' and handler.command == 'GET':
            handler.json(200, service.read_public())
            return True
        if url.path != '/api/wallet/binance/config' or handler.command != 'POST':
            raise WalletError('method', '此投资组合接口不支持该操作。', 405)
        if (len(handler.headers.get_all('X-Terminal-Request', [])) != 1 or handler.headers.get('X-Terminal-Request') != '1'
                or len(handler.headers.get_all('Content-Type', [])) != 1
                or handler.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json'):
            raise WalletError('forbidden', '请通过本机钱包页面配置。', 403)
        lengths = handler.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or handler.headers.get('Transfer-Encoding'):
            raise ValueError()
        size = int(lengths[0])
        if not 0 < size <= 4096:
            raise ValueError()
        handler.connection.settimeout(5)
        raw = handler.rfile.read(size)
        handler._body_consumed = True
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        body = json.loads(raw, object_pairs_hook=pairs)
        handler.json(200, service.configure_binance(body))
    except WalletError as exc:
        handler.json(exc.status, {'error': str(exc), 'code': exc.code})
    except (ValueError, TypeError, UnicodeError, TimeoutError):
        handler.json(400, {'error': '投资组合请求格式无效。', 'code': 'invalid_request'})
    except Exception:
        handler.json(503, {'error': '投资组合服务暂不可用。', 'code': 'unavailable'})
    return True
