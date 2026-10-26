"""Durable, asynchronous QQ email alerts; no account/trading API access."""
import base64
import json
import math
import os
import re
import smtplib
import sqlite3
import ssl
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path


TTL_MS = 15 * 60 * 1000
STATES = ("queued", "sending", "accepted", "failed", "unknown", "expired", "cancelled")
ERRORS = {
    "authentication": "QQ 邮箱登录失败，请检查发件邮箱及 SMTP 授权码。",
    "recipient": "邮件服务器拒绝收件地址。",
    "rejected": "邮件服务器未接受邮件。",
    "transport": "邮件服务连接暂不可用。",
    "unknown": "发送结果不确定，为避免重复通知，未自动重发。",
    "expired": "提醒已超过 15 分钟有效期，未发送。",
    "cancelled": "通知配置已变更，原待发提醒已取消。",
    "tls": "邮件服务证书校验失败。",
}


def _dpapi(data, decrypt=False):
    if os.name != "nt":
        raise RuntimeError("当前系统无法使用 Windows 用户凭据保护。")
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise RuntimeError("Windows 用户凭据保护失败。")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel.LocalFree(target.data)


def _address(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._+-]{1,64}@(qq|foxmail)\.com", value, re.I):
        raise ValueError("请填写有效的 QQ 或 foxmail 发件邮箱。")
    return value.lower()


def _code(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9]{8,128}", value):
        raise ValueError("请填写 QQ 邮箱提供的 SMTP 授权码。")
    return value


