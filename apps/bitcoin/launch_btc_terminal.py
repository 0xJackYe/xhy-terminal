"""Start the local terminal quietly and open it only after its API is ready."""
import argparse
import contextlib
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser


ROOT = Path(__file__).resolve().parent
MAX_RESPONSE = 2 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def probe_server(port, timeout=1.0, opener=None):
    """Return ready, missing, waiting, or occupied without opening an unknown app."""
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open
    try:
        with opener("http://127.0.0.1:%s/api/terminal" % port, timeout=timeout) as response:
            if not response.headers.get("Server", "").startswith("BitcoinTerminal/"):
                return "occupied"
            payload = response.read(MAX_RESPONSE + 1)
            if len(payload) > MAX_RESPONSE:
                return "waiting"
            try:
                value = json.loads(payload)
            except (ValueError, UnicodeError):
                return "waiting"
            return "ready" if isinstance(value, dict) and isinstance(value.get("settings"), dict) else "waiting"
    except urllib.error.HTTPError as exc:
        return "waiting" if exc.headers.get("Server", "").startswith("BitcoinTerminal/") else "occupied"
    except (urllib.error.URLError, OSError, TimeoutError):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=min(timeout, 0.3)):
                return "waiting"
        except OSError:
            return "missing"


def hidden_python(executable=None):
    executable = Path(executable or sys.executable).resolve()
    candidate = executable.with_name("pythonw.exe")
    return candidate if os.name == "nt" and candidate.is_file() else executable


def start_server(root=ROOT, port=8766, popen=subprocess.Popen):
    root = Path(root).resolve()
    logs = root / "terminal" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    command = [str(hidden_python()), str(root / "btc_terminal_server.py"), "--port", str(port), "--no-browser"]
    kwargs = {"cwd": str(root), "stdin": subprocess.DEVNULL, "stderr": subprocess.STDOUT}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    with (logs / "btc-terminal-service.log").open("ab") as output:
        kwargs["stdout"] = output
        return popen(command, **kwargs)


