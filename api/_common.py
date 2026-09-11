"""
Общие утилиты для serverless-функций FTSBC: клиент Upstash Redis (через
Vercel KV) и подпись ссылок на Mini App, чтобы страница могла безопасно
узнавать, какому пользователю Telegram она принадлежит.

Не является отдельным route — Vercel не публикует файлы без handler/app.
"""
import hashlib
import hmac
import json
import os
import urllib.request
import urllib.parse
import urllib.error

# Vercel называет переменные по-разному в зависимости от того, как подключено
# хранилище (нативный Vercel KV или интеграция Upstash из Marketplace) —
# проверяем оба варианта имён.
KV_URL = (
    os.environ.get("KV_REST_API_URL")
    or os.environ.get("UPSTASH_REDIS_REST_URL")
    or ""
)
KV_TOKEN = (
    os.environ.get("KV_REST_API_TOKEN")
    or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    or ""
)

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")


def kv_configured():
    return bool(KV_URL and KV_TOKEN)


def _kv_request(path):
    req = urllib.request.Request(
        f"{KV_URL}{path}",
        headers={"Authorization": f"Bearer {KV_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"KV HTTPError: {e.code} {body}")
        return {"error": body}
    except Exception as e:
        print(f"KV error: {e}")
        return {"error": str(e)}


def kv_get(key):
    """Возвращает сохранённую строку или None."""
    if not kv_configured():
        return None
    result = _kv_request(f"/get/{urllib.parse.quote(key, safe='')}")
    return result.get("result") if isinstance(result, dict) else None


def kv_set(key, value):
    """Сохраняет строку (или сериализует dict/list в JSON)."""
    if not kv_configured():
        return False
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False)
    result = _kv_request(
        f"/set/{urllib.parse.quote(key, safe='')}/{urllib.parse.quote(value, safe='')}"
    )
    return isinstance(result, dict) and result.get("result") == "OK"


def kv_get_json(key, default=None):
    raw = kv_get(key)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default


# ---------- Подпись ссылок ----------

def sign_uid(user_id):
    """Короткая подпись user_id — доказывает, что параметр uid в ссылке
    Mini App не подделан, а выдан именно нашим ботом для этого юзера."""
    msg = str(user_id).encode("utf-8")
    return hmac.new(WEBHOOK_SECRET.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:20]


def verify_uid(user_id, sig):
    if not user_id or not sig:
        return False
    expected = sign_uid(user_id)
    return hmac.compare_digest(expected, sig)
