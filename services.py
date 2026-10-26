"""Reuse local services and start a missing one once, without opening extra tabs."""
import contextlib
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

from server import ROOT, probe_port, read_local_json


@contextlib.contextmanager
def startup_lock(name="XHYTerminal", timeout=60000):
    if os.name != "nt":
        yield
        return
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
    kernel.ReleaseMutex.argtypes = (ctypes.c_void_p,)
    kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel.CreateMutexW(None, False, "Local\\" + name)
    if not handle:
        raise RuntimeError("本机启动锁暂不可用。")
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(handle, timeout) in (0, 0x80)
        if not acquired:
            raise RuntimeError("服务仍在启动，请稍后再打开。")
        yield
    finally:
        if acquired:
            kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def diet_environment(options_root):
    env = os.environ.copy()
    if not env.get("DEEPSEEK_API_KEY"):
        previous = list(sys.path)
        try:
            sys.path.insert(0, str(options_root))
            module = load_module(options_root / "option_ai_service.py", "xhy_option_ai_credentials")
            key = module.KeyVault().read()
            if key:
                env["DEEPSEEK_API_KEY"] = key
        except Exception:
            # No credential paths, values, or provider exceptions reach logs.
            pass
        finally:
            sys.path[:] = previous
    env.setdefault("DEEPSEEK_MODEL", "deepseek-flash")
    return env


def hidden_python():
    candidate = Path(sys.executable).with_name("pythonw.exe")
    return str(candidate) if os.name == "nt" and candidate.is_file() else sys.executable


def start_hidden(command, cwd, log_name, env=None):
    logs = ROOT / ".local" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    kwargs = {"cwd": str(cwd), "stdin": subprocess.DEVNULL, "stderr": subprocess.STDOUT, "env": env}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    with (logs / log_name).open("ab") as output:
        return subprocess.Popen(command, stdout=output, **kwargs)


def service_status(port, kind):
    try:
        path = "/api/health" if kind == "portal" else "/api/terminal" if kind == "btc" else "/data/diary.json"
        result = read_local_json(port, path, timeout=1)
        ready = (result.get("app") == "xhy-terminal" if kind == "portal" else
                 isinstance(result.get("settings"), dict) and isinstance(result.get("market"), dict) if kind == "btc" else
                 result.get("schemaVersion") == 1 and isinstance(result.get("days"), list))
        return "ready" if ready else "occupied"
    except Exception:
        return "occupied" if probe_port(port) else "missing"


def ensure_diet(config, timeout=20):
    with startup_lock("XHYDiet-%s" % config.diet_port):
        status = service_status(config.diet_port, "diet")
        if status == "ready":
            return
        if status == "occupied":
            raise RuntimeError("饮食服务端口正被其他程序占用。")
        entry = config.diet_root / "scripts" / "serve.mjs"
        node = shutil.which("node")
        if not entry.is_file() or not node:
            raise RuntimeError("未找到饮食项目或Node.js。")
        env = diet_environment(config.options_root)
        env["PORT"] = str(config.diet_port)
        child = start_hidden([node, str(entry)], config.diet_root, "diet-service.log", env)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if service_status(config.diet_port, "diet") == "ready":
                return
            if child.poll() is not None:
                raise RuntimeError("饮食服务未启动，请查看本机日志。")
            time.sleep(.25)
        raise RuntimeError("饮食服务仍未就绪；没有重复启动。")


def ensure_btc(config):
    # The project's existing launcher includes its own cross-process mutex and
    # validates the server identity. Importing it does not start market workers.
    path = config.options_root / "launch_btc_terminal.py"
    if not path.is_file():
        raise RuntimeError("未找到现有比特币终端。")
    module = load_module(path, "xhy_btc_launcher")
    with module.startup_lock(config.options_root, config.btc_port):
        module.ensure_server(port=config.btc_port, root=config.options_root)


def ensure_dependencies(config):
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [("饮食日记", pool.submit(ensure_diet, config)), ("比特币终端", pool.submit(ensure_btc, config))]
        for label, job in jobs:
            try:
                job.result()
            except Exception:
                # Deliberately omit raw exceptions: dependencies can include
                # private filesystem paths or credentials in provider errors.
                print(label + "暂未连接。总终端将显示离线状态。", flush=True)
