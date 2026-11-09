"""Keep the local portal and read-only exchange synchronizers running.

No trading or account configuration is performed. The exchange workers own
their encrypted, append-only history and resumable cursors.
"""
import argparse
import datetime as dt
import os
from pathlib import Path
import subprocess
import sys
import time

from launch import ensure_portal
from server import Config, ROOT
from services import ensure_btc, hidden_python, startup_lock


def check_once():
    # A checkout contains the current backend; never fall back to the old
    # Desktop/options application when a future Windows session starts.
    os.environ['XHY_OPTIONS_ROOT'] = str(ROOT / 'apps' / 'bitcoin')
    os.environ.setdefault('XHY_DIET_ROOT', str(ROOT / 'apps' / 'diet'))
    config = Config()
    ensure_portal(config.port)
    ensure_btc(config)


def supervise(check=check_once, wait=time.sleep, changed=None):
    previous = None
    while True:
        try:
            check()
            state = 'running'
        except (OSError, RuntimeError):
            state = 'retrying'
        if state != previous and changed is not None:
            changed(state)
        previous = state
        wait(30)


def record_status(state):
    directory = ROOT / '.local' / 'logs'
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / 'background-sync.log').open('a', encoding='utf-8') as output:
            output.write(dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
                         + ' ' + state + '\n')
    except OSError:
        pass


def install_startup():
    if os.name != 'nt':
        raise RuntimeError('Windows startup is required.')
    directory = Path(os.environ['APPDATA']) / 'Microsoft/Windows/Start Menu/Programs/Startup'
    directory.mkdir(parents=True, exist_ok=True)
    command = subprocess.list2cmdline([hidden_python(), str(ROOT / 'background_sync.py')])
    # Windows Script Host starts pythonw hidden, without storing any API key.
    script = 'CreateObject("WScript.Shell").Run "' + command.replace('"', '""') + '", 0, False\r\n'
    target = directory / 'XHY Terminal Background.vbs'
    target.write_text(script, encoding='utf-16')
    return target


def main(argv=None):
    parser = argparse.ArgumentParser(description='Keep the personal terminal synchronized in the background.')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--install-startup', action='store_true')
    args = parser.parse_args(argv)
    if args.install_startup:
        install_startup()
        print('Installed current-user Windows logon startup; API keys remain in encrypted storage.')
        return 0
    if args.once:
        check_once()
        return 0
    # A second shortcut or launcher exits instead of creating another poller.
    try:
        with startup_lock('XHYBackgroundExchangeSync', timeout=0):
            supervise(changed=record_status)
    except RuntimeError:
        return 0
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
