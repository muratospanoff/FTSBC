/* FORCE TRADE SERVICE — Telegram Mini App витрины алкогольного магазина */

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
// ВАЖНО: initData НЕ передаётся Telegram, если Mini App запущен через
// reply-keyboard кнопку (а не Menu Button) — это официальное поведение,
// не баг: https://core.telegram.org/bots/webapps. Мы специально используем
// именно keyboard-кнопку, чтобы был доступен Telegram.WebApp.sendData().
// Поэтому проверять initData нельзя — определяем реальный Telegram по
// platform (вне Telegram SDK-заглушка отдаёт 'unknown').
const inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');

// ---------- Регистрация организации (закрытый доступ) ----------

const urlParams = new URLSearchParams(window.location.search);
const UID = urlParams.get('uid') || '';
const SIG = urlParams.get('sig') || '';

let PROFILE = null; // { orgForm, companyName, bin, legalAddress, deliveryAddress }, из /api/profile

async function fetchProfile() {
  const res = await fetch(`/api/profile?uid=${encodeURIComponent(UID)}&sig=${encodeURIComponent(SIG)}`);
  const data = await res.json();
  if (data.registered) PROFILE = { ...data.profile, phone: data.phone };
  return data;
}

async function saveProfile(profile) {
  const res = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: UID, sig: SIG, ...profile }),
  });
  return res.json();
}

// ---------- Состояние приложения ----------

const state = {
  cart: loadCart(),          // { productId: qty }
  category: null,
  country: null,
  regOrgForm: 'ИП',           // выбор в форме регистрации: 'ИП' | 'ТОО'
  buyerType: 'company',       // на финальном шаге: 'company' | 'self'
};

const stack = [];            // стек экранов для кнопки "Назад"
let currentScreen = 'screen-age';

// ---------- Инициализация Telegram WebApp ----------

if (tg) {
  tg.ready();
  tg.expand();
}
if (inTelegram) {
  document.body.classList.add('in-tg');
  try { tg.setHeaderColor && tg.setHeaderColor('secondary_bg_color'); } catch (e) {}
  tg.BackButton.onClick(() => goBack());
}

function haptic(type) {
  if (!tg || !tg.HapticFeedback) return;
  if (type === 'select') tg.HapticFeedback.selectionChanged();
  else if (type === 'error') tg.HapticFeedback.notificationOccurred('error');
  else if (type === 'success') tg.HapticFeedback.notificationOccurred('success');
  else tg.HapticFeedback.impactOccurred(type || 'light');
}

// ---------- Навигация ----------

function showScreen(id, { push = true } = {}) {
  if (push && currentScreen) stack.push(currentScreen);
  document.getElementById(currentScreen)?.classList.remove('active');
  document.getElementById(id).classList.add('active');
  currentScreen = id;
  window.scrollTo(0, 0);
  syncBackButton();
  syncCartBar();
}

function goBack() {
  if (!stack.length) return;
  const prev = stack.pop();
  document.getElementById(currentScreen)?.classList.remove('active');
  document.getElementById(prev).classList.add('active');
  currentScreen = prev;
  window.scrollTo(0, 0);
  syncBackButton();
  syncCartBar();
}

function syncBackButton() {
  const rootScreens = ['screen-age', 'screen-denied', 'screen-categories', 'screen-success'];
  const showBack = stack.length > 0 && !rootScreens.includes(currentScreen);
  if (inTelegram) {
    if (showBack) tg.BackButton.show(); else tg.BackButton.hide();
    document.querySelectorAll('.back-inline').forEach(b => b.style.display = 'none');
  } else {
    document.querySelectorAll('.back-inline').forEach(b => {
      b.style.display = (b.closest('.screen').id === currentScreen && showBack) ? 'block' : 'none';
    });
  }
}

