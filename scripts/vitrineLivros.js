'use strict';
/**
 * vitrineLivros.js — pagina publica veloxisit.com.br/livros/ com os livros em
 * destaque e o botao de compra na Hotmart.
 *
 * Por que: em 16/09/2026 nenhum link publico levava aos produtos — zero
 * trafego proprio. A vitrine e o destino dos anuncios e das redes, e da ao
 * afiliado uma pagina para indicar.
 *
 * Regras de conteudo publico (playbook): nada de avaliacao, contagem de vendas
 * ou "mais vendido" inventados. So titulo, descricao do proprio livro, preco e
 * o link oficial da Hotmart.
 *
 * Roda no container (a raiz do site esta montada em /app/landing_pages).
 * Uso: node scripts/vitrineLivros.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { montarPaginaAfiliados } = require('./paginaAfiliados');

const SITE = process.env.SITE_ROOT || '/app/landing_pages';
const BASE_URL = 'https://veloxisit.com.br/livros/';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function resumo(txt, max = 170) {
  const t = String(txt || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const c = t.slice(0, max);
  const p = Math.max(c.lastIndexOf('. '), c.lastIndexOf('! '), c.lastIndexOf('? '));
  if (p >= max * 0.4) return c.slice(0, p + 1);
  return c.slice(0, c.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}

function precoBR(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

/** Endereco de cada livro: /livros/<slug>/. Pura. */
function slug(titulo, pid) {
  const base = String(titulo || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
    .replace(/-$/, '');
  return (base || 'livro') + '-' + String(pid);
}

/**
 * Pagina do livro. Existe porque a vitrine era UMA pagina so: sem pagina por
 * titulo o Google nao tem o que indexar para a busca de cada assunto, e em
 * 17/09/2026 a vitrine recebeu 1 visita humana em 36 h.
 */
function montarPaginaLivro(l, outros = [], agora = new Date()) {
  const url = BASE_URL + l.slug + '/';
  const desc = resumo(l.descricao, 155);
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: l.titulo,
    description: resumo(l.descricao, 500), image: BASE_URL + 'img/' + l.imagem,
    brand: { '@type': 'Brand', name: 'Veloxis Editorial' },
    offers: { '@type': 'Offer', price: Number(l.preco || 0).toFixed(2), priceCurrency: 'BRL', availability: 'https://schema.org/InStock', url: l.link },
  };
  const trilha = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Livros digitais', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: l.titulo, item: url },
    ],
  };
  const jsons = [ld, trilha].map(o => JSON.stringify(o).replace(/</g, '\\u003c'));
  const relacionados = outros.slice(0, 4).map(o => `<li><a href="../${esc(o.slug)}/">${esc(o.titulo)}</a></li>`).join('');
  const paragrafos = String(l.descricao || '').split(/\n+/).map(t => t.trim()).filter(Boolean)
    .map(t => `<p>${esc(t)}</p>`).join('') || `<p>${esc(l.titulo)}</p>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(l.titulo)} — e-book em PDF | Veloxis Editorial</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="product"><meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(l.titulo)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${BASE_URL}img/${esc(l.imagem)}">
${jsons.map(j => `<script type="application/ld+json">${j}</script>`).join('')}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0e0e1a;color:#f2f2f7;line-height:1.55}
.wrap{max-width:860px;margin:0 auto;padding:28px 20px 40px}
a{color:#ffcf5a}
nav{font-size:13px;color:#a9a9c0;margin-bottom:18px}
h1{font-size:clamp(22px,3.6vw,30px);margin-bottom:14px}
.topo{display:flex;gap:22px;flex-wrap:wrap}
.topo img{width:260px;max-width:100%;height:auto;aspect-ratio:10/16;object-fit:cover;border-radius:12px;background:#222}
.compra{flex:1;min-width:240px;display:flex;flex-direction:column;gap:12px}
.preco{font-weight:800;color:#ffcf5a;font-size:26px}
.btn{display:inline-block;background:#ff6a3d;color:#fff;font-weight:700;padding:14px 18px;border-radius:10px;text-decoration:none;text-align:center}
.detalhe{color:#b9b9cf;font-size:14px}
section{margin-top:26px}
section h2{font-size:18px;margin-bottom:10px}
section p{margin-bottom:10px;color:#dcdce8}
ul{margin-left:18px;color:#dcdce8}
footer{margin-top:32px;color:#77778f;font-size:12px}
</style></head><body><div class="wrap">
<nav><a href="../">Livros digitais</a> › ${esc(l.titulo)}</nav>
<h1>${esc(l.titulo)}</h1>
<div class="topo">
  <img src="../img/${esc(l.imagem)}" alt="Capa do e-book ${esc(l.titulo)}" width="300" height="480">
  <div class="compra">
    <span class="preco">${esc(precoBR(l.preco))}</span>
    <a class="btn" href="${esc(l.link)}" target="_blank" rel="noopener sponsored">Comprar na Hotmart</a>
    <span class="detalhe">E-book em PDF. Pagamento e entrega pela Hotmart, com acesso imediato após a confirmação.</span>
  </div>
</div>
<section><h2>Sobre o livro</h2>${paragrafos}</section>
${relacionados ? `<section><h2>Outros livros</h2><ul>${relacionados}</ul></section>` : ''}
<footer>Veloxis Editorial · atualizado em ${agora.toISOString().slice(0, 10)} · <a href="../">ver todos os livros</a></footer>
</div></body></html>
`;
}

