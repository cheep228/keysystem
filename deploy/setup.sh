#!/usr/bin/env bash
# Первичная установка на Ubuntu/Debian VPS. Запуск от root из папки проекта:
#   bash deploy/setup.sh 4fir.xyz
set -euo pipefail

DOMAIN="${1:?укажи домен: bash deploy/setup.sh example.com}"

APP=/opt/srannyhub-keys

echo "== пакеты: Node.js 22, Caddy, ufw =="
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw rsync
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
chown -R srannyhub:srannyhub "$APP"
chmod 600 "$APP/.env"

echo "== systemd =="
cp deploy/srannyhub-keys.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now srannyhub-keys

echo "== Caddy (HTTPS) =="
sed "s/DOMAIN/$DOMAIN/g" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "== firewall =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo
echo "Готово. Заполни $APP/.env (LV_USER_ID, LV_ANTI_BYPASS, ADMIN_TOKEN) и выполни:"
echo "  systemctl restart srannyhub-keys"
