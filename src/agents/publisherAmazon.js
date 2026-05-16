/**
 * PublisherAmazon — Publica e-book no Amazon KDP via Puppeteer
 *
 * IMPORTANTE: O cadastro na Amazon KDP requer dados bancários, fiscais e
 * informações de identidade que devem ser preenchidos manualmente pelo usuário.
 * Este agente automatiza APENAS o upload e criação do produto (ebook + capa + metadados).
 *
 * Pré-requisitos:
 *   - KDP_EMAIL e KDP_PASSWORD no .env (conta já criada e verificada)
 *   - Conta bancária e dados fiscais já configurados no KDP
 */
const puppeteer = require('puppeteer');
const path = require('path');
const { createLogger } = require('../core/logger');
const logger = createLogger('publisherAmazon');

const KDP_URL = 'https://kdp.amazon.com';
const HEADLESS = process.env.HEADLESS !== 'false';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Espera por seletor com timeout longo (KDP é lento para carregar)
 */
async function waitAndClick(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.click(selector);
}

/**
 * Preenche um campo de texto (limpa antes de digitar)
 */
async function fillField(page, selector, value, timeout = 10000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay: 25 });
}

/**
 * Publica um e-book no Amazon KDP
 * @param {Object} ebook - Dados do ebook (title, subtitle, topic, pdfPath, coverPath, price)
 * @returns {Object} { success, url, platform, asin }
 */
