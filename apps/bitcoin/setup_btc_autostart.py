"""Install, inspect, or remove only this terminal's current-user Startup shortcut."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
SHORTCUT_NAME = "Bitcoin Terminal.lnk"


def installation_spec(root=ROOT, executable=None, appdata=None, require_dependencies=True):
    root = Path(root).resolve()
    pythonw = Path(executable or sys.executable).resolve().with_name("pythonw.exe")
    launcher = root / "launch_btc_terminal.py"
    startup_base = appdata or os.environ.get("APPDATA")
    if not startup_base:
        raise RuntimeError("找不到当前用户的 APPDATA 目录。")
    # A broken installation must still be inspectable and removable. Its exact
    # expected paths remain unchanged, even when the target no longer exists.
    if require_dependencies and (not pythonw.is_file() or not launcher.is_file()):
        raise RuntimeError("缺少 pythonw.exe 或终端启动程序，未修改启动项。")
    startup = Path(startup_base).resolve() / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    return {"shortcut": str(startup / SHORTCUT_NAME), "target": str(pythonw),
            "arguments": subprocess.list2cmdline([str(launcher), "--autostart"]),
            "working_directory": str(root), "description": "登录 Windows 后启动并打开本机比特币终端"}


def shortcut_operation(spec, mode, runner=subprocess.run):
    if mode not in ("install", "status", "disable"):
        raise ValueError("unknown shortcut operation")
    payload = base64.b64encode(json.dumps({"spec": spec, "mode": mode}, ensure_ascii=False).encode("utf-8")).decode("ascii")
    # All paths are data inside JSON, never interpolated into executable PowerShell.
    script = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$spec = $value.spec
$shell = New-Object -ComObject WScript.Shell
$exists = Test-Path -LiteralPath $spec.shortcut
$owned = $false
if ($exists) {
    $old = $shell.CreateShortcut($spec.shortcut)
    $owned = ($old.TargetPath -ieq $spec.target) -and ($old.Arguments -ceq $spec.arguments) -and ($old.WorkingDirectory -ieq $spec.working_directory)
}
if (($value.mode -eq 'install' -or $value.mode -eq 'disable') -and $exists -and -not $owned) {
    throw 'A different shortcut already uses this name; it was preserved.'
}
if ($value.mode -eq 'install') {
    $parent = Split-Path -Parent $spec.shortcut
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $shortcut = $shell.CreateShortcut($spec.shortcut)
    $shortcut.TargetPath = $spec.target
    $shortcut.Arguments = $spec.arguments
    $shortcut.WorkingDirectory = $spec.working_directory
    $shortcut.Description = $spec.description
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    $check = $shell.CreateShortcut($spec.shortcut)
    if ($check.TargetPath -ine $spec.target -or $check.Arguments -cne $spec.arguments -or $check.WorkingDirectory -ine $spec.working_directory) {
        throw 'Saved shortcut verification failed.'
    }
    $exists = $true
    $owned = $true
} elseif ($value.mode -eq 'disable' -and $owned) {
    Remove-Item -LiteralPath $spec.shortcut
    $exists = $false
    $owned = $false
}
@{enabled = [bool]($exists -and $owned); conflict = [bool]($exists -and -not $owned); shortcut = $spec.shortcut; target = $spec.target; arguments = $spec.arguments; working_directory = $spec.working_directory} | ConvertTo-Json -Compress
'''.replace("__PAYLOAD__", payload)
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
               base64.b64encode(script.encode("utf-16-le")).decode("ascii")]
    result = runner(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError("无法修改当前用户启动项：" + (result.stderr.strip() or "PowerShell 返回失败。"))
    try:
        value = json.loads(result.stdout.strip())
    except ValueError as exc:
        raise RuntimeError("启动项操作未返回有效结果。") from exc
    if not isinstance(value, dict) or not isinstance(value.get("enabled"), bool):
        raise RuntimeError("启动项验证结果无效。")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description="管理比特币终端的当前用户开机启动项，无需管理员权限。")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--enable", action="store_true")
    group.add_argument("--status", action="store_true")
    group.add_argument("--disable", action="store_true")
    args = parser.parse_args(argv)
    if os.name != "nt":
        parser.error("此功能仅支持 Windows。")
    try:
        mode = "disable" if args.disable else "status" if args.status else "install"
        result = shortcut_operation(installation_spec(require_dependencies=(mode == "install")), mode)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
