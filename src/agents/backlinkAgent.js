'use strict';
/**
 * backlinkAgent.js — Cria hub de afiliados e links internos entre landing pages
 *
 * Funções:
 *   1. Gera hub page (afiliados.veloxisit.com.br) com lista de todos os produtos
 *   2. Para cada LP, adiciona seção "Veja também" com 3-5 links do mesmo nicho
 *   3. Faz deploy do hub e re-deploy das LPs com links cruzados
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

let log;
try {
  const { createLogger } = require('../core/logger');
  log = createLogger('backlinkAgent');
} catch (_) {
  const winston = require('winston');
  log = winston.createLogger({
    transports: [new winston.transports.Console({ format: winston.format.simple() })]
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Environment ───────────────────────────────────────────────────────────────
const CF_ZONE_ID    = process.env.CLOUDFLARE_ZONE_ID  || '';
const CF_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN || '';
const VPS_IP        = process.env.VPS_IP              || '173.212.227.198';
const BASE_DOMAIN   = process.env.BASE_DOMAIN         || 'veloxisit.com.br';
const NGINX_DATA_PATH = process.env.NGINX_DATA_PATH   || '/opt/platform/data/veloxisit';
const NGINX_CONF_PATH = process.env.NGINX_CONF_PATH   || '/opt/platform/nginx/sites';
const IS_VPS        = process.env.RUNNING_ON_VPS === 'true' || (process.platform !== 'win32' && fs.existsSync('/app/data'));
const HUB_SUBDOMAIN = 'afiliados.' + BASE_DOMAIN;
const HUB_SLUG      = 'afiliados';

// ── DB ────────────────────────────────────────────────────────────────────────
const _defaultDbDir2 = (process.platform !== 'win32' && fs.existsSync('/app/data')) ? '/app/data/db' : path.join(__dirname, '../../data/db');
const DB_PATH = process.env.AFFILIATE_DB_PATH || path.join(_defaultDbDir2, 'ebooks.db');

let _db;
function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) {}
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

function getAllDeployedProducts() {
  try {
    return getDb().prepare(
      'SELECT * FROM affiliate_products WHERE landing_page_url IS NOT NULL ORDER BY category, product_name ASC'
    ).all();
  } catch (e) {
    log.warn('getAllDeployedProducts error: ' + e.message);
    return [];
  }
}

// ── Cloudflare DNS ────────────────────────────────────────────────────────────
async function ensureCloudflareRecord(name, ip) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: 'A', name, content: ip, ttl: 1, proxied: true });
    const opts = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/zones/' + CF_ZONE_ID + '/dns_records',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CF_API_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const nonFatalCodes = [81057, 81045]; // 81057=already exists, 81045=quota exceeded (record likely exists)
          if (j.success || (j.errors || []).some(e => nonFatalCodes.includes(e.code))) {
            resolve({ success: true });
          } else {
            log.warn('[CF] ' + name + ' error: ' + JSON.stringify(j.errors || []).slice(0, 100));
            resolve({ success: false });
          }
        } catch (e) { resolve({ success: false }); }
      });
    });
    req.on('error', () => resolve({ success: false }));
    req.write(body);
    req.end();
  });
}

// ── Nginx deploy helper ───────────────────────────────────────────────────────
const AFFILIATE_LP_BASE_URL = (process.env.AFFILIATE_LP_BASE_URL || '').replace(/\/$/, '');

function deployHtml(slug, html, { skipNginxConf = false } = {}) {
  if (IS_VPS) {
    const webRoot = path.join(NGINX_DATA_PATH, slug);
    fs.mkdirSync(webRoot, { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'index.html'), html, 'utf8');

    // Skip subdomain conf + reload when using path-based routing or caller says skip
    if (!skipNginxConf && !AFFILIATE_LP_BASE_URL) {
      const confFile = path.join(NGINX_CONF_PATH, slug + '.conf');
      if (!fs.existsSync(confFile)) {
        const nginxConf = `server {
  listen 80;
  server_name ${slug}.${BASE_DOMAIN};
  root /var/www/veloxisit/${slug};
  index index.html;
  location / {
    try_files $uri $uri/ /index.html;
  }
}
`;
        try {
          fs.mkdirSync(NGINX_CONF_PATH, { recursive: true });
          fs.writeFileSync(confFile, nginxConf, 'utf8');
        } catch (e) { log.warn('[Deploy] conf error: ' + e.message); }
      }

      try {
        const { execSync } = require('child_process');
        execSync('nginx -s reload 2>&1', { timeout: 10000 });
      } catch (e) { log.warn('[Deploy] nginx reload: ' + e.message.slice(0, 60)); }
    }

    log.info('[Deploy] ' + slug + ' → ' + path.join(NGINX_DATA_PATH, slug, 'index.html'));
  } else {
    // Local dev
    const localDir = path.join(process.cwd(), 'data', 'landing_pages', slug);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'index.html'), html, 'utf8');
    log.info('[Deploy] (dev) ' + localDir);
  }
}

// ── Generate hub page HTML ────────────────────────────────────────────────────
function generateHubHtml(products) {
  const hubUrl = 'https://' + HUB_SUBDOMAIN;
  const year = new Date().getFullYear();

  // Group products by category
  const byCategory = {};
  for (const p of products) {
    const cat = p.category || 'Geral';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }

  const platformEmoji = { hotmart: '🔥', cakto: '⚡', amazon: '📦' };

  let categorySections = '';
  for (const [cat, prods] of Object.entries(byCategory)) {
    const cardHtml = prods.map(p => {
      const name = (p.product_name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const lpUrl = p.landing_page_url || p.affiliate_link || '#';
      const price = p.price ? 'R$ ' + p.price.toFixed(2).replace('.', ',') : '';
      const emoji = platformEmoji[p.platform] || '🛒';
      return `<a href="${lpUrl}" class="card" rel="nofollow">
  <div class="card-icon">${emoji}</div>
  <div class="card-body">
    <h3>${name}</h3>
    ${price ? '<span class="price">' + price + '</span>' : ''}
    ${p.commission_pct ? '<span class="comm">' + p.commission_pct + '% comissão</span>' : ''}
  </div>
</a>`;
    }).join('\n');

    categorySections += `<section class="category">
  <h2>${cat}</h2>
  <div class="cards">${cardHtml}</div>
</section>`;
  }

  const totalProducts = products.length;
  const platformCount = [...new Set(products.map(p => p.platform))].length;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Melhores Produtos e Indicações — Afiliados ${BASE_DOMAIN}</title>
<meta name="description" content="Descubra os ${totalProducts} melhores produtos selecionados cuidadosamente. Recomendações verificadas de ${platformCount} plataformas líderes do mercado.">
<link rel="canonical" href="${hubUrl}">
<meta property="og:title" content="Melhores Produtos Recomendados — ${BASE_DOMAIN}">
<meta property="og:description" content="${totalProducts} produtos selecionados com qualidade garantida.">
<meta property="og:url" content="${hubUrl}">
<meta property="og:type" content="website">
<script type="application/ld+json">{
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Melhores Produtos e Indicações",
  "url": "${hubUrl}",
  "description": "Recomendações de produtos verificados",
  "publisher": { "@type": "Organization", "name": "${BASE_DOMAIN}" }
}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;line-height:1.6;background:#f4f6fb}
header{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);color:#fff;padding:60px 20px;text-align:center}
header h1{font-size:2.4rem;margin-bottom:.5rem;font-weight:800}
header p{font-size:1.1rem;opacity:.85;max-width:600px;margin:0 auto}
.stats{display:flex;justify-content:center;gap:40px;margin-top:24px;flex-wrap:wrap}
.stat{text-align:center}
.stat strong{display:block;font-size:2rem;font-weight:800}
.stat span{font-size:.85rem;opacity:.8}
main{max-width:1200px;margin:0 auto;padding:40px 20px}
.category{margin-bottom:50px}
.category h2{font-size:1.6rem;font-weight:700;margin-bottom:20px;padding-bottom:10px;border-bottom:3px solid #0f3460;color:#0f3460}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px}
.card{display:flex;align-items:flex-start;gap:16px;background:#fff;border-radius:12px;padding:20px;text-decoration:none;color:#222;box-shadow:0 2px 8px rgba(0,0,0,.08);transition:transform .2s,box-shadow .2s}
.card:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(0,0,0,.12)}
.card-icon{font-size:2rem;flex-shrink:0}
.card-body h3{font-size:.95rem;font-weight:600;line-height:1.4;margin-bottom:6px}
.price{background:#e8f5e9;color:#2e7d32;padding:3px 8px;border-radius:20px;font-size:.8rem;font-weight:600;margin-right:6px}
.comm{background:#fff3e0;color:#e65100;padding:3px 8px;border-radius:20px;font-size:.8rem;font-weight:600}
.search-bar{background:#fff;border-radius:12px;padding:20px;margin-bottom:30px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.search-bar input{width:100%;padding:12px 16px;border:2px solid #e0e0e0;border-radius:8px;font-size:1rem;outline:none;transition:border-color .2s}
.search-bar input:focus{border-color:#0f3460}
.disclaimer{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:16px 20px;margin:30px 0;font-size:.85rem;color:#5d4037}
footer{background:#1a1a2e;color:#aaa;text-align:center;padding:30px 20px;font-size:.85rem}
footer a{color:#64b5f6;text-decoration:none}
@media(max-width:600px){header h1{font-size:1.8rem}.cards{grid-template-columns:1fr}.stats{gap:20px}}
</style>
</head>
<body>
<header>
  <h1>🛒 Melhores Produtos Recomendados</h1>
  <p>Selecionamos cuidadosamente os melhores produtos para você</p>
  <div class="stats">
    <div class="stat"><strong>${totalProducts}</strong><span>Produtos</span></div>
    <div class="stat"><strong>${platformCount}</strong><span>Plataformas</span></div>
    <div class="stat"><strong>${Object.keys(byCategory).length}</strong><span>Categorias</span></div>
  </div>
</header>
<main>
  <div class="disclaimer">
    ⚠️ <strong>Disclosure:</strong> Este site contém links de afiliado. Quando você compra através dos nossos links, podemos receber uma comissão sem custo adicional para você. Isso nos ajuda a manter o site e trazer mais recomendações de qualidade.
  </div>
  <div class="search-bar">
    <input type="text" id="search" placeholder="🔍 Pesquisar produtos..." oninput="filterProducts(this.value)">
  </div>
  <div id="products-container">
    ${categorySections}
  </div>
</main>
<footer>
  <p>© ${year} <a href="https://${BASE_DOMAIN}">${BASE_DOMAIN}</a> — Links de afiliado | <a href="https://${BASE_DOMAIN}">Início</a></p>
  <p style="margin-top:8px;font-size:.75rem">Este site contém links de afiliado. Comissões ganhas não adicionam custo para o comprador.</p>
</footer>
<script>
function filterProducts(q){
  const s=q.toLowerCase().trim();
  document.querySelectorAll('.card').forEach(c=>{
    const t=(c.textContent||'').toLowerCase();
    c.style.display=(!s||t.includes(s))?'':'none';
  });
  document.querySelectorAll('.category').forEach(sec=>{
    const visible=[...sec.querySelectorAll('.card')].some(c=>c.style.display!=='none');
    sec.style.display=visible?'':'none';
  });
}
</script>
</body>
</html>`;
}

// ── Add "Veja também" section to existing LP HTML ────────────────────────────
function injectRelatedLinks(html, relatedProducts) {
  if (!relatedProducts || relatedProducts.length === 0) return html;

  const linksHtml = relatedProducts.map(p => {
    const name = (p.product_name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 60);
    const url = p.landing_page_url || p.affiliate_link || '#';
    return `<a href="${url}" style="display:block;padding:10px 16px;background:#f8f9fa;border-radius:8px;text-decoration:none;color:#0f3460;font-weight:500;transition:background .2s" onmouseover="this.style.background='#e8eaf6'" onmouseout="this.style.background='#f8f9fa'">${name}</a>`;
  }).join('\n');

  const sectionHtml = `
<!-- Veja Também — gerado automaticamente pelo backlinkAgent -->
<section style="max-width:900px;margin:40px auto;padding:0 20px">
  <h2 style="font-size:1.4rem;margin-bottom:16px;color:#333">🔗 Veja Também</h2>
  <div style="display:flex;flex-direction:column;gap:10px">
    ${linksHtml}
  </div>
  <p style="margin-top:12px;font-size:.75rem;color:#999">Links de afiliado — ganho comissão sem custo extra para você</p>
</section>`;

  // Inject before </body> or before footer
  if (html.includes('</body>')) {
    return html.replace('</body>', sectionHtml + '\n</body>');
  }
  return html + sectionHtml;
}

// ── Find related products (same category, different product) ─────────────────
function findRelatedProducts(currentProduct, allProducts, maxCount = 5) {
  return allProducts
    .filter(p =>
      p.id !== currentProduct.id &&
      p.landing_page_url &&
      (p.category === currentProduct.category || !currentProduct.category)
    )
    .slice(0, maxCount);
}

// ── Read existing LP HTML ────────────────────────────────────────────────────
function readLpHtml(slug) {
  const filePath = IS_VPS
    ? path.join(NGINX_DATA_PATH, slug, 'index.html')
    : path.join(process.cwd(), 'data', 'landing_pages', slug, 'index.html');
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  } catch (_) {}
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Constrói o hub de afiliados e adiciona links cruzados entre as LPs.
 */
