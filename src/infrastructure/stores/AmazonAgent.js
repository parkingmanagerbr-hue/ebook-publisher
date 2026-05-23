/**
 * AmazonAgent.js — GENIA Publisher: Amazon KDP Store Agent
 * Stub implementation — activates when amazon.json session exists.
 * Full automation requires KDP account + Puppeteer flow (future roadmap).
 */
'use strict';

const { SessionManager } = require('../session/SessionManager');

let log;
try {
  const { createLogger } = require('../../core/logger');
  log = createLogger('amazon-agent');
} catch {
  log = { info: console.log, warn: console.warn, error: console.error };
}

class AmazonAgent {
  constructor() {
    this.platform = 'amazon';
  }

  checkSession() {
    const status = SessionManager.check('amazon');
    return { valid: status.valid && status.exists, detail: status };
  }

  /**
   * Publish to Amazon KDP.
   * Delegates to publisherAmazon.js if it exists and session is valid.
   *
   * @param {import('../../domain/entities/Ebook').Ebook} ebook
   * @param {Function} [onProgress]
   * @returns {Promise<{ success: boolean, productId?: string, url?: string, error?: string }>}
   */
  async publish(ebook, onProgress = () => {}) {
    const sessionStatus = this.checkSession();
    if (!sessionStatus.valid) {
      return {
        success:  false,
        platform: 'amazon',
        error:    'Amazon KDP session not configured. Run setup:amazon script.',
      };
    }

    try {
      onProgress(5, 'Iniciando publicação Amazon KDP...');
      const { publishToAmazon } = require('../../agents/publisherAmazon');
      const result = await publishToAmazon({
        title:       ebook.title,
        subtitle:    ebook.subtitle,
        description: ebook.description,
        topic:       ebook.topic,
        pdfPath:     ebook.pdfPath,
        coverPath:   ebook.coverPath,
        price:       ebook.price || 4.99,
      });

      if (result && result.success) {
        onProgress(100, 'Amazon KDP: publicado com sucesso');
        return {
          success:   true,
          platform:  'amazon',
          productId: result.asin || result.productId,
          url:       result.url,
        };
      }
      return { success: false, platform: 'amazon', error: result?.error || 'Amazon publish failed' };
    } catch (err) {
      log.warn(`AmazonAgent: ${err.message} (publisherAmazon.js may not be implemented yet)`);
      return { success: false, platform: 'amazon', error: err.message };
    }
  }
}

module.exports = { AmazonAgent };
