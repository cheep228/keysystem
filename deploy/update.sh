#!/usr/bin/env bash
# Обновление кода/хаба на VPS. Запуск от root из папки проекта: bash deploy/update.sh
set -euo pipefail
APP=/opt/srannyhub-keys
rsync -a --delete --exclude data --exclude .env --exclude .git --exclude node_modules ./ "$APP/"
chown -R srannyhub:srannyhub "$APP"
systemctl restart srannyhub-keys
echo "Обновлено."
