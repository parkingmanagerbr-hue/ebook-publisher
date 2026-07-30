/**
 * server.js - GENIA Publisher v2 Web Server
 * Adds Socket.io + DDD publishing routes on top of existing server.
 * Fully backward-compatible: all existing routes remain functional.
 */
'use strict';

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const jwt        = require('jsonwebtoken');

const { createLogger }   = require('./core/logger');
const authRoutes         = require('./routes/auth');
const legacyApiRoutes    = require('./routes/api');

// ── DDD Infrastructure ────────────────────────────────────────────────────────
const { getDb }              = require('./core/database');
const { runMigrations }      = require('./infrastructure/db/schema');
const { EbookRepository }    = require('./infrastructure/db/EbookRepository');
const { SessionManager }     = require('./infrastructure/session/SessionManager');

// ── Application Layer ──────────────────────────────────────────────────────────
const { PublishingOrchestrator } = require('./application/orchestrator/PublishingOrchestrator');
const { PriorityScorer }         = require('./application/ml/PriorityScorer');

// ── Presentation Routes ────────────────────────────────────────────────────────
const ebooksRoutes    = require('./presentation/api/routes/ebooks');
const publishRoutes   = require('./presentation/api/routes/publish');
const storesRoutes    = require('./presentation/api/routes/stores');
const statsRoutes     = require('./presentation/api/routes/stats');
const gutenbergRoutes = require('./presentation/api/routes/gutenberg');
const catalogRoutes   = require('./presentation/api/routes/catalog');

const logger = createLogger('server');
const app    = express();
const PORT   = process.env.DASHBOARD_PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'genia-ebook-secret-2026-change-in-prod';

// ── Ensure required data directories exist at startup ─────────────────────────
// Prevents ENOENT errors when agents try to write files on a fresh bind-mount.
const DATA_DIR = path.join(__dirname, '../data');
[
  DATA_DIR,
  path.join(DATA_DIR, 'covers'),
  path.join(DATA_DIR, 'pdfs'),
  path.join(DATA_DIR, 'audiobooks'),
  path.join(DATA_DIR, 'logs'),
  path.join(DATA_DIR, 'landing_screenshots'),
  path.join(DATA_DIR, 'sessions'),
  path.join(DATA_DIR, 'db'),
].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { /* already exists or permission error — logged below */ }
});
logger.info('Data directories ensured: ' + DATA_DIR);

// ── Bootstrap DB + Migrations ─────────────────────────────────────────────────
const db   = getDb();
runMigrations(db);
const repo = new EbookRepository(db);

// ── HTTP + Socket.io ───────────────────────────────────────────────────────────
const server = http.createServer(app);

let io = null;
let dashboardSocket = null;
let orchestrator = null;

try {
  const { Server } = require('socket.io');
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });
  logger.info('Socket.io initialized');
} catch (e) {
  logger.warn('Socket.io not available (install socket.io): ' + e.message);
}

// ── Orchestrator ───────────────────────────────────────────────────────────────
orchestrator = new PublishingOrchestrator(repo);

if (io) {
  const { DashboardSocket } = require('./presentation/websocket/DashboardSocket');
  dashboardSocket = new DashboardSocket(io, orchestrator, repo);
  dashboardSocket.init();
  logger.info('DashboardSocket initialized');
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/covers',     express.static(path.join(__dirname, '../data/covers')));
app.use('/audiobooks', express.static(path.join(__dirname, '../data/audiobooks')));
app.use('/pdfs', (req, res, next) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}, express.static(path.join(__dirname, '../data/pdfs')));

app.use(express.static(path.join(__dirname, '../public')));

// ── Auth middleware for new routes ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token required' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes);

// Legacy API (keeps all existing routes working)
app.use('/api', legacyApiRoutes);

// New DDD API routes (mounted under /api/v2 to avoid conflict)
app.use('/api/v2/ebooks',     requireAuth, ebooksRoutes(repo, PriorityScorer));
app.use('/api/v2/publish',    requireAuth, publishRoutes(orchestrator));
app.use('/api/v2/stores',     requireAuth, storesRoutes(SessionManager, orchestrator));
app.use('/api/v2/stats',      requireAuth, statsRoutes(repo));
app.use('/api/v2/gutenberg',  requireAuth, gutenbergRoutes());
app.use('/catalog/api', catalogRoutes(repo));
app.get('/catalog', (req, res) => res.sendFile(path.join(__dirname, '../public/ebooks-catalog.html')));

