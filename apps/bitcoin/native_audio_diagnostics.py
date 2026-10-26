"""Read-only Windows audio endpoint diagnostics; no playback or setting changes.

Uses only Python's standard library and Microsoft's Core Audio COM interfaces.
API success says nothing about whether a human actually heard a sound.
"""

import ctypes
import os
import sys
import uuid
from ctypes import wintypes


class GUID(ctypes.Structure):
    _fields_ = [("data1", ctypes.c_uint32), ("data2", ctypes.c_uint16),
                ("data3", ctypes.c_uint16), ("data4", ctypes.c_ubyte * 8)]

    @classmethod
    def from_string(cls, value):
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", ctypes.c_uint32)]


class _BLOB(ctypes.Structure):
    _fields_ = [("length", ctypes.c_uint32), ("data", ctypes.c_void_p)]


class _VALUE(ctypes.Union):
    _fields_ = [("text", ctypes.c_wchar_p), ("blob", _BLOB),
                ("integer", ctypes.c_int64)]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_uint16), ("reserved1", ctypes.c_uint16),
                ("reserved2", ctypes.c_uint16), ("reserved3", ctypes.c_uint16),
                ("value", _VALUE)]


def _check_hresult(value, operation):
    if value < 0:
        raise OSError("{} failed (HRESULT 0x{:08X})".format(operation, value & 0xffffffff))


def _method(pointer, index, result_type, *argument_types):
    table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(result_type, ctypes.c_void_p, *argument_types)(table[index])


def _release(pointer):
    if pointer:
        _method(pointer, 2, ctypes.c_uint32)(pointer)


def _target_audio_sessions(device, playback_pid):
    """Inspect only System Sounds and the requested playback process.

    Other session names, identifiers, volumes and process IDs are not returned.
    The collection is a snapshot and may omit a session that has not played yet.
    """
    manager = ctypes.c_void_p()
    enumerator = ctypes.c_void_p()
    result = []
    try:
        iid = GUID.from_string("77aa99a0-1bd6-484f-8bc7-2c654c9a9b6f")
        _check_hresult(_method(device, 3, ctypes.c_long, ctypes.POINTER(GUID),
                               ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
                                   device, ctypes.byref(iid), 7, None, ctypes.byref(manager)),
                       "Activate(IAudioSessionManager2)")
        _check_hresult(_method(manager, 5, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p))(
            manager, ctypes.byref(enumerator)), "GetSessionEnumerator")
        count = ctypes.c_int()
        _check_hresult(_method(enumerator, 3, ctypes.c_long, ctypes.POINTER(ctypes.c_int))(
            enumerator, ctypes.byref(count)), "GetCount")
        for index in range(count.value):
            control = ctypes.c_void_p()
            control2 = ctypes.c_void_p()
            volume = ctypes.c_void_p()
            try:
                _check_hresult(_method(enumerator, 4, ctypes.c_long, ctypes.c_int,
                                       ctypes.POINTER(ctypes.c_void_p))(
                                           enumerator, index, ctypes.byref(control)), "GetSession")
                control_iid = GUID.from_string("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d")
                _check_hresult(_method(control, 0, ctypes.c_long, ctypes.POINTER(GUID),
                                       ctypes.POINTER(ctypes.c_void_p))(
                                           control, ctypes.byref(control_iid), ctypes.byref(control2)),
                               "QueryInterface(IAudioSessionControl2)")
                system_result = _method(control2, 15, ctypes.c_long)(control2)
                _check_hresult(system_result, "IsSystemSoundsSession")
                process_id = ctypes.c_uint32()
                _check_hresult(_method(control2, 14, ctypes.c_long, ctypes.POINTER(ctypes.c_uint32))(
                    control2, ctypes.byref(process_id)), "GetProcessId")
                is_system = system_result == 0
                is_playback = process_id.value == playback_pid
                if not is_system and not is_playback:
                    continue
                volume_iid = GUID.from_string("87ce5498-68d6-44e5-9215-6da47ef883d8")
                _check_hresult(_method(control, 0, ctypes.c_long, ctypes.POINTER(GUID),
                                       ctypes.POINTER(ctypes.c_void_p))(
                                           control, ctypes.byref(volume_iid), ctypes.byref(volume)),
                               "QueryInterface(ISimpleAudioVolume)")
                level = ctypes.c_float()
                muted = wintypes.BOOL()
                _check_hresult(_method(volume, 4, ctypes.c_long, ctypes.POINTER(ctypes.c_float))(
                    volume, ctypes.byref(level)), "GetMasterVolume")
                _check_hresult(_method(volume, 6, ctypes.c_long, ctypes.POINTER(wintypes.BOOL))(
                    volume, ctypes.byref(muted)), "GetMute(session)")
                result.append({"kind": "system_sounds" if is_system else "playback_process",
                               "volume_percent": round(level.value * 100, 1),
                               "muted": bool(muted.value)})
            finally:
                _release(volume)
                _release(control2)
                _release(control)
        return {"inspected": True, "sessions": result}
    except (OSError, ValueError) as error:
        return {"inspected": False, "error": str(error), "sessions": result}
    finally:
        _release(enumerator)
        _release(manager)


