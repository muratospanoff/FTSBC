"""
Serverless-функция профиля покупателя (ИП/ТОО), вызывается напрямую со
страницы Mini App через fetch() — НЕ через Telegram-вебхук.

GET  /api/profile?uid=<id>&sig=<sig>              — вернуть сохранённый профиль
POST /api/profile  {uid, sig, orgForm, companyName, bin, legalAddress,
                     deliveryAddress}              — сохранить/обновить профиль

uid — Telegram user_id, подставляется ботом в адрес кнопки при /start.
sig — подпись uid (HMAC по WEBHOOK_SECRET), без неё Mini App не может ни
прочитать, ни записать чужой профиль.
"""
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
KV_URL = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL") or ""
KV_TOKEN = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""

REQUIRED_FIELDS = ["orgForm", "companyName", "bin", "legalAddress", "deliveryAddress"]


def kv_configured():
    return bool(KV_URL and KV_TOKEN)


def _kv_request(path):
    req = urllib.request.Request(f"{KV_URL}{path}", headers={"Authorization": f"Bearer {KV_TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"KV HTTPError: {e.code} {e.read().decode('utf-8', errors='replace')}")
        return {"error": True}
    except Exception as e:
        print(f"KV error: {e}")
        return {"error": True}


def kv_get(key):
    if not kv_configured():
        return None
    result = _kv_request(f"/get/{urllib.parse.quote(key, safe='')}")
    return result.get("result") if isinstance(result, dict) else None


def kv_get_json(key, default=None):
    raw = kv_get(key)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default


def kv_set(key, value):
    if not kv_configured():
        return False
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False)
    result = _kv_request(f"/set/{urllib.parse.quote(key, safe='')}/{urllib.parse.quote(value, safe='')}")
    return isinstance(result, dict) and result.get("result") == "OK"


def sign_uid(user_id):
    msg = str(user_id).encode("utf-8")
    return hmac.new(WEBHOOK_SECRET.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:20]


def verify_uid(user_id, sig):
    if not user_id or not sig:
        return False
    return hmac.compare_digest(sign_uid(user_id), sig)


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        uid = qs.get("uid", [""])[0]
        sig = qs.get("sig", [""])[0]

        if not verify_uid(uid, sig):
            self._send_json(403, {"ok": False, "error": "invalid signature"})
            return

        if not kv_configured():
            self._send_json(200, {"ok": True, "registered": False, "storageMissing": True})
            return

        profile = kv_get_json(f"profile:{uid}")
        phone = kv_get(f"phone:{uid}")
        if profile:
            self._send_json(200, {"ok": True, "registered": True, "profile": profile, "phone": phone})
        else:
            self._send_json(200, {"ok": True, "registered": False, "phone": phone})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "bad json"})
            return

        uid = str(data.get("uid", ""))
        sig = data.get("sig", "")
        if not verify_uid(uid, sig):
            self._send_json(403, {"ok": False, "error": "invalid signature"})
            return

        missing = [f for f in REQUIRED_FIELDS if not str(data.get(f, "")).strip()]
        if missing:
            self._send_json(400, {"ok": False, "error": f"missing fields: {', '.join(missing)}"})
            return

        if not kv_configured():
            self._send_json(200, {"ok": False, "error": "storage not configured"})
            return

        profile = {f: str(data[f]).strip() for f in REQUIRED_FIELDS}
        saved = kv_set(f"profile:{uid}", profile)
        phone = kv_get(f"phone:{uid}")
        self._send_json(200, {"ok": bool(saved), "profile": profile, "phone": phone})
