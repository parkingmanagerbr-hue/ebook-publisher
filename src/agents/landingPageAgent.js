'use strict';
/**
 * landingPageAgent.js — Gera e faz deploy de landing pages para produtos de afiliados
 *
 * Para cada produto com affiliate_link no DB:
 *   1. Gera slug a partir do nome do produto
 *   2. Gera HTML completo via Gemini API (SEO + CTA + schema.org)
 *   3. Cria subdomínio via Cloudflare API
 *   4. Faz deploy do HTML e config Nginx no VPS
 *   5. Atualiza landing_page_url no DB
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

let log;
try {
  const { createLogger } = require('../core/logger');
  log = createLogger('landingPageAgent');
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
const IS_VPS        = process.env.RUNNING_ON_VPS === 'true' || fs.existsSync('/app/data');

// Gemini API keys (rotate through them)
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
].filter(Boolean);

let _geminiKeyIndex = 0;
function getGeminiKey() {
  if (GEMINI_KEYS.length === 0) return null;
  const key = GEMINI_KEYS[_geminiKeyIndex % GEMINI_KEYS.length];
  _geminiKeyIndex++;
  return key;
}

// ── DB ────────────────────────────────────────────────────────────────────────
const DB_PATH = process.env.AFFILIATE_DB_PATH || '/app/data/db/ebooks.db';

let _db;
function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) {}
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  // Ensure affiliate_products table exists (in case landingPageAgent runs standalone)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_products (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      platform     TEXT NOT NULL,
      product_id   TEXT,
      product_name TEXT NOT NULL,
      product_url  TEXT,
      affiliate_link TEXT,
      category     TEXT,
      price        REAL,
      commission_pct REAL,
      landing_page_url TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, product_id)
    )
  `);
  // Add landing_page_url column if not exists (migration)
  try { _db.exec("ALTER TABLE affiliate_products ADD COLUMN landing_page_url TEXT"); } catch (_) {}
  return _db;
}

function getProductsWithLinks() {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM affiliate_products WHERE affiliate_link IS NOT NULL ORDER BY id ASC'
  ).all();
}

function updateLandingPageUrl(id, landingPageUrl) {
  const db = getDb();
  db.prepare('UPDATE affiliate_products SET landing_page_url = ? WHERE id = ?').run(landingPageUrl, id);
}

// ── Slug generator ────────────────────────────────────────────────────────────
function makeSlug(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // remove diacritics
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    });

    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (!text) reject(new Error('Gemini empty response: ' + data.slice(0, 200)));
          else resolve(text);
        } catch (e) {
          reject(new Error('Gemini parse error: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Generate landing page HTML ────────────────────────────────────────────────
async function generateHtml(product) {
  const slug = makeSlug(product.product_name);
  const subdomain = slug + '.' + BASE_DOMAIN;
  const canonicalUrl = 'https://' + subdomain;
  const price = product.price ? 'R$ ' + product.price.toFixed(2).replace('.', ',') : 'Confira o preço';

  const prompt = `Crie uma landing page HTML completa em português brasileiro para um produto de afiliado.

Produto: "${product.product_name}"
Categoria: ${product.category || 'Geral'}
Preço: ${price}
Link de afiliado: ${product.affiliate_link}
URL canônica: ${canonicalUrl}
Plataforma: ${product.platform}

REQUISITOS OBRIGATÓRIOS:
1. HTML completo e válido (<!DOCTYPE html> até </html>)
2. CSS inline APENAS (sem CSS externo, sem CDN, sem frameworks)
3. Design mobile-first e responsivo
4. Performance: sem JavaScript pesado, sem dependências externas
5. SEO completo:
   - <title> atraente (60 chars max)
   - <meta name="description"> (155 chars max)
   - <link rel="canonical" href="${canonicalUrl}">
   - Open Graph tags (og:title, og:description, og:url, og:type)
   - Schema.org Product em JSON-LD
6. Estrutura da página:
   - Hero section: título impactante + subtítulo + botão CTA "Comprar Agora"
   - Seção de benefícios: pelo menos 5 bullet points com ícones emoji
   - Seção "Para quem é?" com 3-4 perfis de público
   - Seção de depoimentos: 3 depoimentos fictícios (adicione nota de disclosure pequena abaixo)
   - FAQ: 5 perguntas e respostas relevantes
   - CTA final com botão grande
   - Footer com aviso: "Este site contém links de afiliado — posso ganhar comissão sem custo adicional para você"
7. Cores: profissional, paleta harmoniosa, botões com bom contraste
8. Todos os links de compra devem apontar para: ${product.affiliate_link}
9. Não use imagens externas (use apenas CSS gradients e emojis)
10. Disclosure visível em fonte pequena: "Links de afiliado — ganho comissão sem custo extra para você"

Retorne APENAS o HTML completo, sem markdown, sem explicações, sem \`\`\`html.`;

  let html = '';
  let lastError = null;
  // Retry with different Gemini keys on failure
  for (let attempt = 0; attempt < Math.min(3, GEMINI_KEYS.length + 1); attempt++) {
    try {
      if (attempt > 0) await sleep(2000);
      const raw = await callGemini(prompt);
      // Strip markdown code blocks if present
      html = raw.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      if (html.includes('<!DOCTYPE') || html.includes('<html')) break;
      html = '<!DOCTYPE html>' + html; // ensure valid start
      break;
    } catch (e) {
      lastError = e;
      log.warn('Gemini attempt ' + (attempt + 1) + ' failed: ' + e.message.slice(0, 80));
    }
  }

  if (!html) {
    // Fallback: minimal HTML template
    log.warn('Gemini failed, usando template fallback para: ' + product.product_name);
    html = generateFallbackHtml(product, canonicalUrl, price);
  }

  return { html, slug, subdomain, canonicalUrl };
}

function generateFallbackHtml(product, canonicalUrl, price) {
  const name = product.product_name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (product.affiliate_link || '#').replace(/"/g, '%22');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} — Oferta Especial</title>
<meta name="description" content="Conheça ${name}. Produto de qualidade com ótimo custo-benefício.">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${name}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:type" content="website">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;line-height:1.6}
.hero{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:80px 20px;text-align:center}
.hero h1{font-size:2.2rem;margin-bottom:1rem;max-width:700px;margin-left:auto;margin-right:auto}
.hero p{font-size:1.2rem;margin-bottom:2rem;opacity:.9}
.cta-btn{display:inline-block;background:#ff6b35;color:#fff;padding:18px 48px;border-radius:50px;text-decoration:none;font-size:1.2rem;font-weight:bold;transition:transform .2s}
.cta-btn:hover{transform:scale(1.05)}
.section{padding:60px 20px;max-width:900px;margin:0 auto}
.benefits{display:flex;flex-wrap:wrap;gap:20px;justify-content:center;margin-top:30px}
.benefit{background:#f8f9fa;border-radius:12px;padding:24px;flex:1;min-width:220px;max-width:260px;text-align:center}
.benefit .icon{font-size:2.5rem;margin-bottom:12px}
.faq-item{border-bottom:1px solid #eee;padding:20px 0}
.faq-item h3{color:#667eea;margin-bottom:8px}
.disclaimer{font-size:.75rem;color:#999;text-align:center;padding:20px;background:#f8f9fa}
footer{background:#333;color:#ddd;text-align:center;padding:20px;font-size:.85rem}
</style>
</head>
<body>
<div class="hero">
  <h1>${name}</h1>
  <p>${price}</p>
  <a href="${link}" class="cta-btn" rel="nofollow sponsored">Comprar Agora</a>
  <p class="disclaimer" style="margin-top:12px;font-size:.75rem;opacity:.7">Link de afiliado — ganho comissão sem custo extra para você</p>
</div>
<div class="section">
  <h2 style="text-align:center;margin-bottom:30px">Por que escolher este produto?</h2>
  <div class="benefits">
    <div class="benefit"><div class="icon">✅</div><p>Qualidade comprovada</p></div>
    <div class="benefit"><div class="icon">⚡</div><p>Entrega rápida</p></div>
    <div class="benefit"><div class="icon">💰</div><p>Melhor preço</p></div>
    <div class="benefit"><div class="icon">🔒</div><p>Compra segura</p></div>
    <div class="benefit"><div class="icon">⭐</div><p>Alta avaliação</p></div>
  </div>
</div>
<div class="section">
  <h2 style="text-align:center;margin-bottom:30px">Perguntas Frequentes</h2>
  <div class="faq-item"><h3>O produto tem garantia?</h3><p>Sim, segue a política da plataforma vendedora.</p></div>
  <div class="faq-item"><h3>Como faço para comprar?</h3><p>Clique no botão "Comprar Agora" acima.</p></div>
  <div class="faq-item"><h3>O pagamento é seguro?</h3><p>Sim, a compra é processada pela plataforma oficial.</p></div>
</div>
<div style="text-align:center;padding:40px 20px">
  <a href="${link}" class="cta-btn" rel="nofollow sponsored">Garantir Meu Produto</a>
</div>
<div class="disclaimer">*Links de afiliado — posso ganhar comissão sem custo adicional para você.</div>
<footer>© ${new Date().getFullYear()} ${BASE_DOMAIN}</footer>
</body>
</html>`;
}

// ── Cloudflare: create DNS record ─────────────────────────────────────────────
async function createCloudflareSubdomain(subdomain) {
  const name = subdomain.replace('.' + BASE_DOMAIN, '');
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'A',
      name: name,
      content: VPS_IP,
      ttl: 1,
      proxied: true,
    });
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
          if (j.success) {
            log.info('[CF] DNS criado: ' + subdomain + ' -> ' + VPS_IP);
            resolve({ success: true });
          } else {
            // Check if already exists (error code 81057)
            const alreadyExists = (j.errors || []).some(e => e.code === 81057 || (e.message || '').includes('already exist'));
            if (alreadyExists) {
              log.info('[CF] DNS já existe: ' + subdomain);
              resolve({ success: true, alreadyExists: true });
            } else {
              log.warn('[CF] DNS create error: ' + JSON.stringify(j.errors).slice(0, 200));
              resolve({ success: false, errors: j.errors });
            }
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
    req.on('error', e => resolve({ success: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

// ── Deploy to VPS filesystem ───────────────────────────────────────────────────
function deployToFilesystem(slug, html) {
  const webRoot = path.join(NGINX_DATA_PATH, slug);
  try {
    fs.mkdirSync(webRoot, { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'index.html'), html, 'utf8');
    log.info('[Deploy] HTML escrito em: ' + path.join(webRoot, 'index.html'));
  } catch (e) {
    throw new Error('Deploy HTML falhou: ' + e.message);
  }

  // Write Nginx server block
  const confDir = NGINX_CONF_PATH;
  const confFile = path.join(confDir, slug + '.conf');
  if (!fs.existsSync(confFile)) {
    const nginxConf = `server {
  listen 80;
  server_name ${slug}.${BASE_DOMAIN};
  root /var/www/veloxisit/${slug};
  index index.html;
  location / {
    try_files $uri $uri/ /index.html;
  }
  add_header X-Content-Type-Options nosniff;
  add_header X-Frame-Options SAMEORIGIN;
}
`;
    try {
      fs.mkdirSync(confDir, { recursive: true });
      fs.writeFileSync(confFile, nginxConf, 'utf8');
      log.info('[Deploy] Nginx conf criado: ' + confFile);
    } catch (e) {
      log.warn('[Deploy] Nginx conf error: ' + e.message);
    }
  }

  // Reload nginx
  try {
    const { execSync } = require('child_process');
    execSync('nginx -s reload 2>&1', { timeout: 10000 });
    log.info('[Deploy] Nginx recarregado');
  } catch (e) {
    log.warn('[Deploy] Nginx reload: ' + e.message.slice(0, 80));
  }
}

// ── Deploy single product landing page ───────────────────────────────────────
async function deployLandingPage(product) {
  log.info('[LP] Gerando LP para: "' + product.product_name.slice(0, 50) + '"');

  const { html, slug, subdomain, canonicalUrl } = await generateHtml(product);

  // Create Cloudflare subdomain
  try {
    const cfResult = await createCloudflareSubdomain(subdomain);
    if (!cfResult.success) {
      log.warn('[LP] CF DNS falhou para ' + subdomain + ' — continuando mesmo assim');
    }
  } catch (cfErr) {
    log.warn('[LP] CF DNS error: ' + cfErr.message);
  }

  // Deploy HTML
  if (IS_VPS) {
    deployToFilesystem(slug, html);
  } else {
    // Local dev: save to ./data/landing_pages/
    const localDir = path.join(process.cwd(), 'data', 'landing_pages', slug);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'index.html'), html, 'utf8');
    log.info('[LP] (dev) HTML salvo em: ' + path.join(localDir, 'index.html'));
  }

  // Update DB
  const landingPageUrl = 'https://' + subdomain;
  updateLandingPageUrl(product.id, landingPageUrl);
  log.info('[LP] Deployed: ' + landingPageUrl);

  return { landingPageUrl, slug, subdomain };
}

// ── Generate all landing pages ────────────────────────────────────────────────
async function generateLandingPages() {
  log.info('[LP] Iniciando geração de landing pages...');
  const products = getProductsWithLinks();
  log.info('[LP] ' + products.length + ' produtos com affiliate_link encontrados');

  const deployed = [];
  for (const product of products) {
    // Skip if already deployed
    if (product.landing_page_url) {
      log.info('[LP] Já deployado: ' + product.product_name.slice(0, 40) + ' → ' + product.landing_page_url);
      continue;
    }
    try {
      const result = await deployLandingPage(product);
      deployed.push({ product: product.product_name, ...result });
      await sleep(1500); // Rate limit Gemini API
    } catch (e) {
      log.error('[LP] Erro em "' + product.product_name.slice(0, 40) + '": ' + e.message);
    }
  }

  log.info('[LP] Concluído: ' + deployed.length + ' landing pages criadas');
  return deployed;
}

module.exports = { generateLandingPages, deployLandingPage };
