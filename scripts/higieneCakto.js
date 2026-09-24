'use strict';
/**
 * higieneCakto.js — passa em TODOS os produtos da Cakto (inclusive os pausados)
 * e corrige o que nao depende do PDF: nome do vendedor, pagina de vendas,
 * afiliacao e capa.
 *
 * Por que (auditoria de 23/09/2026, 8.000 produtos): o checkout mostrava
 * "Termos de uso de <e-mail pessoal>" em todos, 5.768 estavam sem imagem e
 * nenhum tinha afiliacao. O job de entrega so cuidava de quem ja tinha PDF —
 * dois tercos do catalogo nunca foram tocados.
 *
 * Nao mexe em `status`: produto sem arquivo continua pausado (quem reativa e o
 * entregaCakto, quando o PDF volta).
 *
 * Uso (no container): node scripts/higieneCakto.js --limite=200
 */
const fs = require('fs');
const path = require('path');
const { alvoHigiene, precisaSubirCapa, resumoDaCorrecao, ehErroDaLoja } = require('../src/agents/higieneCakto');

let log;
try { log = require('../src/core/logger').createLogger('higieneCakto'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const API = 'https://api.cakto.com.br/api/';
const PAUSA_MS = Number(process.env.CAKTO_PAUSA_MS || 3000);
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const dormir = ms => new Promise(r => setTimeout(r, ms));
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** Cookies + CSRF, como o painel faz (mesma receita do entregaCakto). */
async function cabecalhos() {
  const s = JSON.parse(fs.readFileSync(process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json', 'utf8'));
  const base = {
    accept: 'application/json', 'content-type': 'application/json',
    referer: 'https://app.cakto.com.br/', origin: 'https://app.cakto.com.br',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
  };
  let cookies = s.cookies.map(c => c.name + '=' + c.value);
  const r = await fetch(API + 'get-csrf-token/', { headers: { ...base, cookie: cookies.join('; ') } });
  const novos = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]);
  const nomes = new Set(novos.map(c => c.split('=')[0]));
  cookies = cookies.filter(c => !nomes.has(c.split('=')[0])).concat(novos);
  let token = null;
  try { token = (await r.json()).csrfToken; } catch { /* sem corpo */ }
  if (!token) throw new Error('get-csrf-token nao devolveu token (HTTP ' + r.status + ')');
  return { ...base, cookie: cookies.join('; '), 'x-csrftoken': token };
}

async function api(metodo, rota, corpo, H) {
  const r = await fetch(API + rota, { method: metodo, headers: H, body: corpo ? JSON.stringify(corpo) : undefined });
  const t = await r.text();
  if (t.startsWith('<')) { const e = new Error('Cakto devolveu HTML (HTTP ' + r.status + ')'); e.cloudflare = true; throw e; }
  if (!r.ok) { const e = new Error(metodo + ' ' + rota + ': HTTP ' + r.status + ' ' + t.slice(0, 160)); e.status = r.status; throw e; }
  try { return JSON.parse(t); } catch { return t; }
}

/**
 * Envia a capa. Rota propria, multipart, campo `image` — a mesma achada no
 * bundle do painel e ja usada pelo job de entrega. Em `product/{id}/` direto a
 * API responde `405 Metodo "PATCH" nao e permitido`.
 */
async function enviarCapa(produtoId, caminho, H) {
  const dados = new FormData();
  dados.append('image', new Blob([fs.readFileSync(caminho)], { type: 'image/jpeg' }), path.basename(caminho) || 'capa.jpg');
  const { 'content-type': _tipo, ...semTipo } = H; // o fetch poe o boundary
  const r = await fetch(API + 'product/' + produtoId + '/image/', { method: 'PUT', headers: semTipo, body: dados });
  if (!r.ok) throw new Error('capa: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return true;
}

async function main() {
  const limite = parseInt(arg('limite', '50'), 10);
  const seco = process.argv.includes('--dry-run');
  const db = require('../src/core/database').getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS cakto_higiene (ebook_id TEXT PRIMARY KEY, resultado TEXT, quando INTEGER)').run();

  const feitos = new Set(db.prepare("SELECT ebook_id FROM cakto_higiene WHERE resultado IN ('ok','nada')").all().map(r => r.ebook_id));
  const livros = db.prepare(
    "SELECT id, title, cover_path, cakto_product_id FROM ebooks " +
    "WHERE cakto_product_id IS NOT NULL AND cakto_product_id <> '' ORDER BY rowid DESC"
  ).all().filter(e => !feitos.has(e.id)).slice(0, limite);

  if (!livros.length) { log.info('nada pendente'); return { fila: 0, corrigidos: 0, semMudanca: 0, falhas: 0 }; }
  log.info('higiene do catalogo Cakto: ' + livros.length + ' produtos nesta rodada' + (seco ? ' (dry-run)' : ''));

  const H = await cabecalhos();
  const marca = db.prepare('INSERT OR REPLACE INTO cakto_higiene (ebook_id, resultado, quando) VALUES (?,?,?)');
  let corrigidos = 0, semMudanca = 0, falhas = 0, foraDoAr = false;

  for (const e of livros) {
    try {
      const oferta = await api('GET', 'offers/' + e.cakto_product_id + '/', null, H);
      await dormir(PAUSA_MS);
      const produto = await api('GET', 'product/' + oferta.product + '/', null, H);
      await dormir(PAUSA_MS);

      const checkout = 'https://pay.cakto.com.br/' + e.cakto_product_id;
      const mudancas = alvoHigiene(produto, { checkout });
      const capaEmDisco = !!(e.cover_path && fs.existsSync(e.cover_path));
      const subirCapa = precisaSubirCapa(produto, capaEmDisco);

      if (!Object.keys(mudancas).length && !subirCapa) {
        semMudanca++;
        marca.run(e.id, 'nada', Date.now());
        continue;
      }
      if (seco) { log.info('[dry-run] ' + resumoDaCorrecao(e.cakto_product_id, mudancas, subirCapa)); continue; }

      if (Object.keys(mudancas).length) {
        // A rota nao aceita PATCH em JSON (405): PUT com o produto inteiro.
        await api('PUT', 'product/' + oferta.product + '/', { ...produto, ...mudancas }, H);
        await dormir(PAUSA_MS);
      }
      if (subirCapa) { await enviarCapa(oferta.product, e.cover_path, H); await dormir(PAUSA_MS); }

      corrigidos++;
      marca.run(e.id, 'ok', Date.now());
      log.info(resumoDaCorrecao(e.cakto_product_id, mudancas, subirCapa) + ' | "' + umaLinha(e.title, 50) + '"');
    } catch (err) {
      falhas++;
      const msg = umaLinha(err && err.message, 160);
      log.error('FALHA ' + umaLinha(e.cakto_product_id, 20) + ': ' + msg);
      if (err && err.cloudflare) { log.warn('Cloudflare barrou — parando esta rodada'); break; }
      // 500 da loja: nao adianta seguir nem voltar daqui a 20 min martelando.
      if (ehErroDaLoja(err && err.status, msg)) {
        log.warn('a Cakto esta respondendo erro de servidor — parando a rodada (tenta na proxima)');
        foraDoAr = true;
        break;
      }
      await dormir(PAUSA_MS);
    }
  }
  return { fila: livros.length, corrigidos, semMudanca, falhas, foraDoAr };
}

if (require.main === module) {
  main()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); console.error('ERRO: ' + e.message); process.exit(1); });
}

module.exports = { main, cabecalhos, api };
