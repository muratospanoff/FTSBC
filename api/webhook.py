"""
Serverless-обработчик вебхука Telegram-бота FORCE TRADE SERVICE (Vercel Python
Runtime, без внешних зависимостей — только стандартная библиотека).

Telegram шлёт сюда POST-запрос при каждом новом сообщении/событии бота.
Закрытый доступ: бот пускает в витрину только после того, как пользователь
поделился номером телефона (кнопка запроса контакта). Регистрация компании
(ИП/ТОО, БИН, адреса) происходит внутри самого Mini App и хранится в KV —
см. api/profile.py и api/_common.py.

Функция:
  - проверяет секретный заголовок (защита от чужих запросов на этот URL);
  - если у пользователя ещё нет телефона в KV — просит поделиться контактом
    и ничего другого не показывает;
  - после получения контакта — сохраняет телефон, присылает кнопку «Открыть
    витрину» с подписанной ссылкой (uid+sig), по которой Mini App узнаёт,
    чей это профиль;
  - /id — присылает ID текущего чата (чтобы настроить ADMIN_CHAT_ID);
  - принимает web_app_data (оформленный заказ из Mini App), пересылает всем
    адресам из ADMIN_CHAT_ID и отвечает покупателю подтверждением.

Нужные переменные окружения (Vercel → Settings → Environment Variables):
  BOT_TOKEN        — токен бота из @BotFather
  ADMIN_CHAT_ID    — куда пересылать заказы (chat_id). Можно указать
                      несколько через запятую, чтобы заказы получали
                      сразу несколько человек, например:
                      "111111111,6994024445"
  MINI_APP_URL     — https-адрес витрины (обычно = адрес этого же деплоя)
  WEBHOOK_SECRET   — секрет для проверки заголовка X-Telegram-Bot-Api-Secret-Token
  + переменные хранилища (KV_REST_API_URL/TOKEN или UPSTASH_REDIS_REST_URL/TOKEN),
    их добавляет сам Vercel при подключении Storage → Upstash Redis.
"""

import hashlib
import json
import os
import urllib.request
import urllib.error
import urllib.parse
import hmac
from datetime import datetime
from http.server import BaseHTTPRequestHandler

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "")
# ADMIN_CHAT_ID может содержать несколько chat_id через запятую — заказы
# уходят всем сразу (несколько админов/менеджеров).
ADMIN_CHAT_IDS = [c.strip() for c in ADMIN_CHAT_ID.split(",") if c.strip()]
MINI_APP_URL = os.environ.get("MINI_APP_URL", "")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")

# ---------- KV (Upstash/Vercel) + подпись ссылок — продублировано в
# api/profile.py, т.к. Vercel Python runtime не всегда подхватывает общий
# модуль между отдельными serverless-функциями. ----------

KV_URL = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL") or ""
KV_TOKEN = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""


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

API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"
SHOP_BUTTON_TEXT = "🛍 Открыть витрину"
PHONE_BUTTON_TEXT = "📱 Отправить мой номер телефона"

# Telegram-клиенты (особенно мобильные WebView) иногда кешируют страницу
# Mini App по точному URL и не подхватывают Cache-Control. Добавляем
# версию в query — при каждом значимом деплое фронтенда меняйте эту
# строку, чтобы /start выдавал заведомо "новый" адрес.
BUILD_VERSION = "20260913c"


def call_telegram(method, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}/{method}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            print(f"Telegram API {method}: ok={result.get('ok')}")
            return result
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"Telegram API HTTPError ({method}): {e.code} {body}")
        return {"ok": False, "error_code": e.code, "description": body}
    except Exception as e:
        print(f"Telegram API error ({method}): {e}")
        return {"ok": False, "description": str(e)}


def send_message(chat_id, text, reply_markup=None):
    payload = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return call_telegram("sendMessage", payload)


