"""
Serverless-обработчик вебхука Telegram-бота FORCE TRADE SERVICE (Vercel Python
Runtime, без внешних зависимостей — только стандартная библиотека).

Telegram шлёт сюда POST-запрос при каждом новом сообщении/событии бота.
Функция:
  - проверяет секретный заголовок (защита от чужих запросов на этот URL);
  - /start — присылает reply-кнопку «Открыть витрину» (если задан MINI_APP_URL);
  - /id — присылает ID текущего чата (чтобы настроить ADMIN_CHAT_ID);
  - принимает web_app_data (оформленный заказ из Mini App), пересылает в
    ADMIN_CHAT_ID и отвечает покупателю подтверждением.

Нужные переменные окружения (Vercel → Settings → Environment Variables):
  BOT_TOKEN        — токен бота из @BotFather
  ADMIN_CHAT_ID    — куда пересылать заказы (chat_id)
  MINI_APP_URL     — https-адрес витрины (обычно = адрес этого же деплоя)
  WEBHOOK_SECRET   — секрет для проверки заголовка X-Telegram-Bot-Api-Secret-Token
"""

import json
import os
import urllib.request
import hmac
from datetime import datetime
from http.server import BaseHTTPRequestHandler

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "")
MINI_APP_URL = os.environ.get("MINI_APP_URL", "")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")

API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"
SHOP_BUTTON_TEXT = "🛍 Открыть витрину"


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
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Telegram API error ({method}): {e}")
        return None


def send_message(chat_id, text, reply_markup=None):
    payload = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return call_telegram("sendMessage", payload)


def format_order(order):
    lines = [f"🆕 Новый заказ №{order.get('orderId', '—')}", ""]
    customer = order.get("customer", {})
    lines.append(f"👤 {customer.get('name', '—')}")
    lines.append(f"📞 {customer.get('phone', '—')}")
    method = "Доставка" if customer.get("method") == "delivery" else "Самовывоз"
    lines.append(f"🚚 {method}")
    if customer.get("address"):
        lines.append(f"📍 {customer['address']}")
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


def handle_start(chat_id):
    if not MINI_APP_URL:
        send_message(
            chat_id,
            "Витрина ещё не подключена: не задан MINI_APP_URL в настройках сервера.",
        )
        return
    reply_markup = {
        "keyboard": [[{"text": SHOP_BUTTON_TEXT, "web_app": {"url": MINI_APP_URL}}]],
        "resize_keyboard": True,
    }
    send_message(
        chat_id,
        "Добро пожаловать в FORCE TRADE SERVICE!\nНажмите кнопку ниже, чтобы открыть витрину.",
        reply_markup,
    )


def handle_id(chat_id):
    send_message(
        chat_id,
        f"ID этого чата: {chat_id}\n"
        f"Укажите его в переменной окружения ADMIN_CHAT_ID, чтобы сюда приходили заказы.",
    )


def handle_web_app_data(chat_id, raw_data, user_id):
    try:
        order = json.loads(raw_data)
    except json.JSONDecodeError:
        send_message(chat_id, "Не удалось обработать заказ. Попробуйте ещё раз.")
        return

    order.setdefault("receivedAt", datetime.now().isoformat(timespec="seconds"))
    text = format_order(order)

    target_chat = ADMIN_CHAT_ID or chat_id
    call_telegram("sendMessage", {"chat_id": target_chat, "text": text})

    send_message(
        chat_id,
        f"Спасибо! Заказ №{order.get('orderId', '')} принят. "
        f"Мы свяжемся с вами для подтверждения.",
        reply_markup={"remove_keyboard": True},
    )
    print(f"Заказ {order.get('orderId')} от user_id={user_id} обработан")


def process_update(update):
    message = update.get("message")
    if not message:
        return

    chat_id = message["chat"]["id"]
    user_id = message.get("from", {}).get("id")

    if "web_app_data" in message:
        handle_web_app_data(chat_id, message["web_app_data"]["data"], user_id)
        return

    text = message.get("text", "")
    if text == "/start":
        handle_start(chat_id)
    elif text == "/id":
        handle_id(chat_id)


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

        try:
            if BOT_TOKEN:
                process_update(update)
        except Exception as e:
            print(f"Ошибка обработки update: {e}")

        # Telegram нужен только код 200 — тело не важно
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def do_GET(self):
        # Для ручной проверки, что функция вообще жива
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "ok": True,
            "service": "fts-bot-webhook",
            "bot_token_set": bool(BOT_TOKEN),
            "mini_app_url_set": bool(MINI_APP_URL),
            "admin_chat_id_set": bool(ADMIN_CHAT_ID),
            "webhook_secret_set": bool(WEBHOOK_SECRET),
        }).encode("utf-8"))
