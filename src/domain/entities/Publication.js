/**
 * Publication.js — Value Object
 * Represents a publication record on a specific platform.
 * Immutable — create new instances for changes.
 */
'use strict';

/**
 * @typedef {'hotmart'|'cakto'|'amazon'} Platform
 * @typedef {'pending'|'processing'|'published'|'failed'} PubStatus
 */

class Publication {
  /**
   * @param {Platform} platform
   * @param {string|null} productId
   * @param {string|null} url
   * @param {string|null} publishedAt
   * @param {PubStatus} status
   */
  constructor(platform, productId = null, url = null, publishedAt = null, status = 'pending') {
    if (!['hotmart', 'cakto', 'amazon'].includes(platform)) {
      throw new Error(`Invalid platform: ${platform}`);
    }
    this.platform    = platform;
    this.productId   = productId;
    this.url         = url;
    this.publishedAt = publishedAt;
    this.status      = status;

    Object.freeze(this);
  }

  isActive()  { return this.status === 'published' && !!this.productId; }
  isFailed()  { return this.status === 'failed'; }
  isPending() { return this.status === 'pending'; }

  withSuccess(productId, url) {
    return new Publication(this.platform, productId, url, new Date().toISOString(), 'published');
  }

  withFailure() {
    return new Publication(this.platform, this.productId, this.url, this.publishedAt, 'failed');
  }

  toJSON() {
    return {
      platform:    this.platform,
      productId:   this.productId,
      url:         this.url,
      publishedAt: this.publishedAt,
      status:      this.status,
    };
  }

  static pending(platform) {
    return new Publication(platform, null, null, null, 'pending');
  }
}

module.exports = { Publication };