// ── Amazon OTP endpoint (no auth required — called by user from phone/terminal) ──
app.post('/api/amazon-otp', (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: 'code must be 4-8 digits', example: '{"code":"679751"}' });
  }
  const otpFile = '/app/data/amazon_otp.txt';
  try {
    fs.mkdirSync(require('path').dirname(otpFile), { recursive: true });
    fs.writeFileSync(otpFile, code);
    logger.info('[amazon-otp] Código recebido via API: ' + code);
    // Resetar circuit breaker — Amazon pode tentar publicar novamente
    try { const a = require('./core/autonomousAgent'); if (a.amazonCircuitReset) a.amazonCircuitReset(); } catch (_) {}
    res.json({ ok: true, code, message: 'Código enviado ao publisher Amazon — circuit breaker resetado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET to check if OTP is being waited
app.get('/api/amazon-otp', (req, res) => {
  try {
    const otpFile = '/app/data/amazon_otp.txt';
    const txt = fs.existsSync(otpFile) ? fs.readFileSync(otpFile, 'utf8').trim() : '';
    res.json({ status: txt || 'none', waiting: txt === 'WAITING' });
  } catch (e) {
    res.json({ status: 'none', waiting: false });
  }
});

// ── Cakto OTP endpoint (6-digit email 2FA code for /sso-devices/ step) ─────────
app.post('/api/cakto-otp', (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: 'code must be 4-8 digits', example: '{"code":"776889"}' });
  }
  const otpFile = path.join(DATA_DIR, 'cakto_otp.txt');
  try {
    fs.writeFileSync(otpFile, code);
    logger.info('[cakto-otp] Código recebido via API: ' + code);
    res.json({ ok: true, code, message: 'Código enviado ao publisher Cakto' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cakto-otp', (req, res) => {
  try {
    const otpFile = path.join(DATA_DIR, 'cakto_otp.txt');
    const txt = fs.existsSync(otpFile) ? fs.readFileSync(otpFile, 'utf8').trim() : '';
    res.json({ status: txt || 'none', waiting: txt === 'WAITING' });
  } catch (e) {
    res.json({ status: 'none', waiting: false });
  }
});

// SPA routes
['dashboard', 'ebooks', 'settings', 'publish'].forEach(p => {
  app.get('/' + p, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
  });
});

// ── Painel de afiliados + ebooks (protegido por chave: /painel?key=...) ─────────
app.get('/painel', (req, res) => {
  const KEY = process.env.PAINEL_KEY || 'genia2026';
  if ((req.query.key || '') !== KEY) {
    return res.status(401).send('<h2 style="font-family:sans-serif">Acesso negado</h2><p style="font-family:sans-serif">Use /painel?key=SUA_CHAVE</p>');
  }
  try {
    const Database = require('better-sqlite3');
    const _inDocker = process.platform !== 'win32' && fs.existsSync('/app/data');
    const affPath = process.env.AFFILIATE_DB_PATH || path.join(_inDocker ? '/app/data/db' : path.join(__dirname, '../data/db'), 'ebooks.db');
    const metPath = path.join(__dirname, '../data/metrics.db');

    let aff = { total: 0, links: 0, clicks: 0, byPlat: [], top: [], daily: [] };
    try {
      const db = new Database(affPath, { readonly: true });
      aff.total = db.prepare('SELECT count(*) c FROM affiliate_products').get().c;
      aff.links = db.prepare('SELECT count(*) c FROM affiliate_products WHERE affiliate_link IS NOT NULL').get().c;
      aff.clicks = db.prepare('SELECT COALESCE(sum(click_count),0) c FROM affiliate_products').get().c;
      aff.byPlat = db.prepare("SELECT platform, count(*) total, COALESCE(sum(affiliate_link IS NOT NULL),0) com_link, COALESCE(sum(click_count),0) clicks FROM affiliate_products GROUP BY platform ORDER BY clicks DESC, total DESC").all();
      aff.top = db.prepare('SELECT product_name, platform, click_count, image_url, landing_page_url FROM affiliate_products WHERE click_count > 0 ORDER BY click_count DESC LIMIT 15').all();
      try { aff.daily = db.prepare("SELECT substr(clicked_at,1,10) d, count(*) c FROM affiliate_clicks GROUP BY d ORDER BY d DESC LIMIT 14").all(); } catch (_) {}
      db.close();
    } catch (e) { aff.err = e.message; }

    let eb = { total: 0, byStatus: [], recent: [], daily: [] };
    try {
      const db = new Database(metPath, { readonly: true });
      eb.total = db.prepare('SELECT count(*) c FROM ebooks').get().c;
      eb.byStatus = db.prepare('SELECT status, count(*) c FROM ebooks GROUP BY status ORDER BY c DESC').all();
      eb.recent = db.prepare('SELECT title, status, language, created_at FROM ebooks ORDER BY created_at DESC LIMIT 12').all();
      eb.daily = db.prepare("SELECT substr(created_at,1,10) d, count(*) c FROM ebooks GROUP BY d ORDER BY d DESC LIMIT 14").all();
      db.close();
    } catch (e) { eb.err = e.message; }

    res.send(renderPainel(aff, eb));
  } catch (e) {
    res.status(500).send('Erro: ' + e.message);
  }
});

function renderPainel(aff, eb) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const fmt = n => Number(n || 0).toLocaleString('pt-BR');
  const maxD = Math.max(1, ...eb.daily.map(x => x.c), ...aff.daily.map(x => x.c));
  const bars = (arr, color) => arr.slice().reverse().map(x => `<div class="bar"><div class="fill" style="height:${Math.round(x.c / maxD * 90) + 6}px;background:${color}" title="${x.d}: ${x.c}"></div><span>${(x.d || '').slice(5)}</span></div>`).join('');
  const card = (label, val, sub) => `<div class="kpi"><div class="v">${val}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const platRows = aff.byPlat.map(p => `<tr><td>${esc(p.platform)}</td><td>${fmt(p.total)}</td><td>${fmt(p.com_link)}</td><td><b>${fmt(p.clicks)}</b></td></tr>`).join('');
  const topRows = aff.top.length ? aff.top.map((p, i) => `<tr><td>${i + 1}</td><td class="nm">${p.image_url ? `<img src="${esc(p.image_url)}">` : ''}<span>${esc((p.product_name || '').slice(0, 60))}</span></td><td>${esc(p.platform)}</td><td><b>${fmt(p.click_count)}</b></td></tr>`).join('') : '<tr><td colspan="4" class="muted">Nenhum clique ainda — divulgue o hub para começar a medir.</td></tr>';
  const ebStatus = eb.byStatus.map(s => `<span class="tag">${esc(s.status || '?')}: <b>${fmt(s.c)}</b></span>`).join('');
  const ebRows = eb.recent.map(e => `<tr><td>${(e.created_at || '').slice(0, 16)}</td><td>${esc((e.title || '').slice(0, 55))}</td><td>${esc(e.language || '')}</td><td><span class="st st-${esc(e.status)}">${esc(e.status || '?')}</span></td></tr>`).join('');
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel GENIA — Afiliados & Ebooks</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,-apple-system,'Segoe UI',sans-serif;background:#0b1220;color:#e2e8f0}
.hd{background:linear-gradient(120deg,#1d4ed8,#7c3aed);padding:26px 24px}.hd h1{font-size:1.5rem}.hd p{opacity:.8;font-size:.9rem;margin-top:4px}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:18px 0}
.kpi{background:#131c2e;border:1px solid #1f2a3d;border-radius:14px;padding:18px}.kpi .v{font-size:1.8rem;font-weight:800}.kpi .l{color:#94a3b8;font-size:.82rem;margin-top:4px}.kpi .s{color:#64748b;font-size:.72rem;margin-top:2px}
h2{font-size:1.05rem;margin:26px 0 12px}
.panel{background:#131c2e;border:1px solid #1f2a3d;border-radius:14px;padding:18px;margin-bottom:18px}
table{width:100%;border-collapse:collapse;font-size:.86rem}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #1f2a3d}th{color:#94a3b8;font-weight:600}
.nm{display:flex;align-items:center;gap:10px}.nm img{width:34px;height:34px;object-fit:contain;background:#fff;border-radius:6px;padding:2px}
.muted{color:#64748b;text-align:center;padding:18px}
.tag{display:inline-block;background:#1f2a3d;border-radius:8px;padding:5px 10px;font-size:.8rem;margin:0 6px 6px 0}
.st{font-size:.72rem;padding:3px 8px;border-radius:6px;background:#334155}.st-published{background:#166534;color:#bbf7d0}.st-ready{background:#854d0e;color:#fde68a}.st-failed{background:#7f1d1d;color:#fecaca}
.chart{display:flex;align-items:flex-end;gap:6px;height:120px;padding-top:10px}.bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px}.bar .fill{width:100%;border-radius:4px 4px 0 0}.bar span{font-size:.6rem;color:#64748b}
a{color:#60a5fa}</style></head>
<body><div class="hd"><h1>📊 Painel GENIA</h1><p>Afiliados &amp; Ebooks · ${new Date().toLocaleString('pt-BR')}</p></div>
<div class="wrap">
<div class="kpis">
${card('Produtos afiliados', fmt(aff.total), `${fmt(aff.links)} com link`)}
${card('Cliques totais', fmt(aff.clicks), 'nas páginas de venda')}
${card('Ebooks gerados', fmt(eb.total), 'desde o início')}
${card('Hub', '<a href="https://ofertas.veloxisit.com.br" target="_blank">ofertas ↗</a>', 'pt · en · es')}
</div>

<h2>🔗 Afiliados por plataforma</h2>
<div class="panel"><table><tr><th>Plataforma</th><th>Produtos</th><th>Com link</th><th>Cliques</th></tr>${platRows}</table></div>

<h2>🏆 Top produtos por cliques</h2>
<div class="panel"><table><tr><th>#</th><th>Produto</th><th>Loja</th><th>Cliques</th></tr>${topRows}</table></div>

<h2>📚 Ebooks gerados por dia (14 dias)</h2>
<div class="panel"><div class="chart">${bars(eb.daily, '#7c3aed')}</div><div style="margin-top:14px">${ebStatus}</div></div>

<h2>📖 Ebooks recentes</h2>
<div class="panel"><table><tr><th>Data</th><th>Título</th><th>Idioma</th><th>Status</th></tr>${ebRows}</table></div>

${aff.daily.length ? `<h2>👆 Cliques por dia (14 dias)</h2><div class="panel"><div class="chart">${bars(aff.daily, '#2563eb')}</div></div>` : ''}
</div></body></html>`;
}

app.get('/',         (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '../public/register.html')));
app.get('/status',   (req, res) => res.sendFile(path.join(__dirname, '../public/status.html')));