def _endpoint_info(enumerator, role, ole32, playback_pid):
    device = ctypes.c_void_p()
    properties = ctypes.c_void_p()
    volume = ctypes.c_void_p()
    result = {"role": role, "available": False}
    try:
        _check_hresult(_method(enumerator, 4, ctypes.c_long, ctypes.c_int,
                               ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(
                                   enumerator, 0, role, ctypes.byref(device)),
                       "GetDefaultAudioEndpoint")
        result["available"] = True
        state = ctypes.c_uint32()
        _check_hresult(_method(device, 6, ctypes.c_long, ctypes.POINTER(ctypes.c_uint32))(
            device, ctypes.byref(state)), "GetState")
        result["state"] = state.value
        result["active"] = state.value == 1

        _check_hresult(_method(device, 4, ctypes.c_long, ctypes.c_uint32,
                               ctypes.POINTER(ctypes.c_void_p))(
                                   device, 0, ctypes.byref(properties)), "OpenPropertyStore")
        key = PROPERTYKEY(GUID.from_string("a45c254e-df1c-4efd-8020-67d146a850e0"), 14)
        value = PROPVARIANT()
        try:
            _check_hresult(_method(properties, 5, ctypes.c_long, ctypes.POINTER(PROPERTYKEY),
                                   ctypes.POINTER(PROPVARIANT))(
                                       properties, ctypes.byref(key), ctypes.byref(value)),
                           "GetValue(FriendlyName)")
            if value.vt == 31:
                result["name"] = value.value.text
        finally:
            ole32.PropVariantClear(ctypes.byref(value))

        iid = GUID.from_string("5cdf2c82-841e-4546-9722-0cf74078229a")
        _check_hresult(_method(device, 3, ctypes.c_long, ctypes.POINTER(GUID),
                               ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
                                   device, ctypes.byref(iid), 7, None, ctypes.byref(volume)),
                       "Activate(IAudioEndpointVolume)")
        level = ctypes.c_float()
        muted = wintypes.BOOL()
        _check_hresult(_method(volume, 9, ctypes.c_long, ctypes.POINTER(ctypes.c_float))(
            volume, ctypes.byref(level)), "GetMasterVolumeLevelScalar")
        _check_hresult(_method(volume, 15, ctypes.c_long, ctypes.POINTER(wintypes.BOOL))(
            volume, ctypes.byref(muted)), "GetMute")
        result["volume_percent"] = round(level.value * 100, 1)
        result["muted"] = bool(muted.value)
        result["audio_sessions"] = _target_audio_sessions(device, playback_pid)
    except (OSError, ValueError) as error:
        result["error"] = str(error)
    finally:
        _release(volume)
        _release(properties)
        _release(device)
    return result


def get_audio_status(playback_pid=None):
    """Return diagnostics only; do not alter devices, volumes or play sounds."""
    result = {"platform": sys.platform, "available": False}
    if sys.platform != "win32":
        result["error"] = "Windows Core Audio is unavailable on this platform"
        return result

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    session_id = wintypes.DWORD()
    kernel32.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel32.ProcessIdToSessionId.restype = wintypes.BOOL
    if kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session_id)):
        result["process_session_id"] = session_id.value
    kernel32.WTSGetActiveConsoleSessionId.restype = wintypes.DWORD
    console_id = kernel32.WTSGetActiveConsoleSessionId()
    if console_id != 0xffffffff:
        result["active_console_session_id"] = console_id
        result["same_as_console_session"] = session_id.value == console_id

    ole32 = ctypes.WinDLL("ole32")
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoCreateInstance.argtypes = [ctypes.POINTER(GUID), ctypes.c_void_p,
                                     ctypes.c_uint32, ctypes.POINTER(GUID),
                                     ctypes.POINTER(ctypes.c_void_p)]
    ole32.CoCreateInstance.restype = ctypes.c_long
    ole32.PropVariantClear.argtypes = [ctypes.POINTER(PROPVARIANT)]
    ole32.PropVariantClear.restype = ctypes.c_long
    enumerator = ctypes.c_void_p()
    initialized = False
    try:
        init_result = ole32.CoInitializeEx(None, 0)
        initialized = init_result in (0, 1)
        # An already initialized STA is also safe for these synchronous reads.
        if init_result < 0 and (init_result & 0xffffffff) != 0x80010106:
            _check_hresult(init_result, "CoInitializeEx")
        clsid = GUID.from_string("bcde0395-e52f-467c-8e3d-c4579291692e")
        iid = GUID.from_string("a95664d2-9614-4f35-a746-de8db63617e6")
        _check_hresult(ole32.CoCreateInstance(ctypes.byref(clsid), None, 1,
                                             ctypes.byref(iid), ctypes.byref(enumerator)),
                       "CoCreateInstance(MMDeviceEnumerator)")
        target_pid = os.getpid() if playback_pid is None else int(playback_pid)
        result["endpoints"] = [_endpoint_info(enumerator, role, ole32, target_pid) for role in (0, 1)]
        result["available"] = any(item["available"] for item in result["endpoints"])
    except (OSError, ValueError) as error:
        result["error"] = str(error)
    finally:
        _release(enumerator)
        if initialized:
            ole32.CoUninitialize()
    return result


if __name__ == "__main__":
    import json
    print(json.dumps(get_audio_status(), ensure_ascii=True, indent=2))
