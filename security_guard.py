"""Windows CMD entry point; importing this file never starts a scan."""
from security_guard.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