def _numeric(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if math.isfinite(value) else None
    except (OverflowError, ValueError):
        return None


class EmailAlertService:
    """One local durable outbox. Accepted means SMTP acceptance, not delivery.

    ``email`` in configure is the sender/login; the recipient is fixed when the
    service is constructed. Inject seal/unseal and smtp_factory in offline tests.
    Only fresh market records enqueue automatically. No credentials enter jobs,
    public status, logs, exception messages, or email bodies.
    """
    def __init__(self, directory, smtp_factory=None, seal=None, unseal=None,
                 recipient="oxjackye@qq.com", clock=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._config_path = self.directory / "email-config.protected.json"
        self._db_path = self.directory / "email-outbox.sqlite3"
        self._smtp_factory = smtp_factory or smtplib.SMTP_SSL
        self._seal = seal or _dpapi
        self._unseal = unseal or (lambda data: _dpapi(data, decrypt=True))
        self._recipient = _address(recipient)
        self._clock = clock or time.time
        self._condition = threading.Condition(threading.RLock())
        self._stop = threading.Event()
        self._closed = False
        self._thread = None
        self._owner = uuid.uuid4().hex
        self._epoch = 0
        self._config = {"email": None, "protected_code": None, "enabled": False, "enabled_at": None}
        self._secret = None
        self._last_error = None
        with self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS service (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at_ms INTEGER NOT NULL, payload TEXT NOT NULL, error TEXT, owner TEXT)")
            db.execute("CREATE INDEX IF NOT EXISTS due_jobs ON jobs(state,next_at_ms)")
            db.execute("INSERT OR REPLACE INTO service VALUES ('owner',?)", (self._owner,))
            db.execute("UPDATE jobs SET state='unknown',error='unknown',updated_at_ms=? WHERE state='sending'", (self._now(),))
        self._load_config()

    def _now(self):
        return int(self._clock() * 1000)

    @contextmanager
    def _db(self, timeout=2):
        db = sqlite3.connect(str(self._db_path), timeout=timeout)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA synchronous=FULL")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _owns(self, db):
        owner = db.execute("SELECT value FROM service WHERE name='owner'").fetchone()
        return owner is not None and owner[0] == self._owner

    def _require_active(self, db):
        if self._closed or not self._owns(db):
            raise RuntimeError("邮件通知服务已停止，请重新启动终端。")

    def _ready(self):
        return bool(self._config["email"] and self._secret)

    def _load_config(self):
        try:
            value = json.loads(self._config_path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or value.get("version") != 1 or type(value.get("enabled")) is not bool:
                raise ValueError()
            sender = _address(value["email"])
            protected = value["protected_code"]
            secret = _code(self._unseal(base64.b64decode(protected, validate=True)).decode("ascii"))
            enabled_at = _numeric(value.get("enabled_at"))
            if value["enabled"] and (enabled_at is None or enabled_at <= 0):
                raise ValueError()
            self._config = {"email": sender, "protected_code": protected,
                            "enabled": value["enabled"], "enabled_at": enabled_at}
            self._secret = secret
        except FileNotFoundError:
            pass
        except Exception:
            self._last_error = "无法读取或解密邮件配置，请重新填写授权码。"

    def _save_config(self, config):
        temporary = self._config_path.with_name(self._config_path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump(dict(config, version=1), stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(str(temporary), str(self._config_path))
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    def configure(self, email=None, authorization_code=None, enabled=None):
        if email is not None and not isinstance(email, str) or authorization_code is not None and not isinstance(authorization_code, str):
            raise ValueError("发件邮箱和授权码必须为文本。")
        if enabled is not None and type(enabled) is not bool:
            raise ValueError("邮件开关必须为开启或关闭。")
        with self._condition:
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                self._require_active(db)
                sender = _address(email.strip()) if email else self._config["email"]
                changed_sender = sender != self._config["email"]
                new_code = bool(authorization_code)
                if changed_sender and not new_code:
                    raise ValueError("更换发件邮箱时必须重新填写 SMTP 授权码。")
                secret = _code(authorization_code.strip()) if new_code else self._secret
                if not sender or not secret:
                    raise ValueError("请先填写发件邮箱和 SMTP 授权码。")
                try:
                    protected = (base64.b64encode(self._seal(secret.encode("ascii"))).decode("ascii")
                                 if new_code else self._config["protected_code"])
                except Exception:
                    raise ValueError("Windows 凭据加密失败，授权码未保存。") from None
                active = self._config["enabled"] if enabled is None else enabled
                reset = active and (not self._config["enabled"] or changed_sender or new_code)
                config = {"email": sender, "protected_code": protected, "enabled": active,
                          "enabled_at": self._now() if reset else self._config["enabled_at"]}
                try:
                    self._save_config(config)
                except Exception:
                    raise ValueError("邮件配置保存失败，未启用新设置。") from None
                self._config, self._secret = config, secret
                self._epoch += 1
                self._last_error = None
                if reset or not active:
                    db.execute("UPDATE jobs SET state='cancelled',error='cancelled',updated_at_ms=? WHERE state='queued'", (self._now(),))
            self._condition.notify_all()
        return self.read_public()

    def _payload(self, alert):
        return {key: alert[key] for key in ("metric", "direction") if alert.get(key) in
                ("daily_change", "day_range", "up", "down", "range", "test")} | {
            key: _numeric(alert.get(key)) for key in ("price", "threshold_pct", "change_pct", "range_pct", "at_ms")}

    def enqueue(self, alert):
        if not isinstance(alert, dict) or alert.get("kind") != "market":
            return False
        # Disabled notification paths must not touch SQLite on each market tick.
        if self._closed or not self._config["enabled"] or not self._ready():
            return False
        identifier = alert.get("id")
        created = _numeric(alert.get("local_at_ms", alert.get("at_ms")))
        event_at = _numeric(alert.get("at_ms"))
        if (not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identifier)
                or created is None or event_at is None or not 0 < event_at < 253402300800000):
            return False
        if not self._condition.acquire(timeout=.05):
            return False
        try:
            with self._db(timeout=.05) as db:
                db.execute("BEGIN IMMEDIATE")
                if self._closed or not self._owns(db) or not self._config["enabled"] or not self._ready():
                    return False
                now, cutoff = self._now(), self._config["enabled_at"]
                if cutoff is None or created < cutoff or created > now + 2000 or now - created > TTL_MS:
                    return False
                result = db.execute("INSERT OR IGNORE INTO jobs(id,kind,created_at_ms,updated_at_ms,state,next_at_ms,payload) VALUES (?,?,?,?,'queued',?,?)",
                    (identifier, "market", int(created), now, now, json.dumps(self._payload(alert), allow_nan=False)))
                inserted = result.rowcount == 1
            self._condition.notify_all()
            return inserted
        except sqlite3.Error:
            self._last_error = "邮件队列暂时繁忙，正在自动重试排队。"
            return False
        finally:
            self._condition.release()

    def enqueue_test(self):
        with self._condition:
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                self._require_active(db)
                if not self._ready() or not self._config["enabled"]:
                    raise ValueError("请先配置并启用邮件提醒。")
                identifier, now = "test-" + uuid.uuid4().hex, self._now()
                db.execute("INSERT INTO jobs(id,kind,created_at_ms,updated_at_ms,state,next_at_ms,payload) VALUES (?,'test',?,?,'queued',?,?)",
                    (identifier, now, now, now, json.dumps({"direction": "test"})))
            self._condition.notify_all()
            return {"id": identifier, "state": "queued"}

    test = enqueue_test

    def read_public(self):
        with self._condition:
            with self._db() as db:
                counts = {state: 0 for state in STATES}
                counts.update({row[0]: row[1] for row in db.execute("SELECT state,count(*) FROM jobs GROUP BY state")})
                recent = [{"id": row["id"], "kind": row["kind"], "state": row["state"],
                           "created_at_ms": row["created_at_ms"], "updated_at_ms": row["updated_at_ms"],
                           "attempts": row["attempts"], "error": ERRORS.get(row["error"])}
                          for row in db.execute("SELECT * FROM jobs ORDER BY updated_at_ms DESC,rowid DESC LIMIT 20")]
            name, domain = self._recipient.split("@")
            return {"enabled": self._config["enabled"], "configured": self._ready(),
                    "recipient_masked": name[:2] + "***@" + domain,
                    "enabled_at": self._config["enabled_at"], "last_error": self._last_error,
                    "counts": counts, "recent": recent}

    status = read_public

    def start(self):
        with self._condition:
            with self._db() as db:
                self._require_active(db)
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="btc-alert-email", daemon=True)
                self._thread.start()

    def _claim(self):
        with self._condition:
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                if self._closed or not self._owns(db) or not self._config["enabled"] or not self._ready():
                    return None
                now, enabled_at = self._now(), self._config["enabled_at"]
                db.execute("UPDATE jobs SET state='expired',error='expired',updated_at_ms=? WHERE state='queued' AND created_at_ms<?", (now, now - TTL_MS))
                db.execute("UPDATE jobs SET state='cancelled',error='cancelled',updated_at_ms=? WHERE state='queued' AND created_at_ms<?", (now, enabled_at))
                row = db.execute("SELECT * FROM jobs WHERE state='queued' AND next_at_ms<=? ORDER BY created_at_ms,rowid LIMIT 1", (now,)).fetchone()
                if row is None:
                    return None
                db.execute("UPDATE jobs SET state='sending',attempts=attempts+1,owner=?,updated_at_ms=? WHERE id=?", (self._owner, now, row["id"]))
                return dict(row), self._config["email"], self._secret, self._epoch

    def _message(self, job, sender):
        payload = json.loads(job["payload"])
        message = EmailMessage()
        message["From"], message["To"] = sender, self._recipient
        message["Message-ID"] = "<btc-alert-" + job["id"] + "@local.invalid>"
        message["Date"] = format_datetime(datetime.fromtimestamp(self._now() / 1000, timezone.utc))
        subject = "BTC 价格提醒测试"
        if job["kind"] != "test":
            if payload.get("metric") == "day_range":
                subject = "BTC 当日振幅"
                percent = payload.get("range_pct")
            else:
                subject = "BTC " + {"up": "上涨", "down": "下跌"}.get(payload.get("direction"), "价格警报")
                percent = payload.get("change_pct")
            if percent is not None:
                subject += " %.2f%%" % abs(percent)
            if payload.get("price") is not None:
                subject += " · %.2f USDT" % payload["price"]
        message["Subject"] = subject
        instant = datetime.fromtimestamp((payload.get("at_ms") or job["created_at_ms"]) / 1000, timezone(timedelta(hours=8)))
        text = ["这是一封 BTC 价格提醒测试邮件。" if job["kind"] == "test" else "BTC 价格已触发你在终端设置的提醒规则。",
                "北京时间：" + instant.strftime("%Y-%m-%d %H:%M:%S")]
        labels = {"price": "BTC 价格（USDT）", "threshold_pct": "提醒阈值（%）", "change_pct": "当日涨跌幅（%）", "range_pct": "当日振幅（%）"}
        for key, label in labels.items():
            if payload.get(key) is not None:
                text.append(label + "：" + str(payload[key]))
        text.append("请打开本机比特币终端查看最新行情。邮件可能延迟。")
        message.set_content("\n".join(text))
        return message.as_bytes()

    def _finish(self, job, state, error=None, delay=0):
        with self._condition:
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                if self._closed or not self._owns(db):
                    return
                db.execute("UPDATE jobs SET state=?,error=?,next_at_ms=?,updated_at_ms=? WHERE id=? AND owner=? AND state='sending'",
                    (state, error, self._now() + delay * 1000, self._now(), job["id"], self._owner))
            self._last_error = ERRORS.get(error)
            self._condition.notify_all()

    def _send(self, claimed):
        job, sender, secret, epoch = claimed
        client, phase = None, "connect"
        try:
            client = self._smtp_factory("smtp.qq.com", 465, timeout=8, context=ssl.create_default_context())
            phase = "login"
            client.login(sender, secret)
            with self._condition:
                with self._db() as db:
                    if self._closed or not self._owns(db) or epoch != self._epoch or not self._config["enabled"]:
                        self._finish(job, "cancelled", "cancelled")
                        return
            packet = self._message(job, sender)
            phase = "data"
            refused = client.sendmail(sender, [self._recipient], packet)
            self._finish(job, "failed" if refused else "accepted", "recipient" if refused else None)
        except smtplib.SMTPAuthenticationError:
            self._finish(job, "failed", "authentication")
        except smtplib.SMTPRecipientsRefused:
            self._finish(job, "failed", "recipient")
        except (smtplib.SMTPSenderRefused, smtplib.SMTPDataError):
            self._finish(job, "failed", "rejected")
        except ssl.SSLCertVerificationError:
            self._finish(job, "failed", "tls")
        except Exception:
            if phase == "data":
                self._finish(job, "unknown", "unknown")
            elif job["attempts"] < 2:
                self._finish(job, "queued", "transport", delay=5 * 2 ** job["attempts"])
            else:
                self._finish(job, "failed", "transport")
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    def _run(self):
        while not self._stop.is_set():
            try:
                claimed = self._claim()
                if claimed is not None:
                    self._send(claimed)
                    continue
            except Exception:
                with self._condition:
                    self._last_error = "邮件通知队列暂不可用，请稍后检查。"
            with self._condition:
                if not self._stop.is_set():
                    self._condition.wait(1)

    def stop(self):
        with self._condition:
            if self._closed:
                return
            self._closed = True
            self._stop.set()
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                if self._owns(db):
                    db.execute("UPDATE jobs SET state='unknown',error='unknown',updated_at_ms=? WHERE state='sending' AND owner=?", (self._now(), self._owner))
            self._condition.notify_all()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)
