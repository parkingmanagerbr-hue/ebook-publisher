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

  # Supervisao por POLLING no processo principal, em vez de subshell.
  #
  # A versao com subshell tinha uma fragilidade: `pgrep -f megaAgent.js` casa
  # tambem com a linha de comando do proprio subshell, entao matar "o megaAgent"
  # podia matar o supervisor — e ai ninguem reiniciava nada. Aqui quem
  # supervisiona e o PID 1 (start.sh), que nunca casa com esse padrao.
  MEGA_BACKOFF_MAX=${MEGA_BACKOFF_MAX:-300}
  tentativa=0
  MEGA_PID=""

  iniciar_mega() {
    tentativa=$((tentativa + 1))
    echo "[supervisor] iniciando megaAgent (tentativa ${tentativa})"
    node megaAgent.js &
    MEGA_PID=$!
  }

  iniciar_mega

  while true; do
    sleep 15

    # Server caiu -> encerra o container para o restart policy reiniciar limpo.
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[start] server.js saiu — derrubando container para restart limpo"
      kill "$MEGA_PID" 2>/dev/null || true
      exit 1
    fi

    # megaAgent caiu -> reinicia com backoff progressivo (15s, 30s... ate o max).
    if ! kill -0 "$MEGA_PID" 2>/dev/null; then
      # `|| code=$?` e obrigatorio: com `set -e` (linha 9) um wait que retorna
      # nao-zero — exatamente o caso de crash/kill — derrubaria o start.sh e o
      # container inteiro, em vez de so reerguer o megaAgent. Observado na
      # pratica: RestartCount subiu e o PID voltou identico apos um kill -9.
      code=0
      wait "$MEGA_PID" 2>/dev/null || code=$?
      espera=$((15 * tentativa))
      [ "$espera" -gt "$MEGA_BACKOFF_MAX" ] && espera=$MEGA_BACKOFF_MAX
      echo "[supervisor] megaAgent saiu (code=${code}) — reiniciando em ${espera}s"
      sleep "$espera"
      iniciar_mega
    fi
  done
fi
