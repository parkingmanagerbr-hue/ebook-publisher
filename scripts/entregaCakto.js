'use strict';
/**
 * entregaCakto.js — preenche o link de entrega dos produtos Cakto.
 *
 * Os produtos foram criados com entrega "link externo" e o campo
 * emailAccessLink vazio: quem comprasse nao recebia nada (15/09/2026). Para cada
 * livro com checkout Cakto E PDF em disco, grava no produto o link assinado de
 * /entrega/:token (src/core/entrega.js).
 *
 * Livro sem PDF nao recebe link — nao ha o que entregar; ver --sem-pdf.
 *
 * Ritmo: uma chamada a cada 3 s. Rajada na API da Cakto aciona o desafio do
 * Cloudflare e derruba a sessao salva (aconteceu na auditoria).
 *
 * Uso (dentro do container):
 *   node scripts/entregaCakto.js --limite=1            # testa em 1 produto
 *   node scripts/entregaCakto.js --limite=5000
 *   node scripts/entregaCakto.js --sem-pdf             # so conta/lista quem nao tem PDF
 */
const fs = require('fs');
const { urlEntrega } = require('../src/core/entrega');

const PAUSA_MS = parseInt(process.env.CAKTO_PAUSA_MS || '3000', 10);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

/**
 * Cabecalhos de escrita. A sessao salva nao tem cookie de CSRF e a escrita dava
 * 403 "CSRF cookie not set". O painel pede o token em /get-csrf-token/ (visto no
 * bundle) — que devolve o valor e grava o cookie; aqui se faz o mesmo.
 */
async function cabecalhos() {
  const s = JSON.parse(fs.readFileSync(process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json', 'utf8'));
  const base = {
    accept: 'application/json', 'content-type': 'application/json', referer: 'https://app.cakto.com.br/',
    origin: 'https://app.cakto.com.br',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
  };
  let cookies = s.cookies.map(c => c.name + '=' + c.value);
  const r = await fetch('https://api.cakto.com.br/api/get-csrf-token/', { headers: { ...base, cookie: cookies.join('; ') } });
  const novos = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]);
  const nomesNovos = new Set(novos.map(c => c.split('=')[0]));
  cookies = cookies.filter(c => !nomesNovos.has(c.split('=')[0])).concat(novos);
  let token = null;
  try { token = (await r.json()).csrfToken; } catch { /* sem corpo */ }
  if (!token) throw new Error('get-csrf-token nao devolveu token (HTTP ' + r.status + ')');
  return { ...base, cookie: cookies.join('; '), 'x-csrftoken': token };
}

async function api(metodo, rota, corpo, H) {
  const r = await fetch('https://api.cakto.com.br/api/' + rota, { method: metodo, headers: H, body: corpo ? JSON.stringify(corpo) : undefined });
  const t = await r.text();
  if (t.startsWith('<')) {
    const e = new Error('Cakto devolveu HTML (HTTP ' + r.status + ') — Cloudflare ou sessao expirada');
    e.cloudflare = true; throw e;
  }
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { const e = new Error(metodo + ' ' + rota + ': HTTP ' + r.status + ' ' + String(t).slice(0, 200)); e.status = r.status; throw e; }
  return j;
}

// Nome do vendedor no checkout. Vazio, a Cakto mostrava o E-MAIL da conta
// ("Termos de uso de ...@hotmail.com") — comprador desconfia. E o nome que ja
// esta impresso nas capas.
const PRODUTOR = process.env.CAKTO_PRODUCER_NAME || 'Veloxis Editorial';

/** O que o produto deve ter depois da correcao. Pura. */
function alvo(produto, linkEsperado) {
  const atual = produto.emailAccessLink || '';
  const out = {};
  // Link de terceiro nunca e sobrescrito: alguem configurou a entrega a mao.
  if (atual !== linkEsperado && (!atual || atual.includes('/entrega/'))) out.emailAccessLink = linkEsperado;
  if (!produto.producerName) out.producerName = PRODUTOR;
  return out;
}

/** Decide o que fazer com um produto. Pura. */
function planejar(produto, linkEsperado) {
  if (Object.keys(alvo(produto, linkEsperado)).length) return 'gravar';
  const atual = produto.emailAccessLink || '';
  return atual && atual !== linkEsperado ? 'link-alheio' : 'ok';
}

