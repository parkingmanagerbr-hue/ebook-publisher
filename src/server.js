/**
 * GENIA EbookPublisher — Web Server
 * Dashboard, Landing Page, Auth, API
 */
require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { createLogger } = require('./core/logger');
const authRoutes = require('./routes/auth');
const apiRoutes  = require('./routes/api');

const logger = createLogger('server');
const app    = express();
const PORT   = process.env.DASHBOARD_PORT || 3100;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir capas e PDFs diretamente (com proteção por token)
app.use('/covers', express.static(path.join(__dirname, '../data/covers')));
app.use('/pdfs',   (req, res, next) => {
  // Verificar token na query string para downloads
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  next();
}, express.static(path.join(__dirname, '../data/pdfs')));

// Servir assets públicos
app.use(express.static(path.join(__dirname, '../public')));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api',  apiRoutes);

// ─── SPA fallback para páginas protegidas ────────────────────────────────────
const pages = ['dashboard', 'ebooks', 'settings', 'publish'];
pages.forEach(p => {
  app.get(`/${p}`, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '../public/register.html')));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🌐 Dashboard rodando em http://localhost:${PORT}`);
  logger.info(`   Landing:   http://localhost:${PORT}/`);
  logger.info(`   Login:     http://localhost:${PORT}/login`);
  logger.info(`   Dashboard: http://localhost:${PORT}/dashboard`);
});

module.exports = app;
