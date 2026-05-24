/**
 * publisherCakto.js — Publica e-book na Cakto via Puppeteer
 *
 * Changes v2:
 *  - Uses SPA-native navigation (click "Criar produto") instead of direct URL goto
 *  - Screenshots at each key step
 *  - Handles modal and inline form patterns
 *  - Extracts product shortlink URL from page after creation
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let log;
try {
  const L = require('../core/Logger');
  log = L.createLogger ? L.createLogger('cakto') : { info: console.log, warn: console.warn, error: console.error };
} catch(e) {
  log = { info: (...a) => console.log('[cakto]', ...a), warn: (...a) => console.warn('[cakto]', ...a), error: (...a) => console.error('[cakto]', ...a) };
}

const BASE_URL        = 'https://app.cakto.com.br';
const SESSION_FILE    = process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR   || '/app/data/landing_screenshots';
const LOGS_DIR        = '/app/data/logs';
const DEFAULT_PRICE   = parseFloat(process.env.EBOOK_PRICE || '4.99');

// ── Session ───────────────────────────────────────────────────────────────────
function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (data.savedAt && Date.now() - data.savedAt > 7 * 24 * 60 * 60 * 1000) {
      log.warn('Sessão Cakto com mais de 7 dias — pode estar expirada');
    }
    return data;
  } catch(e) { log.warn('Erro ao carregar sessão Cakto: ' + e.message); return null; }
}

// ── Screenshot helper ─────────────────────────────────────────────────────────
async function screenshot(page, label) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const f = path.join(LOGS_DIR, 'cakto_' + label + '.png');
    await page.screenshot({ path: f, fullPage: false });
    log.info('Screenshot: ' + f);
  } catch {}
}

// ── Click button by text ──────────────────────────────────────────────────────
async function clickByText(page, texts, timeout = 12000) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((arr) => {
      const btns = Array.from(document.querySelectorAll(
        'button, [role="button"], a[class*="btn"], a[class*="button"], span[class*="btn"]'
      ));
      for (const t of arr) {
        const tl = t.toLowerCase();
        const el = btns.find(b => (b.textContent || '').trim().toLowerCase().includes(tl));
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return (el.textContent || '').trim().slice(0, 40); }
        }
      }
      return null;
    }, arr);
    if (clicked) { log.info('Clicked: "' + clicked + '"'); return true; }
    await sleep(500);
  }
  log.warn('Button not found: ' + arr.join(', '));
  return false;
}

// ── Fill input ────────────────────────────────────────────────────────────────
async function fillInput(page, selectors, value) {
  const arr = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of arr) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await sleep(100);
        await el.type(String(value), { delay: 20 });
        return true;
      }
    } catch {}
  }
  return false;
}

// ── Dump form state for debugging ─────────────────────────────────────────────
async function dumpFormState(page, label) {
  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => ({ tag: e.tagName, name: e.name, id: e.id, ph: e.placeholder ? e.placeholder.slice(0, 30) : '', type: e.type }))
      .slice(0, 15);
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => (e.textContent || '').trim().slice(0, 30))
      .filter(Boolean);
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .map(e => ({ id: e.id, name: e.name, accept: e.accept }));
    return { url: location.href.slice(-60), inputs: inputs.slice(0, 10), btns: btns.slice(0, 10), fileInputs };
  }).catch(() => ({}));
  log.info('[' + label + '] url=' + info.url);
  log.info('[' + label + '] inputs: ' + JSON.stringify(info.inputs));
  log.info('[' + label + '] btns: ' + JSON.stringify(info.btns));
  log.info('[' + label + '] files: ' + JSON.stringify(info.fileInputs));
}

// ── Main publisher ────────────────────────────────────────────────────────────
async function publishToCakto(ebook) {
  log.info('Cakto: publicando "' + ebook.title + '"');

  const session = loadSession();
  if (!session) {
    log.warn('Sessão Cakto não encontrada. Execute: node scripts/setup-sessions.js cakto');
    return { success: false, error: 'Sessão não configurada', platform: 'cakto' };
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  if (session.localStorage) {
    await page.evaluateOnNewDocument((ls) => {
      Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
    }, session.localStorage);
  }

  try {
    // ── Inject session ────────────────────────────────────────────────────────
    log.info('Injetando sessão...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(1000);

    for (const cookie of (session.cookies || [])) {
      try { await page.setCookie(cookie); } catch {}
    }

    // ── Verify login ──────────────────────────────────────────────────────────
    await page.goto(BASE_URL + '/dashboard/products', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/auth') || currentUrl.includes('/signin')) {
      log.warn('Sessão Cakto expirada');
      await browser.close();
      return { success: false, error: 'Sessão expirada', platform: 'cakto' };
    }
    log.info('Sessão válida. URL: ' + currentUrl.slice(0, 80));
    await screenshot(page, 'products_list');

    // ── Open new product form (SPA navigation) ────────────────────────────────
    // Strategy 1: Click "Criar produto" button (SPA route)
    let formOpened = await clickByText(page, [
      'Criar produto', 'Novo produto', 'Adicionar produto', '+ Produto', 'Criar',
    ], 5000);

    if (!formOpened) {
      // Strategy 2: Navigate to /new route (might work for SPA)
      log.info('Tentando navegação direta para /new...');
      await page.evaluate(() => { window.history.pushState({}, '', '/dashboard/products/new'); });
      await sleep(1500);
      // Dispatch popstate to trigger SPA routing
      await page.evaluate(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
      await sleep(2000);
    }

    await sleep(2000);
    await screenshot(page, 'new_product_form');
    await dumpFormState(page, 'form_open');

    // ── Select product type ───────────────────────────────────────────────────
    // Some Cakto forms show type selection first
    const typeSelected = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, [role="button"], label, [class*="card"], [class*="type"], [class*="tipo"]'));
      const el = all.find(e => {
        const t = (e.textContent || '').toLowerCase();
        return (t.includes('e-book') || t.includes('ebook') || t.includes('infoproduto') ||
                t.includes('digital') || t.includes('arquivo')) && e.getBoundingClientRect().width > 0;
      });
      if (el) { el.click(); return (el.textContent || '').trim().slice(0, 30); }
      return null;
    });
    if (typeSelected) {
      log.info('Tipo selecionado: ' + typeSelected);
      await sleep(1000);
      await screenshot(page, 'type_selected');
    }

    // ── Fill product name ─────────────────────────────────────────────────────
    await sleep(500);
    const nameFilled = await fillInput(page, [
      'input[name="name"]',
      'input[name="title"]',
      'input[placeholder*="nome do produto" i]',
      'input[placeholder*="nome" i]',
      'input[placeholder*="título" i]',
      'input[placeholder*="title" i]',
      'input[id*="name" i]:not([type="hidden"])',
      'input[id*="title" i]:not([type="hidden"])',
      'input[type="text"]:first-of-type',
    ], ebook.title);
    log.info('Name filled: ' + nameFilled);
    await sleep(400);

    // ── Description ───────────────────────────────────────────────────────────
    const desc = (ebook.description || ebook.subtitle || 'Guia completo sobre ' + (ebook.topic || ebook.title)).slice(0, 500);
    await fillInput(page, [
      'textarea[name="description"]',
      'textarea[placeholder*="descri" i]',
      'textarea[name="desc"]',
      'textarea[id*="desc" i]',
      'textarea',
    ], desc).catch(() => {});
    await sleep(300);

    // ── Price ─────────────────────────────────────────────────────────────────
    const price = String((ebook.price || DEFAULT_PRICE).toFixed(2)).replace('.', ',');
    await fillInput(page, [
      'input[name="price"]',
      'input[placeholder*="preço" i]',
      'input[placeholder*="valor" i]',
      'input[placeholder*="price" i]',
      'input[id*="price" i]',
    ], price).catch(() => {});
    await sleep(300);

    await screenshot(page, 'form_filled');
    await dumpFormState(page, 'before_upload');

    // ── Upload PDF ────────────────────────────────────────────────────────────
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      log.info('Upload PDF: ' + ebook.pdfPath);

      // Click any upload trigger button
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll(
          'button, [role="button"], [class*="upload"], [class*="file"], label'
        )).find(e => {
          const t = (e.textContent || '').toLowerCase();
          return (t.includes('pdf') || t.includes('arquivo') || t.includes('file') ||
                  t.includes('upload') || t.includes('enviar') || t.includes('adicionar arquivo')) &&
                 e.getBoundingClientRect().width > 0;
        });
        if (el) el.click();
      });
      await sleep(1000);

      // Look for file input
      let fileInput = await page.$('input[type="file"][accept*="pdf"]').catch(() => null);
      if (!fileInput) fileInput = await page.$('input[type="file"]:not([accept*="image"])').catch(() => null);
      if (!fileInput) fileInput = await page.$('input[type="file"]').catch(() => null);

      if (fileInput) {
        await fileInput.uploadFile(ebook.pdfPath);
        log.info('PDF upload triggered — aguardando...');
        await sleep(8000);
        await screenshot(page, 'after_pdf_upload');
      } else {
        log.warn('PDF file input not found');
        await dumpFormState(page, 'no_pdf_input');
      }
    }

    // ── Upload cover ──────────────────────────────────────────────────────────
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      log.info('Upload capa: ' + ebook.coverPath);

      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll(
          'button, [role="button"], [class*="upload"], [class*="cover"], [class*="imagem"], [class*="thumbnail"], label'
        )).find(e => {
          const t = (e.textContent || '').toLowerCase();
          return (t.includes('imagem') || t.includes('capa') || t.includes('foto') ||
                  t.includes('cover') || t.includes('thumbnail')) &&
                 e.getBoundingClientRect().width > 0;
        });
        if (el) el.click();
      });
      await sleep(1000);

      let coverInput = await page.$('input[type="file"][accept*="image"]').catch(() => null);
      if (!coverInput) {
        const all = await page.$$('input[type="file"]');
        if (all.length >= 2) coverInput = all[1];
      }

      if (coverInput) {
        await coverInput.uploadFile(ebook.coverPath);
        log.info('Cover upload triggered');
        await sleep(5000);
      } else { log.warn('Cover file input not found'); }
    }

    // ── Save / Publish ────────────────────────────────────────────────────────
    log.info('Publicando...');
    const beforeUrl = page.url();

    const published = await clickByText(page, [
      'Publicar', 'Salvar e publicar', 'Criar produto', 'Criar', 'Salvar', 'Save', 'Avançar', 'Continuar',
    ], 10000);

    if (published) {
      // Wait for URL change (product created → navigate to product page or shortlink)
      await sleep(3000);
      let waited = 0;
      while (page.url() === beforeUrl && waited < 10000) {
        await sleep(1000);
        waited += 1000;
      }
    }

    await sleep(3000);
    const finalUrl = page.url();
    log.info('Cakto done! URL: ' + finalUrl);
    await screenshot(page, 'done');

    // Extract product ID / shortlink
    let productUrl = finalUrl;
    let caktoProductId = null;

    // Check for product ID in URL (e.g. /dashboard/products/PRODUCT_ID)
    const prodMatch = finalUrl.match(/\/products\/([a-zA-Z0-9_-]+)$/);
    if (prodMatch) caktoProductId = prodMatch[1];

    // Check for checkout shortlink (e.g. pay.cakto.com.br/XXXX or cakto.com.br/XXXX)
    if (finalUrl.includes('pay.cakto') || finalUrl.match(/cakto\.com\.br\/[A-Za-z0-9]+$/)) {
      productUrl = finalUrl;
      const shortMatch = finalUrl.match(/\/([A-Za-z0-9]{5,})$/);
      if (shortMatch) caktoProductId = shortMatch[1];
    }

    // Screenshot final state
    try {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const safeTitle = ebook.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const ss = path.join(SCREENSHOTS_DIR, 'cakto_' + safeTitle + '.png');
      await page.screenshot({ path: ss });
      log.info('Screenshot final: ' + ss);
    } catch {}

    await browser.close();

    return {
      success: published || (finalUrl !== beforeUrl),
      url: productUrl,
      caktoProductId,
      platform: 'cakto',
    };

  } catch(err) {
    log.error('Cakto error: ' + err.message);
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(LOGS_DIR, 'cakto_error.png') }).catch(() => {});
    } catch {}
    await browser.close().catch(() => {});
    return { success: false, error: err.message, platform: 'cakto' };
  }
}

module.exports = { publishToCakto };
