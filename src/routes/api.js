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

module.exports = router;
