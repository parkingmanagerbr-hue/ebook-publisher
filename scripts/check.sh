#!/bin/bash
# check.sh -- Diagnostico do GENIA E-book Publisher
# Uso: docker exec platform-ebook-publisher-1 bash /app/scripts/check.sh

echo ""
echo "======================================================"
echo "  GENIA E-book Publisher -- Status Report"
echo "  $(date '+%d/%m/%Y %H:%M:%S')"
echo "======================================================"

echo ""
echo "[UPTIME]"
echo "  Iniciado: $(stat -c %y /proc/1 2>/dev/null | cut -d. -f1 || echo n/a)"

echo ""
echo "[E-BOOKS no DB]"
node -e "
try {
  const db = new (require('better-sqlite3'))('/app/data/metrics.db');
  const rows = db.prepare('SELECT status, COUNT(*) as n FROM ebooks GROUP BY status').all();
  rows.forEach(function(r){ console.log('  ' + r.status + ': ' + r.n); });
  const total = db.prepare('SELECT COUNT(*) as n FROM ebooks').get().n;
  console.log('  TOTAL: ' + total);
} catch(e){ console.log('  Erro: ' + e.message); }
" 2>/dev/null

echo ""
echo "[ULTIMOS 5 PUBLICADOS]"
node -e "
try {
  const db = new (require('better-sqlite3'))('/app/data/metrics.db');
  const rows = db.prepare(\"SELECT title, ai_provider, hotmart_url, cakto_url, published_at FROM ebooks WHERE status='published' ORDER BY published_at DESC LIMIT 5\").all();
  if(!rows.length){ console.log('  Nenhum publicado'); }
  rows.forEach(function(r){
    const dt = r.published_at ? new Date(r.published_at).toLocaleString('pt-BR') : 'n/a';
    console.log('  ['+dt+'] '+r.title);
    console.log('    hotmart='+(r.hotmart_url?'sim':'nao')+' cakto='+(r.cakto_url?'sim':'nao')+' ia='+(r.ai_provider||'?'));
  });
} catch(e){ console.log('  Erro: ' + e.message); }
" 2>/dev/null

echo ""
echo "[ULTIMOS ERROS no DB]"
node -e "
try {
  const db = new (require('better-sqlite3'))('/app/data/metrics.db');
  const rows = db.prepare(\"SELECT title, created_at FROM ebooks WHERE status='error' ORDER BY created_at DESC LIMIT 5\").all();
  if(!rows.length){ console.log('  Sem erros no DB'); }
  rows.forEach(function(r){ console.log('  ['+r.created_at+'] '+r.title); });
} catch(e){ console.log('  Erro: ' + e.message); }
" 2>/dev/null

echo ""
echo "[LOG DE ERROS]"
LOG_DIR="/app/logs"
TODAY=$(date +%Y-%m-%d)
ERROR_LOG="$LOG_DIR/error-$TODAY.log"
if [ -f "$ERROR_LOG" ]; then
  echo "  Arquivo: $ERROR_LOG"
  tail -20 "$ERROR_LOG" | sed 's/^/  /'
else
  echo "  Sem log de erros hoje ($TODAY)"
  LATEST=$(ls "$LOG_DIR"/error-*.log 2>/dev/null | sort | tail -1)
  if [ -n "$LATEST" ]; then
    echo "  Ultimo disponivel: $LATEST"
    tail -5 "$LATEST" | sed 's/^/  /'
  fi
fi

echo ""
echo "[ESTADO DA IA]"
if [ -f /app/data/ai_state.json ]; then
  node -e "
try {
  const s = JSON.parse(require('fs').readFileSync('/app/data/ai_state.json','utf8'));
  console.log('  current: ' + (s.current || s.provider || 'n/a'));
  console.log('  data: ' + JSON.stringify(s));
} catch(e){ console.log('  Erro: ' + e.message); }
" 2>/dev/null
else
  echo "  ai_state.json nao encontrado, usando aiClient:"
  node -e "
try {
  const { getStatus } = require('./src/core/aiClient');
  const st = getStatus();
  Object.keys(st).forEach(function(k){
    const p = st[k];
    console.log('  ' + k + ': calls=' + (p.calls||0) + ' fails=' + (p.failures||0) + (p.degraded?' [DEGRADED]':'') + (p.failed?' [FAILED]':''));
  });
} catch(e){ console.log('  Erro aiClient: ' + e.message); }
" 2>/dev/null
fi

echo ""
echo "[SESSOES]"
if [ -d /app/data/sessions ]; then
  FILES=$(ls /app/data/sessions/ 2>/dev/null)
  if [ -z "$FILES" ]; then
    echo "  Nenhuma sessao encontrada"
  else
    ls /app/data/sessions/ | sed 's/^/  /'
  fi
else
  echo "  /app/data/sessions nao existe"
fi

echo ""
echo "[DISCO]"
echo "  PDFs:    $(du -sh /app/data/pdfs/ 2>/dev/null | cut -f1 || echo n/a)"
echo "  Covers:  $(du -sh /app/data/covers/ 2>/dev/null | cut -f1 || echo n/a)"
echo "  DB:      $(du -sh /app/data/metrics.db 2>/dev/null | cut -f1 || echo n/a)"

echo ""
echo "======================================================"
echo ""