'use strict';
/**
 * scoreCoverHooks.js — fecha o ciclo de aprendizado das capas.
 *
 * O coverPackaging escolhe a TÉCNICA de gancho por bandit e registra qual usou
 * em cada capa. Faltava a outra metade: alguém precisa dizer ao bandit o que
 * vendeu. Sem isso o placar fica eternamente empatado em zero e a escolha é
 * aleatória para sempre — um bandit que nunca recebe recompensa é só um sorteio
 * com passos extras.
 *
 * Aqui cada registro de capa é casado com o e-book correspondente (pelo tópico)
 * e pontuado com as vendas reais daquele e-book.
 *
 * JANELA DE MATURAÇÃO (o detalhe que decide se isto presta): e-book publicado
 * há duas horas ainda não vendeu — pontuá-lo com 0 não é medir, é enterrar a
 * técnica com um dado falso. Só entram e-books com idade mínima, tempo real de
 * mercado. É o mesmo motivo pelo qual não se avalia campanha no primeiro dia.
 */
const fs = require('fs');
const path = require('path');

let log;
try { log = require('../core/logger').createLogger('scoreCoverHooks'); }
catch { log = { info: console.log, warn: console.warn }; }

const { pontuarHook, placar } = require('./coverPackaging');

const MEMORIA = process.env.COVER_PACKAGING_MEMORY
  || path.join(__dirname, '..', '..', 'data', 'cover_packaging_memory.json');

// Dias que um e-book precisa ter no ar antes de valer como evidência.
const MATURACAO_DIAS = parseInt(process.env.COVER_SCORE_MIN_DAYS || '7', 10);

function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // sem acento
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pontua as capas maduras ainda não pontuadas.
 * Idempotente: marca cada registro como pontuado, entao rodar de novo nao
 * conta a mesma venda duas vezes (o que inflaria a tecnica sem evidencia nova).
 */
function pontuarCapas(opts) {
  const o = opts || {};
  const dryRun = !!o.dryRun;

  let memoria;
  try { memoria = JSON.parse(fs.readFileSync(MEMORIA, 'utf8')); }
  catch { log.info('sem memoria de packaging ainda — nada a pontuar'); return { pontuados: 0, semVenda: 0, imaturos: 0, semMatch: 0 }; }

  const registros = (memoria.log || []).filter(r => r && r.hookId && !r.pontuado);
  if (!registros.length) { log.info('nenhuma capa nova para pontuar'); return { pontuados: 0, semVenda: 0, imaturos: 0, semMatch: 0 }; }

  const Database = require('better-sqlite3');
  const dbPath = process.env.METRICS_DB || path.join(__dirname, '..', '..', 'data', 'metrics.db');
  const db = new Database(dbPath, { readonly: true });

  const corte = Date.now() - MATURACAO_DIAS * 24 * 3600 * 1000;
  let pontuados = 0, semVenda = 0, imaturos = 0, semMatch = 0;

  const buscar = db.prepare(
    'SELECT id, topic, title, sales_count, revenue, published_at, created_at ' +
    'FROM ebooks WHERE topic = ? ORDER BY id DESC LIMIT 1'
  );

  for (const r of registros) {
    const quando = Date.parse(r.quando || '') || 0;
    if (quando > corte) { imaturos++; continue; }   // capa nova demais para julgar

    let eb = null;
    try { eb = buscar.get(r.topico); } catch { /* topico pode nao bater exato */ }

    if (!eb) {
      // Casamento tolerante: o registro guarda o topico truncado em 80 chars.
      try {
        const alvo = normalizar(r.topico);
        const cand = db.prepare(
          'SELECT id, topic, sales_count, revenue FROM ebooks ORDER BY id DESC LIMIT 800'
        ).all();
        eb = cand.find(c => normalizar(c.topic).startsWith(alvo.slice(0, 40))) || null;
      } catch { /* sem match */ }
    }

    if (!eb) { semMatch++; continue; }

    // Score = vendas; receita entra como desempate fino (centavos nao dominam).
    const vendas = Number(eb.sales_count || 0);
    const receita = Number(eb.revenue || 0);
    const score = vendas + receita / 1000;

    if (!dryRun) {
      pontuarHook(r.hookId, score);
      r.pontuado = true;
      r.score = score;
      r.ebookId = eb.id;
    }
    if (vendas === 0) semVenda++;
    pontuados++;
  }

  if (!dryRun) {
    try { fs.writeFileSync(MEMORIA, JSON.stringify(memoria, null, 2)); }
    catch (e) { log.warn('nao consegui salvar memoria: ' + e.message.slice(0, 60)); }
  }

  log.info(
    'pontuadas ' + pontuados + ' capas (' + semVenda + ' sem venda), ' +
    imaturos + ' ainda imaturas (<' + MATURACAO_DIAS + 'd), ' + semMatch + ' sem e-book correspondente'
  );
  const p = placar();
  if (p.length) log.info('placar: ' + p.map(h => h.id + '=' + h.media + '(' + h.usos + ')').join(' '));

  return { pontuados, semVenda, imaturos, semMatch, placar: p };
}

module.exports = { pontuarCapas };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const r = pontuarCapas({ dryRun });
  console.log(JSON.stringify(r, null, 2));
}
