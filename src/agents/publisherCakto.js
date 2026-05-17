/**
 * PublisherCakto — Publica e-book na Cakto via Puppeteer com sessão salva.
 *
 * Setup inicial (one-time):
 *   node scripts/setup-sessions.js
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs   = require('fs');
const { createLogger } = require('../core/logger');
const logger = createLogger('publisherCakto');

const BASE_URL     = 'https://app.cakto.com.br';
const SESSION_FILE = path.join(__dirname, '../../data/sessions/cakto.json');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (data.savedAt && Date.now() - data.savedAt > 7 * 24 * 60 * 60 * 1000) {
      logger.warn('⚠️  Sessão Cakto com mais de 7 dias — pode estar expirada');
    }
    return data;
  } catch (e) {
    logger.warn(`Erro ao carregar sessão Cakto: ${e.message}`);
    return null;
  }
}

async function publishToCakto(ebook) {
  logger.info(`📤 Cakto: publicando "${ebook.title}"`);

  const session = loadSession();
  if (!session) {
    logger.warn('⚠️  Sessão Cakto não encontrada. Execute: node scripts/setup-sessions.js');
    return { success: false, error: 'Sessão não configurada. Execute setup-sessions.js', platform: 'cakto' };
  }

  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    // ── Injetar cookies da sessão salva ──────────────────────────────────────
    logger.info('🍪 Injetando sessão salva...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

    if (session.cookies?.length) {
      for (const cookie of session.cookies) {
        try { await page.setCookie(cookie); } catch {}
      }
    }

    if (session.localStorage || session.sessionStorage) {
      await page.evaluateOnNewDocument((ls, ss) => {
        if (ls) Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
        if (ss) Object.entries(ss).forEach(([k, v]) => { try { sessionStorage.setItem(k, v); } catch {} });
      }, session.localStorage || {}, session.sessionStorage || {});
    }

    // ── Navegar para dashboard de produtos ───────────────────────────────────
    await page.goto(`${BASE_URL}/dashboard/products`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    const url = page.url();
    if (url.includes('/login') || url.includes('/auth')) {
      logger.warn(`⚠️  Sessão Cakto expirada. Execute: node scripts/setup-sessions.js`);
      await browser.close();
      return { success: false, error: 'Sessão expirada. Execute setup-sessions.js para renovar.', platform: 'cakto' };
    }

    logger.info('✅ Sessão Cakto válida — criando produto');

    // ── Navegação para novo produto ──────────────────────────────────────────
    await page.goto(`${BASE_URL}/dashboard/products/new`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // Nome
    const nameSelectors = [
      'input[name="name"]',
      'input[placeholder*="nome" i]',
      'input[placeholder*="título" i]',
      'input[placeholder*="title" i]',
    ];
    for (const sel of nameSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ clickCount: 3 }); await el.type(ebook.title, { delay: 30 }); break; }
      } catch {}
    }
    await sleep(500);

    // Tipo: Ebook
    const typeSelectors = [
      '[data-type="ebook"]',
      'button:has-text("E-book")',
      'label:has-text("E-book")',
      'option[value="ebook"]',
    ];
    for (const sel of typeSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await sleep(500); break; }
      } catch {}
    }

    // Descrição
    const desc = ebook.description || ebook.subtitle || `E-book: ${ebook.title}`;
    for (const sel of ['textarea[name="description"]', 'textarea[placeholder*="descrição" i]']) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await el.type(desc.substring(0, 500), { delay: 10 }); break; }
      } catch {}
    }
    await sleep(500);

    // Preço
    const price = (ebook.price || 4.99).toFixed(2);
    for (const sel of ['input[name="price"]', 'input[placeholder*="preço" i]', 'input[placeholder*="valor" i]']) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ clickCount: 3 }); await el.type(price, { delay: 30 }); break; }
      } catch {}
    }
    await sleep(500);

    // Upload PDF
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      logger.info('📄 Upload do PDF...');
      for (const sel of ['input[type="file"][accept*="pdf"]', 'input[type="file"]:not([accept*="image"])']) {
        try {
          const el = await page.$(sel);
          if (el) { await el.uploadFile(ebook.pdfPath); await sleep(8000); break; }
        } catch {}
      }
    }

    // Upload Capa
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      logger.info('🖼️  Upload da capa...');
      for (const sel of ['input[type="file"][accept*="image"]', 'input[name="thumbnail"]', 'input[name="cover"]']) {
        try {
          const el = await page.$(sel);
          if (el) { await el.uploadFile(ebook.coverPath); await sleep(5000); break; }
        } catch {}
      }
    }

    // Publicar
    logger.info('🚀 Publicando...');
    for (const sel of ['button:has-text("Publicar")', 'button:has-text("Salvar")', 'button[type="submit"]']) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await sleep(4000); break; }
      } catch {}
    }

    const finalUrl = page.url();
    logger.info(`✅ Cakto: produto criado! URL: ${finalUrl}`);
    return { success: true, url: finalUrl, platform: 'cakto' };

  } catch (err) {
    logger.error(`❌ Cakto: ${err.message}`);
    try {
      const dir = path.join(__dirname, '../../logs');
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'cakto_error.png') });
    } catch {}
    return { success: false, error: err.message, platform: 'cakto' };
  } finally {
    await browser.close();
  }
}

module.exports = { publishToCakto };
