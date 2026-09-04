#!/usr/bin/env python3
"""
Пересобирает data.js из прайс-листа Excel.

Использование:
    python3 build_data.py "Прайс для телеграма.xlsx"

Ожидаемые колонки на листе "Общий":
    Категория | Страна | Бренд | Название | Емкость | Минимальный заказ | Цена

После запуска замените файл data.js в папке приложения на сгенерированный.

Картинки товаров: положите файл images/<id>.jpg (или .jpeg/.png/.webp) —
id смотрите в products_reference.csv (тоже генерируется этим скриптом).
Скрипт сам подставит найденную картинку в data.js при следующем запуске.
"""
import os
import sys
import json
import re
import csv

import openpyxl

IMAGE_EXTS = ('.jpg', '.jpeg', '.png', '.webp')

# Ручные исправления страны по бренду (в исходном прайсе для категории
# "Водка" страна не указана вовсе — используется как страховка ниже).
# Добавляйте сюда новые бренды/страны по мере уточнения у поставщика.
COUNTRY_OVERRIDE_BY_BRAND = {
    'Celsius': 'Украина',
}


def clean(s):
    if s is None:
        return s
    s = s.replace('\xa0', ' ')
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def main():
    if len(sys.argv) < 2:
        print('Использование: python3 build_data.py <путь к xlsx>')
        sys.exit(1)

    path = sys.argv[1]
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb['Общий']
    rows = list(ws.iter_rows(min_row=2, values_only=True))

    items = []
    for i, r in enumerate(rows):
        cat, country, brand, name, vol, minorder, price = r
        if not cat or not name:
            continue
        country = clean(country)
        brand_clean = clean(brand)
        # В исходном прайсе для категории "Водка" в колонке "Страна" стоит
        # значение "Водка" — по-видимому, страна-производитель не указана.
        if country == 'Водка':
            country = 'Россия'
        # Точечные исправления по бренду (например, Celsius — Украина).
        if brand_clean in COUNTRY_OVERRIDE_BY_BRAND:
            country = COUNTRY_OVERRIDE_BY_BRAND[brand_clean]

        item_id = i + 1
        image = ''
        for ext in IMAGE_EXTS:
            if os.path.isfile(os.path.join('images', f'{item_id}{ext}')):
                image = f'images/{item_id}{ext}'
                break

        items.append({
            'id': item_id,
            'category': clean(cat),
            'country': country,
            'brand': brand_clean,
            'name': clean(name),
            'volume': vol,
            'minOrder': int(minorder) if minorder else 1,
            'price': int(price) if price else 0,
            'image': image,
        })

    with_photo = sum(1 for it in items if it['image'])

    # Справочник id -> товар, чтобы было удобно называть файлы картинок.
    with open('products_reference.csv', 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['id', 'category', 'country', 'brand', 'name', 'volume', 'has_image'])
        for it in items:
            w.writerow([it['id'], it['category'], it['country'], it['brand'], it['name'], it['volume'], 'да' if it['image'] else ''])

    js = "// Автоматически сгенерировано из прайс-листа. Обновляйте при изменении ассортимента.\n"
    js += "const PRODUCTS = " + json.dumps(items, ensure_ascii=False, indent=2) + ";\n\n"
    js += """const CATEGORY_META = {
  'Вино':   { icon: '🍷', title: 'Вино' },
  'Виски':  { icon: '🥃', title: 'Виски' },
  'Водка':  { icon: '🍾', title: 'Водка' }
};

const COUNTRY_META = {
  'Грузия':   { flag: '🇬🇪', title: 'Грузия' },
  'Италия':   { flag: '🇮🇹', title: 'Италия' },
  'Франция':  { flag: '🇫🇷', title: 'Франция' },
  'Ирландия': { flag: '🇮🇪', title: 'Ирландия' },
  'Россия':   { flag: '🇷🇺', title: 'Россия' },
  'Украина':  { flag: '🇺🇦', title: 'Украина' }
};

const CURRENCY = '₸';
"""
    with open('data.js', 'w', encoding='utf-8') as f:
        f.write(js)
    print(f'Готово: data.js ({len(items)} позиций, картинок найдено: {with_photo})')
    print('Справочник id → товар: products_reference.csv')
    print('Категории:', sorted(set(i["category"] for i in items)))
    print('Страны:', sorted(set(i["country"] for i in items)))
    print('Если появилась новая категория/страна — добавьте иконку/флаг в CATEGORY_META / COUNTRY_META вручную.')


if __name__ == '__main__':
    main()
