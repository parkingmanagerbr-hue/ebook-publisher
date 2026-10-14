'use strict';
/**
 * caktoCheckoutDoCatalogo.js — grava `cakto_checkout` (link publico de compra)
 * para os livros cujo produto esta ATIVO na Cakto, e limpa dos que nao estao.
 *
 * A vitrine nao mostrava a Cakto em livro nenhum: ela exigia o formato antigo
 * `<oferta>_<checkout>`, e os produtos criados pela API guardam so o shortcode
 * da oferta — que E o checkout publico, desde que o produto esteja ativo
 * (pausado mostra "Produto nao encontrado"). A decisao esta em
 * src/agents/caktoCheckout.js; aqui so se le a API e se grava.
 *
 * So LEITURA na Cakto (GET), com ritmo de 3 s entre chamadas. Lista que nao
 * chega inteira nao grava nada.
 *
 * Uso (no container, cron diario antes da vitrine):
 *   node scripts/caktoCheckoutDoCatalogo.js [--dry-run]
 */
const fs = require('fs');
const { lerPaginado, listaCompleta, planejar } = require('../src/agents/caktoCheckout');

let log;
try { log = require('../src/core/logger').createLogger('caktoCheckout'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const PAUSA_MS = Math.max(3000, parseInt(process.env.CAKTO_PAUSA_MS || '3000', 10));
const dormir = ms => new Promise(r => setTimeout(r, ms));

function cabecalhos() {
  const s = JSON.parse(fs.readFileSync(process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json', 'utf8'));
  return {
    cookie: s.cookies.map(c => c.name + '=' + c.value).join('; '), accept: 'application/json', referer: 'https://app.cakto.com.br/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
  };
}

function pedidor(H) {
  return async rota => {
    const r = await fetch('https://api.cakto.com.br/api/' + rota, { headers: H });
    const t = await r.text();
    // 429 volta em HTML do Cloudflare: devolve o status para a leitura esperar e
    // repetir. Outro HTML e sessao expirada ou bloqueio — lanca.
    if (t.startsWith('<')) {
      if (r.status === 429) return { status: 429, json: null };
      throw new Error('CAKTO_HTML: HTTP ' + r.status + ' em ' + rota + ' — Cloudflare ou sessao expirada');
    }
    let json = null; try { json = JSON.parse(t); } catch (_) { /* protocolo: corpo nao JSON vira status sem lista */ }
    return { status: r.status, json };
  };
}

function prepararBanco(db) {
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  if (!cols.includes('cakto_checkout')) db.prepare('ALTER TABLE ebooks ADD COLUMN cakto_checkout TEXT').run();
}

async function principal({ seco = process.argv.includes('--dry-run'), db, pedir, esperar } = {}) {
  db = db || require('../src/core/database').getDb();
  prepararBanco(db);
  pedir = pedir || pedidor(cabecalhos());
  // nivel 0: o ritmo normal; nivel n (depois de um 429): 30 s, 60 s, 90 s, 120 s.
  esperar = esperar || (nivel => dormir(nivel ? 30000 * nivel : PAUSA_MS));
  const t0 = Date.now();
  const produtos = await lerPaginado('products/', { pedir, esperar, porPagina: 100 });
  log.info('produtos lidos: ' + produtos.itens.length + ' de ' + produtos.total);
  await esperar(0);
  const ofertas = await lerPaginado('offers/', { pedir, esperar, porPagina: 200 });
  log.info('ofertas lidas: ' + ofertas.itens.length + ' de ' + ofertas.total);
  if (!listaCompleta(produtos) || !listaCompleta(ofertas)) {
    log.error('lista incompleta (produtos ' + produtos.itens.length + '/' + produtos.total + ', ofertas ' + ofertas.itens.length + '/' + ofertas.total + ') — nada gravado');
    return { gravado: false, motivo: 'lista-incompleta' };
  }
  const livros = db.prepare("SELECT id, cakto_product_id, cakto_checkout FROM ebooks WHERE cakto_product_id IS NOT NULL AND cakto_product_id <> ''").all();
  const { mudancas, resumo } = planejar(livros, ofertas.itens, produtos.itens);
  const st = {}; for (const p of produtos.itens) st[p.status] = (st[p.status] || 0) + 1;
  resumo.produtosPorStatus = st;
  resumo.segundos = Math.round((Date.now() - t0) / 1000);
  if (!seco) {
    const up = db.prepare('UPDATE ebooks SET cakto_checkout = ? WHERE id = ?');
    db.transaction(() => { for (const m of mudancas) up.run(m.para, m.id); })();
  }
  log.info('checkout da Cakto' + (seco ? ' (dry-run)' : '') + ': ' + JSON.stringify(resumo));
  return { gravado: !seco, ...resumo };
}

if (require.main === module) {
  principal()
    .then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + String(e && e.message).replace(/[\r\n]+/g, ' ').slice(0, 200)); console.error('ERRO: ' + String(e && e.message).slice(0, 200)); process.exit(1); });
}

module.exports = { principal, prepararBanco };
