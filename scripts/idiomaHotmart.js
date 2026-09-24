'use strict';
/**
 * idiomaHotmart.js — confere e corrige o idioma dos produtos na Hotmart.
 *
 * Por que (24/09/2026): o unico produto NOT_APPROVED da conta era um livro em
 * japones com `contentLocale: PT_BR`. O idioma so e gravado no MESMO PUT da
 * capa (`capas_em_lote.js`), entao produto que ja subiu com capa nunca era
 * corrigido — numa amostra de 8 estrangeiros, 1 estava errado.
 *
 * Roda do servidor, com o token: nao precisa de navegador.
 *
 * Uso (no container): node scripts/idiomaHotmart.js --limite=30
 *                     node scripts/idiomaHotmart.js --limite=30 --dry-run
 */
const fs = require('fs');
const { localeHotmart, precisaCorrigirIdioma, prioridade, resumoIdioma } = require('../src/agents/idiomaHotmart');

let log;
try { log = require('../src/core/logger').createLogger('idiomaHotmart'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const API = 'https://api-product.vulcano.hotmart.com/product/v1/product/';
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const dormir = ms => new Promise(r => setTimeout(r, ms));
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

function cabecalhos() {
  const token = fs.readFileSync(process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt', 'utf8').trim();
  return { authorization: 'Bearer ' + token, 'x-app-name': 'app-product', 'content-type': 'application/json' };
}

async function main() {
  const limite = parseInt(arg('limite', '20'), 10);
  const seco = process.argv.includes('--dry-run');
  const H = cabecalhos();
  const db = require('../src/core/database').getDb();

  const { baixarCatalogo } = require('../src/agents/hotmartCatalogo');
  const catalogo = await baixarCatalogo(H.authorization.replace('Bearer ', ''));
  const porId = new Map(catalogo.map(p => [String(p.id), p]));

  const livros = db.prepare(
    "SELECT id, title, language, hotmart_product_id FROM ebooks " +
    "WHERE hotmart_product_id IS NOT NULL AND hotmart_product_id <> '' AND language IS NOT NULL AND language <> ''"
  ).all();

  // Recusado e pendente primeiro; depois estrangeiro.
  const fila = livros
    .map(l => ({ ...l, status: (porId.get(String(l.hotmart_product_id)) || {}).status || '?' }))
    .filter(l => porId.has(String(l.hotmart_product_id)))
    .sort((a, b) => prioridade(b) - prioridade(a));

  log.info('conferindo idioma de ' + fila.length + ' produtos (ate ' + limite + ' correcoes)' + (seco ? ' — dry-run' : ''));
  let conferidos = 0, corrigidos = 0, falhas = 0;

  for (const l of fila) {
    if (corrigidos >= limite) break;
    const alvo = localeHotmart(l.language);
    if (!alvo) continue;
    try {
      const base = API + l.hotmart_product_id + '/basic-information';
      const atual = await (await fetch(base, { headers: H })).json();
      conferidos++;
      if (!precisaCorrigirIdioma(l.language, atual.contentLocale)) { await dormir(400); continue; }
      if (seco) {
        log.info('[dry-run] ' + resumoIdioma(l.hotmart_product_id, atual.contentLocale, alvo, l.title));
        corrigidos++;
        await dormir(400);
        continue;
      }
      // PUT com o objeto que a propria API acabou de devolver, trocando so o
      // idioma: a capa atual precisa ir junto, senao ela se perde.
      const corpo = {
        name: atual.name,
        contentLocale: alvo,
        targetCountry: atual.targetCountry,
        ucode: atual.ucode,
        categoryId: atual.categoryId,
        subcategoryId: atual.subcategoryId,
        description: atual.description,
        coverPhoto: atual.coverPhoto,
      };
      const r = await fetch(base, { method: 'PUT', headers: H, body: JSON.stringify(corpo) });
      await dormir(1200);
      // Confirmar pelo EFEITO: ja houve 200 que nao gravava (capas_em_lote.js).
      const depois = await (await fetch(base, { headers: H })).json();
      if (String(depois.contentLocale).toUpperCase() === alvo) {
        corrigidos++;
        log.info(resumoIdioma(l.hotmart_product_id, atual.contentLocale, alvo, l.title));
      } else {
        falhas++;
        log.warn('nao gravou: ' + umaLinha(l.hotmart_product_id, 20) + ' status=' + r.status + ' ficou=' + umaLinha(depois.contentLocale, 10));
      }
      await dormir(800);
    } catch (e) {
      falhas++;
      log.error('FALHA ' + umaLinha(l.hotmart_product_id, 20) + ': ' + umaLinha(e && e.message, 120));
      await dormir(1500);
    }
  }
  return { conferidos, corrigidos, falhas };
}

if (require.main === module) {
  main()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); console.error('ERRO: ' + e.message); process.exit(1); });
}

module.exports = { main };
