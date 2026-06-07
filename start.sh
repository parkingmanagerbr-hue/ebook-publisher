#!/bin/sh
# start.sh — Entrypoint do container GENIA EbookPublisher
#
# Modos:
#   DASHBOARD_ONLY=1   → só o servidor web (porta 3100) — megaAgent separado
#   MEGA_ONLY=1        → só o megaAgent (loop infinito sem dashboard)
#   padrão             → ambos em paralelo (dashboard + megaAgent)

set -e

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  GENIA EbookPublisher — Iniciando container              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo "  Node: $(node --version)"
echo "  Modo: ${DASHBOARD_ONLY:+DASHBOARD_ONLY} ${MEGA_ONLY:+MEGA_ONLY} ${DASHBOARD_ONLY:-${MEGA_ONLY:-FULL}}"
echo ""

# Garantir diretórios de dados
mkdir -p /app/data/pdfs /app/data/covers /app/data/sessions \
         /app/data/audiobooks /app/data/logs /app/data/db \
         /app/logs

if [ "${MEGA_ONLY}" = "1" ]; then
  # Apenas o loop de geração (sem dashboard)
  echo "[start] Modo MEGA_ONLY — iniciando megaAgent.js"
  exec node megaAgent.js

elif [ "${DASHBOARD_ONLY}" = "1" ]; then
  # Apenas o dashboard (megaAgent roda em outro container)
  echo "[start] Modo DASHBOARD_ONLY — iniciando src/server.js"
  exec node src/server.js

else
  # Modo completo: dashboard + megaAgent em paralelo
  echo "[start] Modo FULL — dashboard + megaAgent em paralelo"
  node src/server.js &
  SERVER_PID=$!

  # Aguardar server inicializar antes do megaAgent
  sleep 8

  node megaAgent.js &
  MEGA_PID=$!

  # Manter container vivo; sair se qualquer processo morrer
  wait $SERVER_PID $MEGA_PID
fi
