/**
 * schema.js — DB Schema + Backward-Compatible Migrations
 * Safe to run multiple times (idempotent).
 */
'use strict';

/**
 * Run all migrations on the given database connection.
 * @param {import('better-sqlite3').Database} db
 */
function runMigrations(db) {
  // Ensure all columns exist (idempotent — safe to run on any DB version)
  const cols = db.pragma('table_info(ebooks)').map(c => c.name);

  // v2: Amazon KDP columns
  if (!cols.includes('amazon_product_id')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN amazon_product_id TEXT");
  }
  if (!cols.includes('amazon_url')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN amazon_url TEXT");
  }
  // v2.1: Amazon ASIN (separate from product_id for clarity)
  if (!cols.includes('amazon_asin')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN amazon_asin TEXT");
  }
  // v2.2: ML score cache on ebook row
  if (!cols.includes('ml_score')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN ml_score REAL DEFAULT 0");
  }
  // v2.3: AI provider used for generation
  if (!cols.includes('ai_provider')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN ai_provider TEXT");
  }
  // v2.4: Language of the ebook
  if (!cols.includes('language')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN language TEXT DEFAULT 'pt-BR'");
  }
  // v2.5: Word count
  if (!cols.includes('word_count')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN word_count INTEGER DEFAULT 0");
  }

  // publishing_queue table
  db.exec(`
    CREATE TABLE IF NOT EXISTS publishing_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ebook_id   TEXT NOT NULL,
      platform   TEXT NOT NULL,
      status     TEXT DEFAULT 'pending',
      attempts   INTEGER DEFAULT 0,
      error      TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (ebook_id) REFERENCES ebooks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON publishing_queue(status, platform);
  `);

  // affiliate_products table (used by affiliateAgent + landingPageAgent)
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
      click_count      INTEGER DEFAULT 0,
      created_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_affiliate_platform ON affiliate_products(platform);
    CREATE INDEX IF NOT EXISTS idx_affiliate_lp ON affiliate_products(landing_page_url);
  `);

  // click_count column migration (for existing installs)
  try {
    const affCols = db.pragma('table_info(affiliate_products)').map(c => c.name);
    if (!affCols.includes('click_count')) {
      db.exec('ALTER TABLE affiliate_products ADD COLUMN click_count INTEGER DEFAULT 0');
    }
  } catch (_) {}

  // affiliate_clicks log (granular click tracking per IP/day)
  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id      INTEGER NOT NULL,
      platform        TEXT,
      referer         TEXT,
      user_agent      TEXT,
      ip_hash         TEXT,
      clicked_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_product ON affiliate_clicks(product_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_date ON affiliate_clicks(clicked_at);
  `);
}

module.exports = { runMigrations };
