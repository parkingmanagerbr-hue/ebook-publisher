/**
 * IEbookRepository.js — Repository Interface (Contract)
 * Defines the persistence contract for Ebook entities.
 * Concrete implementations live in infrastructure/db/.
 *
 * @interface
 */
'use strict';

/**
 * @interface IEbookRepository
 */
class IEbookRepository {
  /**
   * Find ebook by ID.
   * @param {string} id
   * @returns {Promise<import('../entities/Ebook').Ebook|null>}
   */
  async findById(id) { throw new Error('Not implemented'); }

  /**
   * Get all ebooks, optionally filtered by status.
   * @param {string|null} [status]
   * @returns {Promise<import('../entities/Ebook').Ebook[]>}
   */
  async findAll(status = null) { throw new Error('Not implemented'); }

  /**
   * Find ebooks that have a PDF but are not yet published on the given platform.
   * @param {string} platform
   * @param {number} [limit]
   * @returns {Promise<import('../entities/Ebook').Ebook[]>}
   */
  async findPendingForPlatform(platform, limit = 50) { throw new Error('Not implemented'); }

  /**
   * Persist an ebook (insert or update).
   * @param {import('../entities/Ebook').Ebook} ebook
   * @returns {Promise<void>}
   */
  async save(ebook) { throw new Error('Not implemented'); }

  /**
   * Update publication result for a specific platform.
   * @param {string} id
   * @param {string} platform
   * @param {string} productId
   * @param {string} url
   * @returns {Promise<void>}
   */
  async markPublished(id, platform, productId, url) { throw new Error('Not implemented'); }

  /**
   * Get aggregate statistics.
   * @returns {Promise<{total:number, hotmart:number, cakto:number, amazon:number, pending:number, revenue:number}>}
   */
  async getStats() { throw new Error('Not implemented'); }
}

module.exports = { IEbookRepository };
