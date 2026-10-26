"""Synthetic cash-flow accounting and bounded read-only pagination checks."""
import datetime as dt
import unittest

from c2c_cashflow import (AuditError, C2C_PATH, DAY, HistoryClient, OKX_BILLS,
                          money, normalize_binance, normalize_okx,
                          six_month_start, summarize_orders, windows)

END = 1792886400000


def order(identifier='1', side='BUY', fiat='CNY', total='100.10', status='COMPLETED'):
    return {'orderNumber': identifier, 'tradeType': side, 'fiat': fiat, 'asset': 'USDT',
            'totalPrice': total, 'amount': '10', 'orderStatus': status, 'createTime': END,
            'commission': '1', 'counterPartNickName': 'private-not-retained'}


class CashflowTests(unittest.TestCase):
    def test_completed_fiat_payments_have_correct_direction_and_exact_arithmetic(self):
        result = summarize_orders([normalize_binance(order()),
            normalize_binance(order('2', 'SELL', total='30.05'))])
        self.assertEqual(result['by_fiat']['CNY'], {'buy_paid': '100.10', 'sell_received': '30.05',
            'buy_count': 1, 'sell_count': 1, 'net_contribution': '70.05'})

    def test_cancelled_and_pending_orders_are_excluded_not_counted_as_deposits(self):
        result = summarize_orders([normalize_binance(order(str(i), status=status))
            for i, status in enumerate(('CANCELLED', 'TRADING'))])
        self.assertEqual({}, result['by_fiat'])
        self.assertEqual(2, result['unique_orders'])
        self.assertEqual(2, result['excluded_uncompleted'])

    def test_different_fiat_currencies_are_never_added_or_converted_at_todays_price(self):
        result = summarize_orders([normalize_binance(order()), normalize_binance(order('2', fiat='USD'))])
        self.assertEqual({'CNY', 'USD'}, set(result['by_fiat']))
        self.assertEqual('100.10', result['by_fiat']['USD']['net_contribution'])

    def test_crypto_commission_is_not_mistakenly_subtracted_as_fiat(self):
        row = normalize_binance(order())
        self.assertNotIn('commission', row)
        self.assertNotIn('counterPartNickName', row)
        self.assertEqual('100.10', summarize_orders([row])['by_fiat']['CNY']['buy_paid'])

    def test_duplicate_order_counted_once_and_conflicting_copy_is_rejected(self):
        row = normalize_binance(order())
        self.assertEqual(1, summarize_orders([row, row])['completed_orders'])
        with self.assertRaises(AuditError):
            summarize_orders([row, dict(row, fiat_amount='1')])

    def test_invalid_or_missing_amounts_cannot_turn_into_zero(self):
        for value in (None, '', 'NaN', 'Infinity', '-1', True, 100, '1e999'):
            with self.subTest(value=value), self.assertRaises(AuditError):
                money(value)

    def test_unknown_status_or_invalid_completed_order_cannot_be_silently_ignored(self):
        for override in ({'orderStatus': 'UNKNOWN'}, {'totalPrice': '0'}, {'amount': '-1'},
                         {'createTime': True}, {'fiat': 'usdt'}, {'orderNumber': None}):
            with self.subTest(override=override), self.assertRaises(AuditError):
                normalize_binance(dict(order(), **override))

    def test_intervals_cover_every_millisecond_without_overlap_and_stay_below_thirty_days(self):
        intervals = list(windows(END - 184 * DAY, END))
        self.assertEqual(END - 184 * DAY, intervals[0][0])
        self.assertEqual(END, intervals[-1][1])
        self.assertTrue(all(b - a < 30 * DAY for a, b in intervals))
        self.assertTrue(all(a[1] + 1 == b[0] for a, b in zip(intervals, intervals[1:])))

    def test_six_calendar_months_handle_month_ends_without_a_fake_lifetime_claim(self):
        end = int(dt.datetime(2026, 8, 31, tzinfo=dt.timezone.utc).timestamp() * 1000)
        result = dt.datetime.fromtimestamp(six_month_start(end) / 1000, dt.timezone.utc)
        self.assertEqual((2026, 2, 28, 0, 1), (result.year, result.month, result.day, result.hour, result.minute))

    def test_okx_crypto_bills_do_not_invent_a_fiat_total(self):
        result = normalize_okx({'billId': '1', 'ccy': 'USDT', 'balChg': '-100',
            'type': '116', 'ts': str(END), 'notes': 'not trusted as a fiat payment'})
        self.assertEqual('-100', result['crypto_change'])
        self.assertNotIn('fiat_amount', result)
        self.assertNotIn('notes', result)


