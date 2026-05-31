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

const logger = createLogger('server');
const app    = express();
const PORT   = process.env.DASHBOARD_PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'genia-ebook-secret-2026-change-in-prod';

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

// SPA routes
['dashboard', 'ebooks', 'settings', 'publish'].forEach(p => {
  app.get('/' + p, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
  });
});

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

  // Autonomous agent
  try {
    const agent = require('./core/autonomousAgent');
    agent.loop();
    logger.info('Autonomous agent started (24/7 mode)');
  } catch (e) { logger.error('Failed to start autonomous agent: ' + e.message); }
});

module.exports = app;
