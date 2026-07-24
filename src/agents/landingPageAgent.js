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
const NGINX_DATA_PATH = process.env.NGINX_DATA_PATH   || '/app/landing_pages';
const NGINX_CONF_PATH = process.env.NGINX_CONF_PATH   || '/app/nginx_sites';
const IS_VPS        = process.env.RUNNING_ON_VPS === 'true' || (process.platform !== 'win32' && fs.existsSync('/app/data'));
// Path-based URL: quando definido, todas as LPs ficam em BASE_URL/SLUG/ (evita quota CF DNS e Netlify sites)
const AFFILIATE_LP_BASE_URL = (process.env.AFFILIATE_LP_BASE_URL || '').replace(/\/$/, '');

// Vercel / Netlify tokens (obter em: vercel.com/account/tokens | app.netlify.com/user/applications)
// Adicionar ao ebook-publisher.env:
//   VERCEL_TOKEN=<token>          (vercel.com/account/tokens)
//   NETLIFY_TOKEN=<personal-access-token>  (app.netlify.com/user/applications/oauth)
//   NETLIFY_SITE_ID=<site-id>     (apenas se quiser publicar num site Netlify existente)
const VERCEL_TOKEN  = process.env.VERCEL_TOKEN  || '';
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN || '';

// FORCE_CLOUD_DEPLOY=true → sempre usa Vercel/Netlify, NUNCA publica no VPS.
// VPS_LOAD_THRESHOLD=0.70 → fallback automático quando load > threshold.
const FORCE_CLOUD = process.env.FORCE_CLOUD_DEPLOY === 'true';
const LOAD_THRESHOLD = parseFloat(process.env.VPS_LOAD_THRESHOLD || '0.70');
const N_CPUS = parseInt(process.env.VPS_CPU_COUNT || '6', 10);

function getVpsLoad() {
  try {
    const raw = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ');
    return parseFloat(raw[0]) / N_CPUS;
  } catch (_) { return 0; }
}

function isVpsOverloaded() {
  if (FORCE_CLOUD) return true; // sempre cloud quando FORCE_CLOUD_DEPLOY=true
  const load = getVpsLoad();
  if (load > LOAD_THRESHOLD) {
    log.warn('[Deploy] VPS load=' + load.toFixed(2) + ' > ' + LOAD_THRESHOLD + ' → cloud deploy');
    return true;
  }
  return false;
}

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
let _geminiDead = 0;   // contador de falhas seguidas → pula Gemini no lote
function getGeminiKey() {
  if (GEMINI_KEYS.length === 0) return null;
  const key = GEMINI_KEYS[_geminiKeyIndex % GEMINI_KEYS.length];
  _geminiKeyIndex++;
  return key;
}

// ── DB ────────────────────────────────────────────────────────────────────────
const _defaultDbDir = (process.platform !== 'win32' && fs.existsSync('/app/data')) ? '/app/data/db' : path.join(__dirname, '../../data/db');
const DB_PATH = process.env.AFFILIATE_DB_PATH || path.join(_defaultDbDir, 'ebooks.db');

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
      path: '/v1beta/models/' + (process.env.LP_GEMINI_MODEL || 'gemini-2.0-flash') + ':generateContent?key=' + apiKey,
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
// Tracking URL — redireciona via /api/go/:id antes de ir ao affiliate_link
// Permite contar clicks mesmo quando LP é no Vercel/Netlify
function getTrackingUrl(product) {
  const BASE_URL = process.env.TRACKING_BASE_URL ||
    (process.env.DOMAIN ? 'https://' + process.env.DOMAIN : '');
  return BASE_URL ? BASE_URL + '/api/go/' + product.id : product.affiliate_link;
}

