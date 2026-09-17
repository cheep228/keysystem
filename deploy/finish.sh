#!/usr/bin/env bash
# Доводка после setup.sh: чинит .env (CR из Windows), генерирует пароль админки,
# перезапускает сервис и печатает всё нужное + диагностику.
#   bash /root/srannyhub-keys/deploy/finish.sh [домен]
set -uo pipefail

APP=/opt/srannyhub-keys
DOMAIN="${1:-4fir.xyz}"
SITE_PORT=8443

cd "$APP" || { echo "Нет папки $APP — сначала bash deploy/setup.sh $DOMAIN"; exit 1; }

sed -i 's/\r$//' .env
getenv() { grep "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }
setenv() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}

[ -n "$(getenv ADMIN_USER)" ] || setenv ADMIN_USER admin
if [ -z "$(getenv ADMIN_PASSWORD)" ]; then
  setenv ADMIN_PASSWORD "$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if [ -z "$(getenv ADMIN_TOKEN)" ]; then
  setenv ADMIN_TOKEN "$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
[ -n "$(getenv ADMIN_PATH)" ] || setenv ADMIN_PATH d8xuj1idaso/panel/8318
setenv ADMIN_HOST 0.0.0.0
setenv PUBLIC_URL "https://$DOMAIN:$SITE_PORT"
setenv DEV_NO_LINKVERTISE 0
chmod 600 .env
chown -R srannyhub:srannyhub "$APP" 2>/dev/null

systemctl restart srannyhub-keys
sleep 2

ADMIN_PORT="$(getenv ADMIN_PORT)"
[ -n "$ADMIN_PORT" ] || ADMIN_PORT="$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' data/admin.json 2>/dev/null)"
IP="$(curl -4 -s --max-time 5 https://api.ipify.org)"
[ -n "$IP" ] || IP="$(hostname -I | awk '{print $1}')"

echo
echo "================ ДОСТУПЫ ================"
echo "Сайт:    https://$DOMAIN:$SITE_PORT"
echo "Админка: http://$IP:$ADMIN_PORT/$(getenv ADMIN_PATH)/login"
echo "Логин:   $(getenv ADMIN_USER)"
echo "Пароль:  $(getenv ADMIN_PASSWORD)"
echo "Linkvertise ID: $(getenv LV_USER_ID)   Anti-Bypass: $([ -n "$(getenv LV_ANTI_BYPASS)" ] && echo задан || echo НЕ задан)"
echo
echo "================ ПРОВЕРКА ================"
echo "--- сервис:"
systemctl is-active srannyhub-keys
journalctl -u srannyhub-keys -n 8 --no-pager
echo "--- сайт изнутри (ожидается 200):"
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:8787/
echo "--- админка изнутри (ожидается 303 или 200):"
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 "http://127.0.0.1:$ADMIN_PORT/$(getenv ADMIN_PATH)/login"
echo "--- порты 80 / $SITE_PORT / $ADMIN_PORT:"
ss -ltnp | grep -E ":80 |:$SITE_PORT |:$ADMIN_PORT " || echo "ничего не слушает!"
echo "--- DNS $DOMAIN (должен быть этот сервер, $IP):"
getent hosts "$DOMAIN" || echo "A-запись не найдена — добавь в Namecheap: A @ -> $IP"
echo "--- caddy:"
systemctl is-active caddy
journalctl -u caddy -n 12 --no-pager | tail -12
echo "--- сайт снаружи:"
curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 "https://$DOMAIN:$SITE_PORT/" || echo "недоступен"
echo "=========================================="
echo "Дальше: nano $APP/.env  ->  LV_USER_ID и LV_ANTI_BYPASS  ->  systemctl restart srannyhub-keys"
