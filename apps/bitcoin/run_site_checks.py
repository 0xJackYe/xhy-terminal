"""Run the complete offline regression suite and retain reviewable results."""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def count_checks(output, kind):
    if kind == "python":
        matches = re.findall(r"Ran (\d+) tests?", output)
    elif kind == "tap":
        matches = re.findall(r"^# tests (\d+)\s*$", output, re.MULTILINE)
    else:
        matches = re.findall(r"(\d+)\s+[^\r\n]*?(?:checks|tests)\s+passed", output, re.IGNORECASE)
        if not matches:
            matches = re.findall(r"^# tests (\d+)\s*$", output, re.MULTILINE)
    return int(matches[-1]) if matches else None


def main():
    parser = argparse.ArgumentParser(description="Run all Bitcoin Terminal automated checks without changing user settings.")
    parser.add_argument("--output", type=Path, default=ROOT / "verification" / "site-test-results")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8", NO_COLOR="1", NODE_DISABLE_COLORS="1")
    groups = [("python", "python", [sys.executable, "-m", "unittest", "discover", "-s", str(ROOT), "-p", "test_*.py", "-v"])]
    groups.append(("windows_startup", "python", [sys.executable, "-m", "unittest", "discover", "-s", str(ROOT / "windows_startup"), "-p", "test_*.py", "-v"]))
    groups.extend((path.stem, "node", ["node", str(path)]) for path in sorted(ROOT.glob("test_*.js")))
    wallet_tests = sorted((ROOT / "terminal" / "wallet").glob("test_*.mjs"))
    if wallet_tests:
        groups.append(("wallet", "tap", ["node", "--test"] + [str(path) for path in wallet_tests]))
    results = []
    for name, kind, command in groups:
        print("Running " + name + "...", flush=True)
        try:
            completed = subprocess.run(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                       errors="replace", timeout=180)
            output, exit_code = completed.stdout, completed.returncode
        except (OSError, subprocess.TimeoutExpired) as exc:
            output, exit_code = str(exc), -1
        log_path = args.output / (name + ".log")
        log_path.write_text(output, encoding="utf-8")
        checks = count_checks(output, kind)
        results.append({"group": name, "passed": exit_code == 0, "checks": checks,
                        "exit_code": exit_code, "log": str(log_path.resolve())})
        print("%s: %s (%s checks)" % (name, "PASS" if exit_code == 0 else "FAIL", checks if checks is not None else "see log"), flush=True)
    passed = all(item["passed"] for item in results)
    counted = all(item["checks"] is not None for item in results)
    report = {"generated_at_beijing": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
              "all_passed": passed, "checks": sum(item["checks"] or 0 for item in results) if counted else None,
              "groups": results,
              "scope": "Offline automated regressions. Actual Windows reboot and manual browser checks are separate."}
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Report: " + str((args.output / "report.json").resolve()), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
