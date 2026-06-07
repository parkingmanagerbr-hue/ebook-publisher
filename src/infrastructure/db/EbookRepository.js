/**
 * EbookRepository.js — SQLite Implementation of IEbookRepository
 * Wraps better-sqlite3, maps DB rows to Ebook entities.
 */
'use strict';

const { IEbookRepository } = require('../../domain/repositories/IEbookRepository');
const { Ebook }             = require('../../domain/entities/Ebook');

class EbookRepository extends IEbookRepository {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    super();
    this.db = db;
  }

  async findById(id) {
    const row = this.db.prepare('SELECT * FROM ebooks WHERE id = ?').get(id);
    return row ? Ebook.fromDbRow(row) : null;
  }

  async findAll(status = null) {
    const rows = status
      ? this.db.prepare('SELECT * FROM ebooks WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM ebooks ORDER BY created_at DESC').all();
    return rows.map(Ebook.fromDbRow);
  }

  async findPendingForPlatform(platform, limit = 50) {
    const col = `${platform}_product_id`;
    // Only platforms we know about
    if (!['hotmart', 'cakto', 'amazon'].includes(platform)) return [];

    const rows = this.db.prepare(`
      SELECT * FROM ebooks
      WHERE pdf_path IS NOT NULL
        AND pdf_path != ''
        AND (${col} IS NULL OR ${col} = '')
        AND status NOT IN ('error', 'publishing')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    return rows.map(Ebook.fromDbRow);
  }

  async save(ebook) {
    this.db.prepare(`
      INSERT OR REPLACE INTO ebooks
        (id, topic, title, subtitle, description, cover_path, pdf_path,
         status, price, ai_provider, created_at, published_at,
         hotmart_product_id, hotmart_url, cakto_product_id, cakto_url,
         sales_count, revenue)
      VALUES
        (@id, @topic, @title, @subtitle, @description, @coverPath, @pdfPath,
         @status, @price, @aiProvider, @createdAt, @publishedAt,
         @hotmartProductId, @hotmartUrl, @caktoProductId, @caktoUrl,
         @salesCount, @revenue)
    `).run({
      id:              ebook.id,
      topic:           ebook.topic,
      title:           ebook.title,
      subtitle:        ebook.subtitle,
      description:     ebook.description,
      coverPath:       ebook.coverPath,
      pdfPath:         ebook.pdfPath,
      status:          ebook.status,
      price:           ebook.price,
      aiProvider:      ebook.aiProvider,
      createdAt:       ebook.createdAt,
      publishedAt:     ebook.publishedAt,
      hotmartProductId: ebook.hotmartProductId,
      hotmartUrl:      ebook.hotmartUrl,
      caktoProductId:  ebook.caktoProductId,
      caktoUrl:        ebook.caktoUrl,
      salesCount:      ebook.salesCount,
      revenue:         ebook.revenue,
    });
  }

  async markPublished(id, platform, productId, url) {
    // Amazon uses 'amazon_asin' as the canonical ID field; other platforms use '{platform}_product_id'
    const colId  = platform === 'amazon' ? 'amazon_asin' : `${platform}_product_id`;
    const colUrl = `${platform}_url`;
    this.db.prepare(`
      UPDATE ebooks
      SET ${colId} = ?, ${colUrl} = ?, status = 'published',
          published_at = COALESCE(published_at, datetime('now'))
      WHERE id = ?
    `).run(productId, url, id);
  }

  async getStats() {
    const total   = this.db.prepare("SELECT COUNT(*) as n FROM ebooks").get().n;
    const published = this.db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE status = 'published'").get().n;
    const hotmart = this.db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE hotmart_product_id IS NOT NULL AND hotmart_product_id != ''").get().n;
    const cakto   = this.db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE cakto_product_id IS NOT NULL AND cakto_product_id != ''").get().n;
    const amazon  = this.db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE (amazon_asin IS NOT NULL AND amazon_asin != '') OR (amazon_url IS NOT NULL AND amazon_url != '')").get().n;
    const pending = this.db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE status IN ('ready','pending') AND pdf_path IS NOT NULL").get().n;
    const errors  = this.db.prepare("SELECT COUNT(*) as n FROM ebooks WHERE status = 'error'").get().n;
    const revenue = this.db.prepare("SELECT COALESCE(SUM(revenue),0) as r FROM ebooks").get().r;
    const sales   = this.db.prepare("SELECT COALESCE(SUM(sales_count),0) as s FROM ebooks").get().s;
    return { total, published, hotmart, cakto, amazon, pending, errors, revenue, sales };
  }
}

module.exports = { EbookRepository };
