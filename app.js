/* FORCE TRADE SERVICE — Telegram Mini App витрины алкогольного магазина */

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
// telegram-web-app.js создаёт заглушку Telegram.WebApp даже вне клиента Telegram —
// поэтому реальный запуск внутри Telegram определяем по непустому initData.
const inTelegram = !!(tg && tg.initData && tg.initData.length > 0);

// ---------- Состояние приложения ----------

const state = {
  cart: loadCart(),          // { productId: qty }
  category: null,
  country: null,
  method: 'delivery',
};

const stack = [];            // стек экранов для кнопки "Назад"
let currentScreen = 'screen-age';

// ---------- Инициализация Telegram WebApp ----------

// ВРЕМЕННО: диагностика на экране, чтобы понять, почему inTelegram может
// определяться неверно на реальном устройстве. Уберём после отладки.
(function showDebugInfo() {
  const el = document.getElementById('debug-info');
  if (!el) return;
  const info = {
    tg_exists: !!tg,
    initData_length: tg ? (tg.initData || '').length : null,
    platform: tg ? tg.platform : null,
    version: tg ? tg.version : null,
    inTelegram: inTelegram,
    url: window.location.href,
  };
  el.textContent = 'debug: ' + JSON.stringify(info);
})();

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
  let qty = state.cart[id] || 0;
  if (qty === 0 && delta > 0) {
    qty = product.minOrder;
  } else {
    qty += delta;
  }
  if (qty < product.minOrder) qty = 0;
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
    el.className = 'card';
    el.innerHTML = `
      <div class="card-icon">${meta.icon}</div>
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

// ---------- Рендер: товары ----------

function productRowHTML(p) {
  const qty = state.cart[p.id] || 0;
  const emoji = (CATEGORY_META[p.category] || {}).icon || '🍾';
  return `
    <div class="product-card" data-id="${p.id}">
      <div class="product-thumb">
        <span class="thumb-emoji">${emoji}</span>
        ${p.image ? `<img class="thumb-img" src="${p.image}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </div>
      <div class="product-info">
        <div class="product-name">${p.name}</div>
        <div class="product-meta">${p.volume} л</div>
        <div class="product-price">${formatPrice(p.price)}</div>
        <div class="product-minorder">мин. заказ — ${p.minOrder} шт.</div>
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
}

// ---------- Обработчики: экран возраста ----------

document.getElementById('btn-age-yes').addEventListener('click', () => {
  haptic('success');
  renderCategories();
  stack.length = 0;
  showScreen('screen-categories', { push: false });
});

document.getElementById('btn-age-no').addEventListener('click', () => {
  haptic('error');
  stack.length = 0;
  showScreen('screen-denied', { push: false });
  setTimeout(() => { if (inTelegram) { try { tg.close(); } catch (e) {} } }, 2500);
});

['link-offer', 'link-privacy'].forEach(id => {
  document.getElementById(id).addEventListener('click', (e) => {
    e.preventDefault();
    const url = 'https://example.com/' + (id === 'link-offer' ? 'offer' : 'privacy');
    if (inTelegram && tg.openLink) tg.openLink(url); else window.open(url, '_blank');
  });
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

document.querySelectorAll('.segmented-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.method = btn.dataset.method;
    const addressField = document.getElementById('field-address');
    addressField.style.display = state.method === 'delivery' ? 'block' : 'none';
    document.getElementById('f-address').required = state.method === 'delivery';
    haptic('select');
  });
});

document.getElementById('checkout-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('f-name').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const address = document.getElementById('f-address').value.trim();
  const comment = document.getElementById('f-comment').value.trim();
  const agree = document.getElementById('f-agree').checked;

  if (!name || !phone || (state.method === 'delivery' && !address) || !agree || !cartItems().length) {
    haptic('error');
    const msg = 'Пожалуйста, заполните обязательные поля (*) и подтвердите согласие с условиями.';
    if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
    return;
  }

  const order = {
    orderId: makeOrderId(),
    items: cartItems().map(p => ({ id: p.id, name: p.name, brand: p.brand, volume: p.volume, qty: p.qty, price: p.price })),
    total: cartTotal(),
    customer: { name, phone, method: state.method, address: state.method === 'delivery' ? address : null, comment },
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
