/**
 * Ebook.js — Domain Entity
 * Core business entity representing an ebook and its publication state.
 * Pure domain logic — no I/O, no frameworks.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * @typedef {Object} EbookProps
 * @property {string} id
 * @property {string} topic
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} [description]
 * @property {string} [coverPath]
 * @property {string} [pdfPath]
 * @property {string} status - pending|ready|publishing|published|error
 * @property {number} price
 * @property {number} salesCount
 * @property {number} revenue
 * @property {string} [aiProvider]
 * @property {string} createdAt
 * @property {string} [publishedAt]
 * @property {Publication[]} publications
 */

class Ebook {
  /**
   * @param {EbookProps} props
   */
  constructor(props) {
    this.id          = props.id || uuidv4();
    this.topic       = props.topic;
    this.title       = props.title;
    this.subtitle    = props.subtitle || '';
    this.description = props.description || '';
    this.coverPath   = props.coverPath || null;
    this.pdfPath     = props.pdfPath || null;
    this.status      = props.status || 'pending';
    this.price       = typeof props.price === 'number' ? props.price : 4.99;
    this.salesCount  = props.salesCount || 0;
    this.revenue     = props.revenue || 0;
    this.aiProvider  = props.aiProvider || null;
    this.createdAt   = props.createdAt || new Date().toISOString();
    this.publishedAt = props.publishedAt || null;

    // Flatten platform data from DB columns
    this.hotmartProductId = props.hotmartProductId || props.hotmart_product_id || null;
    this.hotmartUrl       = props.hotmartUrl || props.hotmart_url || null;
    this.caktoProductId   = props.caktoProductId || props.cakto_product_id || null;
    this.caktoUrl         = props.caktoUrl || props.cakto_url || null;
    this.amazonProductId  = props.amazonProductId || props.amazon_product_id || null;
    this.amazonUrl        = props.amazonUrl || props.amazon_url || null;
  }

  /** @returns {boolean} */
  isReadyForPublishing() {
    return !!this.pdfPath && ['ready', 'pending'].includes(this.status);
  }

  /** @returns {boolean} */
  isPublishedOn(platform) {
    const ids = { hotmart: this.hotmartProductId, cakto: this.caktoProductId, amazon: this.amazonProductId };
    return !!ids[platform];
  }

  /** @returns {string[]} Platforms where ebook is NOT yet published */
  pendingPlatforms(targetPlatforms = ['hotmart', 'cakto']) {
    return targetPlatforms.filter(p => !this.isPublishedOn(p));
  }

  /** @returns {number} Count of platforms published on */
  publishedCount() {
    return [this.hotmartProductId, this.caktoProductId, this.amazonProductId].filter(Boolean).length;
  }

  markPublished(platform, productId, url) {
    if (platform === 'hotmart') { this.hotmartProductId = productId; this.hotmartUrl = url; }
    if (platform === 'cakto')   { this.caktoProductId = productId;   this.caktoUrl = url; }
    if (platform === 'amazon')  { this.amazonProductId = productId;  this.amazonUrl = url; }

    if (this.publishedCount() > 0) {
      this.status = 'published';
      this.publishedAt = this.publishedAt || new Date().toISOString();
    }
  }

  markError(msg) {
    this.status = 'error';
    this.lastError = msg;
  }

  toJSON() {
    return {
      id:              this.id,
      topic:           this.topic,
      title:           this.title,
      subtitle:        this.subtitle,
      description:     this.description,
      coverPath:       this.coverPath,
      pdfPath:         this.pdfPath,
      status:          this.status,
      price:           this.price,
      salesCount:      this.salesCount,
      revenue:         this.revenue,
      aiProvider:      this.aiProvider,
      createdAt:       this.createdAt,
      publishedAt:     this.publishedAt,
      hotmartProductId: this.hotmartProductId,
      hotmartUrl:      this.hotmartUrl,
      caktoProductId:  this.caktoProductId,
      caktoUrl:        this.caktoUrl,
      amazonProductId: this.amazonProductId,
      amazonUrl:       this.amazonUrl,
      publishedCount:  this.publishedCount(),
    };
  }

  /**
   * Factory from raw DB row
   * @param {Object} row
   * @returns {Ebook}
   */
  static fromDbRow(row) {
    return new Ebook({
      id:              row.id,
      topic:           row.topic,
      title:           row.title,
      subtitle:        row.subtitle,
      description:     row.description,
      coverPath:       row.cover_path,
      pdfPath:         row.pdf_path,
      status:          row.status,
      price:           row.price,
      salesCount:      row.sales_count,
      revenue:         row.revenue,
      aiProvider:      row.ai_provider,
      createdAt:       row.created_at,
      publishedAt:     row.published_at,
      hotmartProductId: row.hotmart_product_id,
      hotmartUrl:      row.hotmart_url,
      caktoProductId:  row.cakto_product_id,
      caktoUrl:        row.cakto_url,
    });
  }
}

module.exports = { Ebook };
