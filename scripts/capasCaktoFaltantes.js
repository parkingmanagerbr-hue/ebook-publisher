'use strict';
/**
 * capasCaktoFaltantes.js — refaz a capa dos produtos Cakto que entregam mas
 * aparecem sem imagem no checkout.
 *
 * Medido em 16/09/2026: dos ~900 produtos Cakto com PDF, so 251 ainda tinham a
 * capa em disco; a retencao antiga apagou o resto. Sem capa, o job de entrega
 * (entregaCakto.js) nao tem o que enviar e o checkout mostra so o titulo.
 *
 * Gera a capa viral no idioma do livro (sem exigir gancho de IA: com a cota
 * curta, capa com o titulo do livro ainda e melhor que checkout sem imagem),
 * grava o caminho e tira o produto da lista de concluidos do job de entrega,
 * que na proxima rodada envia a imagem.
 *
 * Uso (no container): node scripts/capasCaktoFaltantes.js --limite=5
 */
const fs = require('fs');

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

/** E-books que entregam na Cakto e nao tem capa em disco. Pura sobre o banco. */
function semCapa(db, limite, existe = fs.existsSync) {
  const linhas = db.prepare(
    "SELECT id, title, subtitle, topic, language, pdf_path, cover_path FROM ebooks " +
    "WHERE cakto_product_id IS NOT NULL AND cakto_product_id <> '' AND pdf_path IS NOT NULL ORDER BY rowid DESC"
  ).all();
  return linhas.filter(e => existe(e.pdf_path) && !(e.cover_path && existe(e.cover_path))).slice(0, limite);
}

async function main() {
  const limite = parseInt(arg('limite', '5'), 10);
  const db = require('../src/core/database').getDb();
  const fila = semCapa(db, limite);
  if (!fila.length) { console.log(JSON.stringify({ pendentes: 0 })); return; }
  const { generateViralCover } = require('../src/agents/coverViralAgent');
  const { getCategoryPT } = require('../src/agents/hotmartRegras');
  const COVERS = process.env.COVERS_DIR || '/app/data/covers';
  const grava = db.prepare('UPDATE ebooks SET cover_path = ? WHERE id = ?');
  let tabela = true;
  try { db.prepare('SELECT 1 FROM cakto_entrega LIMIT 1').all(); } catch { tabela = false; }
  const reabre = tabela ? db.prepare('DELETE FROM cakto_entrega WHERE ebook_id = ?') : null;
  let ok = 0, falha = 0;
  for (const e of fila) {
    try {
      const caminho = await generateViralCover(e.title, e.subtitle || '', e.topic || e.title,
        getCategoryPT(e.title, e.topic), COVERS, e.language || 'pt-BR', { exigirImagemUnica: true });
      if (!caminho || !fs.existsSync(caminho)) throw new Error('gerador nao devolveu arquivo');
      grava.run(caminho, e.id);
      if (reabre) reabre.run(e.id);
      ok++;
      console.log('OK ' + e.id.slice(0, 8) + ' ' + String(e.title).slice(0, 50));
    } catch (err) {
      falha++;
      console.log('FALHA ' + e.id.slice(0, 8) + ': ' + String(err.message).slice(0, 100));
    }
  }
  console.log(JSON.stringify({ fila: fila.length, ok, falha }));
}

module.exports = { semCapa };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
