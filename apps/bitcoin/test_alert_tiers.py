"""Tier thresholds, distinct PCM sounds and restart-safe alert deduplication."""
import hashlib
import io
import tempfile
import threading
import unittest
import wave
from pathlib import Path

from audio_assets import alarm_wave_bytes, ensure_tier_wav, SAMPLE_RATE
from btc_alert import BtcAlertMonitor, DAY_MS
from test_btc_alert import Clock, daily_event


class TierAlertTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'state.json'
        self.clock = Clock()
        self.monitor = BtcAlertMonitor(state_path=self.path, clock=self.clock)
        self.monitor.configure({'sound': False})
        self.trade_id = 0
        self.monitor.ingest(daily_event(self.clock))

    def tearDown(self):
        self.monitor.stop()
        self.directory.cleanup()

    def trade(self, price):
        self.clock.advance()
        self.trade_id += 1
        self.monitor.ingest({'e': 'trade', 's': 'BTCUSDT', 'E': self.clock.ms,
            'T': self.clock.ms, 't': self.trade_id, 'p': str(price)})

    def alerts(self):
        return [a for a in self.monitor.read()['alerts'] if a['kind'] == 'market']

    def test_exact_three_boundaries_fire_separately_with_three_sound_levels(self):
        self.trade('102.49999999')
        self.assertEqual([], self.alerts())
        self.trade('102.5'); self.trade('103.49999999')
        self.assertEqual([2.5], [a['threshold_pct'] for a in self.alerts()])
        self.trade('103.5'); self.trade('105')
        self.assertEqual([2.5, 3.5, 5], [a['threshold_pct'] for a in self.alerts()])
        self.assertEqual([1, 2, 3], [a['sound_level'] for a in self.alerts()])

    def test_a_jump_crosses_all_tiers_once_and_rebounds_do_not_repeat(self):
        for price in ('106', '101', '106', '105'):
            self.trade(price)
        self.assertEqual(3, len(self.alerts()))
        self.trade('95')
        self.assertEqual(['up'] * 3 + ['down'] * 3, [a['direction'] for a in self.alerts()])

    def test_restart_preserves_each_daily_threshold_and_direction(self):
        self.trade('104')
        self.monitor.stop()
        self.monitor = BtcAlertMonitor(state_path=self.path, clock=self.clock)
        self.monitor.ingest(daily_event(self.clock))
        self.trade('104'); self.trade('105')
        self.assertEqual([2.5, 3.5, 5], [a['threshold_pct'] for a in self.alerts()])

    def test_beijing_new_day_resets_all_three_tiers(self):
        self.trade('105')
        self.clock.advance(DAY_MS)
        self.monitor.ingest(daily_event(self.clock))
        self.trade('105')
        self.assertEqual(6, len(self.alerts()))

    def test_daily_range_uses_three_independent_tiers(self):
        self.monitor.configure({'metric': 'day_range'})
        self.trade('102'); self.trade('98')
        self.assertEqual([2.5, 3.5], [a['threshold_pct'] for a in self.alerts()])
        self.assertTrue(all(a['direction'] == 'range' for a in self.alerts()))
        self.trade('97')
        self.assertEqual(3, len(self.alerts()))

    def test_invalid_tier_settings_are_atomic_and_scalar_clients_still_work(self):
        before = self.monitor.read()['settings']
        for values in ([], [True], [2.5, 2.5], [5, 3.5], [2.5, float('nan')], [.01], [2,3,4,5], '2.5'):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.monitor.configure({'thresholds_pct': values})
            self.assertEqual(before, self.monitor.read()['settings'])
        self.monitor.configure({'threshold_pct': 4})
        self.assertEqual([4], self.monitor.read()['settings']['thresholds_pct'])
        self.trade('106')
        self.assertEqual([4], [a['threshold_pct'] for a in self.alerts()])

    def test_worker_passes_sound_level_to_notifier_without_blocking_market_detection(self):
        levels = []
        self.monitor._notifier = lambda cancel: levels.append(cancel.sound_level) or 'played'
        self.monitor.configure({'sound': True})
        self.trade('105')
        self.monitor._sound_queue.join()
        self.assertEqual([1, 2, 3], levels)

    def test_three_bundled_sounds_are_distinct_valid_bounded_pcm(self):
        hashes, durations = set(), []
        for level in (1, 2, 3):
            data = alarm_wave_bytes(level)
            hashes.add(hashlib.sha256(data).hexdigest())
            path, duration = ensure_tier_wav(level)
            self.assertEqual(data, path.read_bytes())
            self.assertTrue(0 < duration <= 10)
            durations.append(duration)
            with wave.open(io.BytesIO(data), 'rb') as wav:
                self.assertEqual((1, 2, SAMPLE_RATE, 'NONE'),
                    (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()))
        self.assertEqual(3, len(hashes))
        self.assertEqual(3, len(set(durations)))


if __name__ == '__main__':
    unittest.main()