async function main() {
  const { getDb } = require('../src/core/database');
  const db = getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS cakto_entrega (ebook_id TEXT PRIMARY KEY, produto TEXT, resultado TEXT, quando INTEGER)').run();

  const livros = db.prepare("SELECT id, title, pdf_path, cakto_product_id FROM ebooks WHERE cakto_product_id IS NOT NULL AND cakto_product_id <> '' ORDER BY rowid DESC").all();
  const comPdf = livros.filter(e => e.pdf_path && fs.existsSync(e.pdf_path));
  if (process.argv.includes('--sem-pdf')) {
    console.log(JSON.stringify({ comCheckout: livros.length, comPdf: comPdf.length, semPdf: livros.length - comPdf.length }));
    return;
  }

  const limite = parseInt(arg('limite', '1'), 10);
  const feitos = new Set(db.prepare("SELECT ebook_id FROM cakto_entrega WHERE resultado IN ('gravado-v2','ok-v2')").all().map(r => r.ebook_id));
  const fila = comPdf.filter(e => !feitos.has(e.id)).slice(0, limite);
  const H = await cabecalhos();
  const marca = db.prepare('INSERT OR REPLACE INTO cakto_entrega (ebook_id, produto, resultado, quando) VALUES (?,?,?,?)');
  const cont = {};

  // Oferta (shortcode do checkout) -> produto. O detalhe da oferta traz o produto.
  for (const e of fila) {
    try {
      const oferta = await api('GET', 'offers/' + e.cakto_product_id + '/', null, H); await dormir(PAUSA_MS);
      const produtoId = oferta.product;
      const produto = await api('GET', 'product/' + produtoId + '/', null, H); await dormir(PAUSA_MS);
      const link = urlEntrega(e.id);
      const mudar = alvo(produto, link);
      const decisao = planejar(produto, link);
      if (decisao === 'gravar') {
        // A rota nao aceita PATCH (405): PUT com o produto inteiro que acabou de
        // ser lido, trocando so o link. A conferencia abaixo pega o caso de a
        // API ignorar o campo ou mexer em outro.
        await api('PUT', 'product/' + produtoId + '/', { ...produto, ...mudar }, H); await dormir(PAUSA_MS);
        const conferido = await api('GET', 'product/' + produtoId + '/', null, H); await dormir(PAUSA_MS);
        const mexeuEmOutro = camposAlterados(produto, conferido).filter(k => !['updatedAt', ...Object.keys(mudar)].includes(k));
        if (mexeuEmOutro.length) console.log('ATENCAO', produtoId, 'campos mudaram alem do link:', mexeuEmOutro.join(','));
        const persistiu = Object.entries(mudar).every(([k, v]) => conferido[k] === v);
        const res = !persistiu ? 'nao-persistiu' : (mexeuEmOutro.length ? 'gravado-com-efeito' : 'gravado-v2');
        marca.run(e.id, produtoId, res, Date.now()); cont[res] = (cont[res] || 0) + 1;
      } else {
        marca.run(e.id, produtoId, decisao === 'ok' ? 'ok-v2' : decisao, Date.now()); cont[decisao] = (cont[decisao] || 0) + 1;
      }
    } catch (err) {
      cont.erro = (cont.erro || 0) + 1;
      marca.run(e.id, null, 'erro: ' + String(err.message).slice(0, 120), Date.now());
      console.log('ERRO', e.cakto_product_id, err.message.slice(0, 160));
      if (err.cloudflare) { console.log('parando: Cloudflare/sessao'); break; }
      await dormir(PAUSA_MS * 3);
    }
  }
  console.log(JSON.stringify({ fila: fila.length, ...cont }));
}

/** Campos de primeiro nivel cujo valor mudou entre duas leituras. Pura. */
function camposAlterados(antes, depois) {
  const chaves = new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})]);
  return [...chaves].filter(k => JSON.stringify((antes || {})[k]) !== JSON.stringify((depois || {})[k]));
}

module.exports = { planejar, alvo, camposAlterados, PRODUTOR };

if (require.main === module) main().catch(e => { console.error('ERRO', e.message); process.exit(1); });
