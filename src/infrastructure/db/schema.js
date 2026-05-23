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
  // Ensure amazon columns exist (added in v2)
  const cols = db.pragma('table_info(ebooks)').map(c => c.name);

  if (!cols.includes('amazon_product_id')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN amazon_product_id TEXT");
  }
  if (!cols.includes('amazon_url')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN amazon_url TEXT");
  }

  // ml_score column on ebooks for PriorityScorer caching
  if (!cols.includes('ml_score')) {
    db.exec("ALTER TABLE ebooks ADD COLUMN ml_score REAL DEFAULT 0");
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
}

module.exports = { runMigrations };
