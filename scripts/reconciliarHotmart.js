'use strict';
/**
 * reconciliarHotmart.js — liga produto Hotmart que vendeu ao e-book do banco.
 *
 * Medido em 15/09/2026: 15 produtos com transacao nao existiam na tabela ebooks
 * (`hotmart_product_id` nulo). Sao copias publicadas a mao e produtos cujo id
 * nunca voltou para o banco. Efeito: a venda nao conta para nada — nem para o
 * placar de ganchos, nem para o idioma, e o produto fica fora do passe de capas.
 *
 * Regra conservadora: so liga quando o TITULO do produto na Hotmart e igual
 * (normalizado) ao titulo de UM e-book que ainda nao tem produto Hotmart. Dois
 * candidatos, ou nenhum, nao liga nada — preferivel deixar orfao a apontar o
 * e-book errado, que estragaria a capa e a contagem.
 *
 * Uso (no container):
 *   node scripts/reconciliarHotmart.js            # relatorio
 *   node scripts/reconciliarHotmart.js --aplicar
 */
const { normalizarTitulo } = require('./reconciliarCakto');

/**
 * @param {{produtoId:string, produto:string}[]} vendidos produtos com transacao
 * @param {{id:string,title:string,hotmart_product_id:?string}[]} ebooks
 * Pura: devolve {ligar:[{ebookId, produtoId, titulo}], ambiguos, semTitulo}
 */
function reconciliar(vendidos, ebooks) {
  const jaLigados = new Set(ebooks.map(e => String(e.hotmart_product_id || '')).filter(Boolean));
  const livresPorTitulo = new Map();
  for (const e of ebooks) {
    if (e.hotmart_product_id) continue;
    const k = normalizarTitulo(e.title);
    if (!k) continue;
    if (!livresPorTitulo.has(k)) livresPorTitulo.set(k, []);
    livresPorTitulo.get(k).push(e);
  }

  const ligar = [], ambiguos = [], semTitulo = [];
  const usados = new Set();
  for (const v of vendidos) {
    const pid = String(v.produtoId);
    if (jaLigados.has(pid)) continue;
    const cands = (livresPorTitulo.get(normalizarTitulo(v.produto)) || []).filter(e => !usados.has(e.id));
    if (cands.length === 1) { usados.add(cands[0].id); ligar.push({ ebookId: cands[0].id, produtoId: pid, titulo: v.produto }); }
    else if (cands.length > 1) ambiguos.push({ produtoId: pid, titulo: v.produto, candidatos: cands.length });
    else semTitulo.push({ produtoId: pid, titulo: v.produto });
  }
  return { ligar, ambiguos, semTitulo };
}

function main() {
  const aplicar = process.argv.includes('--aplicar');
  const db = require('../src/core/database').getDb();
  const vendidos = db.prepare('SELECT DISTINCT CAST(produto_id AS TEXT) AS produtoId, produto FROM vendas_hotmart').all();
  const ebooks = db.prepare('SELECT id, title, hotmart_product_id FROM ebooks').all();
  const r = reconciliar(vendidos, ebooks);
  console.log(JSON.stringify({ vendidos: vendidos.length, ligar: r.ligar.length, ambiguos: r.ambiguos.length, semTitulo: r.semTitulo.length }));
  for (const a of r.ambiguos) console.log('AMBIGUO #' + a.produtoId + ' ' + a.titulo.slice(0, 50) + ' (' + a.candidatos + ' candidatos)');
  for (const s of r.semTitulo) console.log('SEM E-BOOK #' + s.produtoId + ' ' + s.titulo.slice(0, 60));
  if (!aplicar) { console.log('(relatorio apenas — use --aplicar)'); return; }
  const up = db.prepare('UPDATE ebooks SET hotmart_product_id = ?, hotmart_url = COALESCE(hotmart_url, ?) WHERE id = ?');
  db.transaction(() => { for (const l of r.ligar) up.run(l.produtoId, 'https://pay.hotmart.com/' + l.produtoId, l.ebookId); })();
  console.log('ligados:', r.ligar.length);
}

module.exports = { reconciliar };

if (require.main === module) main();