// ── Start ──────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  logger.info('GENIA Publisher v2 running on port ' + PORT);
  logger.info('  Dashboard: http://localhost:' + PORT + '/dashboard');
  logger.info('  Status:    http://localhost:' + PORT + '/status');
  logger.info('  API v2:    http://localhost:' + PORT + '/api/v2/stats');

  // Topic expander
  try {
    const { expandTopics } = require('./agents/topicExpander');
    await expandTopics();
    logger.info('Topic DB initialized');
  } catch (e) { logger.warn('topicExpander: ' + e.message); }

  // Session watcher
  try {
    const { startSessionWatcher } = require('./agents/sessionAgent');
    startSessionWatcher();
    logger.info('Session watcher started');
  } catch (e) { logger.warn('sessionAgent: ' + e.message); }

  // Sincronização de vendas reais (Cakto + Hotmart) a cada 6 horas
  try {
    const cron = require('node-cron');
    cron.schedule('0 */6 * * *', async () => {
      logger.info('📊 [cron] Sincronizando vendas das plataformas...');
      try {
        const { syncSalesFromPlatforms } = require('./agents/learningAgent');
        await syncSalesFromPlatforms();
      } catch (e) { logger.warn('syncSales cron: ' + e.message); }
    });
    logger.info('Sales sync cron: a cada 6h');
  } catch (e) { logger.warn('Sales sync cron setup: ' + e.message); }

  // Autonomous agent — só inicia se NÃO estiver em modo dashboard-only.
  // (megaAgent.js é o loop de publicação ativo; evitar dois loops simultâneos.)
  if (process.env.DASHBOARD_ONLY === '1') {
    logger.info('DASHBOARD_ONLY=1 — autonomous agent NÃO iniciado (megaAgent é o loop ativo)');
  } else {
    try {
      const agent = require('./core/autonomousAgent');
      agent.loop();
      logger.info('Autonomous agent started (24/7 mode)');
    } catch (e) { logger.error('Failed to start autonomous agent: ' + e.message); }
  }
});

module.exports = app;