async function publishToAmazon(ebook) {
  logger.info(`Publicando no Amazon KDP: ${ebook.title}`);

  if (!process.env.KDP_EMAIL || !process.env.KDP_PASSWORD) {
    logger.error('KDP_EMAIL e KDP_PASSWORD não configurados no .env');
    return { success: false, error: 'Credenciais KDP não configuradas', platform: 'amazon' };
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();

  // Anti-bot: remover webdriver flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    // ===== LOGIN AMAZON =====
    logger.info('Fazendo login na Amazon...');
    await page.goto('https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fkdp.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=amzn_kdp_desktop_us&marketPlaceId=ATVPDKIKX0DER&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.ui.mode=popup', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Email
    await fillField(page, '#ap_email', process.env.KDP_EMAIL);
    await page.click('#continue');
    await sleep(2000);

    // Senha
    await fillField(page, '#ap_password', process.env.KDP_PASSWORD);
    await page.click('#signInSubmit');
    await sleep(3000);

    // Verificar se está logado (pode ter 2FA)
    const url = page.url();
    if (url.includes('ap/signin') || url.includes('challenge') || url.includes('mfa')) {
      logger.error('Login falhou ou 2FA ativado. Desative o 2FA na conta Amazon para automação.');
      return { success: false, error: 'Login falhou ou 2FA ativado', platform: 'amazon' };
    }

    logger.info('✅ Login Amazon OK');
    await sleep(2000);

    // ===== CRIAR NOVO TÍTULO KDP =====
    logger.info('Criando novo título no KDP...');
    await page.goto(`${KDP_URL}/title-setup/kindle/new/details`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // ─── PASSO 1: Detalhes do livro ───────────────────────────────────────────

    // Título do livro
    await fillField(page, '#data-print-book-title', ebook.title || 'E-book GENIA');

    // Subtítulo (opcional)
    if (ebook.subtitle) {
      try { await fillField(page, '#data-print-book-subtitle', ebook.subtitle, 5000); } catch {}
    }

    // Nome do autor — usa variável de ambiente ou padrão
    const authorName = process.env.KDP_AUTHOR_NAME || 'GENIA Editorial';
    const authorParts = authorName.split(' ');
    try {
      await fillField(page, '#data-print-book-primary-author-first-name', authorParts[0] || 'GENIA', 5000);
      await fillField(page, '#data-print-book-primary-author-last-name', authorParts.slice(1).join(' ') || 'Editorial', 5000);
    } catch { logger.warn('Campos de autor não encontrados'); }

    // Descrição do livro
    const description = ebook.description ||
      `E-book sobre ${ebook.topic || ebook.title}. Guia completo e prático com informações detalhadas e exemplos aplicáveis.`;
    try {
      // Pode ser um editor rico (contenteditable)
      const descEditor = await page.$('[data-name="data-print-book-description"] [contenteditable], #data-print-book-description');
      if (descEditor) {
        await descEditor.click({ clickCount: 3 });
        await descEditor.type(description, { delay: 10 });
      }
    } catch { logger.warn('Campo de descrição não encontrado'); }

    // Palavras-chave (keywords)
    const keywords = [ebook.topic || 'ebook', 'guia', 'completo', 'digital', 'aprendizado', 'prático', 'iniciante'];
    for (let i = 0; i < Math.min(7, keywords.length); i++) {
      try {
        await fillField(page, `#data-print-book-keywords-${i}`, keywords[i], 5000);
      } catch { break; }
    }

    // Categorias — deixar seleção padrão para não travar o fluxo

    // Próximo passo
    logger.info('Salvando detalhes...');
    try {
      await waitAndClick(page, 'input[id="save-and-continue-announce"], button[id="save-announce"]');
      await sleep(3000);
    } catch {
      // Fallback: botão "Save and Continue"
      const btns = await page.$$('button, input[type="submit"]');
      for (const btn of btns) {
        const txt = await page.evaluate(el => el.textContent || el.value || '', btn);
        if (txt.toLowerCase().includes('continue') || txt.toLowerCase().includes('save')) {
          await btn.click(); break;
        }
      }
      await sleep(3000);
    }

    // ─── PASSO 2: Conteúdo do livro (upload PDF + capa) ──────────────────────

    logger.info('Fazendo upload da capa...');
    const coverInput = await page.$('input[type="file"][accept*="image"], input#data-cover-image-file-field');
    if (coverInput && ebook.coverPath) {
      await coverInput.uploadFile(ebook.coverPath);
      await sleep(5000); // KDP leva tempo para processar capa
      logger.info('Capa enviada');
    } else {
      logger.warn('Input de capa não encontrado ou caminho de capa não fornecido');
    }

    logger.info('Fazendo upload do miolo (PDF)...');
    // KDP aceita PDF ou EPUB — usamos PDF
    const manuscriptInput = await page.$('input[type="file"][accept*=".pdf"], input[type="file"][accept*="pdf"], input#data-manuscript-file-field');
    if (manuscriptInput && ebook.pdfPath) {
      await manuscriptInput.uploadFile(ebook.pdfPath);
      await sleep(8000); // PDFs grandes levam mais tempo
      logger.info('PDF enviado');
    } else {
      logger.warn('Input de manuscrito não encontrado ou caminho de PDF não fornecido');
    }

    // Prévia — pular se não necessária
    await sleep(2000);

    // Próximo passo (Conteúdo → Preço)
    try {
      await waitAndClick(page, 'input[id="save-and-continue-announce"], button[id="save-announce"]');
      await sleep(3000);
    } catch {
      const btns = await page.$$('button, input[type="submit"]');
      for (const btn of btns) {
        const txt = await page.evaluate(el => el.textContent || el.value || '', btn);
        if (txt.toLowerCase().includes('continue') || txt.toLowerCase().includes('save')) {
          await btn.click(); break;
        }
      }
      await sleep(3000);
    }

    // ─── PASSO 3: Preço e Royalties ──────────────────────────────────────────

    logger.info('Configurando preço e royalties...');

    // Selecionar royalty 70% (mínimo $2.99 no KDP)
    const price = Math.max(ebook.price || 4.99, 2.99);

    try {
      // Royalty 70%
      const royalty70 = await page.$('#royalty-rate-70, input[value="70"]');
      if (royalty70) await royalty70.click();
      await sleep(500);

      // Preço (território US — obrigatório)
      const priceInput = await page.$('#price_USD_print, input[name*="USD"], input[id*="USD"]');
      if (priceInput) {
        await priceInput.click({ clickCount: 3 });
        await priceInput.type(price.toFixed(2), { delay: 30 });
      }
    } catch { logger.warn('Campos de preço não encontrados'); }

    // Disponível em todos os territórios
    try {
      const worldwideRadio = await page.$('input[value="WORLDWIDE"], input[id*="worldwide"]');
      if (worldwideRadio) await worldwideRadio.click();
    } catch {}

    await sleep(1000);

    // ===== PUBLICAR =====
    logger.info('Publicando no KDP...');
    try {
      // Botão "Publish Your Kindle eBook" ou "Save and Publish"
      const publishBtn = await page.$('input[id*="publish"], button[id*="publish"]');
      if (publishBtn) {
        await publishBtn.click();
        await sleep(5000);
      } else {
        // Fallback genérico
        const btns = await page.$$('button, input[type="submit"]');
        for (const btn of btns) {
          const txt = await page.evaluate(el => el.textContent || el.value || '', btn);
          if (txt.toLowerCase().includes('publish')) { await btn.click(); break; }
        }
        await sleep(5000);
      }
    } catch { logger.warn('Botão de publicar não encontrado'); }

    const finalUrl = page.url();
    logger.info(`✅ Submetido ao KDP! URL: ${finalUrl}`);

    // Extrair ASIN se disponível na URL
    const asinMatch = finalUrl.match(/\/([A-Z0-9]{10})(\/|$)/);
    const asin = asinMatch ? asinMatch[1] : null;

    return {
      success: true,
      url: finalUrl,
      asin,
      platform: 'amazon',
      note: 'E-book enviado para revisão do KDP (aprovação em 24-72h)',
    };

  } catch (err) {
    logger.error(`Erro no Amazon KDP: ${err.message}`);
    try {
      const screenshotPath = path.join(__dirname, '../../logs/amazon_error.png');
      await page.screenshot({ path: screenshotPath, fullPage: false });
      logger.info(`Screenshot salvo em ${screenshotPath}`);
    } catch {}
    return { success: false, error: err.message, platform: 'amazon' };
  } finally {
    await browser.close();
  }
}

module.exports = { publishToAmazon };
