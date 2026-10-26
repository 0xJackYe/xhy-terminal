"""Double-click launcher: reuse a healthy portal and open one browser page."""
import argparse
import http.client
from pathlib import Path
import sys
import time
import webbrowser

from server import Config, ROOT
from services import hidden_python, service_status, start_hidden, startup_lock


def ensure_portal(port=8780, timeout=15):
    with startup_lock("XHYPortal-%s" % port):
        status = service_status(port, "portal")
        if status == "ready":
            # Ask the already-running portal to recover stopped child services.
            # Its own worker continues after this short-lived launcher exits.
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            try:
                connection.request("POST", "/api/services/ensure", body=b"", headers={"X-Terminal-Request": "1", "Origin": "http://127.0.0.1:%s" % port})
                response = connection.getresponse()
                response.read(4096)
            except (OSError, http.client.HTTPException):
                pass
            finally:
                connection.close()
            return
        if status == "occupied":
            raise RuntimeError("端口%s正被其他程序占用，未启动重复服务。" % port)
        child = start_hidden([hidden_python(), str(ROOT / "server.py"), "--port", str(port)], ROOT, "terminal-service.log")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if service_status(port, "portal") == "ready":
                return
            if child.poll() is not None:
                raise RuntimeError("总终端启动失败，请查看.local/logs。")
            time.sleep(.25)
        raise RuntimeError("总终端尚未就绪，未重复启动。")


def main(argv=None):
    parser = argparse.ArgumentParser(description="打开个人总终端")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在1到65535之间。")
    try:
        ensure_portal(args.port)
        if not args.no_browser:
            webbrowser.open("http://127.0.0.1:%s" % args.port)
        return 0
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
