/**
 * HotmartAgent.js — GENIA Publisher: Hotmart Store Agent
 * Wraps the proven publisherHotmart.js with DDD interface.
 * All Hotmart-specific knowledge is embedded here.
 *
 * HOTMART SSO KNOWLEDGE:
 *  - SSO at sso.hotmart.com (Spring Security WebFlow)
 *  - Email/pass -> 2FA OTP email -> form.submit()
 *  - After SSO -> app.hotmart.com/auth/login?code=OC-xxxxx
 *  - SPA exchanges code for JWT in ~7-14 seconds
 *  - JWT in localStorage['token'] (2183 chars) is the main token
 *  - Session valid ~48h; hmSsoExp=TIMESTAMP|TGT-xxx tracks expiry
 *
 * PUBLISHING FLOW:
 *  1. Refresh JWT via CAS ticket
 *  2. Navigate to /products/add/4/info
 *  3. Fill title, description, category, price (R$4,99 BRL, à vista)
 *  4. Save -> /products/manage/{numericId}
 *  5. Upload cover image (/info page, file input)
 *  6. Upload PDF (/overview -> Configurar -> /content, file input)
 *  7. Finalizar cadastro (wait disabled=false)
 *  8. Screenshot proof, update DB
 *
 * CATEGORY MAPPING:
 *  financas/investimento -> "Negócios e Carreira"
 *  saude/fitness/emagre  -> "Saúde e Esportes"
 *  tecnologia/software   -> "Tecnologia e Programação"
 *  negocios/empreende    -> "Negócios e Carreira"
 *  relacionamento        -> "Desenvolvimento Pessoal"
 *  idioma/lingua         -> "Desenvolvimento Pessoal"
 *  default               -> "Negócios e Carreira"
 */
'use strict';

const { SessionManager } = require('../session/SessionManager');

let log;
try {
  const { createLogger } = require('../../core/logger');
  log = createLogger('hotmart-agent');
} catch {
  log = { info: console.log, warn: console.warn, error: console.error };
}

class HotmartAgent {
  constructor() {
    this.platform = 'hotmart';
  }

  /**
   * Check if the Hotmart session is valid.
   * @returns {{ valid: boolean, detail: Object }}
   */
  checkSession() {
    const status = SessionManager.check('hotmart');
    return { valid: status.valid && status.exists, detail: status };
  }

  /**
   * Publish an ebook to Hotmart.
   * Delegates to the proven publisherHotmart.js agent.
   *
   * @param {import('../../domain/entities/Ebook').Ebook} ebook
   * @param {Function} [onProgress] - callback(pct, msg)
   * @returns {Promise<{ success: boolean, productId: string, url: string, error?: string }>}
   */
  async publish(ebook, onProgress = () => {}) {
    try {
      onProgress(5, 'Verificando sessão Hotmart...');
      const sessionStatus = this.checkSession();
      if (!sessionStatus.valid) {
        return {
          success:  false,
          platform: 'hotmart',
          error:    'Sessão Hotmart inválida ou expirada. Execute o setup novamente.',
        };
      }

      onProgress(10, 'Iniciando publicação Hotmart...');
      log.info(`Publishing "${ebook.title}" to Hotmart`);

      const { publishToHotmart } = require('../../agents/publisherHotmart');
      const result = await publishToHotmart({
        title:       ebook.title,
        subtitle:    ebook.subtitle,
        description: ebook.description,
        topic:       ebook.topic,
        pdfPath:     ebook.pdfPath,
        coverPath:   ebook.coverPath,
        price:       ebook.price || 4.99,
      });

      if (result.success) {
        onProgress(100, `Hotmart: publicado com ID ${result.hotmartProductId}`);
        return {
          success:   true,
          platform:  'hotmart',
          productId: result.hotmartProductId,
          url:       result.url || `https://hotmart.com/product/${result.hotmartProductId}`,
        };
      } else {
        return {
          success:  false,
          platform: 'hotmart',
          error:    result.error || 'Publicação falhou sem erro específico',
        };
      }
    } catch (err) {
      log.error(`HotmartAgent error for "${ebook.title}": ${err.message}`);
      return { success: false, platform: 'hotmart', error: err.message };
    }
  }
}

module.exports = { HotmartAgent };
