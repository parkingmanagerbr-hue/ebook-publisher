/**
 * PublisherHotmart — Publica e-book na Hotmart via Puppeteer
 */
const puppeteer = require('puppeteer');
const path = require('path');
const { createLogger } = require('../core/logger');
const logger = createLogger('publisherHotmart');

const BASE_URL = 'https://app-vlc.hotmart.com';
const HEADLESS = process.env.HEADLESS !== 'false';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function publishToHotmart(ebook) {
  logger.info(`Publicando na Hotmart: ${ebook.title}`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    // ===== LOGIN =====
    logger.info('Fazendo login na Hotmart...');
    await page.goto('https://app-vlc.hotmart.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Email
    await page.waitForSelector('#hotmart-custom-input-email, input[type="email"], input[name="email"]', { timeout: 15000 });
    const emailInput = await page.$('#hotmart-custom-input-email') || await page.$('input[type="email"]');
    await emailInput.type(process.env.HOTMART_EMAIL, { delay: 50 });

    // Próximo passo (se houver botão Continuar)
    const continueBtn = await page.$('button:has-text("Continuar"), button[type="submit"]:not(:has-text("Entrar"))');
    if (continueBtn) { await continueBtn.click(); await sleep(1500); }

    // Senha
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.type('input[type="password"]', process.env.HOTMART_PASSWORD, { delay: 50 });

    await page.click('button[type="submit"], button:has-text("Entrar"), #btnLogin');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 });
    logger.info('✅ Login na Hotmart OK');

    await sleep(2000);

    // ===== CRIAR PRODUTO =====
    // Navegar para criação de produto
    await page.goto(`${BASE_URL}/products/new`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Verificar se chegou na página certa, senão tentar via menu
    if (!page.url().includes('products')) {
      await page.goto(`${BASE_URL}/products`, { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(1500);
      const newBtn = await page.$('a[href*="new"], button:has-text("Novo produto"), button:has-text("Criar produto")');
      if (newBtn) await newBtn.click();
      await sleep(2000);
    }

    // Selecionar tipo Ebook (se houver escolha)
    const ebookOption = await page.$('[data-format="EBOOK"], button:has-text("E-book"), label:has-text("E-book")');
    if (ebookOption) { await ebookOption.click(); await sleep(1000); }

    // Nome
    const nameInput = await page.$('input[name="productName"], input[placeholder*="nome"], input[placeholder*="título"]');
    if (nameInput) {
      await nameInput.click({ clickCount: 3 });
      await nameInput.type(ebook.title, { delay: 30 });
    }

    // Descrição
    const descInput = await page.$('textarea[name="productDescription"], textarea[placeholder*="descrição"]');
    if (descInput) {
      await descInput.click();
      await descInput.type(ebook.description || ebook.subtitle || ebook.title, { delay: 15 });
    }

    // Idioma: Português
    try {
      const langSelect = await page.$('select[name="language"]');
      if (langSelect) await page.select('select[name="language"]', 'pt');
    } catch {}

    // Categoria
    try {
      const catSelect = await page.$('select[name="category"]');
      if (catSelect) await page.select('select[name="category"]', 'BUSINESS'); // categoria default
    } catch {}

    await sleep(1000);

    // Próxima etapa (detalhes/conteúdo)
    const nextBtn = await page.$('button:has-text("Próximo"), button:has-text("Continuar"), button[type="submit"]');
    if (nextBtn) { await nextBtn.click(); await sleep(2000); }

    // ===== UPLOAD ARQUIVO =====
    // Upload PDF
    if (ebook.pdfPath) {
      logger.info('Fazendo upload do PDF na Hotmart...');
      const fileInput = await page.$('input[type="file"][accept*="pdf"], input[type="file"][name*="file"]');
      if (fileInput) {
        await fileInput.uploadFile(ebook.pdfPath);
        await sleep(5000); // Upload pode demorar
        logger.info('PDF enviado');
      }
    }

    // ===== PREÇO =====
    // Navegar para aba de preços
    const priceTab = await page.$('[href*="price"], button:has-text("Preço"), a:has-text("Precificação")');
    if (priceTab) { await priceTab.click(); await sleep(1500); }

    const priceInput = await page.$('input[name="price"], input[placeholder*="preço"], input[placeholder*="valor"]');
    if (priceInput) {
      await priceInput.click({ clickCount: 3 });
      await priceInput.type('4.99', { delay: 30 });
    }

    // Moeda BRL
    try {
      const currencySelect = await page.$('select[name="currency"]');
      if (currencySelect) await page.select('select[name="currency"]', 'BRL');
    } catch {}

    // ===== CAPA =====
    if (ebook.coverPath) {
      logger.info('Fazendo upload da capa na Hotmart...');
      const coverInput = await page.$('input[type="file"][accept*="image"], input[name="thumbnail"]');
      if (coverInput) {
        await coverInput.uploadFile(ebook.coverPath);
        await sleep(4000);
        logger.info('Capa enviada');
      }
    }

    // ===== SALVAR / PUBLICAR =====
    await sleep(1000);
    const publishBtn = await page.$('button:has-text("Publicar"), button:has-text("Salvar e publicar"), button[type="submit"]');
    if (publishBtn) { await publishBtn.click(); await sleep(3000); }

    const currentUrl = page.url();
    logger.info(`✅ Publicado na Hotmart! URL: ${currentUrl}`);

    return { success: true, url: currentUrl, platform: 'hotmart' };

  } catch (err) {
    logger.error(`Erro na Hotmart: ${err.message}`);
    try { await page.screenshot({ path: path.join(__dirname, '../../logs/hotmart_error.png') }); } catch {}
    return { success: false, error: err.message, platform: 'hotmart' };
  } finally {
    await browser.close();
  }
}

module.exports = { publishToHotmart };
