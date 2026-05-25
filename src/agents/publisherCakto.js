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

// ── Click button by text — two-stage: standard selectors then ALL elements ────
async function clickByText(page, texts, timeout = 12000) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const pos = await page.evaluate((arr) => {
      function norm(s) { return (s || '').toLowerCase().trim(); }

      // Stage 1: standard button/role/a selectors (fast, works for regular buttons)
      const btns = Array.from(document.querySelectorAll(
        'button, [role="button"], a[class*="btn"], a[class*="button"], input[type="submit"], input[type="button"]'
      ));
      for (const text of arr) {
        const tl = norm(text);
        for (const el of btns) {
          const t = norm(el.textContent || el.value || '');
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.height < 120 && (t === tl || t.startsWith(tl) || t.includes(tl))) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t.slice(0, 40), tag: el.tagName, stage: 1 };
          }
        }
      }

      // Stage 2: ANY visible element in the form area (x > 280) — catches custom React components
      const all = Array.from(document.querySelectorAll('*'));
      for (const text of arr) {
        const tl = norm(text);
        for (const el of all) {
          const t = norm(el.textContent || '');
          // Only near-leaf nodes with short text content
          if (!t || t.length > 100) continue;
          if (el.children.length > 4) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 8 && r.height < 120 && r.x > 280 &&
              (t === tl || t.startsWith(tl) || t.includes(tl))) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t.slice(0, 40), tag: el.tagName, stage: 2 };
          }
        }
      }
      return null;
    }, arr);

    if (pos && pos.x > 0) {
      log.info('Clicking "' + pos.text + '" [' + pos.tag + '] @(' + Math.round(pos.x) + ',' + Math.round(pos.y) + ') stage=' + pos.stage);
      await page.mouse.click(pos.x, pos.y);
      return true;
    }
    await sleep(500);
  }

  log.warn('Button not found: ' + arr.join(', '));
  return false;
}

// ── Fill input — React-compatible via native value setter ─────────────────────
async function fillInput(page, selectors, value) {
  const arr = Array.isArray(selectors) ? selectors : [selectors];
  const strVal = String(value);
  for (const sel of arr) {
    try {
      const found = await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return null;
        // Click to focus
        el.focus();
        el.click();
        // Try React native value setter first (handles controlled inputs)
        const nativeProto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(nativeProto, 'value');
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(el, val);
        } else {
          el.value = val;
        }
        // Dispatch events so React detects the change
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { tag: el.tagName, name: el.name || '', val: el.value.slice(0, 30) };
      }, sel, strVal);
      if (found) {
        log.info('fillInput [' + sel + '] => "' + found.val + '"');
        return true;
      }
    } catch(e) { log.warn('fillInput err [' + sel + ']: ' + e.message.slice(0, 60)); }
  }
  return false;
}

// ── Fill price field — special handling for currency inputs ───────────────────
async function fillPrice(page, price) {
  const strPrice = String(price); // e.g. "5,99"
  const result = await page.evaluate((strPrice) => {
    // Try all likely price selectors
    const selectors = [
      'input[placeholder*="0,00"]',
      'input[name="price"]',
      'input[placeholder*="R$" i]',
      'input[id*="price" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el || el.getBoundingClientRect().width === 0) continue;
      el.focus();
      el.click();
      // Select all
      el.setSelectionRange(0, el.value.length);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, strPrice);
      } else {
        el.value = strPrice;
      }
      el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: strPrice }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
      return { sel, val: el.value };
    }
    return null;
  }, strPrice);
  if (result) {
    log.info('fillPrice => "' + result.val + '" via ' + result.sel);
    return true;
  }
  log.warn('fillPrice: price field not found');
  return false;
}

