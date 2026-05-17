/**
 * PublisherHotmart — Publica e-book na Hotmart via Puppeteer com sessão salva.
 *
 * Fluxo:
 *   1. Carrega sessão salva de data/sessions/hotmart.json
 *   2. Injeta cookies no browser → pula login
 *   3. Navega para criação de produto → preenche → faz upload → publica
 *
 * Setup inicial (one-time):
 *   node scripts/setup-hotmart.js
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../core/logger');
const logger = createLogger('publisherHotmart');

const BASE_URL     = 'https://app-vlc.hotmart.com';
const SESSION_FILE = path.join(__dirname, '../../data/sessions/hotmart.json');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Carregar sessão salva ────────────────────────────────────────────────────
function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    // Verificar se a sessão não expirou (> 7 dias = considerar inválida)
    if (data.savedAt && Date.now() - data.savedAt > 7 * 24 * 60 * 60 * 1000) {
      logger.warn('⚠️  Sessão Hotmart com mais de 7 dias — pode estar expirada');
    }
    return data;
  } catch (e) {
    logger.warn(`Erro ao carregar sessão Hotmart: ${e.message}`);
    return null;
  }
}

// ─── Verificar se está logado na página atual ─────────────────────────────────
async function isLoggedIn(page) {
  try {
    const url = page.url();
    if (url.includes('/login') || url.includes('/auth')) return false;
    // Procura por elementos de usuário logado
    const userEl = await page.$('[data-test="user-avatar"], .user-avatar, [aria-label*="conta"], .hotmart-avatar');
    return !!userEl;
  } catch { return false; }
}

// ─── Publicar produto na Hotmart ──────────────────────────────────────────────
async function publishToHotmart(ebook) {
  logger.info(`📤 Hotmart: publicando "${ebook.title}"`);

  const session = loadSession();
  if (!session) {
    logger.warn('⚠️  Sessão Hotmart não encontrada. Execute: node scripts/setup-hotmart.js');
    return { success: false, error: 'Sessão não configurada. Execute setup-hotmart.js', platform: 'hotmart' };
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

  // Disfarçar automação
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    // ── Extrair Bearer token (access_token CAS embutido no JWT) ──────────────
    const rawToken = session.localStorage?.['token'];
    let bearerToken = rawToken;
    if (rawToken) {
      try {
        const payload = JSON.parse(Buffer.from(rawToken.split('.')[1], 'base64url').toString());
        bearerToken = payload.access_token || rawToken;
      } catch {}
    }

    // ── Injetar localStorage antes da navegação ───────────────────────────────
    if (session.localStorage) {
      await page.evaluateOnNewDocument(ls => {
        Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
      }, session.localStorage);
    }

    // ── Injetar cookies + Authorization header ────────────────────────────────
    logger.info('🍪 Injetando sessão Hotmart...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    for (const cookie of (session.cookies || [])) {
      try { await page.setCookie(cookie); } catch {}
    }
    if (bearerToken) {
      await page.setExtraHTTPHeaders({ 'Authorization': `Bearer ${bearerToken}` });
    }

    // ── Navegar para painel ──────────────────────────────────────────────────
    await page.goto(`${BASE_URL}/products`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    const curUrl = page.url();
    if (curUrl.includes('/login') || curUrl.includes('sso.hotmart')) {
      logger.warn(`⚠️  Sessão Hotmart expirada. Execute: node scripts/setup-sessions.js hotmart`);
      await browser.close();
      return { success: false, error: 'Sessão expirada. Execute setup-sessions.js hotmart', platform: 'hotmart' };
    }

    logger.info('✅ Sessão Hotmart válida — iniciando criação de produto');

    // ── Navegar para novo produto ────────────────────────────────────────────
    await page.goto(`${BASE_URL}/products/new`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // ── ETAPA 1: Tipo de produto — selecionar E-book ─────────────────────────
    const ebookSelectors = [
      '[data-format="EBOOK"]',
      'button:has-text("E-book")',
      'label:has-text("E-book")',
      '[data-product-type="EBOOK"]',
      '.product-type-ebook',
    ];
    for (const sel of ebookSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await sleep(1000); break; }
      } catch {}
    }

    // ── ETAPA 2: Informações básicas ─────────────────────────────────────────
    // Nome do produto
    const nameSelectors = [
      'input[name="productName"]',
      'input[placeholder*="nome do produto" i]',
      'input[placeholder*="título" i]',
      'input[placeholder*="name" i]',
      '#product-name',
    ];
    for (const sel of nameSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(ebook.title, { delay: 30 });
          break;
        }
      } catch {}
    }
    await sleep(500);

    // Descrição
    const descSelectors = [
      'textarea[name="productDescription"]',
      'textarea[placeholder*="descrição" i]',
      'textarea[placeholder*="description" i]',
      '#product-description',
    ];
    const description = ebook.description || ebook.subtitle || `E-book completo sobre ${ebook.topic || ebook.title}`;
    for (const sel of descSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await el.type(description.substring(0, 500), { delay: 10 });
          break;
        }
      } catch {}
    }
    await sleep(500);

    // Idioma (Português)
    try {
      const langSelect = await page.$('select[name="language"], select[id*="language"]');
      if (langSelect) await page.select('select[name="language"], select[id*="language"]', 'pt');
    } catch {}

    // Próxima etapa
    await clickNext(page);
    await sleep(3000);

    // ── ETAPA 3: Upload do arquivo PDF ────────────────────────────────────────
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      logger.info('📄 Fazendo upload do PDF...');
      const fileInputSelectors = [
        'input[type="file"][accept*="pdf"]',
        'input[type="file"][name*="file"]',
        'input[type="file"][name*="content"]',
        'input[type="file"]',
      ];
      for (const sel of fileInputSelectors) {
        try {
          const fileInput = await page.$(sel);
          if (fileInput) {
            await fileInput.uploadFile(ebook.pdfPath);
            logger.info('📤 PDF enviado, aguardando processamento...');
            await sleep(10000); // Upload pode demorar
            break;
          }
        } catch {}
      }
    }

    // Próxima etapa
    await clickNext(page);
    await sleep(3000);

    // ── ETAPA 4: Preço ───────────────────────────────────────────────────────
    logger.info('💰 Configurando preço...');
    const priceTab = await page.$('[href*="price"], button:has-text("Preço"), a:has-text("Precificação"), a:has-text("Price")');
    if (priceTab) { await priceTab.click(); await sleep(2000); }

    const price = (ebook.price || 4.99).toFixed(2);
    const priceSelectors = [
      'input[name="price"]',
      'input[placeholder*="preço" i]',
      'input[placeholder*="valor" i]',
      'input[placeholder*="price" i]',
      '#product-price',
    ];
    for (const sel of priceSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(price, { delay: 30 });
          break;
        }
      } catch {}
    }

    // Moeda BRL
    try {
      const currencySelect = await page.$('select[name="currency"]');
      if (currencySelect) await page.select('select[name="currency"]', 'BRL');
    } catch {}

    // ── ETAPA 5: Capa (thumbnail) ─────────────────────────────────────────────
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      logger.info('🖼️  Fazendo upload da capa...');
      const coverSelectors = [
        'input[type="file"][accept*="image"]',
        'input[type="file"][name*="thumbnail"]',
        'input[type="file"][name*="cover"]',
        'input[type="file"][name*="image"]',
      ];
      for (const sel of coverSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.uploadFile(ebook.coverPath);
            await sleep(5000);
            break;
          }
        } catch {}
      }
    }

    // ── ETAPA 6: Publicar ─────────────────────────────────────────────────────
    logger.info('🚀 Publicando produto...');
    const publishSelectors = [
      'button:has-text("Publicar")',
      'button:has-text("Salvar e publicar")',
      'button:has-text("Publish")',
      'button:has-text("Salvar")',
    ];
    let published = false;
    for (const sel of publishSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); published = true; await sleep(4000); break; }
      } catch {}
    }

    if (!published) {
      // Tentar submit genérico
      try { await page.keyboard.press('Enter'); await sleep(3000); } catch {}
    }

    const finalUrl = page.url();
    logger.info(`✅ Hotmart: produto criado! URL: ${finalUrl}`);

    return { success: true, url: finalUrl, platform: 'hotmart' };

  } catch (err) {
    logger.error(`❌ Hotmart: ${err.message}`);
    try {
      const screenshotDir = path.join(__dirname, '../../logs');
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDir, 'hotmart_error.png') });
    } catch {}
    return { success: false, error: err.message, platform: 'hotmart' };
  } finally {
    await browser.close();
  }
}

// ─── Helper: clicar em botão "Próximo" / "Continuar" ─────────────────────────
async function clickNext(page) {
  const selectors = [
    'button:has-text("Próximo")',
    'button:has-text("Continuar")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    } catch {}
  }
  return false;
}

module.exports = { publishToHotmart };