def ensure_server(port=8766, root=ROOT, timeout=45, probe=probe_server,
                  start=start_server, clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + timeout
    status = probe(port)
    child = None
    if status == "occupied":
        raise RuntimeError("端口 %s 已被其他程序占用，未打开其他程序的页面。" % port)
    if status == "missing":
        child = start(root=root, port=port)
    while status != "ready":
        if status == "occupied":
            raise RuntimeError("端口 %s 被其他程序占用。请查看 terminal/logs。" % port)
        if child is not None and child.poll() is not None:
            raise RuntimeError("比特币终端启动失败，请查看 terminal/logs/btc-terminal-service.log。")
        if clock() >= deadline:
            raise RuntimeError("比特币终端尚未就绪，请查看 terminal/logs/btc-terminal-service.log；未重复启动服务。")
        sleep(0.25)
        status = probe(port)
    return child


@contextlib.contextmanager
def startup_lock(root=ROOT, port=8766, timeout_ms=60000):
    """Serialize current-user launchers; a dead launcher cannot leave a stale lock."""
    if os.name != "nt":
        yield
        return
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel.ReleaseMutex.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    identity = os.path.normcase(str(Path(root).resolve())) + ":" + str(port)
    name = "Local\\BitcoinTerminal-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
    handle = kernel.CreateMutexW(None, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    acquired = False
    try:
        result = kernel.WaitForSingleObject(handle, timeout_ms)
        if result not in (0, 0x80):  # normal acquisition or abandoned owner
            raise RuntimeError("另一个启动程序仍在准备终端，请稍后重试。")
        acquired = True
        yield
    finally:
        if acquired:
            kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


def windows_boot_time(runner=subprocess.run):
    script = "(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')"
    result = runner(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    stamp = result.stdout.strip()
    if result.returncode or not stamp:
        raise RuntimeError("无法读取 Windows 启动时间。")
    try:
        # PowerShell's round-trip format has 7 fractional digits; Python 3.9
        # accepts up to 6. Preserve the authoritative original in the key.
        normalized = re.sub(r"(\.\d{6})\d+(?=Z$|[+-]\d{2}:\d{2}$)", r"\1", stamp)
        parsed = dt.datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone missing")
    except ValueError as exc:
        raise RuntimeError("Windows 启动时间无效。") from exc
    return stamp


def windows_logon_key():
    """Use authoritative boot time plus the token's login identity and session."""
    if os.name != "nt":
        raise RuntimeError("开机自动启动仅支持 Windows。")
    from ctypes import wintypes

    class LUID(ctypes.Structure):
        _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]

    class TOKEN_STATISTICS(ctypes.Structure):
        _fields_ = [("TokenId", LUID), ("AuthenticationId", LUID), ("ExpirationTime", ctypes.c_longlong),
                    ("TokenType", ctypes.c_int), ("ImpersonationLevel", ctypes.c_int),
                    ("DynamicCharged", wintypes.DWORD), ("DynamicAvailable", wintypes.DWORD),
                    ("GroupCount", wintypes.DWORD), ("PrivilegeCount", wintypes.DWORD), ("ModifiedId", LUID)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetCurrentProcessId.argtypes = []
    kernel.GetCurrentProcessId.restype = wintypes.DWORD
    kernel.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel.ProcessIdToSessionId.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                         ctypes.POINTER(wintypes.DWORD)]
    advapi.GetTokenInformation.restype = wintypes.BOOL
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        stats = TOKEN_STATISTICS()
        needed = wintypes.DWORD()
        if not advapi.GetTokenInformation(token, 10, ctypes.byref(stats), ctypes.sizeof(stats), ctypes.byref(needed)):
            raise ctypes.WinError(ctypes.get_last_error())
        session = wintypes.DWORD()
        if not kernel.ProcessIdToSessionId(kernel.GetCurrentProcessId(), ctypes.byref(session)):
            raise ctypes.WinError(ctypes.get_last_error())
        auth = stats.AuthenticationId
        return "%s/%08x%08x-%s" % (windows_boot_time(), auth.HighPart & 0xFFFFFFFF, auth.LowPart, session.value)
    finally:
        kernel.CloseHandle(token)


def open_for_logon(root=ROOT, port=8766, autostart=False, opener=webbrowser.open, key_provider=windows_logon_key):
    logs = Path(root) / "terminal" / "logs"
    # Independent files match the per-port launch mutex. Opening another local
    # terminal cannot overwrite this port's successful-open state.
    marker = logs / ("last-startup-logon-%s.json" % port)
    key = None
    if autostart:
        try:
            key = key_provider()
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            # A failed identity lookup must never suppress a later boot's page.
            append_log("无法确认登录标识，本次正常打开页面并跳过重复打开抑制。", root)
    if key is not None:
        try:
            previous = json.loads(marker.read_text(encoding="utf-8"))
        except FileNotFoundError:
            # Preserve deduplication for a page opened by the previous version.
            try:
                previous = json.loads((logs / "last-startup-logon.json").read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeError):
                previous = None
        except (OSError, ValueError, UnicodeError):
            previous = None
        if isinstance(previous, dict) and previous.get("logon") == key and previous.get("port") == port:
            return False
    if not opener("http://127.0.0.1:%s/" % port):
        raise RuntimeError("终端已运行，但默认浏览器未能打开。请手动访问 http://127.0.0.1:%s/。" % port)
    if key is not None:
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            temporary = marker.with_suffix(".tmp")
            temporary.write_text(json.dumps({"logon": key, "port": port}), encoding="utf-8")
            os.replace(str(temporary), str(marker))
        except OSError:
            append_log("页面已打开，无法保存本次登录标记；后续自动启动可能再次打开页面。", root)
    return True


def append_log(message, root=ROOT):
    logs = Path(root) / "terminal" / "logs"
    try:
        logs.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        with (logs / "btc-terminal-startup.log").open("a", encoding="utf-8") as output:
            output.write(stamp + " " + message + "\n")
    except OSError:
        # Logging availability does not determine whether the terminal works.
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="启动并打开本机比特币终端。")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--autostart", action="store_true", help="同一次 Windows 登录只自动打开一次浏览器。")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间。")
    try:
        with startup_lock(ROOT, args.port):
            ensure_server(port=args.port)
            opened = open_for_logon(port=args.port, autostart=args.autostart)
        append_log("已打开统一终端。" if opened else "本次登录已自动打开过终端，保留现有页面。")
        return 0
    except (OSError, RuntimeError) as exc:
        append_log(str(exc))
        if sys.stderr is not None:
            print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
