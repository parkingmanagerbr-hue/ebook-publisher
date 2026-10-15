'use strict';
/**
 * resumoDiario.js — o resumo das lojas nas ultimas 24 h, num texto so.
 *
 * Os logs moram no HOST (/opt/platform/logs), fora do container; o host manda
 * as linhas pela entrada padrao, uma por linha no formato "arquivo<TAB>linha",
 * e este script junta com o que esta no banco (falhas registradas, eventos do
 * Google Play). Decisoes em src/agents/resumoDiario.js.
 *
 * Uso (cron do host, 23:50):
 *   for f in hotmart_vps.log backlog_publish.log cakto_checkout.log recompressao_pdf.log kiwify_cadeia.log; do
 *     tail -n 20000 /opt/platform/logs/$f | sed "s|^|$f\t|"; done |
 *     docker exec -i platform-ebook-publisher-1 node scripts/resumoDiario.js > /opt/platform/logs/resumo_diario_<data>.txt
 */
const { agregar, formatar, normalizarMotivo } = require('../src/agents/resumoDiario');

// A saida padrao E o resumo (o host a grava no arquivo do dia): o diagnostico
// vai para a saida de erro, nunca pelo logger do projeto, que escreve na padrao.
const log = { info: m => console.error('[resumoDiario] ' + m), error: m => console.error('[resumoDiario] ' + m) };

/** "arquivo<TAB>linha" -> { arquivo, linha }. Linha sem TAB e ignorada. */
function lerEntradas(texto) {
  const out = [];
  for (const bruta of String(texto).split(/\r?\n/)) {
    const i = bruta.indexOf('\t');
    if (i > 0) out.push({ arquivo: bruta.slice(0, i), linha: bruta.slice(i + 1) });
  }
  return out;
}

/** Linhas extras por loja, tiradas do banco. Tabela que nao existe nao derruba o resumo. */
function extrasDoBanco(db, { desde, ate }) {
  const extras = {};
  const add = (loja, texto) => { (extras[loja] = extras[loja] || []).push(texto); };
  const tenta = (rotulo, fn) => { try { fn(); } catch (e) { add('resumo', rotulo + ': nao li (' + String(e.message).slice(0, 60) + ')'); } };
  const temTabela = n => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  const agrupado = (linhas, campo) => {
    const g = {}; for (const r of linhas) { const k = normalizarMotivo(r[campo]); g[k] = (g[k] || 0) + 1; }
    return Object.entries(g).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' — ' + n + 'x');
  };
  tenta('hotmart', () => {
    if (!temTabela('hotmart_publicar_falha')) return;
    const r = db.prepare('SELECT erro, tentativas FROM hotmart_publicar_falha WHERE quando >= ? AND quando < ?').all(desde, ate);
    if (r.length) { add('hotmart', 'falhas registradas no periodo: ' + r.length + ' livro(s)'); for (const x of agrupado(r, 'erro')) add('hotmart', '  * ' + x); }
    if (temTabela('hotmart_pdf_envio')) {
      const d = db.prepare('SELECT count(*) n FROM hotmart_pdf_envio WHERE desistiu = 1').get().n;
      if (d) add('hotmart', 'PDF regerado que a API nunca confirmou (fora da fila, conferir no painel): ' + d + ' produto(s)');
    }
  });
  tenta('kiwify', () => {
    if (temTabela('kiwify_falha')) {
      const r = db.prepare('SELECT motivo FROM kiwify_falha WHERE quando >= ? AND quando < ?').all(desde, ate);
      if (r.length) { add('kiwify', 'livros nao gravados como publicados: ' + r.length); for (const x of agrupado(r, 'motivo')) add('kiwify', '  * ' + x); }
    }
    if (temTabela('kiwify_recusado')) {
      const n = db.prepare('SELECT count(*) n FROM kiwify_recusado WHERE quando >= ? AND quando < ?').get(desde, ate).n;
      if (n) add('kiwify', 'recusados pelo filtro de conteudo da Kiwify: ' + n);
    }
  });
  tenta('cakto', () => {
    if (!temTabela('cakto_recusado')) return;
    const r = db.prepare('SELECT motivo FROM cakto_recusado WHERE quando >= ? AND quando < ?').all(desde, ate);
    if (r.length) { add('cakto', 'recusados: ' + r.length); for (const x of agrupado(r, 'motivo')) add('cakto', '  * ' + x); }
  });
  tenta('gplay', () => {
    if (!temTabela('gplay_eventos')) return;
    const r = db.prepare('SELECT tipo, count(*) n FROM gplay_eventos WHERE quando >= ? AND quando < ? GROUP BY tipo').all(desde, ate);
    if (r.length) add('gplay', 'eventos: ' + r.map(x => x.tipo + ' ' + x.n).join(' | '));
    const e = db.prepare("SELECT gplay_estado, count(*) n FROM ebooks WHERE COALESCE(gplay_id, '') <> '' GROUP BY gplay_estado").all();
    if (e.length) add('gplay', 'livros na conta: ' + e.map(x => (x.gplay_estado || '?') + ' ' + x.n).join(' | '));
  });
  return extras;
}

function principal({ texto, db, agora = Date.now() } = {}) {
  const ate = agora;
  const desde = ate - 24 * 3600 * 1000;
  const entradas = lerEntradas(texto);
  const lojas = agregar(entradas, { desde, ate });
  const extras = extrasDoBanco(db, { desde, ate });
  const saida = formatar(lojas, { desde, ate, extras });
  log.info('resumo diario: ' + entradas.length + ' linhas lidas, ' + Object.keys(lojas).length + ' loja(s) com atividade');
  return saida;
}

if (require.main === module) {
  let texto = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { texto += d; });
  process.stdin.on('end', () => {
    try {
      // Somente leitura e sem o database.js, que escreve "Schema inicializado" na saida padrao.
      const Database = require('better-sqlite3');
      const db = new Database(process.env.METRICS_DB || '/app/data/metrics.db', { readonly: true, fileMustExist: true });
      process.stdout.write(principal({ texto, db }) + '\n');
      process.exit(0);
    } catch (e) {
      log.error('ERRO: ' + String(e && e.message).replace(/[\r\n]+/g, ' ').slice(0, 200));
      process.exit(1);
    }
  });
}

module.exports = { principal, lerEntradas, extrasDoBanco };
