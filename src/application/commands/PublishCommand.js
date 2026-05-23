/**
 * PublishCommand.js — Command Object for Publishing Operations
 * Encapsulates intent + parameters for the orchestrator.
 */
'use strict';

/**
 * @typedef {'single'|'batch'} CommandType
 */

class PublishCommand {
  /**
   * @param {CommandType} type
   * @param {Object} params
   * @param {string} [params.ebookId]       - For 'single' type
   * @param {string[]} [params.stores]      - Target platforms
   * @param {number} [params.limit]         - For 'batch' type
   * @param {string} [params.requestedBy]   - User/system that triggered
   */
  constructor(type, params = {}) {
    if (!['single', 'batch'].includes(type)) {
      throw new Error(`Invalid command type: ${type}`);
    }
    this.type        = type;
    this.ebookId     = params.ebookId || null;
    this.stores      = params.stores || ['hotmart', 'cakto'];
    this.limit       = params.limit || 50;
    this.requestedBy = params.requestedBy || 'system';
    this.createdAt   = new Date().toISOString();

    // Validate
    if (this.type === 'single' && !this.ebookId) {
      throw new Error('PublishCommand type=single requires ebookId');
    }
    const validStores = ['hotmart', 'cakto', 'amazon'];
    for (const s of this.stores) {
      if (!validStores.includes(s)) throw new Error(`Invalid store: ${s}`);
    }
  }

  static single(ebookId, stores = ['hotmart', 'cakto'], requestedBy = 'api') {
    return new PublishCommand('single', { ebookId, stores, requestedBy });
  }

  static batch(stores = ['hotmart', 'cakto'], limit = 50, requestedBy = 'system') {
    return new PublishCommand('batch', { stores, limit, requestedBy });
  }

  toJSON() {
    return {
      type:        this.type,
      ebookId:     this.ebookId,
      stores:      this.stores,
      limit:       this.limit,
      requestedBy: this.requestedBy,
      createdAt:   this.createdAt,
    };
  }
}

module.exports = { PublishCommand };
