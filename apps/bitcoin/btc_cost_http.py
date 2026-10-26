"""Cached read-only cost-ledger API; exchange synchronization runs separately."""
from urllib.parse import urlsplit


def handle_btc_cost(handler):
    url = urlsplit(handler.path)
    if url.path != '/api/wallet/btc-cost':
        return False
    if handler.command != 'GET':
        handler.json(405, {'error': '成本记录仅支持读取。'})
    elif url.query:
        handler.json(400, {'error': '成本记录不接受查询参数。'})
    else:
        service = getattr(handler.server, 'cost_service', None)
        if service is None:
            handler.json(503, {'error': '成本跟踪暂未启动，余额和行情继续更新。'})
        else:
            try:
                handler.json(200, service.read_public())
            except Exception:
                handler.json(503, {'error': '成本记录暂时无法读取，已保存的记录保留在本机。'})
    return True