function syncCartBar() {
  const bar = document.getElementById('cart-bar');
  const hideOn = ['screen-age', 'screen-denied', 'screen-cart', 'screen-checkout', 'screen-success'];
  const items = cartItems();
  if (!items.length || hideOn.includes(currentScreen)) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const count = items.reduce((s, i) => s + i.qty, 0);
  document.getElementById('cart-bar-count').textContent = `${count} ${pluralBottles(count)}`;
  document.getElementById('cart-bar-total').textContent = formatPrice(cartTotal());
}

// ---------- Утилиты каталога ----------

function productById(id) { return PRODUCTS.find(p => p.id === id); }

function formatPrice(n) {
  return n.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ' + CURRENCY;
}

function pluralBottles(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'товар';
  if ([2,3,4].includes(mod10) && ![12,13,14].includes(mod100)) return 'товара';
  return 'товаров';
}

function categoriesAvailable() {
  return [...new Set(PRODUCTS.map(p => p.category))];
}
function countriesForCategory(cat) {
  return [...new Set(PRODUCTS.filter(p => p.category === cat).map(p => p.country))];
}

// ---------- Корзина: хранение ----------

function loadCart() {
  try { return JSON.parse(localStorage.getItem('fts_cart') || '{}'); }
  catch (e) { return {}; }
}
function saveCart() {
  try { localStorage.setItem('fts_cart', JSON.stringify(state.cart)); } catch (e) {}
}
function cartItems() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ ...productById(Number(id)), qty }))
    .filter(i => i.id);
}
function cartTotal() {
  return cartItems().reduce((s, i) => s + i.qty * i.price, 0);
}

function changeQty(id, delta) {
  const product = productById(id);
  if (!product) return;
  let qty = (state.cart[id] || 0) + delta;
  if (qty <= 0) delete state.cart[id]; else state.cart[id] = qty;
  saveCart();
  haptic('select');
}

// ---------- Рендер: категории ----------

function renderCategories() {
  const wrap = document.getElementById('categories-list');
  wrap.innerHTML = '';
  categoriesAvailable().forEach(cat => {
    const meta = CATEGORY_META[cat] || { icon: '🍾', title: cat };
    const count = PRODUCTS.filter(p => p.category === cat).length;
    const el = document.createElement('div');
    el.className = 'card card-photo';
    el.innerHTML = meta.image
      ? `<div class="card-photo-wrap"><img src="${meta.image}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='${meta.icon}'"></div>
         <div class="card-title">${meta.title}</div>
         <div class="card-sub">${count} позиций</div>`
      : `<div class="card-icon">${meta.icon}</div>
         <div class="card-title">${meta.title}</div>
         <div class="card-sub">${count} позиций</div>`;
    el.addEventListener('click', () => {
      haptic('select');
      state.category = cat;
      renderCountries();
      showScreen('screen-countries');
    });
    wrap.appendChild(el);
  });
}

// ---------- Рендер: страны ----------

