/**
 * API Routes — Ebooks, Stats, Generate, Publish
 */
const express  = require('express');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const path     = require('path');
const router   = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'genia-ebook-secret-2026-change-in-prod';
const PDFS_DIR   = path.join(__dirname, '../../data/pdfs');
const COVERS_DIR = path.join(__dirname, '../../data/covers');

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token obrigatório' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getDb() {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, '../../data/metrics.db'));
  db.pragma('journal_mode = WAL');
  return db;
}

// Scan filesystem + merge with DB records
function getAllEbooksData() {
  const db = getDb();

  // Todos do banco
  const dbEbooks = db.prepare('SELECT * FROM ebooks ORDER BY created_at DESC').all();
  const dbMap = new Map(dbEbooks.map(e => [path.basename(e.pdf_path || ''), e]));

  // Scan filesystem de PDFs
  const pdfFiles = fs.existsSync(PDFS_DIR)
    ? fs.readdirSync(PDFS_DIR).filter(f => f.endsWith('.pdf')).sort().reverse()
    : [];

  const result = [];

  for (const fname of pdfFiles) {
    const fullPath = path.join(PDFS_DIR, fname);
    const stat = fs.statSync(fullPath);
    const dbRecord = dbMap.get(fname);

    // Tentar encontrar a capa correspondente (pelo timestamp no nome do arquivo)
    const ts = fname.match(/(\d{13})/)?.[1];
    let coverFile = null;
    if (ts && fs.existsSync(COVERS_DIR)) {
      const covers = fs.readdirSync(COVERS_DIR).filter(f => f.includes(ts));
      if (covers.length) coverFile = covers[0];
    }

    result.push({
      id:          dbRecord?.id || fname.replace('.pdf', ''),
      title:       dbRecord?.title || 'E-book ' + new Date(parseInt(ts || stat.mtimeMs)).toLocaleDateString('pt-BR'),
      subtitle:    dbRecord?.subtitle || '',
      topic:       dbRecord?.topic || '',
      status:      dbRecord?.status || 'ready',
      pdfFile:     fname,
      pdfUrl:      `/pdfs/${fname}`,
      coverUrl:    coverFile ? `/covers/${coverFile}` : null,
      sizeKb:      Math.round(stat.size / 1024),
      createdAt:   dbRecord?.created_at || new Date(stat.mtimeMs).toISOString(),
      price:       dbRecord?.price || 4.99,
      sales:       dbRecord?.sales_count || 0,
      revenue:     dbRecord?.revenue || 0,
      caktoUrl:    dbRecord?.cakto_url || null,
      hotmartUrl:  dbRecord?.hotmart_url || null,
      amazonUrl:   dbRecord?.amazon_url || null,
    });
  }

  return result;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/stats
router.get('/stats', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const ebooks = getAllEbooksData();
    const published = ebooks.filter(e => e.status === 'published').length;
    const totalRevenue = ebooks.reduce((s, e) => s + (e.revenue || 0), 0);
    const totalSales   = ebooks.reduce((s, e) => s + (e.sales || 0), 0);

    res.json({
      totalEbooks:  ebooks.length,
      published,
      ready:        ebooks.filter(e => e.status === 'ready').length,
      totalSales,
      totalRevenue: totalRevenue.toFixed(2),
      aiProviders:  getAiStatus(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ebooks
router.get('/ebooks', requireAuth, (req, res) => {
  try {
    const ebooks = getAllEbooksData();
    res.json({ ok: true, ebooks, total: ebooks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ebooks/:id
router.get('/ebooks/:id', requireAuth, (req, res) => {
  try {
    const all = getAllEbooksData();
    const ebook = all.find(e => e.id === req.params.id || e.pdfFile === req.params.id + '.pdf');
    if (!ebook) return res.status(404).json({ error: 'E-book não encontrado' });
    res.json({ ok: true, ebook });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/topics
router.get('/topics', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const topics = db.prepare('SELECT * FROM topics ORDER BY ml_score DESC, demand_score DESC').all();
    res.json({ ok: true, topics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/generate — Gerar novo e-book
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { topic } = req.body;
    res.json({ ok: true, message: 'Geração iniciada', topic: topic || 'automático' });

    // Rodar pipeline em background
    setImmediate(async () => {
      try {
        const { runPipeline } = require('../index');
        if (runPipeline) await runPipeline(topic || null);
      } catch (e) {
        console.error('Pipeline error:', e.message);
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/publish/:platform — Publicar em plataforma
router.post('/publish/:platform', requireAuth, async (req, res) => {
  const { platform } = req.params;
  const { ebookId }  = req.body;

  if (!['cakto', 'hotmart', 'amazon'].includes(platform)) {
    return res.status(400).json({ error: 'Plataforma inválida. Use: cakto, hotmart, amazon' });
  }

  try {
    const all    = getAllEbooksData();
    const ebook  = all.find(e => e.id === ebookId || e.pdfFile === ebookId + '.pdf');
    if (!ebook) return res.status(404).json({ error: 'E-book não encontrado' });

    res.json({ ok: true, message: `Publicação no ${platform} iniciada`, ebook: ebook.title });

    setImmediate(async () => {
      try {
        const ebookData = {
          ...ebook,
          pdfPath:   path.join(PDFS_DIR, ebook.pdfFile),
          coverPath: ebook.coverUrl ? path.join(COVERS_DIR, path.basename(ebook.coverUrl)) : null,
        };

        let result;
        if (platform === 'cakto') {
          const { publishToCakto } = require('../agents/publisherCakto');
          result = await publishToCakto(ebookData);
        } else if (platform === 'hotmart') {
          const { publishToHotmart } = require('../agents/publisherHotmart');
          result = await publishToHotmart(ebookData);
        } else if (platform === 'amazon') {
          const { publishToAmazon } = require('../agents/publisherAmazon');
          result = await publishToAmazon(ebookData);
        }

        // Atualizar status no banco se tiver ID real
        if (result?.success) {
          const db = getDb();
          const updates = {};
          if (platform === 'cakto')   updates.cakto_url   = result.url;
          if (platform === 'hotmart') updates.hotmart_url = result.url;
          if (platform === 'amazon')  updates.amazon_url  = result.url;
          const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
          if (setClause) {
            db.prepare(`UPDATE ebooks SET ${setClause}, status = 'published' WHERE id = ?`)
              .run(...Object.values(updates), ebook.id);
          }
        }
      } catch (e) {
        console.error(`Publish ${platform} error:`, e.message);
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai-status
router.get('/ai-status', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, providers: getAiStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getAiStatus() {
  try {
    const { getStatus } = require('../core/aiClient');
    return getStatus();
  } catch (e) {
    return {};
  }
}

// POST /api/reset-ai — Resetar estado dos providers
router.post('/reset-ai', requireAuth, (req, res) => {
  try {
    const { resetDegraded } = require('../core/aiClient');
    resetDegraded(req.body.provider || null);
    res.json({ ok: true, message: 'Estado AI resetado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Agente Autônomo ─────────────────────────────────────────────────────────

// GET /api/agent/status
router.get('/agent/status', requireAuth, (req, res) => {
  try {
    const agent = require('../core/autonomousAgent');
    res.json({ ok: true, ...agent.getStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/pause
router.post('/agent/pause', requireAuth, (req, res) => {
  try {
    require('../core/autonomousAgent').pause();
    res.json({ ok: true, message: 'Agente pausado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/resume
router.post('/agent/resume', requireAuth, (req, res) => {
  try {
    require('../core/autonomousAgent').resume();
    res.json({ ok: true, message: 'Agente retomado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/trigger — Forçar geração imediata
router.post('/agent/trigger', requireAuth, (req, res) => {
  try {
    const { topic } = req.body;
    require('../core/autonomousAgent').triggerNow(topic || null);
    res.json({ ok: true, message: 'Ciclo forçado' + (topic ? `: "${topic}"` : '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/sync-sales — Sincronizar vendas das plataformas agora
router.post('/agent/sync-sales', requireAuth, (req, res) => {
  res.json({ ok: true, message: 'Sincronização de vendas iniciada em background' });
  setImmediate(async () => {
    try {
      const { syncSalesFromPlatforms } = require('../agents/learningAgent');
      const result = await syncSalesFromPlatforms();
      console.info('[api] sync-sales concluído:', result);
    } catch (e) { console.error('[api] sync-sales erro:', e.message); }
  });
});


// ─── Public Status Route (no auth required) ──────────────────────────────────

// GET /api/status — Monitoring endpoint (no auth required)
router.get('/status', (req, res) => {
  try {
    const db  = getDb();
    const fs2 = require('fs');

    // Uptime
    const uptimeSec = process.uptime();

    // E-book counts
    const total     = db.prepare("SELECT COUNT(*) as n FROM ebooks").get().n;
    const published = db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE status='published'").get().n;
    const errors    = db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE status='error'").get().n;
    const pending   = db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE status IN ('processing','ready')").get().n;

    // Receita / vendas reais (somatório do banco)
    const agg = db.prepare("SELECT COALESCE(SUM(revenue),0) rev, COALESCE(SUM(sales_count),0) sales FROM ebooks").get();

    // Últimos 20 e-books — com capa, preço, IDs de produto e links de loja
    const last10 = db.prepare(
      "SELECT id, title, subtitle, topic, status, price, sales_count, revenue, " +
      "cover_path, pdf_path, hotmart_url, hotmart_product_id, cakto_url, cakto_product_id, " +
      "ai_provider, created_at, published_at FROM ebooks ORDER BY created_at DESC LIMIT 20"
    ).all().map(e => ({
      ...e,
      amazon_url: null,
      // converte caminho absoluto da capa em URL web servida por /covers
      coverUrl: e.cover_path ? '/covers/' + path.basename(e.cover_path) : null,
    }));

    // Recent errors (last 5)
    const recentErrors = db.prepare("SELECT id, title, created_at FROM ebooks WHERE status='error' ORDER BY created_at DESC LIMIT 5").all();

    // AI state from file (portável: usa data/ local, com fallback Docker)
    let aiState = null;
    for (const p of [path.join(__dirname, '../../data/ai_state.json'), '/app/data/ai_state.json']) {
      if (fs2.existsSync(p)) { try { aiState = JSON.parse(fs2.readFileSync(p, 'utf8')); break; } catch(_) {} }
    }
    // Live AI provider status
    let aiProviders = {};
    try {
      const { getStatus } = require('../core/aiClient');
      aiProviders = getStatus();
    } catch(_) {}

    // Sessions (portável: data/sessions local, com fallback Docker)
    let sessionsDir = path.join(__dirname, '../../data/sessions');
    if (!fs2.existsSync(sessionsDir) && fs2.existsSync('/app/data/sessions')) sessionsDir = '/app/data/sessions';
    const sessions = { hotmart: false, cakto: false, amazon: false };
    if (fs2.existsSync(sessionsDir)) {
      const files = fs2.readdirSync(sessionsDir);
      ['hotmart', 'cakto', 'amazon'].forEach(p => {
        sessions[p] = files.some(f => f.toLowerCase().includes(p));
      });
    }

    res.json({
      ok: true,
      uptime: uptimeSec,
      uptimeHuman: _formatUptime(uptimeSec),
      timestamp: new Date().toISOString(),
      ebooks: { total, published, errors, pending, last20: last10 },
      revenue: agg.rev,
      sales: agg.sales,
      recentErrors,
      aiState,
      aiProviders,
      sessions,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function _formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm ' + s + 's';
}

// ─── Afiliados & Landing Pages ────────────────────────────────────────────────

function getAffiliateDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_products (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      platform         TEXT NOT NULL,
      product_id       TEXT,
      product_name     TEXT NOT NULL,
      product_url      TEXT,
      affiliate_link   TEXT,
      category         TEXT,
      price            REAL,
      commission_pct   REAL,
      landing_page_url TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, product_id)
    )
  `);
  return db;
}

// GET /api/affiliate-products
router.get('/affiliate-products', requireAuth, (req, res) => {
  try {
    const db = getAffiliateDb();
    const products = db.prepare(
      'SELECT * FROM affiliate_products ORDER BY created_at DESC'
    ).all();
    res.json({ ok: true, total: products.length, products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/affiliate-stats — Resumo de clicks e produtos por plataforma
router.get('/affiliate-stats', requireAuth, (req, res) => {
  try {
    const db = getAffiliateDb();
    const byPlatform = db.prepare(`
      SELECT platform,
             COUNT(*) as total_products,
             SUM(CASE WHEN affiliate_link IS NOT NULL THEN 1 ELSE 0 END) as with_link,
             SUM(CASE WHEN landing_page_url IS NOT NULL THEN 1 ELSE 0 END) as with_lp,
             COALESCE(SUM(click_count), 0) as total_clicks
      FROM affiliate_products GROUP BY platform
    `).all();

    const topClicked = db.prepare(`
      SELECT product_name, platform, click_count, landing_page_url, affiliate_link
      FROM affiliate_products WHERE click_count > 0 ORDER BY click_count DESC LIMIT 10
    `).all();

    const recentClicks = (() => {
      try {
        return db.prepare(`
          SELECT ap.product_name, ac.platform, ac.clicked_at
          FROM affiliate_clicks ac
          JOIN affiliate_products ap ON ap.id = ac.product_id
          ORDER BY ac.clicked_at DESC LIMIT 20
        `).all();
      } catch { return []; }
    })();

    res.json({ ok: true, byPlatform, topClicked, recentClicks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/go/:id — Redirect de afiliado com tracking (sem auth — público)
router.get('/go/:id', (req, res) => {
  try {
    const db = getAffiliateDb();
    const product = db.prepare('SELECT * FROM affiliate_products WHERE id = ?').get(req.params.id);
    if (!product || !product.affiliate_link) {
      return res.status(404).send('Link não encontrado');
    }

    // Registra click
    const crypto = require('crypto');
    const ip = req.ip || req.connection?.remoteAddress || '';
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);

    db.prepare('UPDATE affiliate_products SET click_count = click_count + 1 WHERE id = ?').run(product.id);
    try {
      db.prepare(`
        INSERT INTO affiliate_clicks (product_id, platform, referer, user_agent, ip_hash)
        VALUES (?, ?, ?, ?, ?)
      `).run(product.id, product.platform, req.get('referer') || '', (req.get('user-agent') || '').slice(0, 200), ipHash);
    } catch (_) {}

    // Redirect para o link de afiliado
    res.redirect(302, product.affiliate_link);
  } catch (e) {
    res.status(500).send('Erro: ' + e.message);
  }
});

// POST /api/affiliate-products/discover
router.post('/affiliate-products/discover', requireAuth, (req, res) => {
  res.json({ ok: true, message: 'Descoberta de afiliados iniciada em background' });
  setImmediate(async () => {
    try {
      const { runAffiliateAgent } = require('../agents/affiliateAgent');
      await runAffiliateAgent();
    } catch (e) { console.error('[api] affiliate discover error:', e.message); }
  });
});

// POST /api/affiliate-products/:id/generate-lp — Gera LP para produto específico
router.post('/affiliate-products/:id/generate-lp', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  res.json({ ok: true, message: 'Geração de landing page iniciada em background', id });
  setImmediate(async () => {
    try {
      const db = getAffiliateDb();
      const product = db.prepare('SELECT * FROM affiliate_products WHERE id = ?').get(id);
      if (!product) return console.error('[api] Produto não encontrado:', id);
      if (!product.affiliate_link) return console.error('[api] Produto sem affiliate_link:', id);

      const { deployLandingPage } = require('../agents/landingPageAgent');
      const result = await deployLandingPage(product);
      console.info('[api] LP gerada:', result.landingPageUrl);
    } catch (e) { console.error('[api] generate-lp error:', e.message); }
  });
});

// GET /api/landing-pages
router.get('/landing-pages', requireAuth, (req, res) => {
  try {
    const db = getAffiliateDb();
    const withLp = db.prepare(
      "SELECT * FROM affiliate_products WHERE landing_page_url IS NOT NULL AND landing_page_url != '' ORDER BY created_at DESC"
    ).all();
    const pending = db.prepare(
      "SELECT COUNT(*) as n FROM affiliate_products WHERE affiliate_link IS NOT NULL AND (landing_page_url IS NULL OR landing_page_url = '')"
    ).get().n;

    const byDeploy = { vercel: 0, netlify: 0, vps: 0 };
    const baseDomain = process.env.BASE_DOMAIN || 'veloxisit.com.br';
    for (const p of withLp) {
      const url = p.landing_page_url || '';
      if (url.includes('vercel'))        byDeploy.vercel++;
      else if (url.includes('netlify'))  byDeploy.netlify++;
      else if (url.includes(baseDomain)) byDeploy.vps++;
    }

    res.json({ ok: true, total: withLp.length, pending, pages: withLp, byDeploy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/landing-pages/generate
router.post('/landing-pages/generate', requireAuth, (req, res) => {
  res.json({ ok: true, message: 'Geração de landing pages iniciada em background' });
  setImmediate(async () => {
    try {
      const { generateLandingPages } = require('../agents/landingPageAgent');
      await generateLandingPages();
    } catch (e) { console.error('[api] landing-pages/generate error:', e.message); }
  });
});

// GET /api/web-credits — Estado dos créditos de serviços web de ebook
router.get('/web-credits', requireAuth, (req, res) => {
  try {
    const { getSummary, isAllExhausted, GMAIL_ACCOUNTS, LIMITS } = require('../agents/webEbookAgents/creditTracker');
    const summary = getSummary();
    res.json({
      ok:           true,
      exhausted:    isAllExhausted(),
      accounts:     GMAIL_ACCOUNTS.length,
      monthlyTotal: GMAIL_ACCOUNTS.length * Object.values(LIMITS).reduce((s, v) => s + v, 0),
      ...summary,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/web-credits/reset — Força reset mensal dos créditos
router.post('/web-credits/reset', requireAuth, (req, res) => {
  try {
    const { resetMonthly } = require('../agents/webEbookAgents/creditTracker');
    const state = resetMonthly();
    res.json({ ok: true, message: 'Créditos mensais resetados', month: state.month });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/backlinks/build
router.post('/backlinks/build', requireAuth, (req, res) => {
  res.json({ ok: true, message: 'Build de backlinks iniciado em background' });
  setImmediate(async () => {
    try {
      const { buildBacklinks } = require('../agents/backlinkAgent');
      await buildBacklinks();
    } catch (e) { console.error('[api] backlinks/build error:', e.message); }
  });
});

module.exports = router;
