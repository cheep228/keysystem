# SrannyHub Key System

Сайт выдачи ключей через Linkvertise. Работает на своём VPS: Node.js + Caddy (HTTPS).

```
Игрок -> сайт "Получить ключ" -> Linkvertise -> /claim (проверка anti-bypass) -> ключ
Скрипт (loader) -> /api/verify (ключ + HWID) -> /api/script -> код хаба
```

Код хаба лежит только на сервере и отдаётся по валидному ключу.

## Структура

| Путь | Что это |
|---|---|
| `src/index.js` | Логика сайта: страницы, выдача ключей, API, админка |
| `server/server.mjs` | HTTP-сервер для VPS, хранилище ключей в `data/kv.json` |
| `deploy/setup.sh` | Установка на чистый Ubuntu/Debian: Node, Caddy, systemd, firewall |
| `deploy/update.sh` | Обновление кода на сервере |
| `deploy/Caddyfile` | Шаблон HTTPS-прокси (домен подставляет setup.sh) |
| `loader/loader.lua` | Loader для игроков (`SITE` — заглушка) |
| `script/SrannyHub.lua` | Хаб — **не в git**, кладётся на сервер вручную |

Не в git: `.env` (секреты), `data/` (ключи), `script/*.lua` (хаб), `loader/*.prod.lua` (loader с реальным доменом).

## DNS (Namecheap -> Advanced DNS)

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | IP VPS | Automatic |
| A Record | `www` | IP VPS | Automatic |

Удалить стандартные записи Namecheap для `@` и `www` (parking CNAME / URL Redirect), если есть.

## Установка на VPS

1. Скопировать папку проекта на сервер (вместе с `script/SrannyHub.lua`), например:
   ```
   scp -r . root@IP:/root/srannyhub-keys
   ```
2. На сервере:
   ```
   cd /root/srannyhub-keys
   bash deploy/setup.sh <домен>          # firewall не трогается; --with-ufw вторым аргументом
   nano /opt/srannyhub-keys/.env      # LV_USER_ID, LV_ANTI_BYPASS, ADMIN_TOKEN
   systemctl restart srannyhub-keys
   ```
3. Открыть `https://<домен>:8443` — сертификат выпустится сам, когда DNS уже указывает на VPS.
4. Loader для раздачи берётся в админке (Скрипты -> нужный скрипт -> Loader).

Порт 443 часто занят (xray/3x-ui), поэтому сайт слушает **8443**, а порт 80 нужен только для выпуска
сертификата и редиректа. Установщик проверяет 80 и 8443 и выходит, если они заняты — ничего не ломая.

Обновление хаба или сайта: скопировать файлы заново и `bash deploy/update.sh`.

Логи: `journalctl -u srannyhub-keys -f`, `journalctl -u caddy -f`.

## Админ-панель

Отдельный порт, адрес: `http://<IP>:<ADMIN_PORT>/<ADMIN_PATH>/login`
(по умолчанию путь `d8xuj1idaso/panel/8318`). Порт случайный: локально сохраняется в `data/admin.json`,
на VPS `setup.sh` пишет его в `.env`, открывает в firewall и печатает ссылку, логин и пароль.

| Раздел | Что есть |
|---|---|
| Статистика | игроки всего / за час / за сутки, новые, запуски и ключи за день, график запусков за 30 дней, экзекьюторы, игры |
| Игроки | ник и UserId (ссылка на профиль), экзекьютор и версия, PlaceId, ключ, число запусков, первый/последний вход, поиск и фильтр по экзекьютору |
| Ключи | создать (24 ч / 7 д / 30 д / навсегда, заметка), блок/разблок, сброс HWID, удаление |
| Скрипты | добавить (вставить код или загрузить .lua), привязать к PlaceId или сделать «по умолчанию», вкл/выкл, удалить |

Какой скрипт получает игрок: привязанный к PlaceId его игры -> «по умолчанию» -> файл `script/SrannyHub.lua`.

Защита: логин/пароль из `.env`, сессия 12 ч в HttpOnly-cookie, CSRF-токен на всех действиях,
5 неверных входов с IP -> блок на 15 минут, чужой путь -> 404.

Для curl остался API с `Authorization: Bearer <ADMIN_TOKEN>`: `/api/admin/create|revoke|reset-hwid|info` на основном сайте.

## Защита

- Одноразовая сессия на 30 мин, привязана к IP (хэш).
- `MIN_SECONDS` — нельзя вернуться с Linkvertise быстрее N секунд.
- Linkvertise Anti-Bypassing: без подтверждённого `hash` ключ не выдаётся.
- Один активный ключ на IP; ключ привязывается к HWID при первом запуске.
- Сервер слушает только `127.0.0.1`, наружу открыты 80/443 через Caddy.
- `robots.txt: Disallow /`, `X-Robots-Tag: noindex` — сайт не индексируется.

## Локально

```
cp .env.example .env   # заполнить
npm start              # http://127.0.0.1:8787
```
