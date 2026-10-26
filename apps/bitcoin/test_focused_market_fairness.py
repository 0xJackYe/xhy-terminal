"""Public-book recovery remains fair within its real rolling request budget."""
import tempfile
import time
import unittest
from unittest.mock import patch

from dashboard_server import MarketCache
from test_mark_fallback import recovery_snapshot


class FocusedMarketFairnessTests(unittest.TestCase):
    def test_sixteen_watched_contracts_stay_fresh_without_exceeding_the_weight_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = MarketCache(directory, websocket_factory=None)
            cache._snapshot = recovery_snapshot(16)
            cache._rows_by_symbol = {row["symbol"]: row for row in cache._snapshot["options"]}
            now = [time.time()]
            began_at = now[0]
            for priority, symbol in enumerate(cache._rows_by_symbol):
                cache._mark_watch[symbol] = {"until": began_at + 300, "priority": priority}
            ages, costs = [], []
            try:
                # Stub only worker dispatch/the network. Results go through the
                # actual validation, ordering and atomic book-commit path.
                with patch("dashboard_server.time.time", side_effect=lambda: now[0]), \
                        patch("focused_market_recovery.threading.Thread") as worker:
                    for tick in range(180):
                        now[0] = began_at + tick
                        if cache.request_focused_refresh():
                            tasks = worker.call_args.kwargs["args"][0]
                            request_at = int(now[0] * 1000)
                            costs.extend([now[0]] * len(tasks))
                            now[0] += .01
                            received = int(now[0] * 1000)
                            for kind, symbol in tasks:
                                data = ({"indexPrice": "80000", "time": received} if kind == "index" else
                                    {"bids": [["49", "1"]], "asks": [["51", "1"]], "T": received, "lastUpdateId": received})
                                cache._apply_focused_result((kind, symbol, request_at, received,
                                    {"ok": True, "data": data, "http_status": 200}))
                            cache._focused_refreshing = False
                        self.assertLessEqual(sum(cost for _, cost in cache._focused_attempts), 80)
                        if tick >= 30:
                            for row in cache._rows_by_symbol.values():
                                for field in ("bid_price", "ask_price", "bid_quantity", "ask_quantity"):
                                    stamp = row["field_updated_at"].get(field)
                                    self.assertIsNotNone(stamp, field)
                                    ages.append((now[0] * 1000 - stamp) / 1000)
                            self.assertLessEqual(now[0] * 1000 - cache._snapshot["index_updated_at"], 30000)
                self.assertLessEqual(max(ages), 30, "lower-priority contracts starved while other books refreshed repeatedly")
                for instant in costs:
                    self.assertLessEqual(sum(instant - 60 < stamp <= instant for stamp in costs), 80)
            finally:
                cache.stop()


if __name__ == "__main__":
    unittest.main()
