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
  # Modo completo: dashboard + megaAgent supervisionados.
  #
  # BUG CORRIGIDO (06/08/2026): antes era `wait $SERVER_PID $MEGA_PID`, que no
  # sh POSIX espera TODOS terminarem — nao o primeiro. Em 04/08 o megaAgent
  # morreu (Chromium "Target closed") e o wait seguiu aguardando o server, vivo.
  # O healthcheck so testa /api/status (o server), entao o container ficou
  # 3 DIAS "healthy" sem publicar nada. Agora o megaAgent e supervisionado e
  # reinicia sozinho; se o server cair, o container sai e o restart policy age.
  echo "[start] Modo FULL — dashboard + megaAgent supervisionado"

  node src/server.js &
  SERVER_PID=$!

  # Aguardar server inicializar antes do megaAgent
  sleep 8

  # Supervisor: mantem o megaAgent vivo com backoff progressivo.
  MEGA_BACKOFF_MAX=${MEGA_BACKOFF_MAX:-300}
  (
    tentativa=0
    while true; do
      tentativa=$((tentativa + 1))
      echo "[supervisor] iniciando megaAgent (tentativa ${tentativa})"
      node megaAgent.js
      code=$?
      # Backoff: 15s, 30s, 60s... ate MEGA_BACKOFF_MAX. Evita loop de crash
      # quente quando a causa e persistente (ex.: sessao expirada).
      espera=$((15 * tentativa))
      [ "$espera" -gt "$MEGA_BACKOFF_MAX" ] && espera=$MEGA_BACKOFF_MAX
      echo "[supervisor] megaAgent saiu (code=${code}) — reiniciando em ${espera}s"
      sleep "$espera"
    done
  ) &
  SUPERVISOR_PID=$!

  # Se o SERVER morrer, encerra o container para o restart policy reiniciar tudo.
  wait $SERVER_PID
  echo "[start] server.js saiu — derrubando container para restart limpo"
  kill $SUPERVISOR_PID 2>/dev/null || true
  exit 1
fi
