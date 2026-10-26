"""Same-origin JSON boundary for the local OKX read-only wallet service."""
import json
import urllib.parse

from okx_wallet_service import WalletError


def handle_okx(handler):
    url = urllib.parse.urlsplit(handler.path)
    if not url.path.startswith('/api/wallet/okx'):
        return False
    handler.close_connection = True
    service = getattr(handler.server, 'okx_service', None)
    try:
        if service is None:
            raise WalletError('unavailable', '欧易资产服务尚未启动。', 503)
        if url.query:
            raise ValueError()
        if handler.command == 'GET' and url.path == '/api/wallet/okx':
            handler.json(200, service.read_public())
            return True
        if handler.command != 'POST' or url.path not in ('/api/wallet/okx/config', '/api/wallet/okx/refresh'):
            raise WalletError('method', '欧易资产路径或操作不受支持。', 405)
        if (len(handler.headers.get_all('X-Terminal-Request', [])) != 1
                or handler.headers.get('X-Terminal-Request') != '1'
                or len(handler.headers.get_all('Content-Type', [])) != 1
                or handler.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json'):
            raise WalletError('forbidden', '请从本机钱包看板操作。', 403)
        lengths = handler.headers.get_all('Content-Length', [])
        if handler.headers.get('Transfer-Encoding') or len(lengths) != 1:
            raise ValueError()
        length = int(lengths[0])
        if not 0 < length <= 4096:
            raise ValueError()
        handler.connection.settimeout(5)
        raw = handler.rfile.read(length)
        handler._body_consumed = True
        def pairs(items):
            out = {}
            for k, v in items:
                if k in out:
                    raise ValueError()
                out[k] = v
            return out
        body = json.loads(raw, object_pairs_hook=pairs)
        if not isinstance(body, dict):
            raise ValueError()
        if url.path.endswith('/config'):
            handler.json(200, service.configure(body))
        else:
            if body:
                raise ValueError()
            handler.json(202, service.request_refresh())
    except WalletError as exc:
        handler.json(exc.status, {'error': str(exc), 'code': exc.code})
    except (ValueError, TypeError, UnicodeError, TimeoutError):
        handler.json(400, {'error': '欧易资产请求格式无效。', 'code': 'invalid_request'})
    except Exception:
        handler.json(503, {'error': '欧易资产服务暂时不可用。', 'code': 'unavailable'})
    return True
