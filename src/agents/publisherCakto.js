/**
 * PublisherCakto — Publica e-book na plataforma Cakto via Puppeteer
 */
const puppeteer = require('puppeteer');
const path = require('path');
const { createLogger } = require('../core/logger');
const logger = createLogger('publisherCakto');

const BASE_URL = 'https://app.cakto.com.br';
const HEADLESS = process.env.HEADLESS !== 'false';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function publishToCakto(ebook) {
  logger.info(`Publicando no Cakto: ${ebook.title}`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    // ===== LOGIN =====
    logger.info('Fazendo login no Cakto...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
    await page.type('input[type="email"], input[name="email"]', process.env.CAKTO_EMAIL, { delay: 50 });

    await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    await page.type('input[type="password"]', process.env.CAKTO_PASSWORD, { delay: 50 });

    await page.click('button[type="submit"], button:has-text("Entrar"), button:has-text("Login")');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
    logger.info('✅ Login no Cakto OK');

    // ===== CRIAR PRODUTO =====
    await page.goto(`${BASE_URL}/dashboard/products/new`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Nome do produto
    const nameSelector = 'input[name="name"], input[placeholder*="nome"], input[placeholder*="título"]';
    await page.waitForSelector(nameSelector, { timeout: 10000 });
    await page.click(nameSelector);
    await page.type(nameSelector, ebook.title, { delay: 30 });

    // Tipo: Ebook/Digital
    try {
      const typeSelectors = ['select[name="type"]', '[data-type="ebook"]', 'button:has-text("E-book")', 'label:has-text("E-book")'];
      for (const sel of typeSelectors) {
        const el = await page.$(sel);
        if (el) { await el.click(); break; }
      }
    } catch (e) { logger.warn('Tipo não selecionado: ' + e.message); }

    // Descrição
    const descSelectors = ['textarea[name="description"]', 'textarea[placeholder*="descrição"]', '.description-editor'];
    for (const sel of descSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await el.type(ebook.description || ebook.title, { delay: 20 });
        break;
      }
    }

    // Preço
    const priceSelectors = ['input[name="price"]', 'input[placeholder*="preço"]', 'input[placeholder*="valor"]'];
    for (const sel of priceSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type('4.99', { delay: 30 });
        break;
      }
    }

    // Upload PDF
    if (ebook.pdfPath) {
      logger.info('Fazendo upload do PDF...');
      const fileInput = await page.$('input[type="file"][accept*="pdf"], input[type="file"]:not([accept*="image"])');
      if (fileInput) {
        await fileInput.uploadFile(ebook.pdfPath);
        await sleep(3000); // Aguardar upload
        logger.info('PDF enviado');
      }
    }

    // Upload Capa
    if (ebook.coverPath) {
      logger.info('Fazendo upload da capa...');
      const imageInput = await page.$('input[type="file"][accept*="image"]');
      if (imageInput) {
        await imageInput.uploadFile(ebook.coverPath);
        await sleep(3000);
        logger.info('Capa enviada');
      }
    }

    // ===== SALVAR / PUBLICAR =====
    await sleep(1000);
    const submitSelectors = ['button[type="submit"]:has-text("Publicar")', 'button:has-text("Salvar")', 'button[type="submit"]'];
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); break; }
    }

    await sleep(3000);
    const currentUrl = page.url();
    logger.info(`✅ Publicado no Cakto! URL: ${currentUrl}`);

    return { success: true, url: currentUrl, platform: 'cakto' };

  } catch (err) {
    logger.error(`Erro no Cakto: ${err.message}`);
    // Screenshot para debug
    try { await page.screenshot({ path: path.join(__dirname, '../../logs/cakto_error.png') }); } catch {}
    return { success: false, error: err.message, platform: 'cakto' };
  } finally {
    await browser.close();
  }
}

module.exports = { publishToCakto };
