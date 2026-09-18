'use strict';
/**
 * regerarPdfCakto.js — devolve o arquivo dos produtos Cakto que estao pausados
 * por nao ter o que entregar.
 *
 * Medido em 18/09/2026: dos 7.287 produtos Cakto, so 1.440 ainda tinham o PDF
 * em disco. A retencao antiga apagou o resto e o entregaCakto pausou 5.843
 * ("Ajustar para vender" no painel). Regerar todos custaria semanas de cota de
 * IA, entao aqui vai POUCO por vez e na ordem que rende venda: primeiro quem
 * ja tem capa (nao gasta imagem), depois portugues, depois o mais novo.
 *
 * Quem reativa e o entregaCakto: assim que o PDF volta, o produto sai de
 * waiting_config e volta a vender (scripts/entregaCakto.js, alvo()).
 *
 * Uso (no container): node scripts/regerarPdfCakto.js --limite=1
 */
const fs = require('fs');

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

/** Pontua o candidato: capa em disco, portugues e mais recente primeiro. Pura. */
function nota(e, existe = fs.existsSync) {
  const capa = e.cover_path && existe(e.cover_path) ? 1 : 0;
  const pt = String(e.language || '').toLowerCase().startsWith('pt') ? 1 : 0;
  return capa * 1000 + pt * 100 + (Number(e.ordem) || 0) / 1e9;
}

/** Fila de regeracao: produto Cakto pausado por falta de PDF. */
function pendentes(db, limite, existe = fs.existsSync) {
  let linhas = [];
  try {
    linhas = db.prepare(
      'SELECT e.id, e.title, e.subtitle, e.topic, e.language, e.cover_path, e.pdf_path, e.rowid AS ordem, c.produto ' +
      'FROM cakto_entrega c JOIN ebooks e ON e.id = c.ebook_id ' +
      "WHERE c.resultado = 'pausado-sem-pdf'"
    ).all();
  } catch { return []; }
  return linhas
    .filter(e => !e.pdf_path || !existe(e.pdf_path))
    .sort((a, b) => nota(b, existe) - nota(a, existe))
    .slice(0, limite);
}

async function main() {
  const limite = parseInt(arg('limite', '1'), 10);
  const db = require('../src/core/database').getDb();
  const fila = pendentes(db, limite);
  if (!fila.length) { console.log(JSON.stringify({ pendentes: 0 })); return; }

  const { generateFullEbook } = require('../src/agents/writerAgent');
  const { generatePDF } = require('../src/agents/pdfAgent');
  const grava = db.prepare('UPDATE ebooks SET pdf_path = ? WHERE id = ?');
  // Sai da lista de pausados para o entregaCakto reativar na proxima rodada.
  const reabre = db.prepare("DELETE FROM cakto_entrega WHERE ebook_id = ? AND resultado = 'pausado-sem-pdf'");
  let ok = 0, falha = 0;
  for (const e of fila) {
    try {
      const novo = await generateFullEbook(e.topic || e.title, e.language || 'pt-BR');
      const capa = e.cover_path && fs.existsSync(e.cover_path) ? e.cover_path : null;
      const caminho = await generatePDF({ ...novo, title: e.title, subtitle: e.subtitle || novo.subtitle, id: e.id, language: e.language || 'pt-BR' }, capa);
      grava.run(caminho, e.id);
      reabre.run(e.id);
      ok++;
      console.log('OK ' + e.id.slice(0, 8) + ' ' + String(e.title).slice(0, 50) + ' -> ' + caminho);
    } catch (err) {
      falha++;
      console.log('FALHA ' + e.id.slice(0, 8) + ': ' + String(err.message).slice(0, 120));
    }
  }
  console.log(JSON.stringify({ fila: fila.length, ok, falha }));
}

module.exports = { pendentes, nota };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
