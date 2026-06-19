#!/usr/bin/env bash
# promo_ofertas.sh — divulga o hub ofertas.veloxisit.com.br no FB + IG da veloxisit.
# Gera o card, distribui e publica. Cron 2x/semana.
# Log: /opt/platform/logs/promo_ofertas.log
set -uo pipefail
exec >>/opt/platform/logs/promo_ofertas.log 2>&1
echo "=== $(date -u +%FT%TZ) promo_ofertas start ==="

MB=platform-music-backend-1
SB=platform-system-backend-1
LOCK=/tmp/promo_ofertas.lock

# lock simples (TTL 1h) — evita execução concorrente
if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK") )) -lt 3600 ]; then
  echo "lock ativo — saindo"; exit 0
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# 1. gera o card no music-backend (tem @napi-rs/canvas), de /app pra resolver módulos
docker cp /opt/platform/scripts/build_ofertas_card.js ${MB}:/app/build_ofertas_card.js || { echo "FALHA cp card"; exit 1; }
docker exec -e CARD_OUT=/tmp/ofertas_card.png ${MB} node /app/build_ofertas_card.js || { echo "FALHA gen card"; exit 1; }
docker cp ${MB}:/tmp/ofertas_card.png /tmp/ofertas_card.png || { echo "FALHA cp out"; exit 1; }

# 2. distribui: og público (p/ IG feed via URL) + system-backend (p/ FB foto binária)
cp /tmp/ofertas_card.png /opt/platform/data/veloxisit/og/ofertas_card.png
docker exec ${SB} mkdir -p /app/data/sites/veloxisit/reels
docker cp /tmp/ofertas_card.png ${SB}:/app/data/sites/veloxisit/reels/ofertas_card.png || { echo "FALHA cp in"; exit 1; }
rm -f /tmp/ofertas_card.png

# 3. publica FB + IG
docker cp /opt/platform/scripts/promo_ofertas_publish.js ${SB}:/tmp/promo_ofertas_publish.js || { echo "FALHA cp js"; exit 1; }
docker exec ${SB} node /tmp/promo_ofertas_publish.js

echo "=== $(date -u +%FT%TZ) promo_ofertas done ==="