// ── Dump form state for debugging ─────────────────────────────────────────────
async function dumpFormState(page, label) {
  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => ({ tag: e.tagName, name: e.name, id: e.id, ph: e.placeholder ? e.placeholder.slice(0, 30) : '', type: e.type, val: (e.value || '').slice(0, 30) }))
      .slice(0, 15);
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => (e.textContent || '').trim().slice(0, 30))
      .filter(Boolean);
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .map(e => ({ id: e.id, name: e.name, accept: e.accept }));
    // Also check for any validation errors
    const errors = Array.from(document.querySelectorAll('[class*="error" i], [class*="invalid" i], [aria-invalid="true"]'))
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => (e.textContent || '').trim().slice(0, 50))
      .filter(Boolean).slice(0, 5);
    return { url: location.href.slice(-60), inputs: inputs.slice(0, 10), btns: btns.slice(0, 10), fileInputs, errors };
  }).catch(() => ({}));
  log.info('[' + label + '] url=' + info.url);
  log.info('[' + label + '] inputs: ' + JSON.stringify(info.inputs));
  log.info('[' + label + '] btns: ' + JSON.stringify(info.btns));
  log.info('[' + label + '] files: ' + JSON.stringify(info.fileInputs));
  if (info.errors && info.errors.length > 0) log.warn('[' + label + '] ERRORS: ' + JSON.stringify(info.errors));
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

    await sleep(4000); // wait for React modal to fully render
    await screenshot(page, 'new_product_form');
    await dumpFormState(page, 'form_open');

    // ── Select product type & set hidden type field ───────────────────────────
    // Check current type field value and set it if empty
    const typeResult = await page.evaluate(() => {
      // First check what type input currently has
      const typeInput = document.querySelector('input[name="type"]');
      const currentType = typeInput ? typeInput.value : 'N/A';

      // Try clicking a type card (e-book / digital product)
      const all = Array.from(document.querySelectorAll('button, [role="button"], label, [class*="card"], [class*="type"], [class*="tipo"]'));
      const el = all.find(e => {
        const t = (e.textContent || '').toLowerCase();
        return (t.includes('e-book') || t.includes('ebook') || t.includes('infoproduto') ||
                t.includes('digital') || t.includes('arquivo')) && e.getBoundingClientRect().width > 0;
      });
      if (el) { el.click(); }

      // If type input still empty, set it via native setter
      if (typeInput && !typeInput.value) {
        const candidates = ['EBOOK', 'ebook', 'digital', 'DIGITAL'];
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        for (const v of candidates) {
          if (nativeSetter && nativeSetter.set) nativeSetter.set.call(typeInput, v);
          else typeInput.value = v;
          typeInput.dispatchEvent(new Event('input',  { bubbles: true }));
          typeInput.dispatchEvent(new Event('change', { bubbles: true }));
          if (typeInput.value) break;
        }
      }

      return {
        cardClicked: el ? (el.textContent || '').trim().slice(0, 30) : null,
        typeWas:    currentType,
        typeNow:    typeInput ? typeInput.value : 'N/A',
      };
    });
    log.info('Type: was="' + typeResult.typeWas + '" now="' + typeResult.typeNow + '" card=' + (typeResult.cardClicked || 'none'));
    if (typeResult.cardClicked || typeResult.typeNow) await sleep(1000);

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

    // ── Description (Cakto requires MINIMUM 100 chars) ───────────────────────
    let desc = ebook.description || ebook.subtitle || '';
    if (!desc || desc.length < 100) {
      // Build a longer default description
      const base = 'Guia completo e prático sobre ' + (ebook.topic || ebook.title);
      const suffix = '. Aprenda as melhores estratégias e técnicas com conteúdo direto ao ponto, desenvolvido para quem quer resultados reais.';
      desc = (desc ? desc + ' ' + suffix : base + suffix);
    }
    // Cap at 500 chars to avoid potential upper limits
    desc = desc.slice(0, 500);
    log.info('Desc len=' + desc.length + ' (min100)');
    await fillInput(page, [
      'textarea[name="description"]',
      'textarea[placeholder*="descri" i]',
      'textarea[name="desc"]',
      'textarea[id*="desc" i]',
      'textarea',
    ], desc).catch(() => {});
    await sleep(300);

    // ── Sales page URL (required field — use Hotmart URL or generic) ──────────
    const salesUrl = ebook.hotmartUrl || ebook.caktoUrl || 'https://hotmart.com';
    await fillInput(page, [
      'input[name="salesPage"]',
      'input[placeholder*="https" i]',
      'input[type="url"]',
    ], salesUrl).catch(() => {});
    await sleep(200);

    // ── Price (Cakto minimum is R$ 5,00 — use special fillPrice for currency inputs) ─
    const rawPrice = Math.max(5.00, ebook.price || DEFAULT_PRICE);
    const price = String(rawPrice.toFixed(2)).replace('.', ',');
    await fillPrice(page, price);
    await sleep(500);

    await screenshot(page, 'form_filled');
    await dumpFormState(page, 'before_upload');

    // ── Step 1 → Step 2: Click Continuar ─────────────────────────────────────
    log.info('Avançando para step 2...');
    const beforeStep1Url = page.url();

    // Try clicking Continuar up to 3 times — wait for form validation to settle
    let step2reached = false;
    for (let attempt = 0; attempt < 3 && !step2reached; attempt++) {
      if (attempt > 0) {
        log.info('Tentativa ' + (attempt + 1) + ' de avançar para step 2...');
        // Re-fill price in case it was reset
        await fillPrice(page, price);
        await sleep(300);
      }
      const step1ok = await clickByText(page, ['Continuar', 'Avançar', 'Próximo', 'Next'], 8000);
      if (step1ok) {
        await sleep(4000);
        await screenshot(page, 'step2_attempt' + attempt);
        await dumpFormState(page, 'step2_attempt' + attempt);
        // Check if we actually advanced: file inputs appeared, URL changed, OR modal closed
        const newState = await page.evaluate(() => {
          const files = document.querySelectorAll('input[type="file"]');
          // Modal closed = step1 form fields (name/description) are gone from DOM
          const nameInput = document.querySelector('input[name="name"]');
          const descInput = document.querySelector('textarea[name="description"]');
          const url = location.href;
          return {
            fileCount: files.length,
            url: url.slice(-80),
            modalClosed: !nameInput && !descInput,
          };
        });
        log.info('Step2 check: fileCount=' + newState.fileCount + ' modalClosed=' + newState.modalClosed + ' url=' + newState.url);
        if (newState.fileCount > 0 || page.url() !== beforeStep1Url || newState.modalClosed) {
          step2reached = true;
          log.info(newState.modalClosed ? 'Modal fechou — produto criado em step 1!' : 'Avançou para step 2!');
        }
      }
    }

    // ── Step 2: Product type selection ("O que você vai vender?") ───────────
    // If Cakto advanced to the type selection screen, pick "Acesso por e-mail"
    // CRITICAL: use page.mouse.click() (trusted event) — React ignores evaluate().click()
    if (step2reached) {
      const typePos = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, [role="button"], div, h3, p, span'));
        const typeCards = ['acesso por e-mail', 'link de pagamento', 'infoproduto', 'ebook', 'arquivo'];
        for (const target of typeCards) {
          const el = all.find(e => {
            const t = (e.textContent || '').toLowerCase().trim();
            return t === target || t.startsWith(target.slice(0, 12));
          });
          if (el && el.getBoundingClientRect().width > 0) {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, target };
          }
        }
        return null;
      });
      if (typePos) {
        log.info('Tipo encontrado: ' + typePos.target + ' @(' + Math.round(typePos.x) + ',' + Math.round(typePos.y) + ')');
        await page.mouse.click(typePos.x, typePos.y); // TRUSTED click — React requires isTrusted=true
        await sleep(1500);
        log.info('Tipo clicado (trusted): ' + typePos.target);
        // Click "Cadastrar" to confirm type selection
        const cadastrarClicked = await clickByText(page, ['Cadastrar', 'Confirmar', 'Criar'], 5000);
        if (cadastrarClicked) {
          log.info('Cadastrar clicado — aguardando produto ser criado...');
          await sleep(4000);
          await screenshot(page, 'after_cadastrar');
        }
      } else {
        log.info('Tela de seleção de tipo não detectada — pode já ter sido selecionado');
      }
    }

    // ── Step 2: Upload PDF and Cover ──────────────────────────────────────────
    // After "Continuar", Cakto might show file upload step (only in some product types)
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
        log.warn('PDF file input not found on step 2');
        await dumpFormState(page, 'no_pdf_input');
      }
    }

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
      } else { log.warn('Cover file input not found on step 2'); }
    }

    // ── Save / Publish ─────────────────────────────────────────────────────────
    log.info('Publicando...');
    const beforeUrl = page.url();

    const published = await clickByText(page, [
      'Publicar', 'Salvar e publicar', 'Criar produto', 'Criar', 'Salvar', 'Save',
      'Cadastrar', 'Continuar', 'Avançar', 'Finalizar',
    ], 10000);

    if (published) {
      // Wait for URL change (product created → navigate to product page or shortlink)
      await sleep(3000);
      let waited = 0;
      while (page.url() === beforeUrl && waited < 12000) {
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

    // ── Real success detection ─────────────────────────────────────────────────
    // A tab URL means the modal never advanced or product wasn't created.
    // Check: (1) got a product ID, (2) URL changed away from tab, OR (3) title in product list
    const isTabUrl = finalUrl.includes('?tab=products');
    let titleFoundInList = false;

    if (isTabUrl && !caktoProductId && step2reached) {
      // Cakto creates product when "Continuar" is clicked (modal closes) — check if title is now in list
      // Wait a moment for the product list to refresh
      await sleep(2000);
      titleFoundInList = await page.evaluate((title) => {
        const short = title.slice(0, 30).toLowerCase();
        // Check all text-bearing elements on the page
        return Array.from(document.querySelectorAll('td, tr, li, [role="row"], [class*="name"], [class*="title"], [class*="product"]'))
          .some(el => {
            const t = el.textContent.toLowerCase();
            return t.includes(short) && t.length < 200; // avoid matching huge containers
          });
      }, ebook.title).catch(() => false);
      log.info('Título na lista após publicar: ' + titleFoundInList);
    }

    const realSuccess = caktoProductId !== null ||
                        (!isTabUrl && finalUrl !== beforeUrl) ||
                        (step2reached && titleFoundInList);

    log.info('Success: ' + realSuccess + ' step2=' + step2reached + ' prodId=' + caktoProductId + ' titleInList=' + titleFoundInList);

    await browser.close();

    if (!realSuccess) {
      return { success: false, error: 'Produto não criado (URL ficou em ?tab=products sem ID)', platform: 'cakto' };
    }

    return {
      success: true,
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
