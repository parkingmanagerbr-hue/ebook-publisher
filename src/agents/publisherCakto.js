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
    // Wait for page CONTENT to render (React SPA hydration can lag beyond networkidle2)
    await page.waitForFunction(() => {
      // Consider page ready when we see ANY button outside the sidebar (<= x280),
      // or at least 3 buttons total (sidebar has ~10 nav items visible anyway)
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      return btns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length > 5;
    }, { timeout: 12000 }).catch(() => {});
    await sleep(2000); // additional buffer for React render

    let currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/auth') || currentUrl.includes('/signin')) {
      log.warn('Sessão Cakto expirada');
      await browser.close();
      return { success: false, error: 'Sessão expirada', platform: 'cakto' };
    }
    // Ensure we're on the "Meus Produtos" tab which shows the products list
    // and the "Adicionar Produto" button. The URL must include ?tab=products.
    if (!currentUrl.includes('?tab=products') && currentUrl.includes('/dashboard/products')) {
      log.info('Navegando para ?tab=products para garantir lista e botão de criar...');
      await page.goto('https://app.cakto.com.br/dashboard/products?tab=products', {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(e => log.warn('goto tab=products: ' + e.message));
      await sleep(3000); // wait for React to render the product list + Adicionar Produto button
      currentUrl = page.url();
    }
    log.info('Sessão válida. URL: ' + currentUrl.slice(0, 80));
    await screenshot(page, 'products_list');

    // ── Check if product already exists (avoid duplicates on retry) ────────────
    // Products list uses "Ativo" filter by default — reset to Todos and search by title
    const shortTitle = ebook.title.slice(0, 20).toLowerCase();
    let existingPayUrl = null;
    {
      // Try to reset Status filter to show all products (including drafts)
      const statusBtn = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, select, [role="combobox"], [class*="select"], [class*="dropdown"], [class*="filter"]'));
        const el = all.find(e => {
          const t = (e.textContent || e.value || '').trim();
          return (t === 'Ativo' || t.includes('Status')) && e.getBoundingClientRect().width > 0;
        });
        if (el) { el.click(); return true; }
        return false;
      }).catch(() => false);
      if (statusBtn) {
        await sleep(800);
        await page.evaluate(() => {
          const opts = Array.from(document.querySelectorAll('li, [role="option"], [role="menuitem"], option, button'));
          const el = opts.find(o => {
            const t = (o.textContent || '').trim().toLowerCase();
            return (t === 'todos' || t === 'all') && o.getBoundingClientRect().width > 0;
          });
          if (el) el.click();
        }).catch(() => {});
        await sleep(1500);
      }
      // Search for product by title in the (now unfiltered) list
      const found = await page.evaluate((sTitle) => {
        const html = document.documentElement.innerHTML || '';
        const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
        // Check if any pay URL is near our title in the HTML
        const rows = Array.from(document.querySelectorAll('tr, [class*="row"], li, [class*="product-item"]'));
        for (const row of rows) {
          if (!row.textContent.toLowerCase().includes(sTitle)) continue;
          const rowHtml = row.innerHTML || '';
          const pm = rowHtml.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
          if (pm) return pm[0];
          // Title matched but no pay URL in row — product might be in draft
          return '__exists_no_url__';
        }
        return null;
      }, shortTitle).catch(() => null);

      if (found && found !== '__exists_no_url__') {
        existingPayUrl = found;
        log.info('Produto já existe no Cakto com pay URL: ' + found);
      } else if (found === '__exists_no_url__') {
        log.info('Produto já existe no Cakto (sem pay URL visível) — tentando publicar...');
        // Click the product row to navigate to its detail page
        const clickedRow = await page.evaluate((sTitle) => {
          const rows = Array.from(document.querySelectorAll('tr, [class*="row"], li, [class*="product-item"]'));
          const row = rows.find(r => r.textContent.toLowerCase().includes(sTitle) && r.textContent.length < 500);
          if (row) { (row.querySelector('a') || row).click(); return true; }
          return false;
        }, shortTitle).catch(() => false);
        if (clickedRow) {
          await sleep(3000);
          const payFromDetail = await page.evaluate(() => {
            const m = (document.documentElement.innerHTML || '').match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
            return m ? m[0] : null;
          }).catch(() => null);
          if (payFromDetail) {
            existingPayUrl = payFromDetail;
          } else {
            // Try to publish the draft product
            const published = await clickByText(page, ['Publicar', 'Ativar', 'Publish', 'Activate'], 8000);
            if (published) {
              await sleep(4000);
              const payAfter = await page.evaluate(() => {
                const m = (document.documentElement.innerHTML || '').match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
                return m ? m[0] : null;
              }).catch(() => null);
              if (payAfter) existingPayUrl = payAfter;
            }
          }
          log.info('Existing product pay URL: ' + (existingPayUrl || 'not found'));
        }
      }
    }

    // If we found the product already exists with a pay URL, return early
    if (existingPayUrl) {
      const m = existingPayUrl.match(/\/([A-Za-z0-9]{5,})$/);
      const existingId = m ? m[1] : 'found';
      log.info('Produto já existia — usando URL: ' + existingPayUrl);
      await browser.close();
      return {
        success: true, platform: 'cakto',
        productUrl: existingPayUrl, caktoProductId: existingId,
        caktoUrl: existingPayUrl,
      };
    }

    // If we navigated away during the existing-product check, go back to the products list
    if (!page.url().includes('/dashboard/products')) {
      await page.goto('https://app.cakto.com.br/dashboard/products?tab=products', {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(() => {});
      await sleep(2000);
    }

    // ── Phase 1: Ensure we're on ?tab=products so "Adicionar Produto" btn is visible ──
    // The "Adicionar Produto" btn at (1164,190) is ONLY present on ?tab=products.
    // On /dashboard/products without tab, only the search FAB at (339,82) is visible.
    // Strategy: click the "Produtos" nav item in the sidebar to activate the tab via SPA routing.
    {
      const prodNavClicked = await page.evaluate(() => {
        // Find the "Produtos" item in the sidebar nav (left side, x < 280)
        const all = Array.from(document.querySelectorAll('nav a, nav button, [class*="sidebar"] a, [class*="sidebar"] button, a, button'));
        const el = all.find(e => {
          const t = (e.textContent || '').trim().toLowerCase();
          const r = e.getBoundingClientRect();
          return (t === 'produtos' || t === 'products') && r.width > 0 && r.height > 0;
        });
        if (el) { el.click(); return 'clicked:' + (el.textContent||'').trim(); }
        return null;
      }).catch(() => null);
      log.info('Produtos nav click: ' + prodNavClicked);
      if (prodNavClicked) await sleep(2000); // wait for SPA to navigate
    }

    // ── Phase 2: Look for "Adicionar Produto" button with explicit search ─────
    // After ?tab=products loads, the btn appears in the top-right of the products list.
    // Try to find it. If not visible after 5s, trigger a hard navigation.
    let adicionarBtnPos = null;
    for (let tabWait = 0; tabWait < 3 && !adicionarBtnPos; tabWait++) {
      if (tabWait > 0) {
        // Hard navigation fallback: goto ?tab=products directly
        await page.goto('https://app.cakto.com.br/dashboard/products?tab=products', {
          waitUntil: 'domcontentloaded', timeout: 20000
        }).catch(e => log.warn('goto tab=products fallback: ' + e.message));
        await sleep(3000);
      }
      adicionarBtnPos = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const targets = ['adicionar produto','criar produto','novo produto','+ produto','+ produto','adicionar','add product','create product'];
        for (const el of all) {
          const t = (el.textContent || '').toLowerCase().trim();
          const r = el.getBoundingClientRect();
          // Must be in the MAIN CONTENT area: x > 600 (right side), y > 60 (below topbar)
          if (r.width > 0 && r.height > 0 && r.left > 600 && r.top > 60) {
            if (targets.some(tgt => t.includes(tgt))) {
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t.slice(0, 40) };
            }
          }
        }
        // Also check for a "+" button in the content area (right side)
        const plusBtn = all.find(el => {
          const t = (el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.left > 600 && r.top > 60 && r.width < 200 &&
                 (t === '+' || t.includes('+') || t === 'Adicionar');
        });
        if (plusBtn) {
          const r = plusBtn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: 'plus:' + (plusBtn.textContent||'').trim().slice(0,30) };
        }
        return null;
      }).catch(() => null);
      log.info('Adicionar Produto btn (tabWait=' + tabWait + '): ' + (adicionarBtnPos ? '"' + adicionarBtnPos.text + '" @(' + Math.round(adicionarBtnPos.x) + ',' + Math.round(adicionarBtnPos.y) + ')' : 'not found'));
    }

    // ── Phase 3: Click "Adicionar Produto" and wait for the modal form ────────
    let formOpened = false;
    if (adicionarBtnPos) {
      log.info('Clicando "Adicionar Produto" @(' + Math.round(adicionarBtnPos.x) + ',' + Math.round(adicionarBtnPos.y) + ')');
      await page.mouse.click(adicionarBtnPos.x, adicionarBtnPos.y);
      // Wait for modal to open: 5+ non-search inputs must appear
      await page.waitForFunction(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[name], textarea'));
        const nonSearch = inputs.filter(i => {
          const r = i.getBoundingClientRect();
          const ph = (i.placeholder || '').toLowerCase();
          return r.width > 0 && r.height > 0 &&
                 !ph.includes('pesquis') && !ph.includes('search') &&
                 !ph.includes('busca') && !ph.includes('filter');
        });
        return nonSearch.length >= 2; // modal has 5 inputs; require at least 2
      }, { timeout: 8000 }).catch(() => {});
      const formCount = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[name], textarea'));
        return inputs.filter(i => {
          const r = i.getBoundingClientRect();
          const ph = (i.placeholder || '').toLowerCase();
          return r.width > 0 && r.height > 0 &&
                 !ph.includes('pesquis') && !ph.includes('search') &&
                 !ph.includes('busca') && !ph.includes('filter');
        }).length;
      }).catch(() => 0);
      log.info('Modal form inputs after Adicionar click: ' + formCount);
      if (formCount >= 2) { formOpened = true; log.info('Modal aberto OK — ' + formCount + ' inputs'); }
    }

    // Fallback: if "Adicionar Produto" not found on ?tab=products, try direct coordinate click
    // at known position (1164,190) which is where the button appears on 1920x1080 viewport
    if (!formOpened) {
      log.info('Adicionar btn not found via text — trying coordinate click at (1164,190)...');
      await page.mouse.click(1164, 190);
      await page.waitForFunction(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[name], textarea'));
        return inputs.filter(i => {
          const r = i.getBoundingClientRect();
          const ph = (i.placeholder || '').toLowerCase();
          return r.width > 0 && r.height > 0 && !ph.includes('pesquis') && !ph.includes('search');
        }).length >= 2;
      }, { timeout: 6000 }).catch(() => {});
      const formCount2 = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input[type="text"], input[name], textarea')).filter(i => {
          const r = i.getBoundingClientRect();
          const ph = (i.placeholder || '').toLowerCase();
          return r.width > 0 && r.height > 0 && !ph.includes('pesquis') && !ph.includes('search');
        }).length;
      }).catch(() => 0);
      log.info('Coordinate click form inputs: ' + formCount2);
      if (formCount2 >= 2) { formOpened = true; log.info('Modal via coordenada'); }
    }

    if (!formOpened) {
      // Strategy 2: Navigate to /new route and wait for React hydration
      log.info('Tentando page.goto para /dashboard/products/new...');
      await page.goto(BASE_URL + '/dashboard/products/new', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => log.warn('goto /new: ' + e.message));
      // Wait up to 12s for a PRODUCT form input (exclude search boxes)
      await page.waitForFunction(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[name], textarea, input[placeholder]'));
        return inputs.some(i => {
          const r = i.getBoundingClientRect();
          const ph = (i.placeholder || '').toLowerCase();
          return r.width > 0 && r.height > 0 &&
                 !ph.includes('pesquis') && !ph.includes('search') &&
                 !ph.includes('busca') && !ph.includes('filter') && !ph.includes('filtro');
        });
      }, { timeout: 12000 }).catch(e => log.warn('waitForForm: ' + e.message));
      await sleep(1000);

      // Strategy 3: if still no form, scroll down — form might be below fold
      const formAfterGoto = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="text"], input[name], textarea')).filter(i => {
          const r = i.getBoundingClientRect();
          const ph = (i.placeholder || '').toLowerCase();
          return r.width > 0 && r.height > 0 &&
                 !ph.includes('pesquis') && !ph.includes('search') &&
                 !ph.includes('busca') && !ph.includes('filter') && !ph.includes('filtro');
        }).length
      );
      if (!formAfterGoto) {
        log.info('Form still not visible — trying scroll + wait');
        await page.evaluate(() => window.scrollTo(0, 500));
        await sleep(2000);
      }
    }

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
      // Last-resort: first visible text input that is NOT a search/filter box
      'input[type="text"]:not([placeholder*="esquisa"]):not([placeholder*="earch"]):not([placeholder*="usca"]):not([placeholder*="iltro"])',
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

    // ── Network interception: capture ALL API responses to find product data ──
    let interceptedPayUrl = null;
    let interceptedProductId = null;
    const capturedApiCalls = []; // DEBUG: log all JSON responses
    const responseHandler = async (response) => {
      try {
        const rUrl = response.url();
        if (response.status() < 200 || response.status() >= 300) return;
        const ct = (response.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;
        const json = await response.json().catch(() => null);
        if (!json) return;
        const text = JSON.stringify(json);
        // DEBUG: log every JSON response URL and snippet
        capturedApiCalls.push(rUrl.slice(-80) + ' → ' + text.slice(0, 100));
        // Look for pay URL pattern directly in response
        const payMatch = text.match(/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
        if (payMatch) {
          interceptedPayUrl = 'https://pay.cakto.com.br/' + payMatch[1];
          interceptedProductId = payMatch[1];
          log.info('API intercepted pay URL: ' + interceptedPayUrl);
          return;
        }
        // Look for shortcode/slug/id fields
        const shortMatch = text.match(/"(?:shortlink|shortcode|slug|checkout_url|checkoutUrl|pay_url|payUrl|payment_link|paymentLink|short_link)":\s*"([A-Za-z0-9_\-]{4,})"/) ||
                           text.match(/"(?:id|productId|product_id|uuid)":\s*"([A-Za-z0-9\-]{8,})"/) ;
        if (shortMatch && !shortMatch[1].match(/^\d{4}-\d{2}-\d{2}/) && !interceptedProductId) {
          interceptedProductId = shortMatch[1];
          log.info('API intercepted product field: ' + shortMatch[0].slice(0, 80) + ' from ' + rUrl.slice(-60));
        }
      } catch {}
    };
    page.on('response', responseHandler);

    // Try clicking Continuar up to 3 times — wait for form validation to settle
    let step2reached = false;
    let createdInStep1 = false; // true when modal closed after Continuar (product already created)
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
          createdInStep1 = newState.modalClosed; // product already created — skip type selection
          log.info(newState.modalClosed ? 'Modal fechou — produto criado em step 1!' : 'Avançou para step 2!');
        }
      }
    }

    // ── Remove network listener — log what was captured ─────────────────────
    page.off('response', responseHandler);
    log.info('API calls captured during Continuar: ' + capturedApiCalls.length);
    capturedApiCalls.forEach((c, i) => log.info('  API[' + i + ']: ' + c));

    // ── Secondary: scan page HTML / React state for pay URL (if interception missed) ──
    if (!interceptedPayUrl && createdInStep1) {
      const fromPageState = await page.evaluate(() => {
        // Check window.__NEXT_DATA__ (Next.js apps embed server state here)
        try {
          const nd = window.__NEXT_DATA__;
          if (nd) {
            const s = JSON.stringify(nd);
            const m = s.match(/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
            if (m) return 'https://pay.cakto.com.br/' + m[1];
            // Also look for shortcode/slug in nested props
            const sm = s.match(/"(?:shortlink|shortcode|slug|checkout_url|payment_link)":\s*"([A-Za-z0-9_\-]{5,})"/);
            if (sm) return '__id:' + sm[1];
          }
        } catch {}
        // Check raw page HTML for pay URL
        const html = document.documentElement.innerHTML || '';
        const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
        if (m && m.length > 0) return m[0];
        // Check for any product ID/shortcode in the page state data
        const idMatch = html.match(/"(?:shortlink|shortcode|slug)":\s*"([A-Za-z0-9]{4,})"/);
        if (idMatch) return '__id:' + idMatch[1];
        return null;
      }).catch(() => null);

      // Also try direct API fetch using session cookies
      if (!fromPageState) {
        const apiResult = await page.evaluate(async (sTitle) => {
          const endpoints = [
            '/api/v1/products?limit=10&sort=-createdAt',
            '/api/products?limit=10&sort=-createdAt',
            '/api/v1/products?status=draft&limit=10',
            '/api/products?status=draft&limit=10',
            '/graphql',
          ];
          for (const ep of endpoints) {
            try {
              const r = await fetch(ep, {
                credentials: 'include',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                ...(ep.includes('graphql') ? {
                  method: 'POST',
                  body: JSON.stringify({ query: '{ products { id shortcode title status } }' })
                } : {})
              });
              if (r.ok) {
                const txt = await r.text();
                const snippet = txt.slice(0, 300);
                return { endpoint: ep, snippet };
              }
            } catch (e) {}
          }
          return null;
        }, shortTitle).catch(() => null);
        if (apiResult) {
          log.info('Direct API fetch ' + apiResult.endpoint + ': ' + apiResult.snippet);
          // Try to extract pay URL from result
          const pm = (apiResult.snippet || '').match(/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
          if (pm) {
            interceptedPayUrl = 'https://pay.cakto.com.br/' + pm[1];
            interceptedProductId = pm[1];
            log.info('API fetch pay URL: ' + interceptedPayUrl);
          }
        } else {
          log.info('Direct API fetch: all endpoints failed or returned non-200');
        }
      }

      if (fromPageState) {
        if (fromPageState.startsWith('__id:')) {
          interceptedProductId = fromPageState.slice(5);
          log.info('Page state: product ID=' + interceptedProductId);
        } else {
          interceptedPayUrl = fromPageState;
          const m = fromPageState.match(/\/([A-Za-z0-9]{5,})$/);
          if (m) interceptedProductId = m[1];
          log.info('Page state: pay URL=' + interceptedPayUrl);
        }
      }
    }

    // Log interception result
    if (interceptedPayUrl) {
      log.info('Interception result: pay URL=' + interceptedPayUrl);
    } else if (interceptedProductId) {
      log.info('Interception result: product ID only=' + interceptedProductId);
    } else {
      log.info('Interception result: nothing captured');
    }

    // ── Step 2: Product type selection ("O que você vai vender?") ───────────
    // If Cakto advanced to the type selection screen, pick "Acesso por e-mail"
    // CRITICAL: use page.mouse.click() (trusted event) — React ignores evaluate().click()
    // NOTE: skip if createdInStep1 — product already exists, type selection not needed
    if (step2reached && !createdInStep1) {
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
    // Declare result vars before branching
    let productUrl = null;
    let caktoProductId = null;
    const beforeUrl = page.url();

    if (!createdInStep1) {
      log.info('Publicando...');
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
    } else {
      // ── createdInStep1: modal closed after Continuar — product IS created ────
      // Primary: use intercepted API response (most reliable)
      if (interceptedPayUrl) {
        productUrl = interceptedPayUrl;
        caktoProductId = interceptedProductId;
        log.info('createdInStep1: pay URL from API interception: ' + productUrl);
      } else if (interceptedProductId && interceptedProductId.length >= 5 && !/^\d+$/.test(interceptedProductId)) {
        // Have a product ID but no full pay URL — construct it
        productUrl = 'https://pay.cakto.com.br/' + interceptedProductId;
        caktoProductId = interceptedProductId;
        log.info('createdInStep1: constructed pay URL from product ID: ' + productUrl);
      } else {
        // Fallback: navigate products list and search for draft product
        log.info('createdInStep1=true — buscando produto na lista (incluindo rascunhos)...');

      const findAndPublishProduct = async () => {
        // 1. Navigate to products list (domcontentloaded avoids frame detachment + timeout)
        await page.goto('https://app.cakto.com.br/dashboard/products?tab=products', {
          waitUntil: 'domcontentloaded', timeout: 20000
        }).catch(e => log.warn('goto products list: ' + e.message));
        await sleep(4000); // extra wait for React to render list

        // 2. Reset the Status filter to show ALL products (not just "Ativo")
        // Click the Status dropdown and select "Todos"
        const filterReset = await page.evaluate(() => {
          // Find the Status dropdown button/select — look for elements containing "Ativo" text
          const all = Array.from(document.querySelectorAll('button, select, [role="combobox"], [class*="select"], [class*="dropdown"], [class*="filter"]'));
          const statusBtn = all.find(el => {
            const t = (el.textContent || el.value || '').trim();
            return (t === 'Ativo' || t.includes('Ativo') || t.includes('Status')) && el.getBoundingClientRect().width > 0;
          });
          if (statusBtn) { statusBtn.click(); return 'clicked:' + (statusBtn.textContent || statusBtn.tagName).slice(0, 30); }
          return null;
        }).catch(() => null);
        log.info('Status filter click: ' + filterReset);
        if (filterReset) {
          await sleep(1000);
          // Select "Todos" option from the dropdown
          const todosClicked = await page.evaluate(() => {
            const opts = Array.from(document.querySelectorAll('li, [role="option"], [role="menuitem"], option, button'));
            const el = opts.find(o => {
              const t = (o.textContent || '').trim().toLowerCase();
              return (t === 'todos' || t === 'all' || t === 'rascunho' || t.includes('todos')) && o.getBoundingClientRect().width > 0;
            });
            if (el) { el.click(); return (el.textContent || '').trim(); }
            return null;
          });
          log.info('Status option selected: ' + todosClicked);
          await sleep(2000); // wait for list to reload with all statuses
        }

        // 3. Also try via URL — some apps support status param
        // Scan the current page HTML for our product's pay link or title
        const shortTitle = ebook.title.slice(0, 20).toLowerCase();

        for (let attempt = 0; attempt < 3 && !productUrl; attempt++) {
          if (attempt > 0) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await sleep(3000);
          }

          // 4. Search page HTML for pay URL (product might be visible as data attr or link)
          const found = await page.evaluate((sTitle) => {
            // 4a. Any pay.cakto.com.br link on page
            const links = Array.from(document.querySelectorAll('a[href*="pay.cakto"], a[href*="cakto.com.br/"]'));
            if (links.length > 0) {
              // Prefer link that's in a row matching our title
              const match = links.find(l => {
                const row = l.closest('tr, [class*="row"], [class*="product"], li') || l.parentElement;
                return row && row.textContent.toLowerCase().includes(sTitle);
              });
              return match ? match.href : links[0].href;
            }
            // 4b. Pay URL pattern anywhere in page HTML (data attrs, JSON state, etc.)
            const html = document.documentElement.innerHTML || '';
            const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
            if (m && m.length > 0) return m[0];
            // 4c. Is our product title visible in any row?
            const rows = Array.from(document.querySelectorAll('tr, [class*="row"], li, [class*="product-item"]'));
            const row = rows.find(r => r.textContent.toLowerCase().includes(sTitle) && r.textContent.length < 500);
            return row ? '__row_found__' : null;
          }, shortTitle).catch(() => null);

          log.info('Produto search attempt ' + (attempt + 1) + ': ' + (found || 'null'));

          if (found && found !== '__row_found__' && found.includes('pay.cakto')) {
            productUrl = found;
            const m = found.match(/\/([A-Za-z0-9]{5,})$/);
            if (m) caktoProductId = m[1];
            log.info('Pay URL encontrada na lista: ' + productUrl);
            break;
          } else if (found === '__row_found__' || (found && found.includes('pay.cakto'))) {
            // Product found in list — click on it to get detail page
            log.info('Produto encontrado na lista — navegando para detalhes...');
            const clickResult = await page.evaluate((sTitle) => {
              const rows = Array.from(document.querySelectorAll('tr, [class*="row"], li, [class*="product-item"], td'));
              const row = rows.find(r => r.textContent.toLowerCase().includes(sTitle) && r.textContent.length < 500);
              if (!row) return null;
              // Click on the row or a link within it
              const link = row.querySelector('a') || row;
              const r = link.getBoundingClientRect();
              link.click();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }, shortTitle).catch(() => null);

            if (clickResult) {
              await sleep(3000);
              await screenshot(page, 'cakto_product_detail');
              const detailUrl = page.url();
              log.info('Detail page URL: ' + detailUrl);

              // Look for pay URL in detail page
              const payUrl = await page.evaluate(() => {
                const html = document.documentElement.innerHTML || '';
                const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
                if (m) return m[0];
                const links = Array.from(document.querySelectorAll('a[href*="pay.cakto"]'));
                return links.length > 0 ? links[0].href : null;
              }).catch(() => null);

              if (payUrl) {
                productUrl = payUrl;
                const m = payUrl.match(/\/([A-Za-z0-9]{5,})$/);
                if (m) caktoProductId = m[1];
                log.info('Pay URL from detail: ' + payUrl);
              } else {
                // Try clicking "Publicar" if product is in draft state
                log.info('Tentando publicar produto do detalhe...');
                const published = await clickByText(page, ['Publicar', 'Ativar', 'Publish', 'Activate'], 8000);
                if (published) {
                  await sleep(5000);
                  const payAfterPublish = await page.evaluate(() => {
                    const html = document.documentElement.innerHTML || '';
                    const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
                    return m ? m[0] : null;
                  }).catch(() => null);
                  if (payAfterPublish) {
                    productUrl = payAfterPublish;
                    const m = payAfterPublish.match(/\/([A-Za-z0-9]{5,})$/);
                    if (m) caktoProductId = m[1];
                    log.info('Pay URL após publicar: ' + payAfterPublish);
                  }
                }
                if (!productUrl) {
                  caktoProductId = caktoProductId || 'created';
                  log.warn('Pay URL não encontrada no detalhe — produto criado mas sem URL de checkout');
                }
              }
            }
            break; // exit retry loop
          }
        }
      };

      await findAndPublishProduct();

      if (!caktoProductId) {
        // Product was created (modal closed) but we couldn't locate via list — still success
        caktoProductId = 'created';
        log.warn('createdInStep1 mas checkout URL não encontrada — marcando como sucesso');
      }
      } // end else (no intercepted pay URL)
    }

    await sleep(2000);
    const finalUrl = page.url();
    log.info('Cakto done! URL: ' + finalUrl);
    await screenshot(page, 'done');

    // ── Extract product ID / shortlink from final URL (normal publish path) ──
    // Only use finalUrl as productUrl if it's a valid pay/checkout URL (not a dashboard page)
    if (!productUrl) {
      if (finalUrl.includes('pay.cakto') || finalUrl.match(/cakto\.com\.br\/[A-Za-z0-9]{5,}$/)) {
        productUrl = finalUrl;
      } else if (!createdInStep1) {
        // For non-createdInStep1 path, use finalUrl as fallback
        productUrl = finalUrl;
      }
      // For createdInStep1 with no pay URL found, leave productUrl null
      // (caller will save as null rather than a wrong dashboard URL)
    }
    if (!caktoProductId) {
      const prodMatch = finalUrl.match(/\/products\/([a-zA-Z0-9_-]+)$/);
      if (prodMatch) caktoProductId = prodMatch[1];
      if (finalUrl.includes('pay.cakto') || finalUrl.match(/cakto\.com\.br\/[A-Za-z0-9]+$/)) {
        productUrl = finalUrl;
        const shortMatch = finalUrl.match(/\/([A-Za-z0-9]{5,})$/);
        if (shortMatch) caktoProductId = shortMatch[1];
      }
    }

    // Screenshot final state
    try {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const safeTitle = ebook.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'cakto_' + safeTitle + '.png') });
    } catch {}

    // ── Real success detection ─────────────────────────────────────────────────
    // createdInStep1 is an EXPLICIT success (modal closed = product created on Cakto)
    let realSuccess = createdInStep1;
    let titleFoundInList = false;

    if (!realSuccess) {
      const isTabUrl = finalUrl.includes('?tab=products');
      if (isTabUrl && !caktoProductId && step2reached) {
        await sleep(2000);
        titleFoundInList = await page.evaluate((title) => {
          const short = title.slice(0, 30).toLowerCase();
          return Array.from(document.querySelectorAll('td, tr, li, [role="row"], [class*="name"], [class*="title"], [class*="product"]'))
            .some(el => { const t = el.textContent.toLowerCase(); return t.includes(short) && t.length < 200; });
        }, ebook.title).catch(() => false);
        log.info('Título na lista após publicar: ' + titleFoundInList);
      }
      const nothingCreated = (caktoProductId === 'new' || finalUrl.endsWith('/products/new')) && !titleFoundInList;
      realSuccess = !nothingCreated && (
        (caktoProductId !== null && caktoProductId !== 'new') ||
        (!isTabUrl && finalUrl !== beforeUrl && !finalUrl.endsWith('/products/new')) ||
        (step2reached && titleFoundInList)
      );
    }

    log.info('Success: ' + realSuccess + ' createdInStep1=' + createdInStep1 + ' step2=' + step2reached + ' prodId=' + caktoProductId + ' url=' + productUrl);

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
