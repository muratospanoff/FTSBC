"""
Serverless-функция профиля покупателя (ИП/ТОО), вызывается напрямую со
страницы Mini App через fetch() — НЕ через Telegram-вебхук.

GET  /api/profile?uid=<id>&sig=<sig>              — вернуть сохранённый профиль
POST /api/profile  {uid, sig, orgForm, companyName, bin, legalAddress,
                     deliveryAddress}              — сохранить/обновить профиль

uid — Telegram user_id, подставляется ботом в адрес кнопки при /start.
sig — подпись uid (см. _common.sign_uid), без неё Mini App не может ни
прочитать, ни записать чужой профиль.
"""
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from _common import kv_get, kv_get_json, kv_set, verify_uid, kv_configured

REQUIRED_FIELDS = ["orgForm", "companyName", "bin", "legalAddress", "deliveryAddress"]


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
