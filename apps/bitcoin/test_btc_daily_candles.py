"""Daily candle day boundaries, history recovery, persistence and single flight."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from btc_daily_candles import (BTCDailyCandlesService, DailyCandlesError,
    DAY_MS, BEIJING_MS, START_MS, BINANCE_ORIGINS, day_start, date_text,
    parse_binance, parse_okx, _safe_url, fetch_public_json)


class Clock:
    def __init__(self, day=3):
        self.ms = START_MS + day * DAY_MS + 10000

    def __call__(self):
        return self.ms / 1000


def binance(at, close='101'):
    return [at, '100.000', '110', '90', close, '5.000', at + DAY_MS - 1, '0', 1, '0', '0', '0']


def okx(at, close='101', complete='1'):
    return [str(at), '100', '110', '90', close, '5', '0', '0', complete]


class Source:
    def __init__(self, clock):
        self.clock, self.calls, self.close, self.fail = clock, [], '101', False
        self.binance_error = False
        self.gap = None

    def __call__(self, url):
        self.calls.append(url)
        if self.fail:
            raise DailyCandlesError()
        parts, today = urlsplit(url), day_start(self.clock.ms)
        query = parse_qs(parts.query)
        if 'binance' in parts.netloc:
            if self.binance_error:
                raise DailyCandlesError()
            start, limit = int(query['startTime'][0]), int(query['limit'][0])
            dates = range(start, min(today + DAY_MS, start + limit * DAY_MS), DAY_MS)
            return [binance(at, self.close) for at in dates if at != self.gap]
        if parts.path.endswith('/history-candles'):
            before = int(query['after'][0])
            dates = range(min(today, before - DAY_MS), min(today, before - DAY_MS) - 300 * DAY_MS, -DAY_MS)
        else:
            dates = [today, today - DAY_MS]
        return {'code': '0', 'data': [okx(at, self.close, '0' if at == today else '1')
                                    for at in dates if at != self.gap]}


class CandlesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.source = Source(self.clock)
        self.path = Path(self.temp.name) / 'market.json'
        self.service = BTCDailyCandlesService(self.path, self.source, self.clock)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def read(self):
        return self.service.snapshot(wait=True)

    def test_beijing_midnight_and_start_date_are_not_utc_midnights(self):
        self.assertEqual(date_text(START_MS), '2024-07-01')
        self.assertEqual(day_start(START_MS + DAY_MS - 1), START_MS)
        self.assertEqual(day_start(START_MS + DAY_MS), START_MS + DAY_MS)
        self.assertEqual((START_MS + BEIJING_MS) % DAY_MS, 0)
        with self.assertRaises(DailyCandlesError):
            parse_binance([binance(START_MS + BEIJING_MS)], START_MS + DAY_MS)

    def test_real_ohlc_is_sorted_and_complete_from_july_and_has_no_credentials(self):
        result = self.read()
        self.assertEqual(result['status'], 'fresh')
        self.assertTrue(result['coverage_complete'])
        self.assertEqual(result['timezone'], 'Asia/Shanghai')
        self.assertEqual(result['candles'][0]['time'], '2024-07-01')
        self.assertEqual(result['candles'][-1]['time'], '2024-07-04')
        self.assertEqual(result['candles'][0]['open'], '100')
        self.assertEqual(result['candles'][0]['volume'], '5')
        self.assertEqual(len(self.source.calls), 1)
        query = parse_qs(urlsplit(self.source.calls[0]).query)
        self.assertEqual(query['timeZone'], ['8'])
        self.assertEqual(query['symbol'], ['BTCUSDT'])
        self.assertNotRegex(self.source.calls[0], r'(?i)key|secret|signature')

    def test_closed_history_is_saved_once_and_today_stays_in_memory(self):
        self.read()
        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(len(saved['candles']), 3)
        self.assertEqual(saved['candles'][-1]['time'], '2024-07-03')
        with patch.object(self.service, '_save_cache', wraps=self.service._save_cache) as save:
            self.clock.ms += 5000
            self.source.close = '102'
            result = self.read()
            self.assertEqual(result['candles'][-1]['close'], '102')
            self.assertEqual(result['candles'][0]['close'], '101')
            save.assert_not_called()
        last = parse_qs(urlsplit(self.source.calls[-1]).query)
        self.assertEqual(last['startTime'], [str(day_start(self.clock.ms))])
        self.assertEqual(last['limit'], ['1'])

    def test_repeated_reads_use_memory_and_do_not_read_the_file_again(self):
        self.read()
        with patch.object(Path, 'read_text', side_effect=AssertionError('no disk read')):
            for _ in range(10):
                self.assertEqual(self.service.snapshot()['status'], 'fresh')
        self.assertEqual(len(self.source.calls), 1)

    def test_next_beijing_day_fetches_authoritative_closed_bar_not_yesterdays_partial(self):
        self.read()
        self.clock.ms = START_MS + 4 * DAY_MS + 1000
        self.source.close = '103'
        result = self.read()
        self.assertEqual(result['candles'][-2]['time'], '2024-07-04')
        self.assertEqual(result['candles'][-2]['close'], '103')
        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(saved['candles'][-1]['close'], '103')
        self.assertEqual(len(saved['candles']), 4)

    def test_outage_preserves_candles_and_original_quote_time_as_stale(self):
        first = self.read()
        self.source.fail = True
        self.clock.ms += 5000
        result = self.read()
        self.assertEqual(result['status'], 'stale')
        self.assertEqual(result['candles'], first['candles'])
        self.assertEqual(result['as_of'], first['as_of'])
        self.assertIn('上次', result['error'])

    def test_request_spanning_midnight_does_not_freeze_a_partial_close(self):
        original = self.source
        previous = day_start(self.clock.ms)
        crossed = False
        def crossing(url):
            nonlocal crossed
            result = original(url)
            if not crossed:
                crossed = True
                self.clock.ms = previous + DAY_MS + 1000
            return result
        self.service.fetcher = crossing
        first = self.read()
        self.assertEqual(first['status'], 'stale')
        self.assertFalse(first['coverage_complete'])
        self.assertNotIn(date_text(previous), [row['time'] for row in first['candles']])
        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertNotIn(date_text(previous), [row['time'] for row in saved['candles']])
        self.clock.ms += 5000
        self.source.close = '104'
        final = self.read()
        self.assertEqual(final['status'], 'fresh')
        self.assertEqual(next(row['close'] for row in final['candles'] if row['time'] == date_text(previous)), '104')

    def test_empty_outage_never_invents_candles_or_zero_prices(self):
        self.source.fail = True
        result = self.read()
        self.assertEqual(result['status'], 'unavailable')
        self.assertFalse(result['coverage_complete'])
        self.assertEqual(result['candles'], [])
        self.assertIsNone(result['as_of'])

    def test_cache_survives_restart_and_needs_only_the_active_tail(self):
        self.read()
        calls = len(self.source.calls)
        restored = BTCDailyCandlesService(self.path, self.source, self.clock)
        try:
            result = restored.snapshot(wait=True)
            self.assertEqual(result['status'], 'fresh')
            self.assertEqual(len(result['candles']), 4)
            self.assertEqual(len(self.source.calls), calls + 1)
            self.assertEqual(parse_qs(urlsplit(self.source.calls[-1]).query)['limit'], ['1'])
        finally:
            restored.close()

    def test_missing_history_is_visible_and_never_filled_with_a_current_price(self):
        self.source.gap = START_MS + DAY_MS
        result = self.read()
        self.assertEqual(result['status'], 'stale')
        self.assertFalse(result['coverage_complete'])
        self.assertNotIn('2024-07-02', [row['time'] for row in result['candles']])
        self.assertEqual(len(result['candles']), 3)

    def test_binance_history_paginates_after_a_thousand_days(self):
        self.clock.ms = START_MS + 1020 * DAY_MS + 1000
        result = self.read()
        self.assertEqual(result['status'], 'fresh')
        self.assertEqual(len(result['candles']), 1021)
        self.assertEqual(len(self.source.calls), 2)
        self.assertEqual(parse_qs(urlsplit(self.source.calls[1]).query)['startTime'], [str(START_MS + 1000 * DAY_MS)])

    def test_okx_fallback_uses_beijing_1d_and_backwards_pagination_including_old_rows(self):
        self.clock.ms = START_MS + 650 * DAY_MS + 1000
        self.source.binance_error = True
        result = self.read()
        self.assertEqual(result['status'], 'fresh')
        self.assertEqual(result['source'], 'OKX Spot')
        self.assertEqual(len(result['candles']), 651)
        calls = [url for url in self.source.calls if 'okx.com' in url]
        self.assertEqual(len(calls), 3)
        for url in calls:
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query['bar'], ['1D'])
            self.assertEqual(query['limit'], ['300'])
        self.assertGreater(int(parse_qs(urlsplit(calls[0]).query)['after'][0]), int(parse_qs(urlsplit(calls[1]).query)['after'][0]))

    def test_okx_closed_bars_must_be_confirmed(self):
        with self.assertRaises(DailyCandlesError):
            parse_okx({'code': '0', 'data': [okx(START_MS, complete='0')]}, START_MS + DAY_MS)
        self.assertEqual(len(parse_okx({'code': '0', 'data': [okx(START_MS, complete='0')]}, START_MS)), 1)

    def test_invalid_ohlc_day_end_future_bar_and_conflicting_duplicates_fail_closed(self):
        bad = binance(START_MS)
        bad[2] = '99'
        ending = binance(START_MS)
        ending[6] += 1
        for payload in [[bad], [ending], [binance(START_MS + 2 * DAY_MS)],
                        [binance(START_MS), binance(START_MS, '102')]]:
            with self.assertRaises(DailyCandlesError):
                parse_binance(payload, START_MS + DAY_MS)
        self.assertEqual(len(parse_binance([binance(START_MS), binance(START_MS)], START_MS)), 1)

    def test_corrupt_or_future_cache_is_not_a_fresh_quote(self):
        self.path.write_text('{bad', encoding='utf-8')
        broken = BTCDailyCandlesService(self.path, lambda url: (_ for _ in ()).throw(DailyCandlesError()), self.clock)
        try:
            self.assertEqual(broken.snapshot(wait=True)['status'], 'unavailable')
        finally:
            broken.close()

    def test_background_requests_coalesce_and_initial_loading_does_not_block(self):
        began, release = threading.Event(), threading.Event()
        original = self.source
        def slow(url):
            began.set()
            release.wait(timeout=2)
            return original(url)
        self.service.fetcher = slow
        initial = self.service.snapshot()
        self.assertTrue(began.wait(timeout=1))
        self.assertEqual(initial['status'], 'loading')
        for _ in range(10):
            self.assertEqual(self.service.snapshot()['status'], 'loading')
        release.set()
        result = self.service.snapshot(wait=True)
        self.assertEqual(result['status'], 'fresh')
        self.assertEqual(len(self.source.calls), 1)

    def test_public_transport_is_fixed_read_only_and_does_not_follow_redirects(self):
        allowed = BINANCE_ORIGINS[0] + '/api/v3/klines?symbol=BTCUSDT&interval=1d&timeZone=8&startTime=1719763200000&limit=1000'
        self.assertTrue(_safe_url(allowed))
        for url in [allowed.replace('https://', 'http://'), allowed.replace('binance.vision', 'binance.vision.evil'),
                    allowed.replace('timeZone=8', 'timeZone=0'), allowed + '&signature=private',
                    'https://www.okx.com/api/v5/account/balance']:
            self.assertFalse(_safe_url(url))
            with self.assertRaises(DailyCandlesError):
                fetch_public_json(url)
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def geturl(self): return 'https://evil.example/redirect'
            def getcode(self): return 200
        class Opener:
            def open(self, request, timeout):
                self.request = request
                self.timeout = timeout
                return Response()
        opener = Opener()
        with patch('btc_daily_candles._verified_opener', return_value=opener):
            with self.assertRaises(DailyCandlesError):
                fetch_public_json(allowed)
        self.assertEqual(opener.request.get_method(), 'GET')
        self.assertIsNone(opener.request.get_header('Authorization'))
        self.assertIsNone(opener.request.get_header('X-mbx-apikey'))


if __name__ == '__main__':
    unittest.main()
