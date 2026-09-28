'use strict';
/**
 * vitrineCompleta.js — uma pagina publica para CADA livro do catalogo.
 *
 * A vitrine antiga (vitrineLivros.js) publicava so os ~20 livros marcados como
 * destaque: em 28/09/2026 eram 23 paginas para 13.700 produtos. Sem pagina
 * publica, o produto so existe para quem ja esta dentro do marketplace, e o
 * afiliado nao tem o que divulgar.
 *
 * O que muda em relacao a antiga:
 *   - le o catalogo do BANCO (nada de uma chamada de API por livro, que nao
 *     escala para milhares);
 *   - o link de compra sai de `vitrineRegras.linkDeCompra` — checkout da Cakto
 *     quando esta completo, senao a pagina do produto na Hotmart. Link da Cakto
 *     pela metade NAO vai para o ar: devolve 404 ao visitante;
 *   - indice paginado e por idioma (uma pagina com milhares de itens nao se
 *     navega);
 *   - sitemaps de 10.000 URLs, dentro do limite do protocolo.
 *
 * Conteudo publico segue o playbook: so titulo, descricao do proprio livro,
 * preco e o link oficial. Nada de avaliacao, contagem de vendas ou "mais
 * vendido".
 *
 * Uso (no container):
 *   node scripts/vitrineCompleta.js --dry-run
 *   node scripts/vitrineCompleta.js --limite=200
 *   node scripts/vitrineCompleta.js
 */
const fs = require('fs');
const path = require('path');
const { linkDeCompra, elegivelParaVitrine, slugDoLivro, paginasDoIndice, lotesDeSitemap, porIdioma, umaLinha } = require('../src/agents/vitrineRegras');

