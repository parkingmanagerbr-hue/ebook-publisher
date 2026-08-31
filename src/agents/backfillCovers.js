'use strict';
/**
 * backfillCovers.js — reenvia a capa dos produtos que ficaram sem imagem.
 *
 * Constatado A OLHO na lista de produtos do Hotmart (print de 30/08/2026): dos
 * 12 primeiros produtos, 11 mostram o placeholder cinza. A capa e o unico ativo
 * que o comprador ve antes de decidir; produto com icone generico compete em
 * desvantagem contra qualquer concorrente.
 *
 * A causa nao foi a geracao — no banco os 6.859 e-books TEM cover_path, e os
 * arquivos estao em disco. O envio ao Hotmart e que so passou a funcionar
 * depois, e nada volta para preencher o passivo.
 *
 * Uso:
 *   node src/agents/backfillCovers.js --limite=20
 *   node src/agents/backfillCovers.js --limite=20 --dry-run
 */
const fs = require('fs');
const path = require('path');

let log;
try { log = require('../core/logger').createLogger('backfillCovers'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

// Marca quem ja teve a capa reenviada. Coluna nova seria migracao no banco de
// producao; uma tabela propria e reversivel e nao toca no schema existente.
function garantirTabela(db) {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS cover_backfill (' +
    'produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)'
  ).run();
}

function jaTentado(db, produto) {
  const r = db.prepare('SELECT ok FROM cover_backfill WHERE produto = ?').get(String(produto));
  return !!r;
}

function registrar(db, produto, ok) {
  db.prepare('INSERT OR REPLACE INTO cover_backfill (produto, quando, ok) VALUES (?, ?, ?)')
    .run(String(produto), Date.now(), ok ? 1 : 0);
}

/**
 * Candidatos: produto existe no Hotmart, capa existe em disco, ainda nao
 * tentado. Sem o arquivo em disco nao ha o que enviar — a retencao ja apagou a
 * capa dos mais antigos, e esses so voltariam regerando a imagem.
 */
function buscarCandidatos(db, limite) {
  garantirTabela(db);
  // O descarte de ja-processados PRECISA acontecer no SQL, nao em JS depois.
  // Filtrando so em JS, a janela lida (limite*6 linhas mais recentes) enchia de
  // itens ja feitos e a funcao passava a devolver ZERO — o cron anunciava
  // "nenhum produto pendente" com ~600 produtos ainda sem capa, e nunca mais
  // alcancaria os antigos. O NOT EXISTS garante que a janela so traz candidato
  // de verdade.
  const cand = db.prepare(
    'SELECT e.id, e.title, e.hotmart_product_id, e.cover_path FROM ebooks e ' +
    "WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' " +
    "AND e.cover_path IS NOT NULL AND e.cover_path <> '' " +
    'AND NOT EXISTS (SELECT 1 FROM cover_backfill b WHERE b.produto = CAST(e.hotmart_product_id AS TEXT)) ' +
    'ORDER BY e.rowid DESC LIMIT ?'
  ).all(limite * 6);

  const out = [];
  let semArquivo = 0;
  for (const e of cand) {
    if (out.length >= limite) break;
    // A capa some do disco por retencao; sem arquivo nao ha o que enviar.
    if (!fs.existsSync(e.cover_path)) { semArquivo++; continue; }
    out.push({ ebookId: e.id, numericId: String(e.hotmart_product_id), coverPath: e.cover_path, titulo: e.title });
  }
  if (semArquivo) log.info('ignorados ' + semArquivo + ' com a capa ja apagada do disco');
  return out;
}

async function backfill(opts) {
  const o = opts || {};
  const limite = parseInt(o.limite || 10, 10);
  const dryRun = !!o.dryRun;

  const { getDb } = require('../core/database');
  const db = getDb();
  const itens = buscarCandidatos(db, limite);

  if (!itens.length) { log.info('nenhum produto pendente de capa'); return { total: 0, ok: 0 }; }
  log.info('capas a reenviar: ' + itens.length);
  if (dryRun) {
    for (const i of itens) log.info('  [dry-run] ' + i.numericId + ' ' + String(i.titulo).slice(0, 45));
    return { total: itens.length, ok: 0, dryRun: true };
  }

  const { backfillCapas } = require('./publisherHotmart');
  // Persistir POR ITEM: um lote morto no meio (ja aconteceu, por SIGTERM) nao
  // pode perder o que ja deu certo e reenviar tudo de novo no proximo passe.
  const r = await backfillCapas(itens, (item, ok) => registrar(db, item.numericId, ok));
  return r;
}

module.exports = { backfill, buscarCandidatos, garantirTabela, jaTentado, registrar };

if (require.main === module) {
  backfill({ limite: arg('limite', '10'), dryRun: process.argv.includes('--dry-run') })
    .then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
