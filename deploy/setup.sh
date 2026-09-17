#!/usr/bin/env bash
# Первичная установка на Ubuntu/Debian VPS. Запуск от root из папки проекта:
#   bash deploy/setup.sh example.com
set -euo pipefail

DOMAIN="${1:?укажи домен: bash deploy/setup.sh example.com}"
WITH_UFW="${2:-}"   # второй аргумент --with-ufw: открыть порт админки в ufw (по умолчанию firewall не трогаем)

APP=/opt/srannyhub-keys

# ничего не ломаем: 443 может быть занят xray/3x-ui, поэтому HTTPS сайта живёт на SITE_PORT
SITE_PORT=8443
echo "== проверка портов =="
for p in 80 "$SITE_PORT"; do
  if ss -ltnp 2>/dev/null | grep -q ":$p "; then
    echo "Порт $p занят:"
    ss -ltnp | grep ":$p "
    echo
    echo "Установка остановлена, чтобы не сломать то, что уже работает (например 3x-ui)."
    echo "Освободи порт или настрой проксирование вручную."
    exit 1
  fi
done

echo "== пакеты: Node.js 22, Caddy =="
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https rsync iproute2
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(`.`)[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "== пользователь и файлы =="
id srannyhub >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin srannyhub
mkdir -p "$APP/data"
rsync -a --delete --exclude data --exclude .env --exclude .git --exclude node_modules ./ "$APP/"
[ -f "$APP/.env" ] || cp "$APP/.env.example" "$APP/.env"

# админка: слушает все интерфейсы на случайном порту, пароль генерируется, если пустой
setenv() { grep -q "^$1=" "$APP/.env" && sed -i "s|^$1=.*|$1=$2|" "$APP/.env" || echo "$1=$2" >> "$APP/.env"; }
getenv() { grep "^$1=" "$APP/.env" | head -1 | cut -d= -f2-; }
setenv ADMIN_HOST 0.0.0.0
[ -n "$(getenv ADMIN_PORT)" ] || setenv ADMIN_PORT "$(shuf -i 20000-60000 -n 1)"
[ -n "$(getenv ADMIN_PASSWORD)" ] || setenv ADMIN_PASSWORD "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
[ -n "$(getenv ADMIN_TOKEN)" ] || setenv ADMIN_TOKEN "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
setenv DEV_NO_LINKVERTISE 0
setenv PUBLIC_URL "https://$DOMAIN:$SITE_PORT"

chown -R srannyhub:srannyhub "$APP"
chmod 600 "$APP/.env"

echo "== systemd =="
cp deploy/srannyhub-keys.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now srannyhub-keys

echo "== Caddy (HTTPS) =="
sed "s/DOMAIN/$DOMAIN/g" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

# firewall не включаем сами: включённый ufw закрыл бы порты VPN/3x-ui
if [ "$WITH_UFW" = "--with-ufw" ] && command -v ufw >/dev/null && ufw status | grep -q "^Status: active"; then
  echo "== firewall: открываю порты (ufw уже активен) =="
  ufw allow 80/tcp
  ufw allow "$SITE_PORT/tcp"
  ufw allow "$(getenv ADMIN_PORT)/tcp"
else
  echo "== firewall не трогаю =="
  echo "   Если у тебя активен ufw/iptables — открой сам: 80, $SITE_PORT и $(getenv ADMIN_PORT)"
fi

IP=$(curl -4 -s https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "Готово."
echo "  Сайт:    https://$DOMAIN:$SITE_PORT"
echo "  Админка: http://$IP:$(getenv ADMIN_PORT)/$(getenv ADMIN_PATH)/login"
echo "  Логин:   $(getenv ADMIN_USER)"
echo "  Пароль:  $(getenv ADMIN_PASSWORD)"
echo
echo "Заполни в $APP/.env LV_USER_ID и LV_ANTI_BYPASS, потом: systemctl restart srannyhub-keys"
