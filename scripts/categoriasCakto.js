'use strict';
/**
 * categoriasCakto.js — da categoria aos produtos da Cakto que estao sem.
 *
 * 06/10/2026: 205 dos 13.444 produtos vivos estavam sem categoria (o
 * publicador nunca escolhe; fica o que a Cakto puser). A categoria sai da mesma
 * regra da Kiwify (kiwifyRegras.categoriaKiwify), pelo NOME: as duas lojas usam
 * os mesmos nomes, e o id da Cakto vem dos produtos que ja tem aquela categoria.
 *
 * PUT parcial (so `category`): a Cakto faz merge — medido em 28/09/2026 no
 * higieneCakto. Confere pela API depois. Uma chamada a cada 3 s (Cloudflare).
 *
 * Uso (no container):
 *   node scripts/categoriasCakto.js                 # relatorio
 *   node scripts/categoriasCakto.js --aplicar --limite=1
 */
const { cabecalhos, API } = require('../src/agents/publisherCaktoApi');
const { categoriaKiwify, NOMES_CATEGORIA, CATEGORIAS } = require('../src/agents/kiwifyRegras');

let log;
try { log = require('../src/core/logger').createLogger('categoriasCakto'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const PAUSA_MS = parseInt(process.env.CAKTO_PAUSA_MS || '3000', 10);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const chave = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** Id da categoria da Cakto pelo nome, lido dos proprios produtos. Pura. */
function idsPorNome(produtos) {
  const m = new Map();
  for (const p of produtos) if (p && p.category && p.category.id && p.category.name) m.set(chave(p.category.name), p.category.id);
  return m;
}

/**
 * Categoria (id da Cakto) para um produto sem categoria, ou null. Usa o tema do
 * livro quando o nome do produto liga a um livro unico; senao, so o nome.
 * "Outros" nao existe na Cakto: fica sem. Pura.
 */
function categoriaDoProduto(produto, livro, ids) {
  const k = categoriaKiwify(livro ? livro.title : produto.name, livro ? livro.topic : '');
  if (k === CATEGORIAS.outros) return null;
  return ids.get(chave(NOMES_CATEGORIA[k])) || null;
}

/** Livro (titulo e tema) pelo nome do produto, so quando o nome e unico. */
function livrosPorNome(db) {
  const mapa = new Map();
  const linhas = db.prepare("SELECT title, topic, cakto_nome FROM ebooks WHERE COALESCE(cakto_product_id,'') <> ''").all();
  for (const e of linhas) { const k = chave(e.cakto_nome || e.title); mapa.set(k, mapa.has(k) ? null : e); }
  return mapa;
}

async function lerJson(rota, H, opcoes = {}) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(API + rota, { headers: H, ...opcoes });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (_) { /* tenta de novo */ }
    await dormir(2000 * (t + 1));
  }
  throw new Error('Cakto nao respondeu: ' + rota);
}

async function principal() {
  const aplicar = process.argv.includes('--aplicar');
  const limite = Number(arg('limite', '1000')) || 1000;
  const H = await cabecalhos();
  const primeira = await lerJson('products/?page=1&limit=100', H);
  const paginas = Math.ceil(primeira.count / 100);
  const todos = [...primeira.results];
  // Uma pagina por vez: 5 em paralelo, duas listagens seguidas, acionaram o
  // desafio do Cloudflare e o PUT seguinte voltou 429 (06/10/2026).
  for (let p = 2; p <= paginas; p++) {
    const l = await lerJson('products/?page=' + p + '&limit=100', H);
    todos.push(...((l && l.results) || []));
    await dormir(1000);
  }
  const ids = idsPorNome(todos);
  const sem = todos.filter(p => p.status !== 'deleted' && !p.category);
  const db = require('../src/core/database').getDb();
  const porNome = livrosPorNome(db);
  const resumo = { produtos: todos.length, semCategoria: sem.length, aplicados: 0, semRegra: 0, falhas: 0 };
  log.info('produtos ' + todos.length + ', sem categoria ' + sem.length + ', categorias conhecidas ' + ids.size + (aplicar ? '' : ' (relatorio)'));

  for (const p of sem.slice(0, limite)) {
    const livro = porNome.get(chave(p.name)) || null;
    const cat = categoriaDoProduto(p, livro, ids);
    if (!cat) { resumo.semRegra++; log.warn('sem categoria pela regra: ' + umaLinha(p.name, 60)); continue; }
    if (!aplicar) continue;
    try {
      const H2 = { ...H, 'content-type': 'application/json' };
      const r = await fetch(API + 'product/' + p.id + '/', { method: 'PUT', headers: H2, body: JSON.stringify({ category: cat }) });
      if (!r.ok) throw new Error('PUT ' + r.status + ' ' + umaLinha(await r.text(), 120));
      await dormir(PAUSA_MS);
      const depois = await lerJson('product/' + p.id + '/', H);
      const gravada = depois && depois.category && (depois.category.id || depois.category);
      if (gravada === cat) { resumo.aplicados++; log.info('categoria ok: ' + umaLinha(p.name, 50) + ' -> ' + umaLinha(depois.category.name || cat, 40)); }
      else { resumo.falhas++; log.warn('PUT aceito mas a categoria nao ficou: ' + umaLinha(p.name, 50)); }
      await dormir(PAUSA_MS);
    } catch (e) {
      resumo.falhas++;
      log.error('falha ' + umaLinha(p.name, 50) + ': ' + umaLinha(e.message, 160));
      if (/html|cloudflare|just a moment|\b(403|429)\b/i.test(e.message)) break; // a borda barrou: para a rodada
    }
  }
  log.info('resumo: ' + JSON.stringify(resumo));
  console.log(JSON.stringify(resumo));
  return resumo;
}

module.exports = { principal, idsPorNome, categoriaDoProduto };

if (require.main === module) principal().catch(e => { log.error('ERRO ' + umaLinha(e.message, 200)); process.exit(1); });
