import unittest
from unittest.mock import patch

import background_sync


class SupervisorTests(unittest.TestCase):
    def test_failed_service_is_retried_and_recovery_does_not_stop_polling(self):
        checks, waits, statuses = [], [], []
        def check():
            checks.append(True)
            if len(checks) == 1:
                raise RuntimeError('service starting')
        def wait(seconds):
            waits.append(seconds)
            if len(waits) == 3:
                raise KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            background_sync.supervise(check, wait, statuses.append)
        self.assertEqual(3, len(checks))
        self.assertEqual([30, 30, 30], waits)
        self.assertEqual(['retrying', 'running'], statuses)

    def test_supervisor_uses_this_checkouts_exchange_backend(self):
        with patch.dict(background_sync.os.environ, {'XHY_OPTIONS_ROOT': 'old-options'}), \
             patch.object(background_sync, 'ensure_portal') as portal, \
             patch.object(background_sync, 'ensure_btc') as btc:
            background_sync.check_once()
        portal.assert_called_once_with(8780)
        config = btc.call_args.args[0]
        self.assertEqual(background_sync.ROOT / 'apps' / 'bitcoin', config.options_root)


if __name__ == '__main__':
    unittest.main()