function renderCountries() {
  document.getElementById('countries-title').textContent =
    (CATEGORY_META[state.category]?.title || state.category);
  const wrap = document.getElementById('countries-list');
  wrap.innerHTML = '';
  countriesForCategory(state.category).forEach(country => {
    const meta = COUNTRY_META[country] || { flag: '🏳️', title: country };
    const count = PRODUCTS.filter(p => p.category === state.category && p.country === country).length;
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="card-icon">${meta.flag}</div>
      <div class="card-title">${meta.title}</div>
      <div class="card-sub">${count} позиций</div>`;
    el.addEventListener('click', () => {
      haptic('select');
      state.country = country;
      renderProducts();
      showScreen('screen-products');
    });
    wrap.appendChild(el);
  });
}

// ---------- Увеличение фото товара ----------

function openLightbox(src, caption) {
  const overlay = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const cap = document.getElementById('lightbox-caption');
  img.src = src;
  cap.textContent = caption || '';
  overlay.classList.add('open');
  haptic('light');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}
document.getElementById('lightbox').addEventListener('click', closeLightbox);

// ---------- Рендер: товары ----------

function productRowHTML(p) {
  const qty = state.cart[p.id] || 0;
  const emoji = (CATEGORY_META[p.category] || {}).icon || '🍾';
  return `
    <div class="product-card" data-id="${p.id}">
      <div class="product-thumb" data-action="zoom">
        <span class="thumb-emoji">${emoji}</span>
        ${p.image ? `<img class="thumb-img" src="${p.image}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </div>
      <div class="product-info">
        <div class="product-name">${p.name}</div>
        <div class="product-meta">${p.volume} л</div>
        <div class="product-price">${formatPrice(p.price)}</div>
      </div>
      <div class="qty-holder">
        ${qty > 0 ? `
          <div class="qty-control">
            <button class="qty-btn" data-action="minus">−</button>
            <span class="qty-value">${qty}</span>
            <button class="qty-btn" data-action="plus">+</button>
          </div>` : `
          <button class="btn-add" data-action="add">В корзину</button>`
        }
      </div>
    </div>`;
}

function attachProductHandlers(container, onChange) {
  container.querySelectorAll('.product-card').forEach(card => {
    const id = Number(card.dataset.id);
    card.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'zoom') {
          const p = productById(id);
          if (p && p.image) openLightbox(p.image, p.name);
          return;
        }
        if (action === 'add' || action === 'plus') changeQty(id, +1);
        if (action === 'minus') changeQty(id, -1);
        if (onChange) {
          onChange();
        } else {
          // перерисовываем только эту карточку
          const fresh = document.createElement('div');
          fresh.innerHTML = productRowHTML(productById(id));
          card.replaceWith(fresh.firstElementChild);
          attachProductHandlers(container, onChange);
        }
        syncCartBar();
      });
    });
  });
}

function renderProducts() {
  const meta = CATEGORY_META[state.category] || { title: state.category };
  const cmeta = COUNTRY_META[state.country] || { title: state.country };
  document.getElementById('products-title').textContent = `${meta.title} · ${cmeta.title}`;
  document.getElementById('products-sub').textContent = 'Выберите позиции и количество';

  const items = PRODUCTS.filter(p => p.category === state.category && p.country === state.country);
  const byBrand = new Map();
  items.forEach(p => {
    if (!byBrand.has(p.brand)) byBrand.set(p.brand, []);
    byBrand.get(p.brand).push(p);
  });

  const wrap = document.getElementById('products-list');
  wrap.innerHTML = '';
  byBrand.forEach((list, brand) => {
    const heading = document.createElement('div');
    heading.className = 'brand-heading';
    heading.textContent = brand;
    wrap.appendChild(heading);
    list.forEach(p => {
      const el = document.createElement('div');
      el.innerHTML = productRowHTML(p);
      wrap.appendChild(el.firstElementChild);
    });
  });
  attachProductHandlers(wrap);
}

// ---------- Рендер: корзина ----------

function renderCart() {
  const items = cartItems();
  const list = document.getElementById('cart-list');
  const emptyMsg = document.getElementById('cart-empty-msg');
  const summary = document.getElementById('cart-summary');

  document.getElementById('cart-sub').textContent = items.length
    ? `${items.reduce((s,i)=>s+i.qty,0)} ${pluralBottles(items.reduce((s,i)=>s+i.qty,0))}`
    : 'пусто';

  if (!items.length) {
    list.innerHTML = '';
    emptyMsg.style.display = 'block';
    summary.style.display = 'none';
    return;
  }
  emptyMsg.style.display = 'none';
  summary.style.display = 'block';

  list.innerHTML = '';
  items.forEach(p => {
    const el = document.createElement('div');
    el.innerHTML = productRowHTML(p);
    list.appendChild(el.firstElementChild);
  });
  attachProductHandlers(list, renderCart);

  document.getElementById('cart-count').textContent = items.reduce((s,i)=>s+i.qty,0);
  document.getElementById('cart-total').textContent = formatPrice(cartTotal());
}

// ---------- Рендер: оформление заказа ----------