/** sitemap so dos livros. Pura. */
function sitemapLivros(livros, data) {
  const urls = [BASE_URL, ...livros.map(l => BASE_URL + l.slug + '/')]
    .map(u => `  <url><loc>${u}</loc><lastmod>${data}</lastmod><changefreq>weekly</changefreq></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/** Acrescenta a linha Sitemap ao robots.txt se faltar. Pura. */
function comSitemapNoRobots(txt, url) {
  const t = String(txt || '');
  if (t.includes(url)) return t;
  const corpo = t.replace(/\s*$/, '');
  return (corpo ? corpo + '\n' : '') + 'Sitemap: ' + url + '\n';
}

/** Monta a pagina. Pura: recebe os livros ja resolvidos. */
function montarPagina(livros, agora = new Date()) {
  const cards = livros.map(l => `
    <a class="card" href="${esc(l.slug)}/">
      <img loading="lazy" src="img/${esc(l.imagem)}" alt="Capa do e-book ${esc(l.titulo)}" width="300" height="480">
      <div class="info">
        <h2>${esc(l.titulo)}</h2>
        <p>${esc(resumo(l.descricao))}</p>
        <div class="row"><span class="preco">${esc(precoBR(l.preco))}</span><span class="btn">Ver detalhes</span></div>
      </div>
    </a>`).join('');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Livros digitais Veloxis Editorial',
    itemListElement: livros.map((l, i) => ({
      '@type': 'ListItem', position: i + 1,
      item: {
        '@type': 'Product', name: l.titulo, description: resumo(l.descricao, 300),
        image: BASE_URL + 'img/' + l.imagem, brand: { '@type': 'Brand', name: 'Veloxis Editorial' },
        offers: { '@type': 'Offer', price: Number(l.preco || 0).toFixed(2), priceCurrency: 'BRL', availability: 'https://schema.org/InStock', url: l.link },
      },
    })),
  };
  // "<" escapado dentro do JSON-LD para nao fechar a tag script
  const ldTexto = JSON.stringify(ld).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Livros digitais práticos — Veloxis Editorial</title>
<meta name="description" content="E-books práticos sobre finanças pessoais, carreira, produtividade e negócios. Entrega imediata após a compra pela Hotmart.">
<link rel="canonical" href="${BASE_URL}">
<meta property="og:type" content="website"><meta property="og:url" content="${BASE_URL}">
<meta property="og:title" content="Livros digitais práticos — Veloxis Editorial">
<meta property="og:description" content="E-books práticos com entrega imediata.">
${livros[0] ? `<meta property="og:image" content="${BASE_URL}img/${esc(livros[0].imagem)}">` : ''}
<script type="application/ld+json">${ldTexto}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0e0e1a;color:#f2f2f7;line-height:1.45}
header{max-width:1100px;margin:0 auto;padding:36px 20px 8px;text-align:center}
header h1{font-size:clamp(24px,4vw,34px)}
header p{color:#a9a9c0;margin-top:8px;font-size:15px}
.grid{max-width:1100px;margin:22px auto;padding:0 20px;display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.card{display:flex;flex-direction:column;background:#17172a;border:1px solid #26264a;border-radius:14px;overflow:hidden;color:inherit;text-decoration:none;transition:transform .15s}
.card:hover{transform:translateY(-3px)}
.card img{width:100%;height:auto;aspect-ratio:10/16;object-fit:cover;background:#222}
.info{padding:14px;display:flex;flex-direction:column;gap:8px;flex:1}
.info h2{font-size:16px}
.info p{font-size:13px;color:#b9b9cf;flex:1}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.preco{font-weight:800;color:#ffcf5a;font-size:17px}
.btn{background:#ff6a3d;color:#fff;font-weight:700;font-size:13px;padding:8px 12px;border-radius:9px;white-space:nowrap}
footer{text-align:center;color:#77778f;font-size:12px;padding:30px 20px}
</style></head><body>
<header><h1>Livros digitais práticos</h1>
<p>Guias diretos ao ponto sobre dinheiro, carreira e produtividade. Pagamento e entrega pela Hotmart.</p></header>
<main class="grid">${cards}
</main>
<footer>Veloxis Editorial · atualizado em ${agora.toISOString().slice(0, 10)} · <a href="/privacy.html" style="color:#99a">Privacidade</a></footer>
</body></html>
`;
}

/** Inclui a URL no sitemap-extra se ainda nao estiver. Pura. */
function comUrlNoSitemap(xml, url, data) {
  if (!xml || xml.includes('<loc>' + url + '</loc>')) return xml;
  return xml.replace('</urlset>', `  <url><loc>${url}</loc><lastmod>${data}</lastmod><changefreq>daily</changefreq></url>\n</urlset>`);
}

function gravarAtomico(arquivo, conteudo) {
  const tmp = arquivo + '.tmp' + process.pid;
  fs.writeFileSync(tmp, conteudo);
  fs.renameSync(tmp, arquivo);
}

async function main() {
  const db = require('../src/core/database').getDb();
  const tok = fs.readFileSync(process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt', 'utf8').trim();
  const H = { authorization: 'Bearer ' + tok, accept: 'application/json' };
  const destaques = db.prepare(
    'SELECT e.hotmart_product_id AS pid, e.title, e.description, e.cover_path, a.comissao FROM afiliacao_hotmart a ' +
    'JOIN ebooks e ON CAST(e.hotmart_product_id AS TEXT) = a.produto ' +
    "WHERE a.destaque = 1 AND a.resultado = 'ok' ORDER BY a.quando ASC"
  ).all();
  const dirImg = path.join(SITE, 'livros', 'img');
  fs.mkdirSync(dirImg, { recursive: true });
  const livros = [];
  for (const d of destaques) {
    if (!d.cover_path || !fs.existsSync(d.cover_path)) continue;
    const r = await fetch('https://api-affiliation.hotmart.com/v1/easy-setup/settings/' + d.pid, { headers: H });
    if (!r.ok) { console.log('sem dados da Hotmart para', d.pid, r.status); continue; }
    const p = (await r.json()).product || {};
    if (!p.salesPageLink) continue;
    const imagem = d.pid + '.jpg';
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', d.cover_path, '-vf', 'scale=600:-2', '-q:v', '4', path.join(dirImg, imagem)]);
    livros.push({ titulo: d.title, descricao: d.description, preco: p.price && p.price.value, link: p.salesPageLink, imagem, slug: slug(d.title, d.pid), ucode: p.ucode || null, comissao: d.comissao || 70 });
  }
  if (!livros.length) throw new Error('nenhum livro com capa e link — nada publicado');
  gravarAtomico(path.join(SITE, 'livros', 'index.html'), montarPagina(livros));
  // Uma pagina por livro: a vitrine sozinha nao da ao Google o que indexar
  // para a busca de cada assunto.
  for (const l of livros) {
    const dir = path.join(SITE, 'livros', l.slug);
    fs.mkdirSync(dir, { recursive: true });
    const outros = livros.filter(o => o !== l);
    gravarAtomico(path.join(dir, 'index.html'), montarPaginaLivro(l, outros));
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const dirAfil = path.join(SITE, 'livros', 'afiliados');
  fs.mkdirSync(dirAfil, { recursive: true });
  gravarAtomico(path.join(dirAfil, 'index.html'), montarPaginaAfiliados(livros, { esc, precoBR }));
  gravarAtomico(path.join(SITE, 'sitemap-livros.xml'), sitemapLivros(livros.concat([{ slug: 'afiliados' }]), hoje));
  const robots = path.join(SITE, 'robots.txt');
  if (fs.existsSync(robots)) {
    const antes = fs.readFileSync(robots, 'utf8');
    const depois = comSitemapNoRobots(antes, 'https://veloxisit.com.br/sitemap-index.xml');
    if (depois !== antes) gravarAtomico(robots, depois);
  }
  const indice = path.join(SITE, 'sitemap-index.xml');
  if (fs.existsSync(indice)) {
    const antes = fs.readFileSync(indice, 'utf8');
    const alvo = '<sitemap><loc>https://veloxisit.com.br/sitemap-livros.xml</loc></sitemap>';
    if (!antes.includes(alvo)) gravarAtomico(indice, antes.replace('</sitemapindex>', '  ' + alvo + String.fromCharCode(10) + '</sitemapindex>'));
  }
  const sm = path.join(SITE, 'sitemap-extra.xml');
  if (fs.existsSync(sm)) {
    const antes = fs.readFileSync(sm, 'utf8');
    const depois = comUrlNoSitemap(antes, BASE_URL, new Date().toISOString().slice(0, 10));
    if (depois !== antes) gravarAtomico(sm, depois);
  }
  console.log(JSON.stringify({ livros: livros.length, pagina: BASE_URL, paginas: livros.map(l => l.slug) }));
}

module.exports = { montarPagina, montarPaginaLivro, sitemapLivros, comSitemapNoRobots, slug, resumo, precoBR, esc, comUrlNoSitemap };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