async function buildBacklinks() {
  log.info('[Backlink] Iniciando construção de backlinks...');

  const products = getAllDeployedProducts();
  log.info('[Backlink] ' + products.length + ' produtos com LP encontrados');

  if (products.length === 0) {
    log.warn('[Backlink] Nenhuma LP deployada. Execute generateLandingPages() primeiro.');
    return { hub: null, relatedLinksAdded: 0 };
  }

  // ── 1. Generate and deploy hub page ──────────────────────────────────────
  log.info('[Backlink] Gerando hub page: https://' + HUB_SUBDOMAIN);
  const hubHtml = generateHubHtml(products);

  // Ensure Cloudflare DNS for hub
  try {
    const cfResult = await ensureCloudflareRecord(HUB_SLUG, VPS_IP);
    if (cfResult.success) log.info('[Backlink] CF DNS hub: OK');
  } catch (e) {
    log.warn('[Backlink] CF DNS hub error: ' + e.message);
  }

  deployHtml(HUB_SLUG, hubHtml);
  log.info('[Backlink] Hub deployado: https://' + HUB_SUBDOMAIN);

  // ── 2. Add "Veja também" links to each LP ────────────────────────────────
  let relatedLinksAdded = 0;
  for (const product of products) {
    try {
      const slug = (() => {
        const url = product.landing_page_url;
        if (!url) return null;
        // Path-based: https://ofertas.veloxisit.com.br/SLUG/ → extract SLUG
        const pathMatch = url.match(/ofertas\.veloxisit\.com\.br\/([^/?#]+)/);
        if (pathMatch) return pathMatch[1];
        // Subdomain-based: https://SLUG.veloxisit.com.br → extract SLUG
        const sub = url.replace(/^https?:\/\//, '').split('.')[0];
        return (sub && sub !== 'www' && sub !== 'ofertas') ? sub : null;
      })();
      if (!slug) continue;

      const existingHtml = readLpHtml(slug);
      if (!existingHtml) {
        log.warn('[Backlink] LP HTML não encontrado para slug: ' + slug);
        continue;
      }

      // Skip if already has "Veja Também" section
      if (existingHtml.includes('backlinkAgent') || existingHtml.includes('Veja Também')) {
        log.info('[Backlink] ' + slug + ' já tem links cruzados — pulando');
        continue;
      }

      const related = findRelatedProducts(product, products, 5);
      if (related.length === 0) {
        log.info('[Backlink] ' + slug + ': sem produtos relacionados');
        continue;
      }

      const updatedHtml = injectRelatedLinks(existingHtml, related);
      deployHtml(slug, updatedHtml, { skipNginxConf: true });
      relatedLinksAdded++;
      log.info('[Backlink] ' + slug + ': adicionados ' + related.length + ' links relacionados');

      await sleep(200); // Small delay to avoid hammering filesystem
    } catch (e) {
      log.warn('[Backlink] Erro em produto ' + product.id + ': ' + e.message);
    }
  }

  log.info('[Backlink] Concluído: hub criado, ' + relatedLinksAdded + ' LPs atualizadas com links cruzados');

  return {
    hub: 'https://' + HUB_SUBDOMAIN,
    productsLinked: products.length,
    relatedLinksAdded,
  };
}

module.exports = { buildBacklinks };