function renderCheckout() {
  const items = cartItems();
  const wrap = document.getElementById('checkout-items');
  wrap.innerHTML = items.map(p => `
    <div class="checkout-item-row">
      <span>${p.name} <span class="qty">× ${p.qty}</span></span>
      <span>${formatPrice(p.price * p.qty)}</span>
    </div>`).join('');
  document.getElementById('checkout-total').textContent = formatPrice(cartTotal());

  const p = PROFILE || {};
  document.getElementById('profile-summary-body').innerHTML = `
    <div class="checkout-item-row"><span>${p.orgForm || ''} «${p.companyName || '—'}»</span><span></span></div>
    <div class="checkout-item-row"><span>БИН</span><span>${p.bin || '—'}</span></div>
    <div class="checkout-item-row"><span>Телефон</span><span>${p.phone || '—'}</span></div>
    <div class="checkout-item-row"><span>Адрес доставки</span><span>${p.deliveryAddress || '—'}</span></div>`;
  document.querySelector('[data-buyer-type="company"]').textContent = `Для ${p.companyName || 'компании'}`;

  // сбрасываем форму на «Для компании» при каждом новом входе
  state.buyerType = 'company';
  document.getElementById('field-self-iin').style.display = 'none';
  document.getElementById('f-self-iin').value = '';
  document.querySelectorAll('[data-buyer-type]').forEach((b, i) => b.classList.toggle('active', i === 0));
}

// Возвращает {ok, age} по ИИН РК: первые 6 цифр — ГГММДД, 7-я — век/пол.
function iinAge(iin) {
  if (!/^\d{12}$/.test(iin)) return { ok: false, reason: 'format' };
  const centuryBase = { '1': 1800, '2': 1800, '3': 1900, '4': 1900, '5': 2000, '6': 2000 }[iin[6]];
  if (!centuryBase) return { ok: false, reason: 'century' };
  const year = centuryBase + parseInt(iin.slice(0, 2), 10);
  const month = parseInt(iin.slice(2, 4), 10);
  const day = parseInt(iin.slice(4, 6), 10);
  const birth = new Date(year, month - 1, day);
  if (birth.getFullYear() !== year || birth.getMonth() !== month - 1 || birth.getDate() !== day) {
    return { ok: false, reason: 'date' };
  }
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const hadBirthday = today.getMonth() > birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hadBirthday) age -= 1;
  // Защита от «правдоподобно посчитавшегося», но бессмысленного возраста —
  // например, если реальный 7-й символ ИИН не совпал с ожидаемым и дата
  // ушла в 1800-е: тогда age получался огромным и ошибочно проходил
  // проверку "не младше 21". Такое считаем невалидным, а не взрослым.
  if (age < 0 || age > 100) return { ok: false, reason: 'implausible' };
  return { ok: true, age };
}

// ---------- Обработчики: экран возраста ----------

document.getElementById('btn-age-yes').addEventListener('click', async () => {
  haptic('success');

  if (!UID || !SIG) {
    stack.length = 0;
    showScreen('screen-noauth', { push: false });
    return;
  }

  const btn = document.getElementById('btn-age-yes');
  const originalText = btn.textContent;
  btn.textContent = 'Проверяем регистрацию…';
  btn.disabled = true;

  let data;
  try {
    data = await fetchProfile();
  } catch (err) {
    btn.textContent = originalText;
    btn.disabled = false;
    const msg = 'Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.';
    if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
    return;
  }
  btn.textContent = originalText;
  btn.disabled = false;

  stack.length = 0;
  if (data.registered) {
    renderCategories();
    showScreen('screen-categories', { push: false });
  } else {
    showScreen('screen-registration', { push: false });
  }
});

document.getElementById('btn-age-no').addEventListener('click', () => {
  haptic('error');
  stack.length = 0;
  showScreen('screen-denied', { push: false });
  setTimeout(() => { if (inTelegram) { try { tg.close(); } catch (e) {} } }, 2500);
});

