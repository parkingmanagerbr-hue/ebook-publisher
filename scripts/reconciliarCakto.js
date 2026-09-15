'use strict';
/**
 * reconciliarCakto.js — liga cada e-book ao checkout Cakto que e DELE.
 *
 * Medido em 15/09/2026: 8490 e-books com link Cakto, mas so 6734 links
 * distintos — 2353 livros dividiam 597 checkouts (um checkout com 114 livros).
 * Quem clicava no livro X pagava pelo livro Y. A causa e o fallback de
 * publisherCakto.getCaktoPayUrlFromApi, que aceitava qualquer oferta cujo nome
 * contivesse as palavras do titulo, olhando so as 200 mais recentes.
 *
 * Regra: o link so vale se o NOME da oferta for o titulo do livro (normalizado).
 * - titulo com oferta propria -> grava o link dela;
 * - sem oferta com esse nome -> apaga o link, e o backlog republica o livro;
 * - varias ofertas com o mesmo nome (produto duplicado na Cakto) -> a mais antiga
 *   fica com o livro; as outras sao listadas no relatorio, sem apagar nada la.
 *
 * Uso (dentro do container):
 *   node scripts/reconciliarCakto.js            # so relatorio
 *   node scripts/reconciliarCakto.js --aplicar  # grava no banco
 */
const fs = require('fs');

// Mesma normalizacao dos dois lados: caixa, acento, espaco e pontuacao solta
// nao podem fazer um titulo igual parecer diferente.
function normalizarTitulo(t) {
  return String(t || '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―‑]/g, '-')
    // NFC de volta: o NFD separa o dakuten do japones (プ -> フ + ゚) e a marca
    // precisa continuar grudada na letra.
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

/**
 * Decide o link de cada e-book a partir da lista de ofertas.
 * Pura: recebe dados, devolve decisoes — o I/O fica em main().
 */
function reconciliar(ebooks, ofertas) {
  const porNome = new Map();
  // A API lista da mais nova para a mais antiga; inverter faz a mais antiga
  // chegar primeiro e ficar como a oficial do titulo.
  for (const o of [...ofertas].reverse()) {
    const k = normalizarTitulo(o.name);
    if (!k) continue;
    if (!porNome.has(k)) porNome.set(k, []);
    porNome.get(k).push(o);
  }

  const mudancas = [];
  const resumo = { ok: 0, corrigidos: 0, semOferta: 0, duplicadasNaCakto: 0 };
  const usados = new Set();
  for (const e of ebooks) {
    const lista = porNome.get(normalizarTitulo(e.title)) || [];
    // Oferta ainda nao entregue a outro livro de mesmo titulo.
    const oferta = lista.find(o => !usados.has(o.id));
    if (!oferta) {
      resumo.semOferta++;
      if (e.cakto_product_id) mudancas.push({ id: e.id, de: e.cakto_product_id, para: null });
      continue;
    }
    usados.add(oferta.id);
    if (oferta.id === e.cakto_product_id) { resumo.ok++; continue; }
    resumo.corrigidos++;
    mudancas.push({ id: e.id, de: e.cakto_product_id, para: oferta.id });
  }
  for (const l of porNome.values()) if (l.length > 1) resumo.duplicadasNaCakto += l.length - 1;
  return { mudancas, resumo };
}

async function baixarOfertas(cookie) {
  const H = {
    cookie, accept: 'application/json', referer: 'https://app.cakto.com.br/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
  };
  const todas = [];
  for (let pagina = 1; pagina < 200; pagina++) {
    const r = await fetch('https://api.cakto.com.br/api/offers/?limit=200&page=' + pagina, { headers: H });
    if (r.status === 404) break;
    if (!r.ok) throw new Error('offers pagina ' + pagina + ': HTTP ' + r.status);
    const j = await r.json();
    todas.push(...(j.results || []).map(o => ({ id: o.id, name: o.name, product: o.product, status: o.status })));
    if (!j.next) break;
  }
  return todas;
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const sessao = JSON.parse(fs.readFileSync(process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json', 'utf8'));
  const cookie = sessao.cookies.map(c => c.name + '=' + c.value).join('; ');
  const ofertas = await baixarOfertas(cookie);
  console.log('ofertas na Cakto:', ofertas.length);

  const db = require('../src/core/database').getDb();
  const ebooks = db.prepare('SELECT id, title, cakto_product_id FROM ebooks ORDER BY rowid ASC').all();
  const { mudancas, resumo } = reconciliar(ebooks, ofertas);
  console.log(JSON.stringify(resumo));
  console.log('mudancas:', mudancas.length, '| amostra:', JSON.stringify(mudancas.slice(0, 5)));

  if (!aplicar) { console.log('(relatorio apenas — rode com --aplicar para gravar)'); return; }
  const up = db.prepare('UPDATE ebooks SET cakto_product_id = ?, cakto_url = ? WHERE id = ?');
  db.transaction(() => {
    for (const m of mudancas) up.run(m.para, m.para ? 'https://pay.cakto.com.br/' + m.para : null, m.id);
  })();
  console.log('gravado:', mudancas.length);
}

module.exports = { normalizarTitulo, reconciliar };

if (require.main === module) {
  main().catch(e => { console.error('ERRO', e.message); process.exit(1); });
}