def format_order(order):
    lines = [f"🆕 Новый заказ №{order.get('orderId', '—')}", ""]
    customer = order.get("customer", {})

    lines.append(f"🏢 {customer.get('orgForm', '—')} «{customer.get('companyName', '—')}»")
    lines.append(f"🧾 БИН/ИИН компании: {customer.get('bin', '—')}")
    lines.append(f"📞 {customer.get('phone', '—')}")
    lines.append(f"📍 Юр. адрес: {customer.get('legalAddress', '—')}")
    lines.append(f"🚚 Адрес доставки: {customer.get('deliveryAddress', '—')}")

    if customer.get("buyerType") == "self":
        lines.append(f"🙋 Заказ для себя лично (ИИН: {customer.get('selfIin', '—')})")
    else:
        lines.append(f"🏢 Заказ для компании")

    if customer.get("comment"):
        lines.append(f"💬 {customer['comment']}")

    lines.append("")
    lines.append("Состав заказа:")
    for item in order.get("items", []):
        price = item.get("price", 0)
        qty = item.get("qty", 0)
        lines.append(f"• {item.get('name', '?')} — {qty} шт. × {price:,} ₸".replace(",", " "))
    total = order.get("total", 0)
    lines.append("")
    lines.append(f"Итого: {total:,} ₸".replace(",", " "))
    return "\n".join(lines)


def shop_button_url(user_id):
    sep = "&" if "?" in MINI_APP_URL else "?"
    return f"{MINI_APP_URL}{sep}v={BUILD_VERSION}&uid={user_id}&sig={sign_uid(user_id)}"


def send_phone_request(chat_id):
    reply_markup = {
        "keyboard": [[{"text": PHONE_BUTTON_TEXT, "request_contact": True}]],
        "resize_keyboard": True,
    }
    return send_message(
        chat_id,
        "Здравствуйте! Доступ к витрине FORCE TRADE SERVICE открыт только "
        "зарегистрированным ИП, ТОО, и лицам достигшим 21 года.\n\n"
        "Пожалуйста, поделитесь номером телефона при помощи кнопки снизу, "
        "чтобы продолжить.",
        reply_markup,
    )


def docs_url(page):
    sep = "&" if "?" in MINI_APP_URL else "?"
    return f"{MINI_APP_URL}/{page}{sep}v={BUILD_VERSION}"


def shop_keyboard(user_id):
    # Reply-keyboard, а не inline: только через неё Mini App получает
    # доступ к Telegram.WebApp.sendData(). Оферта/политика — тоже
    # web_app-кнопки (обычная url-кнопка в reply-keyboard недоступна),
    # но ведут на простые информационные страницы, без uid/sig.
    return {
        "keyboard": [
            [{"text": SHOP_BUTTON_TEXT, "web_app": {"url": shop_button_url(user_id)}}],
            [
                {"text": "📄 Оферта", "web_app": {"url": docs_url("offer.html")}},
                {"text": "🔒 Политика конфиденциальности", "web_app": {"url": docs_url("privacy.html")}},
            ],
        ],
        "resize_keyboard": True,
    }


def handle_start(chat_id, user_id):
    phone = kv_get(f"phone:{user_id}") if kv_configured() else None
    if not phone:
        r = send_phone_request(chat_id)
        return {"handler": "start", "phone_required": True, "send": r}

    if not MINI_APP_URL:
        r = send_message(
            chat_id,
            "Витрина ещё не подключена: не задан MINI_APP_URL в настройках сервера.",
        )
        return {"handler": "start", "mini_app_url_missing": True, "send": r}

    r = send_message(
        chat_id,
        "Добро пожаловать в FORCE TRADE SERVICE!\nНажмите кнопку ниже, чтобы открыть витрину.",
        shop_keyboard(user_id),
    )
    return {"handler": "start", "send": r}


def handle_contact(message):
    chat_id = message["chat"]["id"]
    user_id = message.get("from", {}).get("id")
    contact = message.get("contact", {})

    # Защита: контакт должен принадлежать самому отправителю, а не быть
    # переслан за кого-то другого.
    if contact.get("user_id") and contact.get("user_id") != user_id:
        r = send_message(chat_id, "Пожалуйста, поделитесь именно своим номером телефона.")
        return {"handler": "contact", "mismatch": True, "send": r}

    phone = contact.get("phone_number", "")
    if not phone:
        return {"handler": "contact", "error": "no phone in contact"}

    saved = kv_set(f"phone:{user_id}", phone) if kv_configured() else False
    print(f"phone saved for user_id={user_id}: {saved}")

    if not MINI_APP_URL:
        r = send_message(chat_id, "Спасибо! Витрина скоро будет подключена.")
        return {"handler": "contact", "saved": saved, "send": r}

    r = send_message(
        chat_id,
        "Спасибо! Теперь нажмите кнопку ниже, чтобы открыть витрину и "
        "завершить регистрацию организации.",
        shop_keyboard(user_id),
    )
    return {"handler": "contact", "saved": saved, "send": r}


