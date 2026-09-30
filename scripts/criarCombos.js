'use strict';
/**
 * criarCombos.js — transforma cada livro com ferramenta num COMBO a venda.
 *
 * Decisao do dono (30/09/2026): combo como e-book, R$ 19,90, com a pagina de
 * acesso ao plano de acao inserida no PDF logo depois da folha de rosto.
 *
 * O combo vira uma linha NOVA em `ebooks` (titulo com "+ Plano de Acao",
 * `combo_de` apontando para o original). Assim os publicadores da Hotmart e da
 * Cakto o pegam pela fila de sempre, sem caminho paralelo. O livro original
 * continua existindo a R$ 5 — nada e alterado nele.
 *
 * Idempotente: livro que ja tem combo e pulado.
 *
 * Uso (no container): node scripts/criarCombos.js [--limite=20]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tituloDoCombo, descricaoDoCombo, montarPdfDoCombo, PRECO_COMBO } = require('../src/ferramentas/combo');
const { totalDeAcoes } = require('../src/ferramentas/especificacao');

let log;
try { log = require('../src/core/logger').createLogger('combos'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const umaLinha = (s, n = 60) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const BASE_URL = 'https://veloxisit.com.br/ferramentas/';

/** Garante a coluna que liga o combo ao livro original. */
function prepararBanco(db) {
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  if (!cols.includes('combo_de')) db.prepare('ALTER TABLE ebooks ADD COLUMN combo_de TEXT').run();
}

async function criarUm(db, f) {
  const orig = db.prepare('SELECT * FROM ebooks WHERE id = ?').get(f.ebook_id);
  if (!orig) return { estado: 'sem-livro' };
  const ja = db.prepare('SELECT id FROM ebooks WHERE combo_de = ?').get(orig.id);
  if (ja) return { estado: 'ja-existe', id: ja.id };
  if (!orig.pdf_path || !fs.existsSync(orig.pdf_path)) return { estado: 'sem-pdf' };

  const esp = JSON.parse(f.especificacao);
  const url = BASE_URL + f.token + '/';
  const bytes = await montarPdfDoCombo(fs.readFileSync(orig.pdf_path), { titulo: orig.title, url });
  const id = crypto.randomUUID();
  const destino = path.join(path.dirname(orig.pdf_path), 'combo_' + id.slice(0, 8) + '.pdf');
  const tmp = destino + '.tmp' + process.pid;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, destino);   // temporario + rename: falha no meio nao deixa PDF pela metade

  const titulo = tituloDoCombo(orig.title);
  db.prepare(
    'INSERT INTO ebooks (id, topic, title, subtitle, description, cover_path, pdf_path, status, price, ai_provider, language, word_count, combo_de) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 'combo', ?, ?, ?)"
  ).run(id, orig.topic, titulo, orig.subtitle, descricaoDoCombo(orig.description, totalDeAcoes(esp)),
    orig.cover_path, destino, PRECO_COMBO, orig.language, orig.word_count || 0, orig.id);
  return { estado: 'criado', id, titulo, acoes: totalDeAcoes(esp), kb: Math.round(bytes.length / 1024) };
}

async function principal() {
  const db = require('../src/core/database').getDb();
  prepararBanco(db);
  const limite = Number(arg('limite', '20')) || 20;
  const ferramentas = db.prepare('SELECT ebook_id, token, especificacao FROM ferramentas ORDER BY criado_em ASC LIMIT ?').all(limite);
  const resumo = { criados: 0, jaExistiam: 0, pulados: 0, falhas: 0 };
  for (const f of ferramentas) {
    try {
      const r = await criarUm(db, f);
      if (r.estado === 'criado') {
        resumo.criados++;
        log.info('combo criado "' + umaLinha(r.titulo) + '" | ' + r.acoes + ' passos | PDF ' + r.kb + ' KB | id ' + r.id.slice(0, 8));
      } else if (r.estado === 'ja-existe') resumo.jaExistiam++;
      else { resumo.pulados++; log.warn('combo pulado (' + r.estado + ') livro ' + String(f.ebook_id).slice(0, 8)); }
    } catch (e) {
      resumo.falhas++;
      log.error('combo falhou livro ' + String(f.ebook_id).slice(0, 8) + ': ' + umaLinha(e && e.message, 160));
    }
  }
  return resumo;
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); });
}

module.exports = { principal, criarUm, prepararBanco };