async function generateHtml(product) {
  const slug = makeSlug(product.product_name);
  const subdomain = slug + '.' + BASE_DOMAIN;
  const canonicalUrl = AFFILIATE_LP_BASE_URL ? AFFILIATE_LP_BASE_URL + '/' + slug + '/' : 'https://' + subdomain;
  const price = product.price ? 'R$ ' + product.price.toFixed(2).replace('.', ',') : 'Confira o preço';
  // Use tracking URL for click counting
  product = { ...product, affiliate_link: getTrackingUrl(product) };

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

// ── Deploy to Vercel (serverless, free tier) ──────────────────────────────────
async function deployToVercel(slug, html, subdomain) {
  // Uses Vercel Deployments API v13 — uploads a single static file
  const projectName = slug.slice(0, 52); // Vercel project name max 52 chars
  const body = JSON.stringify({
    name: projectName,
    files: [{ file: 'index.html', data: Buffer.from(html).toString('base64'), encoding: 'base64' }],
    projectSettings: { framework: null },
    target: 'production',
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.vercel.com',
      path: '/v13/deployments',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + VERCEL_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.url) {
            const deployUrl = 'https://' + j.url;
            log.info('[Vercel] Deployed: ' + deployUrl + ' (project: ' + projectName + ')');
            resolve({ url: deployUrl, provider: 'vercel', project: projectName });
          } else {
            reject(new Error('Vercel deploy failed: ' + JSON.stringify(j).slice(0, 200)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Deploy to Netlify (static hosting, free tier) ────────────────────────────
// Helper HTTP JSON/raw para a API do Netlify (cross-platform, sem zip/binário externo)
function netlifyRequest(method, apiPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    const headers = { 'Authorization': 'Bearer ' + NETLIFY_TOKEN };
    if (payload) { headers['Content-Type'] = contentType || 'application/json'; headers['Content-Length'] = payload.length; }
    const req = https.request({ hostname: 'api.netlify.com', path: apiPath, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) return reject(new Error('Netlify ' + method + ' ' + apiPath + ' → ' + res.statusCode + ': ' + d.slice(0, 160)));
        try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function deployToNetlify(slug, html) {
  // API de digest do Netlify: sem zip, sem /tmp, sem binário externo (funciona em qualquer SO).
  const crypto = require('crypto');
  const buf = Buffer.from(html, 'utf8');
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');

  // 1. Site: usa NETLIFY_SITE_ID se houver, senão cria um site novo (nome derivado do slug).
  let siteId = process.env.NETLIFY_SITE_ID || null;
  if (!siteId) {
    const safe = ('lp-' + slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 60);
    const site = await netlifyRequest('POST', '/api/v1/sites', { name: safe });
    siteId = site.id || site.site_id;
    if (!siteId) throw new Error('Netlify: não criou site (' + JSON.stringify(site).slice(0, 120) + ')');
  }

  // 2. Cria deploy declarando o digest do index.html.
  const deploy = await netlifyRequest('POST', `/api/v1/sites/${siteId}/deploys`, { files: { '/index.html': sha1 } });
  const deployId = deploy.id;

  // 3. Faz upload do conteúdo dos arquivos requeridos (required = sha1s que faltam).
  const required = Array.isArray(deploy.required) ? deploy.required : [];
  if (required.includes(sha1)) {
    await netlifyRequest('PUT', `/api/v1/deploys/${deployId}/files/index.html`, buf, 'application/octet-stream');
  }

  const deployUrl = deploy.ssl_url || deploy.deploy_ssl_url || deploy.url
    || ('https://' + (deploy.subdomain || slug) + '.netlify.app');
  log.info('[Netlify] Deployed: ' + deployUrl);
  return { url: deployUrl, provider: 'netlify', siteId };
}

// ── Smart deploy: VPS if healthy, cloud if overloaded ────────────────────────
async function smartDeploy(slug, html, subdomain) {
  const overloaded = isVpsOverloaded();

  if (!overloaded && IS_VPS) {
    // VPS healthy → deploy local (nginx) + DNS
    deployToFilesystem(slug, html);
    if (!AFFILIATE_LP_BASE_URL) {
      try { await createCloudflareSubdomain(subdomain); } catch (e) {
        log.warn('[Deploy] CF DNS error: ' + e.message);
      }
    }
    const vpsUrl = AFFILIATE_LP_BASE_URL ? AFFILIATE_LP_BASE_URL + '/' + slug + '/' : 'https://' + subdomain;
    return { url: vpsUrl, provider: 'vps' };
  }

  // VPS overloaded → try Vercel first, Netlify as fallback
  log.info('[Deploy] Routing to cloud deploy (slug=' + slug + ')');

  if (VERCEL_TOKEN) {
    try {
      const r = await deployToVercel(slug, html, subdomain);
      // Still create CF DNS even for cloud deploys (CNAME to vercel deployment) — best-effort
      try { await createCloudflareSubdomain(subdomain); } catch (_) {}
      return r;
    } catch (e) {
      log.warn('[Vercel] falhou: ' + e.message.slice(0, 120) + ' — tentando Netlify...');
    }
  }

  if (NETLIFY_TOKEN) {
    try {
      return await deployToNetlify(slug, html);
    } catch (e) {
      log.warn('[Netlify] falhou: ' + e.message.slice(0, 120) + ' — caindo para VPS local');
    }
  }

  // Final fallback: VPS regardless of load
  log.warn('[Deploy] Sem tokens cloud disponíveis ou todos falharam → forçando deploy local');
  if (IS_VPS) deployToFilesystem(slug, html);
  if (!AFFILIATE_LP_BASE_URL) { try { await createCloudflareSubdomain(subdomain); } catch (_) {} }
  const fallbackUrl = AFFILIATE_LP_BASE_URL ? AFFILIATE_LP_BASE_URL + '/' + slug + '/' : 'https://' + subdomain;
  return { url: fallbackUrl, provider: 'vps-fallback' };
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
  // With path-based routing, one nginx vhost serves all LPs — no per-product conf or CF DNS needed.
  if (AFFILIATE_LP_BASE_URL) return;

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

// ── Deploy single product landing page (with smart VPS/cloud routing) ────────
async function deployLandingPage(product) {
  log.info('[LP] Gerando LP para: "' + product.product_name.slice(0, 50) + '"');
  const { html, slug, subdomain, canonicalUrl } = await generateHtml(product);

  let deployResult;
  if (IS_VPS) {
    deployResult = await smartDeploy(slug, html, subdomain);
  } else {
    const localDir = path.join(process.cwd(), 'data', 'landing_pages', slug);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'index.html'), html, 'utf8');
    log.info('[LP] (dev) HTML salvo em: ' + localDir);
    deployResult = { url: 'file://' + localDir, provider: 'local' };
  }

  const landingPageUrl = deployResult.url;
  updateLandingPageUrl(product.id, landingPageUrl);
  log.info('[LP] Deployed via ' + deployResult.provider + ': ' + landingPageUrl);
  return { landingPageUrl, slug, subdomain };
}

// ── 10 línguas de publicação (§ genia.md — idiomas do autonomous agent) ───────
const LANGUAGES = [
  { code: 'pt', lang: 'pt-BR', label: 'Português',  prefix: '' },       // sem prefix = slug principal
  { code: 'en', lang: 'en',    label: 'English',     prefix: 'en-' },
  { code: 'es', lang: 'es',    label: 'Español',     prefix: 'es-' },
  { code: 'fr', lang: 'fr',    label: 'Français',    prefix: 'fr-' },
  { code: 'de', lang: 'de',    label: 'Deutsch',     prefix: 'de-' },
  { code: 'it', lang: 'it',    label: 'Italiano',    prefix: 'it-' },
  { code: 'pl', lang: 'pl',    label: 'Polski',      prefix: 'pl-' },
  { code: 'nl', lang: 'nl',    label: 'Nederlands',  prefix: 'nl-' },
  { code: 'ja', lang: 'ja',    label: '日本語',       prefix: 'ja-' },
  { code: 'zh', lang: 'zh-CN', label: '中文',         prefix: 'zh-' },
];

// Generate HTML in a specific language (reuses callGemini with language instruction)
async function generateHtmlMultilang(product, langConfig) {
  // Use tracking URL for click counting
  product = { ...product, affiliate_link: getTrackingUrl(product) };
  const baseSlug = makeSlug(product.product_name);
  const slug = langConfig.prefix + baseSlug;
  const subdomain = slug + '.' + BASE_DOMAIN;
  const canonicalUrl = AFFILIATE_LP_BASE_URL ? AFFILIATE_LP_BASE_URL + '/' + slug + '/' : 'https://' + subdomain;
  const price = product.price ? 'R$ ' + product.price.toFixed(2).replace('.', ',') : '';

  const isPortuguese = langConfig.code === 'pt';
  const languageInstruction = isPortuguese
    ? 'em português brasileiro'
    : `in ${langConfig.label} (${langConfig.lang}). Translate ALL text including benefits, FAQ, testimonials, and CTAs to ${langConfig.label}.`;

  const prompt = `Create a complete affiliate product landing page ${languageInstruction}.

Product name: "${product.product_name}"
Category: ${product.category || 'General'}
${price ? 'Price: ' + price : ''}
Affiliate link: ${product.affiliate_link}
Canonical URL: ${canonicalUrl}
Platform: ${product.platform}
Language: ${langConfig.lang}

MANDATORY REQUIREMENTS:
1. Complete valid HTML (<!DOCTYPE html> to </html>)
2. Inline CSS ONLY (no external CSS, no CDN, no frameworks)
3. Mobile-first responsive design
4. SEO: title (60 chars max), meta description (155 chars max), canonical, Open Graph tags, schema.org Product JSON-LD
5. <html lang="${langConfig.lang}">
6. Page sections (all in ${langConfig.label}):
   - Hero: compelling headline + CTA button "Buy Now" / equivalent in ${langConfig.label}
   - Benefits: 5 bullet points with emoji icons
   - "Who is this for?" section with 3 profiles
   - 3 testimonials (fictional — add small disclosure)
   - FAQ: 5 relevant Q&As
   - Final CTA + big button
   - Footer: affiliate disclosure in ${langConfig.label}
7. All purchase links → ${product.affiliate_link}
8. No external images (use CSS gradients and emojis only)
9. Affiliate disclosure visible in small font

Return ONLY the complete HTML, no markdown, no explanations, no \`\`\`html.`;

  let html = '';
  // Se o Gemini falhou 2x seguidas (quota/billing), pula direto p/ fallback no resto do lote.
  if (_geminiDead < 2) {
    for (let attempt = 0; attempt < Math.min(3, GEMINI_KEYS.length + 1); attempt++) {
      try {
        if (attempt > 0) await sleep(2000);
        const raw = await callGemini(prompt);
        html = raw.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        if (!html.includes('<!DOCTYPE') && !html.includes('<html')) html = '<!DOCTYPE html>' + html;
        _geminiDead = 0;
        break;
      } catch (e) {
        _geminiDead++;
        log.warn('[LP][' + langConfig.code + '] Gemini attempt ' + (attempt + 1) + ' failed: ' + e.message.slice(0, 80));
      }
    }
  }

  if (!html) {
    const price2 = product.price ? 'R$ ' + product.price.toFixed(2).replace('.', ',') : 'Ver preço';
    html = generateFallbackHtml({ ...product }, canonicalUrl, price2);
  }

  return { html, slug, subdomain, canonicalUrl, langConfig };
}

// Deploy one language version of a landing page — smart (VPS or cloud)
async function deployLandingPageLang(product, langConfig) {
  const { html, slug, subdomain, canonicalUrl } = await generateHtmlMultilang(product, langConfig);

  let deployResult;
  if (IS_VPS || FORCE_CLOUD) {
    // Smart deploy: VPS if healthy, Vercel/Netlify se overloaded ou FORCE_CLOUD
    deployResult = await smartDeploy(slug, html, subdomain);
  } else {
    // Local dev sem FORCE_CLOUD: salva arquivo
    const localDir = path.join(process.cwd(), 'data', 'landing_pages', slug);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'index.html'), html, 'utf8');
    deployResult = { url: 'file://' + localDir, provider: 'local' };
  }

  const landingPageUrl = deployResult.url;
  if (langConfig.code === 'pt') updateLandingPageUrl(product.id, landingPageUrl);

  log.info('[LP][' + langConfig.code + '] Deployed via ' + deployResult.provider + ': ' + landingPageUrl);
  return { landingPageUrl, slug, subdomain, lang: langConfig.code, provider: deployResult.provider };
}

// ── Generate all landing pages (10 languages per product) ────────────────────
async function generateLandingPages() {
  // Guards: evita explodir 10 idiomas × N produtos numa rodada só.
  const maxProducts = parseInt(process.env.LP_MAX_PRODUCTS || '0');   // 0 = sem limite
  const langFilter = (process.env.LP_LANGS || '').split(',').map(s => s.trim()).filter(Boolean);
  const langs = langFilter.length ? LANGUAGES.filter(l => langFilter.includes(l.code)) : LANGUAGES;

  log.info('[LP] Iniciando geração de landing pages (' + langs.length + ' idioma(s) por produto)...');
  let products = getProductsWithLinks();
  log.info('[LP] ' + products.length + ' produtos com affiliate_link encontrados');
  if (maxProducts > 0) {
    products = products.slice(0, maxProducts);
    log.info('[LP] Limitado a ' + products.length + ' produto(s) (LP_MAX_PRODUCTS)');
  }

  const deployed = [];
  for (const product of products) {
    log.info('[LP] Produto: "' + product.product_name.slice(0, 50) + '" [' + product.platform + ']');

    for (const langConfig of langs) {
      const baseSlug = langConfig.prefix + makeSlug(product.product_name);
      // Skip PT if already has landing_page_url (other langs always regenerate to fill gaps)
      if (langConfig.code === 'pt' && product.landing_page_url) {
        log.info('[LP][pt] Já deployado → ' + product.landing_page_url);
        continue;
      }
      try {
        const result = await deployLandingPageLang(product, langConfig);
        deployed.push({ product: product.product_name, lang: langConfig.code, ...result });
        await sleep(2000); // Rate-limit Gemini across 10 calls per product
      } catch (e) {
        log.error('[LP][' + langConfig.code + '] Erro em "' + product.product_name.slice(0, 40) + '": ' + e.message);
      }
    }
  }

  log.info('[LP] Concluído: ' + deployed.length + ' landing pages criadas (' + products.length + ' produtos × ' + langs.length + ' idiomas)');
  return deployed;
}

// ── Deploy em UM site Netlify só (todas as páginas em paths + hub) ────────────
// Evita 1 site por produto (348 sites). Multi-file deploy via API de digest.
const crypto = require('crypto');

function _batchSiteFile() { return path.join(__dirname, '../../data/netlify_batch_site.json'); }

async function getOrCreateBatchSite() {
  if (process.env.NETLIFY_BATCH_SITE_ID) return process.env.NETLIFY_BATCH_SITE_ID;
  try { const j = JSON.parse(fs.readFileSync(_batchSiteFile(), 'utf8')); if (j.siteId) return j.siteId; } catch (_) {}
  // nome único (sufixo aleatório p/ evitar colisão global de nome no Netlify)
  const suffix = Math.abs((Date.now() ^ (Math.random() * 1e9)) | 0).toString(36).slice(0, 6);
  const site = await netlifyRequest('POST', '/api/v1/sites', { name: 'veloxisit-afiliados-' + suffix });
  const id = site.id || site.site_id;
  try { fs.mkdirSync(path.dirname(_batchSiteFile()), { recursive: true }); fs.writeFileSync(_batchSiteFile(), JSON.stringify({ siteId: id, url: site.ssl_url || site.url })); } catch (_) {}
  return id;
}

async function deployFilesToNetlify(siteId, files) {
  const digest = {}, byPath = {};
  for (const [p, html] of Object.entries(files)) {
    const buf = Buffer.from(html, 'utf8');
    digest[p] = crypto.createHash('sha1').update(buf).digest('hex');
    byPath[p] = buf;
  }
  const deploy = await netlifyRequest('POST', `/api/v1/sites/${siteId}/deploys`, { files: digest });
  const need = new Set(Array.isArray(deploy.required) ? deploy.required : []);
  for (const [p, buf] of Object.entries(byPath)) {
    if (need.has(digest[p])) {
      await netlifyRequest('PUT', `/api/v1/deploys/${deploy.id}/files${p}`, buf, 'application/octet-stream');
    }
  }
  return deploy;
}

// Dicionário de localização das páginas/hubs (template determinístico, sem IA)
const LP_I18N = {
  pt: { htmlLang: 'pt-BR', offer: 'Oferta Especial', buy: 'Comprar Agora', secure: 'Garantir Meu Produto',
    why: 'Por que escolher este produto?', faqT: 'Perguntas Frequentes',
    benefits: ['Qualidade comprovada', 'Entrega rápida', 'Melhor preço', 'Compra segura', 'Alta avaliação'],
    faq: [['O produto tem garantia?', 'Sim, segue a política da plataforma vendedora.'],
          ['Como faço para comprar?', 'Clique no botão "Comprar Agora" acima.'],
          ['O pagamento é seguro?', 'Sim, a compra é processada pela plataforma oficial.']],
    affNote: 'Link de afiliado — ganho comissão sem custo extra para você',
    affFoot: '*Links de afiliado — posso ganhar comissão sem custo adicional para você.',
    hubTitle: '🛒 Ofertas Selecionadas', hubSub: 'produtos com os melhores preços', see: 'Ver oferta',
    hubFoot: 'Contém links de afiliado. Podemos receber comissão pelas compras, sem custo extra para você.',
    metaDesc: n => `Conheça ${n}. Produto de qualidade com ótimo custo-benefício.`,
    priceNote: 'na Amazon — preço pode variar', trustSecure: 'Compra segura', trustShip: 'Envio pela Amazon', trustReturn: 'Devolução fácil',
    search: 'Buscar produto...', all: 'Todos' },
  en: { htmlLang: 'en', offer: 'Special Offer', buy: 'Buy Now', secure: 'Get My Product',
    why: 'Why choose this product?', faqT: 'Frequently Asked Questions',
    benefits: ['Proven quality', 'Fast delivery', 'Best price', 'Secure checkout', 'Top rated'],
    faq: [['Does the product have a warranty?', 'Yes, per the selling platform policy.'],
          ['How do I buy?', 'Click the "Buy Now" button above.'],
          ['Is payment secure?', 'Yes, the purchase is processed by the official platform.']],
    affNote: 'Affiliate link — I earn a commission at no extra cost to you',
    affFoot: '*Affiliate links — I may earn a commission at no additional cost to you.',
    hubTitle: '🛒 Curated Deals', hubSub: 'products at the best prices', see: 'View deal',
    hubFoot: 'Contains affiliate links. We may earn a commission, at no extra cost to you.',
    metaDesc: n => `Discover ${n}. Quality product with great value for money.`,
    priceNote: 'on Amazon — price may vary', trustSecure: 'Secure checkout', trustShip: 'Shipped by Amazon', trustReturn: 'Easy returns',
    search: 'Search products...', all: 'All' },
  es: { htmlLang: 'es', offer: 'Oferta Especial', buy: 'Comprar Ahora', secure: 'Asegurar Mi Producto',
    why: '¿Por qué elegir este producto?', faqT: 'Preguntas Frecuentes',
    benefits: ['Calidad comprobada', 'Entrega rápida', 'Mejor precio', 'Compra segura', 'Alta valoración'],
    faq: [['¿El producto tiene garantía?', 'Sí, según la política de la plataforma vendedora.'],
          ['¿Cómo compro?', 'Haz clic en el botón "Comprar Ahora" arriba.'],
          ['¿El pago es seguro?', 'Sí, la compra la procesa la plataforma oficial.']],
    affNote: 'Enlace de afiliado — gano comisión sin costo extra para ti',
    affFoot: '*Enlaces de afiliado — puedo ganar comisión sin costo adicional para ti.',
    hubTitle: '🛒 Ofertas Seleccionadas', hubSub: 'productos a los mejores precios', see: 'Ver oferta',
    hubFoot: 'Contiene enlaces de afiliado. Podemos recibir comisión, sin costo extra para ti.',
    metaDesc: n => `Descubre ${n}. Producto de calidad con excelente relación precio-calidad.`,
    priceNote: 'en Amazon — el precio puede variar', trustSecure: 'Compra segura', trustShip: 'Envío por Amazon', trustReturn: 'Devolución fácil',
    search: 'Buscar producto...', all: 'Todos' },
};

function buildLocalizedPage(product, langCode, canonicalUrl, hubPrefix) {
  const t = LP_I18N[langCode] || LP_I18N.pt;
  const name = product.product_name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (product.affiliate_link || '#').replace(/"/g, '%22');
  const img = product.image_url && /^https?:/.test(product.image_url) ? product.image_url : null;
  const price = product.price ? 'R$ ' + product.price.toFixed(2).replace('.', ',') : '';
  const hubHref = hubPrefix || '/';
  const benefitsHtml = t.benefits.map((b, i) => `<div class="benefit"><span>${['✓','⚡','💰','🔒','★'][i]}</span><p>${b}</p></div>`).join('');
  const faqHtml = t.faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('');
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: product.product_name,
    ...(img ? { image: img } : {}), ...(product.price ? { offers: { '@type': 'Offer', price: product.price.toFixed(2), priceCurrency: 'BRL', url: canonicalUrl } } : {}),
  });
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} — ${t.offer}</title>
<meta name="description" content="${t.metaDesc(name)}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${name}"><meta property="og:url" content="${canonicalUrl}"><meta property="og:type" content="product">
${img ? `<meta property="og:image" content="${img}">` : ''}
<script type="application/ld+json">${jsonLd}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--acc:#2563eb;--cta:#ff6b35}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--ink);background:#f8fafc;line-height:1.6}
.top{background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;position:sticky;top:0;z-index:10}
.top a{color:var(--acc);text-decoration:none;font-weight:700;font-size:.95rem}
.wrap{max-width:1040px;margin:0 auto;padding:32px 20px}
.hero{display:grid;grid-template-columns:1fr 1fr;gap:40px;background:#fff;border:1px solid var(--line);border-radius:24px;padding:40px;align-items:center;box-shadow:0 4px 24px rgba(15,23,42,.06)}
.pic{display:flex;align-items:center;justify-content:center;background:#fff;border-radius:16px;min-height:340px}
.pic img{max-width:100%;max-height:380px;object-fit:contain}
.pic .ph{font-size:6rem}
h1{font-size:1.55rem;line-height:1.35;margin-bottom:14px;font-weight:800}
.price{font-size:2.2rem;font-weight:800;color:var(--ink);margin:10px 0 4px}
.price small{font-size:.85rem;color:var(--mut);font-weight:500;display:block}
.cta{display:block;text-align:center;background:var(--cta);color:#fff;padding:17px 30px;border-radius:14px;text-decoration:none;font-size:1.15rem;font-weight:800;margin:22px 0 10px;box-shadow:0 8px 24px rgba(255,107,53,.35);transition:transform .15s, box-shadow .15s}
.cta:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(255,107,53,.45)}
.trust{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}
.trust span{font-size:.8rem;color:var(--mut);background:#f1f5f9;border-radius:8px;padding:6px 12px;font-weight:600}
.note{font-size:.74rem;color:var(--mut);margin-top:12px}
h2{font-size:1.25rem;margin:46px 0 18px;font-weight:800}
.benefits{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}
.benefit{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;text-align:center}
.benefit span{display:inline-flex;width:42px;height:42px;align-items:center;justify-content:center;background:#eff6ff;color:var(--acc);border-radius:12px;font-size:1.2rem;font-weight:800;margin-bottom:10px}
.benefit p{font-size:.9rem;font-weight:600}
.faq{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 20px;margin-bottom:10px}
.faq summary{font-weight:700;cursor:pointer;font-size:.95rem}
.faq p{margin-top:10px;color:var(--mut);font-size:.92rem}
.bottom-cta{text-align:center;margin:40px 0 8px}
.bottom-cta .cta{display:inline-block;min-width:320px}
footer{text-align:center;color:#94a3b8;font-size:.78rem;padding:34px 20px;border-top:1px solid var(--line);margin-top:40px}
@media(max-width:760px){.hero{grid-template-columns:1fr;padding:24px}.pic{min-height:240px}.pic img{max-height:260px}h1{font-size:1.3rem}}
</style>
</head>
<body>
<div class="top"><div class="wrap" style="padding:0;max-width:1040px"><a href="${hubHref}">← ${t.hubTitle.replace('🛒 ', '')}</a></div></div>
<div class="wrap">
  <div class="hero">
    <div class="pic">${img ? `<img src="${img}" alt="${name}" loading="eager">` : '<div class="ph">🛍️</div>'}</div>
    <div>
      <h1>${name}</h1>
      ${price ? `<div class="price">${price}<small>${t.priceNote}</small></div>` : ''}
      <a href="${link}" class="cta" rel="nofollow sponsored">${t.buy} →</a>
      <div class="trust"><span>🔒 ${t.trustSecure}</span><span>🚚 ${t.trustShip}</span><span>↩️ ${t.trustReturn}</span></div>
      <p class="note">${t.affNote}</p>
    </div>
  </div>
  <h2>${t.why}</h2>
  <div class="benefits">${benefitsHtml}</div>
  <h2>${t.faqT}</h2>
  ${faqHtml}
  <div class="bottom-cta"><a href="${link}" class="cta" rel="nofollow sponsored">${t.secure} →</a></div>
</div>
<footer>${t.affFoot}<br>© ${new Date().getFullYear()} ${BASE_DOMAIN}</footer>
</body></html>`;
}

function buildHubHtml(items, langCode = 'pt', allLangs = ['pt']) {
  const t = LP_I18N[langCode] || LP_I18N.pt;
  const prefix = langCode === 'pt' ? '' : '/' + langCode;
  const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const switcher = allLangs.length > 1
    ? allLangs.map(l => l === langCode
        ? `<span class="lng on">${l.toUpperCase()}</span>`
        : `<a class="lng" href="${l === 'pt' ? '/' : '/' + l + '/'}">${l.toUpperCase()}</a>`).join('')
    : '';
  const cats = [...new Set(items.map(it => it.category).filter(Boolean))];
  const chips = ['<button class="chip on" data-cat="*">' + t.all + '</button>']
    .concat(cats.map(c => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`)).join('');
  const cards = items.map(it => {
    const price = it.price ? 'R$ ' + it.price.toFixed(2).replace('.', ',') : '';
    const media = it.image ? `<img src="${esc(it.image)}" alt="${esc(it.name)}" loading="lazy">` : `<div class="ph">${it.emoji}</div>`;
    return `
    <a class="card" href="${prefix}/${it.slug}/" data-cat="${esc(it.category || '')}" data-name="${esc((it.name || '').toLowerCase())}">
      <div class="media">${media}</div>
      <div class="body">
        <div class="name">${esc((it.name || '').slice(0, 84))}</div>
        <div class="row">${price ? `<div class="price">${price}</div>` : '<div></div>'}<div class="go">${t.see} →</div></div>
      </div>
    </a>`;
  }).join('');
  return `<!DOCTYPE html><html lang="${t.htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.hubTitle.replace('🛒 ', '')} — Veloxisit</title>
<meta name="description" content="${items.length} ${t.hubSub}.">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--acc:#2563eb;--cta:#ff6b35}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:var(--ink)}
.hd{background:linear-gradient(120deg,#1d4ed8,#7c3aed);color:#fff;padding:54px 20px 88px;text-align:center;position:relative}
.hd h1{font-size:2.3rem;font-weight:900;letter-spacing:-.5px}
.hd p{opacity:.85;margin-top:8px;font-size:1.05rem}
.lngs{position:absolute;top:18px;right:22px}
.lng{display:inline-block;margin-left:6px;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;text-decoration:none;font-weight:700;font-size:.8rem}
.lng.on{background:#fff;color:#1d4ed8}
.tools{max-width:1140px;margin:-52px auto 0;padding:0 20px;position:relative;z-index:2}
.search{width:100%;padding:16px 22px;border:1px solid var(--line);border-radius:16px;font-size:1rem;box-shadow:0 10px 30px rgba(15,23,42,.10);outline:none;background:#fff}
.search:focus{border-color:var(--acc)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.chip{border:1px solid var(--line);background:#fff;color:var(--mut);padding:8px 16px;border-radius:999px;font-size:.85rem;font-weight:700;cursor:pointer;transition:.15s}
.chip.on,.chip:hover{background:var(--ink);color:#fff;border-color:var(--ink)}
.grid{max-width:1140px;margin:26px auto;padding:0 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:18px}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden;text-decoration:none;color:inherit;display:flex;flex-direction:column;transition:transform .18s, box-shadow .18s}
.card:hover{transform:translateY(-5px);box-shadow:0 14px 34px rgba(15,23,42,.12)}
.media{height:200px;display:flex;align-items:center;justify-content:center;background:#fff;padding:16px;border-bottom:1px solid #f1f5f9}
.media img{max-width:100%;max-height:100%;object-fit:contain}
.ph{font-size:3.4rem}
.body{padding:16px 18px 18px;display:flex;flex-direction:column;gap:12px;flex:1}
.name{font-weight:700;font-size:.92rem;line-height:1.4;flex:1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row{display:flex;align-items:center;justify-content:space-between}
.price{font-weight:900;font-size:1.12rem}
.go{color:var(--cta);font-weight:800;font-size:.85rem}
.empty{display:none;text-align:center;color:var(--mut);padding:60px 20px}
footer{text-align:center;color:#94a3b8;font-size:.78rem;padding:36px 20px;border-top:1px solid var(--line);margin-top:30px}
@media(max-width:640px){.hd h1{font-size:1.7rem}.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}.media{height:150px}}
</style></head>
<body>
<header class="hd"><div class="lngs">${switcher}</div><h1>${t.hubTitle}</h1><p>${items.length} ${t.hubSub}</p></header>
<div class="tools">
  <input class="search" id="q" type="search" placeholder="${t.search}">
  <div class="chips" id="chips">${chips}</div>
</div>
<div class="grid" id="grid">${cards}</div>
<div class="empty" id="empty">∅</div>
<footer>${t.hubFoot}</footer>
<script>
(function(){
  var q=document.getElementById('q'),grid=document.getElementById('grid'),cards=[].slice.call(grid.children),cat='*';
  function apply(){var s=q.value.toLowerCase().trim(),n=0;cards.forEach(function(c){var ok=(cat==='*'||c.dataset.cat===cat)&&(!s||c.dataset.name.indexOf(s)>-1);c.style.display=ok?'':'none';if(ok)n++;});document.getElementById('empty').style.display=n?'none':'block';}
  q.addEventListener('input',apply);
  document.getElementById('chips').addEventListener('click',function(e){var b=e.target.closest('.chip');if(!b)return;document.querySelectorAll('.chip').forEach(function(x){x.classList.remove('on')});b.classList.add('on');cat=b.dataset.cat;apply();});
})();
</script>
</body></html>`;
}

/**
 * Gera e publica TODAS as landing pages (produtos com affiliate_link) em UM site Netlify.
 * pt em /slug/, outros idiomas em /<lang>/slug/, hubs em / , /en/, /es/ (com seletor).
 * Template localizado determinístico (rápido, sem depender de quota de IA).
 * opts: { langs=['pt','en','es'], platform=null, max=0 }
 */
async function deployAllOneSite(opts = {}) {
  const langs = (opts.langs || (process.env.LP_LANGS || 'pt,en,es').split(',').map(s => s.trim()).filter(Boolean))
    .filter(l => LP_I18N[l]);
  if (!langs.includes('pt')) langs.unshift('pt');
  let products = getProductsWithLinks();
  if (opts.platform) products = products.filter(p => p.platform === opts.platform);
  if (opts.max) products = products.slice(0, opts.max);
  log.info('[LP-batch] Gerando ' + products.length + ' produtos × ' + langs.length + ' idiomas (' + langs.join(',') + ') p/ 1 site...');

  const files = {}, items = [];
  const emojiFor = c => /fone|som|bluetooth|caixa/i.test(c) ? '🎧' : /smartwatch|watch|rel[óo]gio/i.test(c) ? '⌚' :
    /fry|fritadeira|cafeteira|liquidi|panela|cook/i.test(c) ? '🍳' : /webcam|c[âa]mera/i.test(c) ? '📷' :
    /aspirador|robo/i.test(c) ? '🤖' : /kindle|livro|ebook/i.test(c) ? '📚' : '🛍️';
  for (const product of products) {
    try {
      const baseSlug = makeSlug(product.product_name);
      const tracked = { ...product, affiliate_link: getTrackingUrl(product) };
      for (const lc of langs) {
        const prefix = lc === 'pt' ? '' : '/' + lc;
        const pagePath = prefix + '/' + baseSlug + '/index.html';
        const canonical = 'https://' + BASE_DOMAIN + prefix + '/' + baseSlug + '/';
        files[pagePath] = buildLocalizedPage(tracked, lc, canonical, lc === 'pt' ? '/' : '/' + lc + '/');
      }
      items.push({
        slug: baseSlug, name: product.product_name, id: product.id,
        image: product.image_url || null, price: product.price || 0, category: product.category || '',
        emoji: emojiFor((product.category || '') + ' ' + product.product_name),
      });
    } catch (e) { log.warn('[LP-batch] erro "' + product.product_name.slice(0, 30) + '": ' + e.message.slice(0, 60)); }
  }
  if (!items.length) { log.warn('[LP-batch] nenhuma página gerada'); return { siteUrl: null, count: 0 }; }
  for (const lc of langs) {
    const hubPath = lc === 'pt' ? '/index.html' : '/' + lc + '/index.html';
    files[hubPath] = buildHubHtml(items, lc, langs);
  }

  const siteId = await getOrCreateBatchSite();
  const deploy = await deployFilesToNetlify(siteId, files);
  const siteUrl = deploy.ssl_url || deploy.deploy_ssl_url || deploy.url || ('https://' + (deploy.subdomain || '') + '.netlify.app');
  for (const it of items) { try { updateLandingPageUrl(it.id, siteUrl.replace(/\/$/, '') + '/' + it.slug + '/'); } catch (_) {} }
  log.info('[LP-batch] ✅ ' + items.length + ' produtos × ' + langs.length + ' idiomas (' + Object.keys(files).length + ' arquivos) no ar em ' + siteUrl);
  return { siteUrl, count: items.length, langs, files: Object.keys(files).length };
}

module.exports = {
  generateLandingPages, deployLandingPage, deployLandingPageLang, deployAllOneSite,
  buildHubHtml, buildLocalizedPage, LANGUAGES,
};