def handle_id(chat_id):
    r = send_message(
        chat_id,
        f"ID этого чата: {chat_id}\n"
        f"Укажите его в переменной окружения ADMIN_CHAT_ID, чтобы сюда приходили заказы.",
    )
    return {"handler": "id", "send": r}


def handle_web_app_data(chat_id, raw_data, user_id):
    print(f"web_app_data raw: {len(raw_data)} bytes, preview={raw_data[:200]!r}")

    try:
        order = json.loads(raw_data)
    except json.JSONDecodeError as e:
        print(f"JSON parse FAILED: {e}")
        r = send_message(chat_id, "Не удалось обработать заказ. Попробуйте ещё раз.")
        return {"handler": "web_app_data", "json_error": str(e), "send": r}

    order.setdefault("receivedAt", datetime.now().isoformat(timespec="seconds"))
    text = format_order(order)
    print(f"formatted admin text: {len(text)} chars")

    targets = ADMIN_CHAT_IDS or [chat_id]
    print(f"sending admin message to targets={targets!r} (ADMIN_CHAT_ID env={ADMIN_CHAT_ID!r})")
    admin_results = []
    for target_chat in targets:
        r = call_telegram("sendMessage", {"chat_id": target_chat, "text": text})
        print(f"admin_result for {target_chat!r}: {r}")
        admin_results.append({"chat_id": target_chat, "result": r})

    confirm_result = send_message(
        chat_id,
        f"Спасибо! Заказ №{order.get('orderId', '')} принят. "
        f"Мы свяжемся с вами для подтверждения.",
        reply_markup={"remove_keyboard": True},
    )
    print(f"Заказ {order.get('orderId')} от user_id={user_id} обработан")
    return {
        "handler": "web_app_data",
        "order_id": order.get("orderId"),
        "admin_chats_used": targets,
        "admin_send": admin_results,
        "confirm_send": confirm_result,
    }


def process_update(update):
    print(f"incoming update keys: {list(update.keys())}")
    message = update.get("message")
    if not message:
        return {"handler": "none", "reason": "no message in update"}

    print(f"message keys: {list(message.keys())}")
    chat_id = message["chat"]["id"]
    user_id = message.get("from", {}).get("id")

    if "contact" in message:
        return handle_contact(message)

    if "web_app_data" in message:
        return handle_web_app_data(chat_id, message["web_app_data"]["data"], user_id)

    # Закрытый доступ: пока нет телефона в KV — ничего, кроме запроса
    # контакта, не показываем, каким бы ни было сообщение.
    if kv_configured() and not kv_get(f"phone:{user_id}"):
        r = send_phone_request(chat_id)
        return {"handler": "phone_gate", "send": r}

    text = message.get("text", "")
    if text == "/start":
        return handle_start(chat_id, user_id)
    elif text == "/id":
        return handle_id(chat_id)
    return {"handler": "none", "reason": f"unhandled text: {text!r}"}


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if WEBHOOK_SECRET:
            incoming = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
            if not hmac.compare_digest(incoming, WEBHOOK_SECRET):
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b"unauthorized")
                return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"

        try:
            update = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            update = {}

        result = None
        error = None
        try:
            if BOT_TOKEN:
                result = process_update(update)
        except Exception as e:
            error = str(e)
            print(f"Ошибка обработки update: {e}")

        # Telegram нужен только код 200 — тело не важно, но мы кладём туда
        # диагностику, чтобы можно было проверить обработку прямым curl-ом.
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "result": result, "error": error}).encode("utf-8"))

    def do_GET(self):
        # Для ручной проверки, что функция вообще жива
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        kv_env_hint = [k for k in os.environ.keys() if "KV" in k.upper() or "UPSTASH" in k.upper() or "REDIS" in k.upper()]
        self.wfile.write(json.dumps({
            "ok": True,
            "service": "fts-bot-webhook",
            "bot_token_set": bool(BOT_TOKEN),
            "mini_app_url_set": bool(MINI_APP_URL),
            "admin_chat_id_set": bool(ADMIN_CHAT_ID),
            "admin_chat_ids_count": len(ADMIN_CHAT_IDS),
            "webhook_secret_set": bool(WEBHOOK_SECRET),
            "kv_configured": kv_configured(),
            "kv_related_env_vars_found": kv_env_hint,
        }).encode("utf-8"))
