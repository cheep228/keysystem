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
   bash deploy/setup.sh <домен>
   nano /opt/srannyhub-keys/.env      # LV_USER_ID, LV_ANTI_BYPASS, ADMIN_TOKEN
   systemctl restart srannyhub-keys
   ```
3. Открыть `https://<домен>` — сертификат выпустится сам, когда DNS уже указывает на VPS.
4. В `loader/loader.prod.lua` указан реальный `SITE` — его и раздавать.

Обновление хаба или сайта: скопировать файлы заново и `bash deploy/update.sh`.

Логи: `journalctl -u srannyhub-keys -f`, `journalctl -u caddy -f`.

## Админка

`POST` с заголовком `Authorization: Bearer <ADMIN_TOKEN>`:

```bash
curl -X POST https://<домен>/api/admin/create     -H "Authorization: Bearer TOKEN" -d '{"hours":0,"note":"вечный"}'
curl -X POST https://<домен>/api/admin/revoke     -H "Authorization: Bearer TOKEN" -d '{"key":"SRANNY-..."}'
curl -X POST https://<домен>/api/admin/reset-hwid -H "Authorization: Bearer TOKEN" -d '{"key":"SRANNY-..."}'
curl -X POST https://<домен>/api/admin/info       -H "Authorization: Bearer TOKEN" -d '{"key":"SRANNY-..."}'
```

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
