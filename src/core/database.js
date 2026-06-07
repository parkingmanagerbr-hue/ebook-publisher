/**
 * SQLite Database — Métricas, topics, e-books, aprendizado ML
 */
const Database = require('better-sqlite3');
const path = require('path');
const { createLogger } = require('./logger');
const logger = createLogger('database');

const DB_PATH = path.join(__dirname, '../../data/metrics.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

// Inicializar DB imediatamente no carregamento do módulo
db = getDb();

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT UNIQUE NOT NULL,
      category TEXT,
      demand_score REAL DEFAULT 5.0,
      ml_score REAL DEFAULT 0.0,
      times_used INTEGER DEFAULT 0,
      total_sales INTEGER DEFAULT 0,
      total_revenue REAL DEFAULT 0.0,
      avg_rating REAL DEFAULT 0.0,
      last_used TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ebooks (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      description TEXT,
      cover_path TEXT,
      pdf_path TEXT,
      status TEXT DEFAULT 'pending',
      cakto_url TEXT,
      cakto_product_id TEXT,
      hotmart_url TEXT,
      hotmart_product_id TEXT,
      amazon_url TEXT,
      amazon_product_id TEXT,
      amazon_asin TEXT,
      language TEXT DEFAULT 'pt-BR',
      word_count INTEGER DEFAULT 0,
      ml_score REAL DEFAULT 0,
      price REAL DEFAULT 4.99,
      sales_count INTEGER DEFAULT 0,
      revenue REAL DEFAULT 0.0,
      ai_provider TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      published_at TEXT,
      FOREIGN KEY (topic) REFERENCES topics(topic)
    );

    CREATE TABLE IF NOT EXISTS sales_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ebook_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      sales INTEGER DEFAULT 0,
      revenue REAL DEFAULT 0.0,
      date TEXT DEFAULT (date('now')),
      FOREIGN KEY (ebook_id) REFERENCES ebooks(id)
    );

    CREATE TABLE IF NOT EXISTS topic_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      score REAL,
      reason TEXT,
      evaluated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  logger.info('Schema inicializado');
  seedTopics();
}

function seedTopics() {
  const existing = db.prepare('SELECT COUNT(*) as c FROM topics').get();
  if (existing.c > 0) return;

  const topics = [
    ['Educação financeira e saída das dívidas', 'financas', 9.5],
    ['Investimentos para iniciantes', 'financas', 9.0],
    ['Inteligência artificial na prática', 'tecnologia', 9.0],
    ['Emagrecimento e dietas low carb', 'saude', 8.8],
    ['Empreendedorismo digital', 'negocios', 8.5],
    ['Marketing digital e tráfego pago', 'negocios', 8.5],
    ['Desenvolvimento pessoal e hábitos', 'comportamento', 8.5],
    ['Ansiedade e saúde mental', 'saude', 8.8],
    ['Espiritualidade e devocional cristão', 'espiritualidade', 8.0],
    ['Relacionamentos e comunicação amorosa', 'relacionamentos', 7.8],
    ['Fitness e hipertrofia muscular', 'saude', 7.5],
    ['Receitas saudáveis e culinária fitness', 'culinaria', 7.5],
    ['Copywriting e vendas online', 'negocios', 7.5],
    ['IA para criadores de conteúdo', 'tecnologia', 7.5],
    ['Concursos públicos', 'educacao', 7.0],
    ['Autoconhecimento e psicologia', 'comportamento', 7.0],
    ['Maternidade e criação de filhos', 'familia', 7.0],
    ['Biohacking e longevidade', 'saude', 6.8],
    ['Freelancer e trabalho remoto', 'carreira', 7.0],
    ['Afiliados e monetização de conteúdo', 'negocios', 7.2],
  ];

  const insert = db.prepare('INSERT OR IGNORE INTO topics (topic, category, demand_score) VALUES (?, ?, ?)');
  topics.forEach(([t, c, s]) => insert.run(t, c, s));
  logger.info(`${topics.length} tópicos iniciais inseridos`);
}

// ========= TOPICS =========
function getNextTopic() {
  return db.prepare(`
    SELECT *, (demand_score * 0.4 + ml_score * 0.4 + (10 - times_used) * 0.2) as final_score
    FROM topics
    WHERE (last_used IS NULL OR last_used < datetime('now', '-48 hours'))
    ORDER BY final_score DESC
    LIMIT 1
  `).get();
}

