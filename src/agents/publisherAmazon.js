/**
 * PublisherAmazon — Publica e-book no Amazon KDP via Puppeteer com sessão salva.
 *
 * Setup inicial: node scripts/setup-sessions.js amazon
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs   = require('fs');
const { createLogger } = require('../core/logger');
const logger = createLogger('publisherAmazon');

const BASE_URL     = 'https://kdp.amazon.com';
const BOOKSHELF    = 'https://kdp.amazon.com/pt_BR/bookshelf';
const NEW_TITLE    = 'https://kdp.amazon.com/pt_BR/title-setup/kindle/new';
const SESSION_FILE = path.join(__dirname, '../../data/sessions/amazon.json');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (e) {
    logger.warn(`Erro ao carregar sessão Amazon: ${e.message}`);
    return null;
  }
}

async function publishToAmazon(ebook) {
  logger.info(`📤 Amazon KDP: publicando "${ebook.title}"`);

  const session = loadSession();
  if (!session) {
    logger.warn('⚠️  Sessão Amazon não encontrada. Execute: node scripts/setup-sessions.js amazon');
    return { success: false, error: 'Sessão não configurada.', platform: 'amazon' };
  }

  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=pt-BR',
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });

  try {
    // ── Injetar cookies ──────────────────────────────────────────────────────
    logger.info('🍪 Injetando sessão Amazon...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

    for (const cookie of (session.cookies || [])) {
      try {
        const c = { ...cookie };
        if (!c.domain) c.domain = '.amazon.com.br';
        await page.setCookie(c);
      } catch {}
    }

    // ── Verificar login ──────────────────────────────────────────────────────
    await page.goto(BOOKSHELF, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    const url = page.url();
    if (url.includes('signin') || url.includes('ap/signin') || url.includes('auth')) {
      logger.warn(`⚠️  Sessão Amazon expirada. Execute: node scripts/setup-sessions.js amazon`);
      await browser.close();
      return { success: false, error: 'Sessão expirada.', platform: 'amazon' };
    }

    logger.info('✅ Sessão Amazon válida — criando e-book Kindle');

    // ── Novo título Kindle ───────────────────────────────────────────────────
    await page.goto(NEW_TITLE, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // ── ETAPA 1: Detalhes do livro ───────────────────────────────────────────
    await fillField(page, [
      'input[id*="title" i]', 'input[name*="title" i]',
      'input[placeholder*="título" i]', 'input[placeholder*="title" i]',
    ], ebook.title);
    await sleep(400);

    if (ebook.subtitle) {
      await fillField(page, ['input[id*="subtitle" i]', 'input[name*="subtitle" i]'], ebook.subtitle);
      await sleep(300);
    }

    const authorName = process.env.AUTHOR_NAME || 'GENIA Publishing';
    await fillField(page, [
      'input[id*="author" i]', 'input[name*="author" i]',
      'input[placeholder*="autor" i]', 'input[placeholder*="author" i]',
    ], authorName);
    await sleep(300);

    const desc = ebook.description || ebook.subtitle || `Guia completo sobre ${ebook.topic || ebook.title}`;
    await fillField(page, [
      'textarea[id*="description" i]', 'textarea[name*="description" i]',
      'textarea[placeholder*="descrição" i]',
    ], desc.substring(0, 4000));
    await sleep(400);

    try {
      const langSel = await page.$('select[id*="language" i], select[name*="language" i]');
      if (langSel) { await langSel.select('por'); await sleep(300); }
    } catch {}

    await clickButton(page, ['Salvar e continuar', 'Save and continue', 'Próximo', 'Next']);
    await sleep(3000);

    // ── ETAPA 2: Conteúdo ────────────────────────────────────────────────────
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      logger.info('📄 Upload manuscrito PDF...');
      const fileInput = await page.$('input[type="file"][accept*="pdf"], input[type="file"][id*="manuscript" i], input[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(ebook.pdfPath);
        logger.info('⏳ Processando (KDP pode demorar ~30s)...');
        await sleep(25000);
      }
    }

    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      logger.info('🖼️  Upload capa...');
      const coverInput = await page.$('input[type="file"][accept*="image"], input[type="file"][id*="cover" i]');
      if (coverInput) { await coverInput.uploadFile(ebook.coverPath); await sleep(8000); }
    }

    await clickButton(page, ['Salvar e continuar', 'Save and continue', 'Próximo', 'Next']);
    await sleep(3000);

    // ── ETAPA 3: Precificação ────────────────────────────────────────────────
    logger.info('💰 Configurando preço KDP...');

    try {
      const worldRights = await page.$('input[value="WORLD"], label:has-text("Todos os territórios")');
      if (worldRights) { await worldRights.click(); await sleep(500); }
    } catch {}

    // Royalties 35% (sem restrição de preço mínimo)
    try {
      const r35 = await page.$('input[value="35"], label:has-text("35%")');
      if (r35) { await r35.click(); await sleep(300); }
    } catch {}

    // Preço USD (mínimo $0.99 no plano 35%)
    const priceUsd = Math.max(0.99, (ebook.price || 4.99) * 0.2).toFixed(2);
    await fillField(page, [
      'input[id*="us-price" i]', 'input[name*="us_price" i]', 'input[id*="USD" i]',
    ], priceUsd);
    await sleep(500);

    logger.info('🚀 Publicando no KDP...');
    await clickButton(page, ['Publicar e-book Kindle', 'Publish Your Kindle eBook', 'Salvar e publicar', 'Publicar']);
    await sleep(5000);

    const finalUrl = page.url();
    logger.info(`✅ Amazon KDP: submetido! URL: ${finalUrl}`);
    return { success: true, url: finalUrl, platform: 'amazon' };

  } catch (err) {
    logger.error(`❌ Amazon KDP: ${err.message}`);
    try {
      fs.mkdirSync(path.join(__dirname, '../../logs'), { recursive: true });
      await page.screenshot({ path: path.join(__dirname, '../../logs/amazon_error.png') });
    } catch {}
    return { success: false, error: err.message, platform: 'amazon' };
  } finally {
    await browser.close();
  }
}

async function fillField(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({ clickCount: 3 }); await el.type(String(value), { delay: 20 }); return true; }
    } catch {}
  }
  return false;
}

async function clickButton(page, labels) {
  for (const label of labels) {
    try {
      const el = await page.$(`button:has-text("${label}"), input[value="${label}"]`);
      if (el) { await el.click(); return true; }
    } catch {}
  }
  return false;
}

module.exports = { publishToAmazon };
