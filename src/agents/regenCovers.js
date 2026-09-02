'use strict';
/**
 * regenCovers.js — regera a capa dos produtos cujo PNG a retencao ja apagou.
 *
 * Medido em 01/09/2026: dos 570 produtos ainda sem capa no Hotmart, ZERO tinham
 * a imagem em disco. A retencao (KEEP_COVERS=1000) guarda so as mais recentes,
 * e o passivo e todo anterior a isso. Sem regerar, esses produtos ficam para
 * sempre com o placeholder cinza.
 *
 * A regeracao NAO gasta cota de imagem: o fundo sai do pool do Google FX ja
 * baixado. Só o texto da embalagem passa pelo LLM, e o coverViralAgent tem
 * fallback proprio quando a IA esta fora — capa com texto padrao e melhor que
 * produto sem capa.
 *
 * TRABALHA EM LOTES PEQUENOS DE PROPOSITO: a mesma retencao que apagou essas
 * capas continua rodando. Regerar 570 de uma vez faria as primeiras serem
 * apagadas antes de subir. O ciclo certo e regerar um lote e enviar em seguida.
 *
 * Uso:
 *   node src/agents/regenCovers.js --limite=40
 */
const fs = require('fs');
const path = require('path');

let log;
try { log = require('../core/logger').createLogger('regenCovers'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

const COVERS_DIR = process.env.COVERS_DIR || '/app/data/covers';

/**
 * Produtos publicados no Hotmart que ainda nao receberam capa E cujo arquivo
 * sumiu do disco. Sao exatamente os que o backfill nao consegue atender.
 */
function buscarSemArquivo(db, limite) {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS cover_backfill (' +
    'produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)'
  ).run();

  const cand = db.prepare(
    // Nao existe coluna `category` na tabela: a categoria e DERIVADA do topico
    // pela mesma funcao que o publisher usa (getCategory), entao a capa regerada
    // fica coerente com a categoria em que o produto foi cadastrado.
    'SELECT e.id, e.title, e.subtitle, e.topic, e.hotmart_product_id AS pid, e.cover_path ' +
    'FROM ebooks e ' +
    "WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' " +
    'AND NOT EXISTS (SELECT 1 FROM cover_backfill b WHERE b.produto = CAST(e.hotmart_product_id AS TEXT)) ' +
    'ORDER BY e.rowid DESC LIMIT ?'
  ).all(limite * 4);

  // Só quem NAO tem arquivo: quem tem e trabalho do backfill, que e mais barato.
  return cand.filter(e => !e.cover_path || !fs.existsSync(e.cover_path)).slice(0, limite);
}

async function regerar(opts) {
  const o = opts || {};
  const limite = parseInt(o.limite || 20, 10);
  const { getDb } = require('../core/database');
  const db = getDb();

  const itens = buscarSemArquivo(db, limite);
  if (!itens.length) { log.info('nenhuma capa para regerar'); return { total: 0, ok: 0 }; }
  log.info('regerando ' + itens.length + ' capas');

  const { generateViralCover } = require('./coverViralAgent');
  const { getCategory } = require('./publisherHotmart');
  const atualiza = db.prepare('UPDATE ebooks SET cover_path = ? WHERE id = ?');

  let ok = 0;
  const t0 = Date.now();
  for (const e of itens) {
    try {
      const caminho = await generateViralCover(
        e.title, e.subtitle || '', e.topic || e.title,
        (() => { try { return getCategory(e.topic || e.title) || 'Outros'; } catch { return 'Outros'; } })(),
        COVERS_DIR
      );
      if (caminho && fs.existsSync(caminho)) {
        // Gravar o caminho novo: e por ele que o backfill vai encontrar a capa.
        atualiza.run(caminho, e.id);
        ok++;
        log.info('OK  ' + e.pid + ' ' + String(e.title).slice(0, 42) + ' -> ' + path.basename(caminho));
      } else {
        log.warn('FALHA ' + e.pid + ' — gerador nao devolveu arquivo');
      }
    } catch (err) {
      log.warn('FALHA ' + e.pid + ': ' + String(err.message).slice(0, 90));
    }
  }

  const min = ((Date.now() - t0) / 60000).toFixed(1);
  log.info('regeracao: ' + ok + '/' + itens.length + ' em ' + min + ' min');
  return { total: itens.length, ok, minutos: Number(min) };
}

module.exports = { regerar, buscarSemArquivo };

if (require.main === module) {
  regerar({ limite: arg('limite', '20') })
    .then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