document.querySelectorAll('[data-doc-link]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const page = el.dataset.docLink === 'offer' ? 'offer.html' : 'privacy.html';
    const url = window.location.origin + '/' + page;
    if (inTelegram && tg.openLink) tg.openLink(url); else window.open(url, '_blank');
  });
});

// ---------- Обработчики: регистрация организации ----------

document.querySelectorAll('[data-reg-org-form]').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.parentElement.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.regOrgForm = btn.dataset.regOrgForm;
    haptic('select');
  });
});

document.getElementById('reg-same-address').addEventListener('change', (e) => {
  document.getElementById('reg-field-delivery-address').style.display = e.target.checked ? 'none' : 'block';
});

document.getElementById('registration-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const companyName = document.getElementById('reg-company-name').value.trim();
  // Отбрасываем всё, кроме цифр — на случай, если БИН вставлен/введён с
  // пробелами или дефисами (частая ситуация при копировании из документов).
  const bin = document.getElementById('reg-bin').value.replace(/\D/g, '');
  const legalAddress = document.getElementById('reg-legal-address').value.trim();
  const sameAddress = document.getElementById('reg-same-address').checked;
  const deliveryAddress = sameAddress ? legalAddress : document.getElementById('reg-delivery-address').value.trim();

  const missing = [];
  if (!companyName) missing.push('наименование компании');
  if (!/^\d{12}$/.test(bin)) missing.push('БИН (ровно 12 цифр)');
  if (!legalAddress) missing.push('юридический адрес');
  if (!deliveryAddress) missing.push('адрес доставки');

  if (missing.length) {
    haptic('error');
    const msg = 'Проверьте поля: ' + missing.join(', ') + '.';
    if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
    return;
  }

  const btn = document.getElementById('btn-registration-submit');
  btn.disabled = true;
  btn.textContent = 'Сохраняем…';

  let result;
  try {
    result = await saveProfile({ orgForm: state.regOrgForm, companyName, bin, legalAddress, deliveryAddress });
  } catch (err) {
    result = { ok: false };
  }
  btn.disabled = false;
  btn.textContent = 'Продолжить';

  if (!result.ok) {
    haptic('error');
    const msg = 'Не удалось сохранить регистрацию. Проверьте интернет и попробуйте ещё раз.';
    if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
    return;
  }

  PROFILE = { ...result.profile, phone: result.phone };
  haptic('success');
  stack.length = 0;
  renderCategories();
  showScreen('screen-categories', { push: false });
});

// ---------- Обработчики: навигация назад (браузер без Telegram) ----------

document.getElementById('back-from-countries').addEventListener('click', goBack);
document.getElementById('back-from-products').addEventListener('click', goBack);
document.getElementById('back-from-cart').addEventListener('click', goBack);
document.getElementById('back-from-checkout').addEventListener('click', goBack);

// ---------- Обработчики: панель корзины ----------

document.getElementById('btn-open-cart').addEventListener('click', () => {
  haptic('select');
  renderCart();
  showScreen('screen-cart');
});
document.getElementById('btn-cart-goshop').addEventListener('click', () => {
  stack.length = 0;
  renderCategories();
  showScreen('screen-categories', { push: false });
});
document.getElementById('btn-continue-shopping').addEventListener('click', () => {
  stack.length = 0;
  renderCategories();
  showScreen('screen-categories', { push: false });
});

// ---------- Обработчики: оформление заказа ----------

document.querySelectorAll('[data-buyer-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.parentElement.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.buyerType = btn.dataset.buyerType;
    document.getElementById('field-self-iin').style.display = state.buyerType === 'self' ? 'block' : 'none';
    haptic('select');
  });
});

