"""Open an existing local dashboard, or start it in this console."""
import json
import urllib.error
import urllib.request
import webbrowser

import dashboard_server


def main():
    url = "http://127.0.0.1:8765/"
    try:
        with urllib.request.urlopen(url + "api/market", timeout=2) as response:
            data = json.load(response)
            existing = response.headers.get("Server", "").startswith("OptionsDashboard/") and isinstance(data, dict) and data.get("credentials_used") is False
    except (urllib.error.URLError, OSError, ValueError):
        existing = False
    if existing:
        webbrowser.open(url)
        return 0
    return dashboard_server.main()


if __name__ == "__main__":
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