let log;
try { log = require('../src/core/logger').createLogger('vitrineCompleta'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const SITE = process.env.SITE_ROOT || '/app/landing_pages';
const RAIZ_URL = 'https://veloxisit.com.br';
const BASE = '/livros';
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const temFlag = n => process.argv.includes('--' + n);

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const precoBR = v => 'R$ ' + Number(v || 5).toFixed(2).replace('.', ',');

const IDIOMAS = { pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', ja: '日本語', nl: 'Nederlands', pl: 'Polski', zh: '中文' };

const ESTILO = `<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed}
a{color:#7cc4ff}
.capa{max-width:1080px;margin:0 auto;padding:24px 16px}
header h1{font-size:1.5rem;margin:0 0 4px}
header p{margin:0;color:#aab}
.grade{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));margin:24px 0}
.cartao{background:#171a21;border:1px solid #232733;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px}
.cartao h2{font-size:1rem;margin:0}
.cartao p{margin:0;color:#aab;font-size:.9rem}
.cartao img{width:100%;height:auto;border-radius:6px;background:#232733}
.preco{font-weight:600;color:#9fe3a0}
.botao{display:inline-block;background:#2f7d32;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;text-align:center}
nav.paginas{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0}
nav.paginas a,nav.paginas span{padding:6px 10px;border:1px solid #232733;border-radius:6px}
footer{color:#7c8494;font-size:.85rem;margin-top:32px;border-top:1px solid #232733;padding-top:16px}
article.livro{max-width:760px}
article.livro img{max-width:320px;width:100%;border-radius:8px}
</style>`;

function cabecalho(titulo, descricao, canonica, extra = '') {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
<link rel="canonical" href="${esc(canonica)}">
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(descricao)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(canonica)}">
${extra}${ESTILO}</head><body><div class="capa">`;
}

const rodape = `<footer>Veloxis Editorial · <a href="${BASE}/">todos os livros</a> · <a href="${BASE}/afiliados/">divulgue e ganhe 50%</a> · <a href="/privacy.html">privacidade</a></footer></div></body></html>`;

/** Dados estruturados do produto: o que o buscador entende de verdade. */
function dadosDoProduto(l) {
  const dados = {
    '@context': 'https://schema.org', '@type': 'Book',
    name: umaLinha(l.title, 200), description: umaLinha(l.description, 400),
    inLanguage: umaLinha(l.language || 'pt-BR', 10), bookFormat: 'https://schema.org/EBook',
    author: { '@type': 'Organization', name: 'Veloxis Editorial' },
    offers: { '@type': 'Offer', price: Number(l.price || 5).toFixed(2), priceCurrency: 'BRL', availability: 'https://schema.org/InStock', url: l.link },
  };
  if (l.imagem) dados.image = RAIZ_URL + BASE + '/img/' + l.imagem;
  return '<script type="application/ld+json">' + JSON.stringify(dados) + '</script>';
}

function paginaDoLivro(l, vizinhos) {
  const canonica = RAIZ_URL + BASE + '/' + l.slug + '/';
  const desc = umaLinha(l.description, 160);
  const corpo = String(l.description || '').split(/\n{2,}/).map(p => '<p>' + esc(umaLinha(p, 1200)) + '</p>').join('');
  const relacionados = vizinhos.slice(0, 6)
    .map(o => `<li><a href="${BASE}/${esc(o.slug)}/">${esc(umaLinha(o.title, 70))}</a></li>`).join('');
  return cabecalho(umaLinha(l.title, 70) + ' — e-book em PDF | Veloxis Editorial', desc, canonica, dadosDoProduto(l)) +
    `<article class="livro">
<h1>${esc(umaLinha(l.title, 200))}</h1>
${l.imagem ? `<img src="${BASE}/img/${esc(l.imagem)}" alt="Capa: ${esc(umaLinha(l.title, 100))}" loading="lazy">` : ''}
${corpo}
<p class="preco">${precoBR(l.price)} · entrega imediata em PDF</p>
<p><a class="botao" href="${esc(l.link)}" rel="nofollow noopener">Comprar agora</a></p>
</article>
${relacionados ? '<h2>Outros livros</h2><ul>' + relacionados + '</ul>' : ''}` + rodape;
}

function paginaDoIndice(itens, { numero, total, idioma }) {
  const sufixo = idioma ? '/' + idioma : '';
  const canonica = RAIZ_URL + BASE + sufixo + (numero > 1 ? '/pagina-' + numero + '/' : '/');
  const nome = idioma ? (IDIOMAS[idioma] || idioma) : 'todos os idiomas';
  const cartoes = itens.map(l => `<div class="cartao">
${l.imagem ? `<img src="${BASE}/img/${esc(l.imagem)}" alt="Capa: ${esc(umaLinha(l.title, 100))}" loading="lazy">` : ''}
<h2><a href="${BASE}/${esc(l.slug)}/">${esc(umaLinha(l.title, 90))}</a></h2>
<p>${esc(umaLinha(l.description, 120))}</p>
<span class="preco">${precoBR(l.price)}</span>
</div>`).join('');
  let paginacao = '';
  for (let n = 1; n <= total; n++) {
    const href = BASE + sufixo + (n > 1 ? '/pagina-' + n + '/' : '/');
    paginacao += n === numero ? `<span>${n}</span>` : `<a href="${href}">${n}</a>`;
  }
  return cabecalho(
    'Livros digitais' + (idioma ? ' em ' + nome : '') + (numero > 1 ? ' — página ' + numero : '') + ' | Veloxis Editorial',
    'Catálogo de e-books práticos em PDF, entrega imediata, a partir de R$ 5,00.',
    canonica,
  ) + `<header><h1>Livros digitais${idioma ? ' em ' + esc(nome) : ''}</h1>
<p>${itens.length} títulos nesta página · entrega imediata em PDF</p></header>
<div class="grade">${cartoes}</div>
${total > 1 ? '<nav class="paginas">' + paginacao + '</nav>' : ''}` + rodape;
}

function xmlSitemap(urls, hoje) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => '<url><loc>' + esc(u) + '</loc><lastmod>' + hoje + '</lastmod></url>').join('\n') +
    '\n</urlset>\n';
}

function gravar(arquivo, conteudo) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = arquivo + '.tmp' + process.pid;
  fs.writeFileSync(tmp, conteudo);
  fs.renameSync(tmp, arquivo);
}

function principal() {
  const seco = temFlag('dry-run');
  const limite = Number(arg('limite', '0')) || 0;
  const db = require('../src/core/database').getDb();

  const brutos = db.prepare(
    "SELECT id, title, description, language, price, cover_path, hotmart_product_id, hotmart_url, cakto_product_id, cakto_nome " +
    "FROM ebooks WHERE (hotmart_product_id IS NOT NULL AND hotmart_product_id <> '') " +
    "   OR (cakto_product_id IS NOT NULL AND cakto_product_id <> '')"
  ).all();

  // O link da Cakto so serve completo; o campo salesPage nao esta no banco,
  // entao aqui vale a Hotmart e, quando nao houver, o livro fica de fora.
  const livros = [];
  for (const b of brutos) {
    if (!elegivelParaVitrine(b)) continue;
    const link = linkDeCompra(b);
    const slug = slugDoLivro(b.title, b.id);
    if (!link || !slug) continue;
    livros.push({ ...b, link, slug, imagem: null });
  }
  livros.sort((a, b) => String(a.title).localeCompare(String(b.title), 'pt'));
  const escolhidos = limite ? livros.slice(0, limite) : livros;

  log.info('catalogo: ' + brutos.length + ' publicados | com pagina: ' + escolhidos.length + (seco ? ' (dry-run)' : ''));
  if (seco) {
    for (const l of escolhidos.slice(0, 5)) log.info('  ' + l.slug + ' -> ' + l.link);
    return { paginas: 0, previstas: escolhidos.length };
  }
  if (!escolhidos.length) { log.warn('nenhum livro elegivel — nada publicado'); return { paginas: 0 }; }

  // Capas: aproveita o que ja existe em /livros/img (o passe de capas cuida da
  // geracao); sem imagem a pagina funciona igual.
  const dirImg = path.join(SITE, 'livros', 'img');
  const jaTem = new Set(fs.existsSync(dirImg) ? fs.readdirSync(dirImg) : []);
  for (const l of escolhidos) {
    const nome = l.slug + '.jpg';
    if (jaTem.has(nome)) l.imagem = nome;
  }

  let paginas = 0;
  for (let i = 0; i < escolhidos.length; i++) {
    const l = escolhidos[i];
    const vizinhos = escolhidos.slice(i + 1, i + 7).concat(escolhidos.slice(Math.max(0, i - 6), i)).slice(0, 6);
    gravar(path.join(SITE, 'livros', l.slug, 'index.html'), paginaDoLivro(l, vizinhos));
    paginas++;
  }

  // Indice geral e por idioma.
  const escreverIndice = (lista, idioma) => {
    const partes = paginasDoIndice(lista, 60);
    partes.forEach((itens, k) => {
      const numero = k + 1;
      const destino = idioma
        ? path.join(SITE, 'livros', idioma, numero > 1 ? 'pagina-' + numero : '', 'index.html')
        : path.join(SITE, 'livros', numero > 1 ? 'pagina-' + numero : '', 'index.html');
      gravar(destino, paginaDoIndice(itens, { numero, total: partes.length, idioma }));
      paginas++;
    });
    return partes.length;
  };
  escreverIndice(escolhidos, null);
  for (const [idioma, lista] of porIdioma(escolhidos)) escreverIndice(lista, idioma);

  // Sitemaps.
  const hoje = new Date().toISOString().slice(0, 10);
  const urls = escolhidos.map(l => RAIZ_URL + BASE + '/' + l.slug + '/');
  urls.unshift(RAIZ_URL + BASE + '/');
  const lotes = lotesDeSitemap(urls, 10000);
  const arquivos = [];
  lotes.forEach((lote, k) => {
    const nome = 'sitemap-livros' + (k ? '-' + (k + 1) : '') + '.xml';
    gravar(path.join(SITE, nome), xmlSitemap(lote, hoje));
    arquivos.push(RAIZ_URL + '/' + nome);
  });
  // O indice precisa listar TAMBEM os sitemaps que ja existiam (o do site e o
  // sitemap-extra). Reescrever so com os de livros tira o resto do site do
  // radar dos buscadores — foi o que aconteceu na primeira geracao.
  const ehSitemapAntigo = nome => nome.startsWith('sitemap') && nome.endsWith('.xml') &&
    nome !== 'sitemap-index.xml' && !nome.startsWith('sitemap-livros');
  const outros = fs.readdirSync(SITE).filter(ehSitemapAntigo).sort().map(n => RAIZ_URL + '/' + n);
  const todos = outros.concat(arquivos);
  gravar(path.join(SITE, 'sitemap-index.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    todos.map(a => '<sitemap><loc>' + esc(a) + '</loc><lastmod>' + hoje + '</lastmod></sitemap>').join('\n') +
    '\n</sitemapindex>\n');

  log.info('vitrine publicada: ' + paginas + ' paginas | ' + todos.length + ' sitemap(s) no indice | ' + urls.length + ' URLs de livro');
  return { paginas, urls: urls.length, sitemaps: todos.length, arquivos: todos };
}

if (require.main === module) {
  try { const r = principal(); console.log(JSON.stringify(r)); process.exit(0); }
  catch (e) { log.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); }
}

module.exports = { principal, paginaDoLivro, paginaDoIndice, xmlSitemap };