class PagingTests(unittest.TestCase):
    def client(self, venue='binance'):
        credentials = {'api_key': 'test-key', 'secret_key': 'test-secret'}
        if venue == 'okx':
            credentials['passphrase'] = 'test-passphrase'
        return HistoryClient(venue, credentials, sleeper=lambda _: None)

    def test_all_buy_and_sell_pages_are_read_before_totalling(self):
        client, calls = self.client(), []
        def fetch(path, params):
            calls.append(dict(params))
            if params['tradeType'] == 'SELL':
                return {'success': True, 'data': [], 'total': 0}
            rows = [order(str(i)) for i in (range(1, 101) if params['page'] == 1 else range(101, 102))]
            return {'success': True, 'data': rows, 'total': 101}
        client.get = fetch
        orders = client.binance_orders(END - DAY, END)
        self.assertEqual(101, len(orders))
        self.assertEqual([1, 2, 1], [p['page'] for p in calls])
        self.assertEqual('10110.10', summarize_orders(orders)['by_fiat']['CNY']['net_contribution'])

    def test_empty_page_before_claimed_total_is_incomplete(self):
        client = self.client()
        client.get = lambda *args: {'success': True, 'data': [], 'total': 10}
        with self.assertRaises(AuditError):
            client.binance_orders(END - DAY, END)

    def test_repeated_page_is_not_mistaken_for_another_hundred_orders(self):
        client = self.client()
        client.get = lambda *args: {'success': True, 'data': [order()], 'total': 2}
        with self.assertRaises(AuditError):
            client.binance_orders(END - DAY, END)

    def test_wrong_side_or_outside_window_is_rejected(self):
        client = self.client()
        for row in (order(side='SELL'), dict(order(), createTime=END + 1)):
            client.get = lambda *args: {'success': True, 'data': [row], 'total': 1}
            with self.assertRaises(AuditError):
                client.binance_orders(END - DAY, END)

    def test_all_okx_bill_types_read_with_bill_id_paging(self):
        client, calls = self.client('okx'), []
        def fetch(path, params):
            calls.append(dict(params))
            return {'data': []}
        client.get = fetch
        self.assertEqual([], client.okx_bills())
        self.assertEqual(['116', '117', '118'], [p['type'] for p in calls])
        self.assertTrue(all(p['pagingType'] == '2' for p in calls))

    def test_no_trading_endpoint_can_receive_credentials(self):
        for venue, path in [('binance', '/api/v3/order'), ('okx', '/api/v5/trade/order')]:
            with self.assertRaises(AuditError):
                self.client(venue).get(path, {})

    def test_unapproved_query_fields_are_rejected_before_network(self):
        for client, path, params in [(self.client(), C2C_PATH, {'url': 'https://other.invalid'}),
            (self.client('okx'), OKX_BILLS, {'type': '1', 'limit': '100', 'pagingType': '2'})]:
            with self.assertRaises(AuditError):
                client.get(path, params)

    def test_transient_limit_retries_are_bounded_and_wait_before_resigning(self):
        client, calls, delays = self.client('okx'), [], []
        client._sleep = delays.append
        def once(path, params):
            calls.append(path)
            if len(calls) < 3:
                raise AuditError('rate_limited', 4)
            return {'code': '0', 'data': []}
        client._get_once = once
        self.assertEqual([], client.get(OKX_BILLS, {})['data'])
        self.assertEqual([4, 6], delays)
        self.assertEqual(3, len(calls))

    def test_auth_failures_ip_bans_and_long_retry_after_never_loop(self):
        for code, delay in [('permission_denied', 0), ('ip_banned', 0), ('rate_limited', 120)]:
            client = self.client()
            client._sleep = lambda _: self.fail('unexpected retry')
            def once(*args):
                raise AuditError(code, delay)
            client._get_once = once
            with self.assertRaises(AuditError):
                client.get(C2C_PATH, {})

    def test_persistent_transient_error_stops_after_three_requests(self):
        client, calls = self.client(), []
        def once(*args):
            calls.append(1)
            raise AuditError('network_error')
        client._get_once = once
        with self.assertRaises(AuditError):
            client.get(C2C_PATH, {})
        self.assertEqual(3, len(calls))


if __name__ == '__main__':
    unittest.main()
