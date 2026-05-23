/**
 * CaktoAgent.js — GENIA Publisher: Cakto Store Agent
 * Wraps publisherCakto.js with DDD interface.
 *
 * CAKTO KNOWLEDGE:
 *  - Session: cookies from /app/data/sessions/cakto.json
 *  - Session check: navigate to app.cakto.com.br/dashboard/products
 *    If URL changes to /login -> session expired
 *  - Product creation via Puppeteer form automation
 *  - Upload cover: file input for images
 *  - Upload PDF: file input for files
 *  - Price: R$4,99 BRL
 *  - After creation: productId + pay.cakto.com.br/XXXXX URL
 *  - Session TTL: ~7 days
 */
'use strict';

const { SessionManager } = require('../session/SessionManager');

let log;
try {
  const { createLogger } = require('../../core/logger');
  log = createLogger('cakto-agent');
} catch {
  log = { info: console.log, warn: console.warn, error: console.error };
}

class CaktoAgent {
  constructor() {
    this.platform = 'cakto';
  }

  /**
   * Check if the Cakto session is valid.
   * @returns {{ valid: boolean, detail: Object }}
   */
  checkSession() {
    const status = SessionManager.check('cakto');
    return { valid: status.valid && status.exists, detail: status };
  }

  /**
   * Publish an ebook to Cakto.
   * Delegates to the proven publisherCakto.js agent.
   *
   * @param {import('../../domain/entities/Ebook').Ebook} ebook
   * @param {Function} [onProgress] - callback(pct, msg)
   * @returns {Promise<{ success: boolean, productId: string, url: string, error?: string }>}
   */
  async publish(ebook, onProgress = () => {}) {
    try {
      onProgress(5, 'Verificando sessão Cakto...');
      const sessionStatus = this.checkSession();
      if (!sessionStatus.valid) {
        return {
          success:  false,
          platform: 'cakto',
          error:    'Sessão Cakto inválida ou expirada. Execute o setup novamente.',
        };
      }

      onProgress(10, 'Iniciando publicação Cakto...');
      log.info(`Publishing "${ebook.title}" to Cakto`);

      const { publishToCakto } = require('../../agents/publisherCakto');
      const result = await publishToCakto({
        title:       ebook.title,
        subtitle:    ebook.subtitle,
        description: ebook.description,
        topic:       ebook.topic,
        pdfPath:     ebook.pdfPath,
        coverPath:   ebook.coverPath,
        price:       ebook.price || 4.99,
      });

      if (result.success) {
        // Extract product ID from URL if possible
        const urlMatch = (result.url || '').match(/\/([A-Za-z0-9]+)$/);
        const productId = urlMatch ? urlMatch[1] : `cakto-${Date.now()}`;

        onProgress(100, `Cakto: publicado — ${result.url}`);
        return {
          success:   true,
          platform:  'cakto',
          productId,
          url:       result.url,
        };
      } else {
        return {
          success:  false,
          platform: 'cakto',
          error:    result.error || 'Publicação Cakto falhou',
        };
      }
    } catch (err) {
      log.error(`CaktoAgent error for "${ebook.title}": ${err.message}`);
      return { success: false, platform: 'cakto', error: err.message };
    }
  }
}

module.exports = { CaktoAgent };
