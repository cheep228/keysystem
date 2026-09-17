# SrannyHub Key System

Сайт выдачи ключей через Linkvertise на Cloudflare Workers + KV (бесплатный тариф).

```
Игрок -> сайт "Получить ключ" -> Linkvertise -> /claim (проверка anti-bypass) -> ключ
Скрипт (loader.lua) -> /api/verify (ключ + HWID) -> /api/script -> код хаба
```

Код хаба лежит на сервере (в KV) и отдаётся только по валидному ключу — без ключа его не скачать.

## Структура

| Файл | Что это |
|---|---|
| `src/index.js` | Worker: сайт, выдача ключей, API проверки, админка |
| `wrangler.toml` | Конфиг Cloudflare (KV, Linkvertise ID, срок ключа) |
| `loader/loader.lua` | То, что ты раздаёшь игрокам: окно ввода ключа -> загрузка хаба |
| `script/SrannyHub.lua` | Сам хаб, загружается в KV командой `upload-script` |

## Установка

1. Аккаунт на https://dash.cloudflare.com (бесплатно), потом в этой папке:
   ```
   npm install
   npx wrangler login
   ```
2. Создать хранилище и вставить выданный `id` в `wrangler.toml` вместо `PASTE_KV_NAMESPACE_ID_HERE`:
   ```
   npx wrangler kv namespace create KEYS
   ```
3. Linkvertise:
   - `LV_USER_ID` в `wrangler.toml` — число из твоих ссылок `https://link-to.net/<ID>/...`
     (кабинет Linkvertise -> Dynamic Links / Full Script API).
   - Токен Anti-Bypassing (кабинет -> Anti-Bypassing) — секретом:
     ```
     npx wrangler secret put LV_ANTI_BYPASS
     ```
4. Пароль админки:
   ```
   npx wrangler secret put ADMIN_TOKEN
   ```
5. Деплой и загрузка хаба:
   ```
   npm run deploy
   npm run upload-script
   ```
   Wrangler напишет адрес вида `https://srannyhub-keys.<name>.workers.dev`.
6. В `loader/loader.lua` поменять `SITE` на этот адрес и раздавать игрокам loader.

После каждого изменения хаба — снова `npm run upload-script` (loader менять не нужно).

## Свой домен (4fir.su)

Cloudflare -> Workers -> srannyhub-keys -> Settings -> Domains & Routes -> Add Custom Domain
(например `key.4fir.su`; домен должен быть подключён к Cloudflare). Потом обнови `SITE` в loader.

## Админка

Все запросы — `POST` с заголовком `Authorization: Bearer <ADMIN_TOKEN>`.

```bash
# вечный ключ (hours: 0) или на N часов
curl -X POST https://<site>/api/admin/create -H "Authorization: Bearer TOKEN" -d '{"hours":0,"note":"для друга"}'
# заблокировать
curl -X POST https://<site>/api/admin/revoke -H "Authorization: Bearer TOKEN" -d '{"key":"SRANNY-XXXX-XXXX-XXXX-XXXX"}'
# сбросить привязку к устройству
curl -X POST https://<site>/api/admin/reset-hwid -H "Authorization: Bearer TOKEN" -d '{"key":"SRANNY-XXXX-XXXX-XXXX-XXXX"}'
# инфо по ключу
curl -X POST https://<site>/api/admin/info -H "Authorization: Bearer TOKEN" -d '{"key":"SRANNY-XXXX-XXXX-XXXX-XXXX"}'
```

## Защита

- Сессия на 30 мин, одноразовая, привязана к IP (хэш).
- `MIN_SECONDS` — нельзя вернуться с Linkvertise быстрее, чем за N секунд.
- Anti-Bypassing Linkvertise: без подтверждённого `hash` ключ не выдаётся
  (если `LV_ANTI_BYPASS` не задан — проверка пропускается, работают только сессия и таймер).
- Один активный ключ на IP: повторное прохождение отдаёт тот же ключ.
- Ключ привязывается к HWID при первом запуске.

## Локальная проверка

```
npm run dev
```
Открой http://localhost:8787. Для локального теста без Linkvertise удобно временно не задавать `LV_ANTI_BYPASS`.