document.getElementById('checkout-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const comment = document.getElementById('f-comment').value.trim();
  const agree = document.getElementById('f-agree').checked;
  const p = PROFILE || {};

  if (!agree || !cartItems().length) {
    haptic('error');
    const msg = 'Подтвердите согласие с условиями — корзина не может быть пустой.';
    if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
    return;
  }

  let selfIin = null;
  if (state.buyerType === 'self') {
    selfIin = document.getElementById('f-self-iin').value.replace(/\D/g, '');
    const check = iinAge(selfIin);
    if (!check.ok) {
      haptic('error');
      const msg = 'ИИН указан неверно. Проверьте, что введено 12 цифр.';
      if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
      return;
    }
    if (check.age < 21) {
      haptic('error');
      const msg = 'Покупка алкогольной продукции недоступна лицам младше 21 года.';
      if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
      return;
    }
  }

  const customer = {
    orgForm: p.orgForm, companyName: p.companyName, bin: p.bin,
    legalAddress: p.legalAddress, deliveryAddress: p.deliveryAddress, phone: p.phone,
    buyerType: state.buyerType, selfIin, comment,
  };

  const order = {
    orderId: makeOrderId(),
    items: cartItems().map(p => ({ id: p.id, name: p.name, brand: p.brand, volume: p.volume, qty: p.qty, price: p.price })),
    total: cartTotal(),
    customer,
    createdAt: new Date().toISOString(),
  };

  // У Telegram.WebApp.sendData() жёсткий лимит 4096 байт на строку. Если
  // превысить — Telegram может ничего не сообщить об ошибке, просто заказ
  // не долетит до бота, а покупатель увидит "успех". Поэтому проверяем
  // ДО отправки и не даём молча потерять заказ.
  const orderJson = JSON.stringify(order);
  const orderBytes = new TextEncoder().encode(orderJson).length;
  if (inTelegram && tg.sendData && orderBytes > 4000) {
    haptic('error');
    const msg = 'Заказ слишком большой для отправки (много позиций). ' +
      'Пожалуйста, оформите его двумя отдельными заказами.';
    if (tg.showAlert) tg.showAlert(msg); else alert(msg);
    return; // корзину не трогаем — можно поправить и отправить заново
  }

  document.getElementById('success-order-id').textContent = order.orderId;
  haptic('success');

  // Отправляем заказ СРАЗУ по факту оформления, не дожидаясь отдельного тапа
  // по «Закрыть» — sendData() всё равно закрывает Mini App сам, а полагаться
  // на то, что покупатель не свайпнёт/не закроет приложение иначе, нельзя:
  // так заказ рискует не долететь до бота вообще.
  if (inTelegram && tg.sendData) {
    try {
      tg.sendData(orderJson);
      state.cart = {};
      saveCart();
      return; // sendData сам закрывает Mini App внутри Telegram
    } catch (err) {
      // Реальный сбой вызова (например, запуск не через reply-кнопку).
      // НЕ показываем "успех" — покупатель должен знать, что заказ не ушёл.
      haptic('error');
      const msg = 'Не удалось отправить заказ. Попробуйте ещё раз или ' +
        'напишите нам напрямую в чат.';
      if (tg.showAlert) tg.showAlert(msg); else alert(msg);
      return; // корзина не тронута — можно повторить попытку
    }
  }

  stack.length = 0;
  showScreen('screen-success', { push: false });
  document.getElementById('btn-success-close').onclick = () => {
    state.cart = {};
    saveCart();
    stack.length = 0;
    renderCategories();
    showScreen('screen-categories', { push: false });
  };
});

function makeOrderId() {
  const d = new Date();
  return `${d.getFullYear()%100}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${Math.floor(1000+Math.random()*9000)}`;
}

// кнопка "Оформить заказ" внутри summary добавляется программно, перед "Продолжить покупки"
(function addCheckoutButton() {
  const summary = document.getElementById('cart-summary');
  const continueBtn = document.getElementById('btn-continue-shopping');
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.style.marginTop = '10px';
  btn.textContent = 'Оформить заказ';
  btn.id = 'btn-goto-checkout';
  btn.addEventListener('click', () => {
    haptic('select');
    renderCheckout();
    showScreen('screen-checkout');
  });
  summary.insertBefore(btn, continueBtn);
})();

// ---------- Старт ----------

showScreen('screen-age', { push: false });
