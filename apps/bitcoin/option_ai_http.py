"""Same-origin local-only HTTP boundary shared by both dashboard ports."""
import json
import re
import urllib.parse

from option_ai_service import AIServiceError


def handle_ai(handler):
    url = urllib.parse.urlsplit(handler.path)
    if not url.path.startswith("/api/option-ai"):
        return False
    send_json = getattr(handler, "json", None) or handler._json
    def respond(status, value):
        if status >= 400 and handler.command in ("POST", "DELETE") and not getattr(handler, "_body_consumed", False):
            # Windows may reset a connection with unread request bytes before
            # the browser receives its JSON error. Drain only a small bounded
            # amount; never trust a rejected body's declared length.
            previous_timeout = handler.connection.gettimeout()
            try:
                declared = int(handler.headers.get("Content-Length", "0"))
                budget = declared if 0 < declared <= 65536 else 65536
                handler.connection.settimeout(.15)
                while budget:
                    chunk = handler.rfile.read1(min(8192, budget))
                    if not chunk:
                        break
                    budget -= len(chunk)
            except (OSError, ValueError):
                pass
            finally:
                handler._body_consumed = True
                handler.connection.settimeout(previous_timeout)
        send_json(status, value)
    # Close after each small AI response; malformed bodies cannot desynchronize
    # the next request on a persistent HTTP connection.
    handler.close_connection = True
    port = handler.server.server_address[1]
    allowed = {"127.0.0.1:%s" % port, "localhost:%s" % port}
    if port == 80:
        allowed |= {"127.0.0.1", "localhost"}
    host = handler.headers.get("Host", "").lower()
    origin = handler.headers.get("Origin")
    if (len(handler.headers.get_all("Host", [])) != 1 or host not in allowed
            or len(handler.headers.get_all("Origin", [])) > 1
            or origin is not None and origin != "http://" + host):
        respond(403, {"error": "AI 服务仅允许当前本机网页访问。"})
        return True
    service = getattr(handler.server, "ai_service", None)
    if service is None:
        respond(503, {"error": "AI 服务尚未启动，行情继续更新。"})
        return True
    try:
        if url.query:
            raise AIServiceError("invalid_request", "AI 请求不接受查询参数。")
        path, method = url.path, handler.command
        body = None
        if method in ("POST", "DELETE"):
            if (len(handler.headers.get_all("X-Terminal-Request", [])) != 1
                    or handler.headers.get("X-Terminal-Request") != "1"):
                raise AIServiceError("forbidden", "请通过看板页面操作。", 403)
            if handler.headers.get("Transfer-Encoding"):
                raise AIServiceError("invalid_request", "不支持流式请求体。")
            lengths = handler.headers.get_all("Content-Length", [])
            if len(lengths) > 1:
                raise AIServiceError("invalid_request", "请求体长度无效。")
            length = int(lengths[0]) if lengths else 0
            if method == "DELETE":
                if length:
                    raise AIServiceError("invalid_request", "取消操作不接受请求体。")
            else:
                if (len(handler.headers.get_all("Content-Type", [])) != 1
                        or handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
                    raise AIServiceError("forbidden", "请通过看板页面发送 JSON 请求。", 403)
                if not 0 < length <= 65536:
                    raise AIServiceError("invalid_request", "请求体大小无效。")
                handler.connection.settimeout(5)
                raw = handler.rfile.read(length)
                handler._body_consumed = True
                def pairs(items):
                    output = {}
                    for key, value in items:
                        if key in output:
                            raise ValueError()
                        output[key] = value
                    return output
                def constant(_):
                    raise ValueError()
                body = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
                if not isinstance(body, dict):
                    raise ValueError()
        if method == "GET" and path == "/api/option-ai/status":
            respond(200, service.status())
        elif method == "POST" and path == "/api/option-ai/config":
            if set(body) != {"api_key"}:
                raise ValueError()
            respond(200, service.configure(body["api_key"]))
        elif method == "POST" and path == "/api/option-ai/jobs":
            if "risk_profile" in body:
                if not {"risk_profile", "model"} <= set(body) <= {"risk_profile", "model", "expiry", "quantity"}:
                    raise ValueError()
            elif not {"question", "model"} <= set(body) <= {"question", "model", "history", "previous_criteria"}:
                raise ValueError()
            respond(202, service.submit(**body))
        elif method == "POST" and path == "/api/option-ai/selection":
            if not {"symbol", "criteria"} <= set(body) <= {"symbol", "criteria", "risk_profile"}:
                raise ValueError()
            respond(200, service.select(**body))
        else:
            match = re.fullmatch(r"/api/option-ai/jobs/([a-f0-9]{32})(/revalidate)?", path)
            if match and method == "GET" and not match[2]:
                respond(200, service.read_job(match[1]))
            elif match and method == "DELETE" and not match[2]:
                respond(200, service.cancel(match[1]))
            elif match and method == "POST" and match[2]:
                if body:
                    raise ValueError()
                respond(200, service.revalidate(match[1]))
            else:
                respond(405, {"error": "AI 路径或操作不受支持。"})
    except AIServiceError as exc:
        respond(exc.status, {"error": str(exc), "code": exc.code})
    except (ValueError, TypeError, UnicodeError, TimeoutError):
        respond(400, {"error": "AI 请求格式无效，请检查参数。"})
    except Exception:
        respond(503, {"error": "AI 服务暂时不可用，行情继续更新。"})
    return True