function markTopicUsed(topic) {
  db.prepare("UPDATE topics SET times_used = times_used + 1, last_used = datetime('now') WHERE topic = ?").run(topic);
}

function updateTopicScore(topic, sales, revenue) {
  const mlScore = Math.min(10, (sales * 0.5) + (revenue * 0.1));
  db.prepare(`
    UPDATE topics SET
      total_sales = total_sales + ?,
      total_revenue = total_revenue + ?,
      ml_score = ?,
      demand_score = MIN(10, demand_score + ?)
    WHERE topic = ?
  `).run(sales, revenue, mlScore, sales > 5 ? 0.5 : 0, topic);
}

function getAllTopics() {
  return db.prepare('SELECT * FROM topics ORDER BY ml_score DESC, demand_score DESC').all();
}

// ========= EBOOKS =========
function saveEbook(ebook) {
  // Ensure topic exists in topics table (handles manually-triggered topics not in DB)
  if (ebook.topic) {
    db.prepare(`INSERT OR IGNORE INTO topics (topic, category) VALUES (?, ?)`)
      .run(ebook.topic, ebook.category || 'geral');
  }
  db.prepare(`
    INSERT OR REPLACE INTO ebooks
    (id, topic, title, subtitle, description, cover_path, pdf_path, status, price, ai_provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ebook.id, ebook.topic, ebook.title, ebook.subtitle, ebook.description,
         ebook.coverPath, ebook.pdfPath, ebook.status || 'pending', ebook.price || 4.99, ebook.aiProvider);
}

function updateEbookStatus(id, status, extra = {}) {
  const sets = ['status = ?'];
  const vals = [status];
  if (extra.caktoUrl) { sets.push('cakto_url = ?'); vals.push(extra.caktoUrl); }
  if (extra.hotmartUrl) { sets.push('hotmart_url = ?'); vals.push(extra.hotmartUrl); }
  if (extra.hotmartProductId) { sets.push('hotmart_product_id = ?'); vals.push(extra.hotmartProductId); }
  if (extra.caktoProductId) { sets.push('cakto_product_id = ?'); vals.push(extra.caktoProductId); }
  if (extra.amazonAsin) { sets.push('amazon_asin = ?'); vals.push(extra.amazonAsin); }
  if (extra.amazonUrl) { sets.push('amazon_url = ?'); vals.push(extra.amazonUrl); }
  if (status === 'published') { sets.push("published_at = datetime('now')"); }
  vals.push(id);
  db.prepare(`UPDATE ebooks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function getEbooks(status = null) {
  if (status) return db.prepare('SELECT * FROM ebooks WHERE status = ? ORDER BY created_at DESC').all(status);
  return db.prepare('SELECT * FROM ebooks ORDER BY created_at DESC').all();
}

// ========= METRICS =========
function recordSale(ebookId, platform, sales, revenue) {
  db.prepare('INSERT INTO sales_metrics (ebook_id, platform, sales, revenue) VALUES (?, ?, ?, ?)').run(ebookId, platform, sales, revenue);
  db.prepare('UPDATE ebooks SET sales_count = sales_count + ?, revenue = revenue + ? WHERE id = ?').run(sales, revenue, ebookId);
  const ebook = db.prepare('SELECT topic FROM ebooks WHERE id = ?').get(ebookId);
  if (ebook) updateTopicScore(ebook.topic, sales, revenue);
}

function getStats() {
  return {
    totalEbooks: db.prepare('SELECT COUNT(*) as c FROM ebooks').get().c,
    published: db.prepare("SELECT COUNT(*) as c FROM ebooks WHERE status = 'published'").get().c,
    totalSales: db.prepare('SELECT SUM(sales_count) as s FROM ebooks').get().s || 0,
    totalRevenue: db.prepare('SELECT SUM(revenue) as r FROM ebooks').get().r || 0,
    topTopic: db.prepare('SELECT topic, total_sales FROM topics ORDER BY total_sales DESC LIMIT 1').get(),
  };
}

module.exports = { getDb, getNextTopic, markTopicUsed, updateTopicScore, getAllTopics, saveEbook, updateEbookStatus, getEbooks, recordSale, getStats };
