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

// ── Cakto Offers API helper — returns pay URL for a product by title ──────────
// The /api/offers/ endpoint returns offers with `id` = the pay shortcode.
// e.g., offer { id: "35vb4nn", name: "Emagreça...", status: "active" }
// → pay URL: https://pay.cakto.com.br/35vb4nn
//
// This runs inside the Puppeteer page context so it uses the browser's auth cookies.
async function getCaktoPayUrlFromApi(page, titleSnippet) {
  try {
    const result = await page.evaluate(async (sTitle) => {
      const endpoints = [
        'https://api.cakto.com.br/api/offers/?limit=200&ordering=-created_at',
        'https://api.cakto.com.br/api/offers/?limit=200',
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          const txt = await r.text();
          if (!txt || txt.startsWith('<')) continue;
          const j = JSON.parse(txt);
          const items = j.results || j.items || (Array.isArray(j) ? j : []);
          // Find offer matching our title (first 20 chars, case insensitive)
          const match = items.find(o => {
            const n = (o.name || '').toLowerCase();
            return n.includes(sTitle) || sTitle.split(' ').filter(Boolean).slice(0,3).every(w => n.includes(w.toLowerCase()));
          });
          if (match) {
            return { offerId: match.id, offerName: match.name, status: match.status, productId: match.product };
          }
          // No match — return raw snippet for debugging
          return { debug: items.slice(0,3).map(o => o.name), count: j.count };
        } catch {}
      }
      return null;
    }, titleSnippet);

    if (result && result.offerId) {
      const payUrl = 'https://pay.cakto.com.br/' + result.offerId;
      log.info('getCaktoPayUrlFromApi: found offer "' + result.offerName + '" id=' + result.offerId + ' status=' + result.status + ' → ' + payUrl);
      return { payUrl, offerId: result.offerId, productId: result.productId };
    } else if (result && result.debug) {
      log.info('getCaktoPayUrlFromApi: no match. Sample offers: ' + JSON.stringify(result.debug) + ' (total: ' + result.count + ')');
    } else {
      log.info('getCaktoPayUrlFromApi: API returned null/HTML');
    }
  } catch (e) {
    log.warn('getCaktoPayUrlFromApi error: ' + e.message);
  }
  return null;
}

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
    await page.goto(BASE_URL + '/dashboard/products', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000); // wait for React SPA redirect/hydration
    // Wait for page CONTENT to render
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      return btns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length > 3;
    }, { timeout: 12000 }).catch(() => {});
    await sleep(1000);

    let currentUrl = page.url();
    log.info('URL após navegação para dashboard: ' + currentUrl.slice(0, 100));
    if (currentUrl.includes('/login') || currentUrl.includes('/auth') || currentUrl.includes('/signin')) {
      log.warn('Sessão Cakto expirada (redirecionou para login) — tentando login automático');
      await screenshot(page, 'session_expired');

      // ── Auto-login with credentials ──────────────────────────────────────────
      const CAKTO_EMAIL    = process.env.CAKTO_EMAIL    || '';
      const CAKTO_PASSWORD = process.env.CAKTO_PASSWORD || '';
      let loginOk = false;

      if (CAKTO_EMAIL && CAKTO_PASSWORD) {
        try {
          // Navigate to login page if not already there
          if (!currentUrl.includes('cakto.com.br')) {
            await page.goto('https://app.cakto.com.br/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await sleep(2000);
          }
          await screenshot(page, 'login_page');

          // Fill email
          const emailPos = await page.evaluate(() => {
            const sel = ['input[type="email"]', 'input[name="email"]', 'input[id*="email" i]', 'input[placeholder*="e-mail" i]', 'input[placeholder*="email" i]'];
            for (const s of sel) {
              const el = document.querySelector(s);
              if (el) { const r = el.getBoundingClientRect(); if (r.width > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
            }
            return null;
          });
          if (emailPos) {
            await page.mouse.click(emailPos.x, emailPos.y, { clickCount: 3 });
            await sleep(200);
            await page.keyboard.type(CAKTO_EMAIL, { delay: 30 });
            await sleep(300);
            log.info('Cakto email preenchido');
          }

          // Fill password
          const passPos = await page.evaluate(() => {
            const sel = ['input[type="password"]', 'input[name="password"]', 'input[id*="pass" i]'];
            for (const s of sel) {
              const el = document.querySelector(s);
              if (el) { const r = el.getBoundingClientRect(); if (r.width > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
            }
            return null;
          });
          if (passPos) {
            await page.mouse.click(passPos.x, passPos.y, { clickCount: 3 });
            await sleep(200);
            await page.keyboard.type(CAKTO_PASSWORD, { delay: 30 });
            await sleep(300);
            log.info('Cakto password preenchido');
          }

          // Submit
          const submitPos = await page.evaluate(() => {
            const sel = ['button[type="submit"]', 'input[type="submit"]', 'button:not([type])'];
            for (const s of sel) {
              for (const el of Array.from(document.querySelectorAll(s))) {
                const t = (el.textContent || el.value || '').toLowerCase();
                const r = el.getBoundingClientRect();
                if (r.width > 0 && (t.includes('entrar') || t.includes('login') || t.includes('acessar') || t.includes('continuar') || t.includes('sign'))) {
                  return { x: r.left + r.width/2, y: r.top + r.height/2 };
                }
              }
            }
            // Fallback: first submit button
            const btn = document.querySelector('button[type="submit"], input[type="submit"]');
            if (btn) { const r = btn.getBoundingClientRect(); if (r.width > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
            return null;
          });
          if (submitPos) {
            await page.mouse.click(submitPos.x, submitPos.y);
            log.info('Cakto submit clicado — aguardando dashboard...');
            await sleep(5000);
            try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
            await sleep(3000);
          }

          currentUrl = page.url();
          log.info('URL após login: ' + currentUrl.slice(0, 100));
          await screenshot(page, 'after_login');

          if (!currentUrl.includes('/login') && !currentUrl.includes('/auth')) {
            loginOk = true;
            log.info('Cakto login bem-sucedido!');
            // Save new session
            try {
              const cookies = await page.cookies();
              let ls = {};
              try { ls = await page.evaluate(() => { const o={}; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);o[k]=localStorage.getItem(k);} return o; }); } catch {}
              const newSession = { platform: 'cakto', savedAt: Date.now(), savedAtHuman: new Date().toLocaleString('pt-BR'), url: page.url(), cookies, localStorage: ls };
              fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
              fs.writeFileSync(SESSION_FILE, JSON.stringify(newSession, null, 2));
              log.info('Nova sessão Cakto salva (' + cookies.length + ' cookies)');
            } catch(se) { log.warn('Erro ao salvar sessão Cakto: ' + se.message); }
          } else {
            log.warn('Login Cakto falhou — ainda em página de login');
          }
        } catch(loginErr) {
          log.warn('Erro no login automático Cakto: ' + loginErr.message.slice(0, 80));
        }
      } else {
        log.warn('CAKTO_EMAIL/CAKTO_PASSWORD não configurados');
      }

      if (!loginOk) {
        await browser.close();
        return { success: false, error: 'Sessão expirada e login automático falhou', platform: 'cakto' };
      }

      // Navigate to products after successful login
      await page.goto('https://app.cakto.com.br/dashboard/products?tab=products', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3000);
      currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
        await browser.close();
        return { success: false, error: 'Login Cakto ok mas redirecionou para login novamente', platform: 'cakto' };
      }
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

      // API fallback: query api.cakto.com.br/api/offers/ to find any product matching this title
      // The offers endpoint returns { id: "shortcode", name: "...", status: "active"|"draft" }
      // where `id` is the shortcode for pay.cakto.com.br/<id>
      if (!existingPayUrl) {
        const apiMatch = await getCaktoPayUrlFromApi(page, shortTitle).catch(() => null);
        if (apiMatch && apiMatch.payUrl) {
          existingPayUrl = apiMatch.payUrl;
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
    // Use 110 as threshold to give buffer for Unicode/encoding discrepancies
    let desc = ebook.description || ebook.subtitle || '';
    if (!desc || desc.length < 110) {
      // Build a longer default description
      const base = 'Guia completo e prático sobre ' + (ebook.topic || ebook.title);
      const suffix = '. Aprenda as melhores estratégias e técnicas com conteúdo direto ao ponto, desenvolvido para quem quer resultados reais e duradouros.';
      desc = (desc ? desc + ' ' + suffix : base + suffix);
    }
    // Ensure >= 110 chars (safety check after any concatenation)
    if (desc.length < 110) {
      desc = desc + ' Conteúdo exclusivo, prático e transformador para sua vida.';
    }
    // Cap at 500 chars to avoid potential upper limits
    desc = desc.slice(0, 500);
    log.info('Desc len=' + desc.length + ' (min100, padded to 110+)');
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

    // ── Network interception: capture ALL POST/PATCH/PUT requests and their responses ──
    let interceptedPayUrl = null;
    let interceptedProductId = null;
    const capturedApiCalls = []; // DEBUG: all write requests
    const requestFinishedHandler = async (request) => {
      try {
        const method = request.method();
        if (!['POST','PATCH','PUT'].includes(method)) return;
        const rUrl = request.url();
        // Skip static assets
        if (/\.(js|css|png|jpg|woff|svg|ico)(\?|$)/.test(rUrl)) return;
        const response = request.response();
        if (!response) return;
        const status = response.status();
        const ct = (response.headers()['content-type'] || '').toLowerCase();
        const text = await response.text().catch(() => '');
        // Log ALL write requests for debugging
        capturedApiCalls.push(method + ' ' + status + ' ' + rUrl.slice(-80) + ' → ' + text.slice(0, 150));
        if (status < 200 || status >= 300 || !text) return;
        // Look for pay URL pattern
        const payMatch = text.match(/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
        if (payMatch) {
          interceptedPayUrl = 'https://pay.cakto.com.br/' + payMatch[1];
          interceptedProductId = payMatch[1];
          log.info('Intercepted pay URL: ' + interceptedPayUrl);
          return;
        }
        // Look for shortcode/slug/id fields
        const shortMatch = text.match(/"(?:shortlink|shortcode|slug|checkout_url|checkoutUrl|pay_url|payUrl|payment_link|short_link)":\s*"([A-Za-z0-9_\-]{4,})"/) ||
                           text.match(/"(?:id|productId|product_id|uuid)":\s*"([A-Za-z0-9\-]{8,})"/) ;
        if (shortMatch && !shortMatch[1].match(/^\d{4}-\d{2}-\d{2}/) && !interceptedProductId) {
          interceptedProductId = shortMatch[1];
          log.info('Intercepted product field: ' + shortMatch[0].slice(0, 80) + ' from ' + rUrl.slice(-60));
        }
      } catch {}
    };
    page.on('requestfinished', requestFinishedHandler);

    // ── Step 1 → Step 2: Click Continuar on form, then handle "O que você vai vender?" ──
    // Cakto wizard flow (confirmed by screenshots):
    //   1. Form (name/desc/price) → Click "Continuar" →
    //   2. "O que você vai vender?" type selection (cards, NO inputs) → Click card + "Cadastrar" →
    //   3. Product created → pay URL via /api/offers/
    //
    // CRITICAL TIMING: The card selection modal closes automatically within ~2s if not interacted.
    // We must detect and click the card IMMEDIATELY — not after sleeping 4 seconds.
    let step2reached = false;
    let productCreatedViaWizard = false; // true when wizard fully completed (card selected + Cadastrar clicked)

    for (let attempt = 0; attempt < 3 && !step2reached; attempt++) {
      if (attempt > 0) {
        log.info('Tentativa ' + (attempt + 1) + ' de avançar...');
        await fillPrice(page, price); // re-fill in case it reset
        await sleep(300);
      }

      const step1ok = await clickByText(page, ['Continuar', 'Avançar', 'Próximo', 'Next'], 8000);
      if (!step1ok) {
        log.info('Attempt ' + attempt + ': Continuar not found');
        continue;
      }

      log.info('Continuar clicked — polling for next step (card selection or file upload)...');
      await screenshot(page, 'step2_after_continuar');

      // Poll every 300ms for up to 10s looking for what appeared next
      const deadline = Date.now() + 10000;
      let pollResult = null;
      while (Date.now() < deadline && !pollResult) {
        pollResult = await page.evaluate(() => {
          // Check 1: "O que você vai vender?" type selection (card grid)
          const allEls = Array.from(document.querySelectorAll('*'));
          // Look for the card title "Área de membros Externa" or similar
          const cardTitles = [
            'área de membros externa', 'acesso por e-mail', 'link de pagamento',
            'cakto members', 'telegram', 'discord', 'área de membros cakto',
          ];
          for (const kw of cardTitles) {
            const el = allEls.find(e => {
              const t = (e.textContent || '').trim().toLowerCase();
              const r = e.getBoundingClientRect();
              return t === kw && r.width > 40 && r.height > 5;
            });
            if (el) {
              const r = el.getBoundingClientRect();
              return { type: 'card_selection', text: el.textContent.trim().slice(0, 40), x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
          }
          // Also check for the modal heading "O que você vai vender?"
          const headingEl = allEls.find(e => {
            const t = (e.textContent || '').trim().toLowerCase();
            return (t === 'o que você vai vender?' || t.includes('o que você vai vender')) &&
                   e.getBoundingClientRect().width > 0 &&
                   e.children.length <= 3;
          });
          if (headingEl) {
            // Find the "Área de membros Externa" card near the heading
            const cards = allEls.filter(e => {
              const t = (e.textContent || '').trim().toLowerCase();
              const r = e.getBoundingClientRect();
              return (t.includes('membros externa') || t.includes('acesso por e-mail')) &&
                     r.width > 60 && r.height > 20;
            });
            if (cards.length > 0) {
              const r = cards[0].getBoundingClientRect();
              return { type: 'card_selection', text: cards[0].textContent.trim().slice(0, 40), x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
            return { type: 'card_heading_only', x: 0, y: 0, text: 'heading found' };
          }
          // Check 2: File input appeared (upload step)
          const fileInputs = document.querySelectorAll('input[type="file"]');
          if (fileInputs.length > 0) return { type: 'file_input', x: 0, y: 0, text: '' };
          // Check 3: Still on form (validation error) — name/desc still present
          const hasForm = !!document.querySelector('input[name="name"]') || !!document.querySelector('textarea[name="description"]');
          if (hasForm) return { type: 'still_on_form', x: 0, y: 0, text: '' };
          // Check 4: URL changed to products list (modal closed without creation)
          const url = location.href;
          if (url.includes('/dashboard/products') && !url.includes('/new')) {
            return { type: 'modal_closed', x: 0, y: 0, text: url.slice(-50) };
          }
          return null;
        }).catch(() => null);

        if (!pollResult) await sleep(300);
      }

      log.info('Poll result: ' + JSON.stringify(pollResult));
      await screenshot(page, 'step2_poll_result' + attempt);

      if (!pollResult) {
        log.info('Poll timed out — no recognizable state');
        continue;
      }

      if (pollResult.type === 'card_selection' || pollResult.type === 'card_heading_only') {
        step2reached = true;
        log.info('Card selection detected: "' + pollResult.text + '"');

        // IMMEDIATELY click the preferred card using trusted mouse.click()
        // Find the best card to click: prefer "Área de membros Externa", fallback to first card
        const cardPos = await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll('*'));
          // Priority order for ebook products
          const priorities = [
            'área de membros externa',
            'acesso por e-mail',
            'link de pagamento',
          ];
          for (const kw of priorities) {
            const el = allEls.find(e => {
              const t = (e.textContent || '').trim().toLowerCase();
              const r = e.getBoundingClientRect();
              return t === kw && r.width > 40 && r.height > 5;
            });
            if (el) {
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent.trim().slice(0, 40) };
            }
          }
          // Fallback: click the first card element (any card with an arrow icon suggests it's clickable)
          const cards = allEls.filter(e => {
            const r = e.getBoundingClientRect();
            return r.width > 100 && r.height > 60 && r.height < 200 &&
                   (e.tagName === 'DIV' || e.tagName === 'BUTTON') &&
                   (e.textContent || '').trim().length > 3 &&
                   e.children.length >= 1 && e.children.length <= 6;
          });
          if (cards.length > 0) {
            const r = cards[0].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: 'card:' + (cards[0].textContent || '').trim().slice(0, 30) };
          }
          return null;
        }).catch(() => null);

        if (cardPos) {
          log.info('Clicking card (trusted): "' + cardPos.text + '" @(' + Math.round(cardPos.x) + ',' + Math.round(cardPos.y) + ')');
          await page.mouse.click(cardPos.x, cardPos.y);
          await sleep(800);
        } else {
          // Fallback: use the position from polling
          if (pollResult.x > 0) {
            log.info('Clicking card via poll pos @(' + Math.round(pollResult.x) + ',' + Math.round(pollResult.y) + ')');
            await page.mouse.click(pollResult.x, pollResult.y);
            await sleep(800);
          }
        }

        // Click "Cadastrar" button to confirm type selection and create product
        await screenshot(page, 'before_cadastrar');
        const cadastrarClicked = await clickByText(page, ['Cadastrar', 'Criar produto', 'Criar', 'Confirmar', 'Continuar'], 6000);
        log.info('Cadastrar clicked: ' + cadastrarClicked);
        if (cadastrarClicked) {
          log.info('Aguardando criação do produto...');
          await sleep(5000);
          await screenshot(page, 'after_cadastrar');
          productCreatedViaWizard = true;
        }
      } else if (pollResult.type === 'file_input') {
        step2reached = true;
        log.info('File upload step reached');
      } else if (pollResult.type === 'still_on_form') {
        log.info('Still on form (validation error?) — attempt ' + attempt);
        await dumpFormState(page, 'form_validation_error' + attempt);
        // Try re-filling description with more content
        if (attempt === 0) {
          const extraDesc = desc + ' Conteúdo exclusivo e completo para transformar sua vida.';
          await fillInput(page, ['textarea[name="description"]', 'textarea'], extraDesc).catch(() => {});
          await sleep(300);
        }
      } else if (pollResult.type === 'modal_closed') {
        log.info('Modal fechou antes de detectar step 2 — URL: ' + pollResult.text);
        step2reached = true; // treat as if we advanced (might have been created)
      }
    }

    // ── Wait for any late API responses, then stop listening ─────────────────
    if (productCreatedViaWizard || step2reached) await sleep(2000);
    page.off('requestfinished', requestFinishedHandler);
    log.info('POST/PATCH calls captured: ' + capturedApiCalls.length);
    capturedApiCalls.forEach((c, i) => log.info('  REQ[' + i + ']: ' + c));

    // ── Scan page for pay URL after wizard completed ──────────────────────────
    if (productCreatedViaWizard || step2reached) {
      const fromPageState = await page.evaluate(() => {
        try {
          const nd = window.__NEXT_DATA__;
          if (nd) {
            const s = JSON.stringify(nd);
            const m = s.match(/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
            if (m) return 'https://pay.cakto.com.br/' + m[1];
          }
        } catch {}
        const html = document.documentElement.innerHTML || '';
        const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
        if (m && m.length > 0) return m[0];
        return null;
      }).catch(() => null);

      if (fromPageState) {
        interceptedPayUrl = fromPageState;
        const m = fromPageState.match(/\/([A-Za-z0-9]{5,})$/);
        if (m) interceptedProductId = m[1];
        log.info('Page state: pay URL=' + interceptedPayUrl);
      }

      // Try /api/offers/ — most reliable way to get the new offer's pay URL
      if (!interceptedPayUrl) {
        await sleep(2000); // give backend a moment to persist
        const apiMatch = await getCaktoPayUrlFromApi(page, shortTitle).catch(() => null);
        if (apiMatch && apiMatch.payUrl) {
          interceptedPayUrl = apiMatch.payUrl;
          interceptedProductId = apiMatch.offerId;
          log.info('Offers API pay URL: ' + interceptedPayUrl);
        } else {
          log.info('Offers API: no match found for "' + shortTitle + '"');
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

    if (!productCreatedViaWizard) {
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
      // ── productCreatedViaWizard: wizard fully completed (card selected + Cadastrar clicked) ──
      // Primary: use intercepted API response (most reliable, already set in wizard section)
      if (interceptedPayUrl) {
        productUrl = interceptedPayUrl;
        caktoProductId = interceptedProductId;
        log.info('wizard done: pay URL from interception: ' + productUrl);
      } else if (interceptedProductId && interceptedProductId.length >= 5 && !/^\d+$/.test(interceptedProductId)) {
        productUrl = 'https://pay.cakto.com.br/' + interceptedProductId;
        caktoProductId = interceptedProductId;
        log.info('wizard done: constructed pay URL from product ID: ' + productUrl);
      } else {
        // ── Fallback: scan current products list page ─────────────────────────
        log.info('productCreatedViaWizard=true — escaneando lista de produtos...');

      const findAndPublishProduct = async () => {
        // 1. Wait 4s for React to re-render the list after modal close
        await sleep(4000);
        await screenshot(page, 'cakto_list_after_modal');

        // 2. Use the SEARCH BOX to find the product (works regardless of status filter)
        // The search box (placeholder "Pesquisar") searches all products including drafts
        const shortTitle = ebook.title.slice(0, 20).toLowerCase();
        const searchTitle = ebook.title.slice(0, 30); // use first 30 chars for search
        const searchResult = await page.evaluate((searchTitle) => {
          // Find the search input
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"]'));
          const searchInput = inputs.find(i => {
            const ph = (i.placeholder || '').toLowerCase();
            return ph.includes('pesquis') || ph.includes('search') || ph.includes('busca');
          });
          if (!searchInput) return 'no_search_input';
          // Set the search value
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(searchInput, searchTitle);
          } else {
            searchInput.value = searchTitle;
          }
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));
          searchInput.focus();
          return 'searched:' + searchTitle;
        }, searchTitle).catch(() => null);
        log.info('Search: ' + searchResult);
        if (searchResult && searchResult.startsWith('searched:')) {
          await sleep(2500); // wait for search results to load
          await screenshot(page, 'cakto_search_results');
        }

        // Also try: look for ALL elements containing "Ativo" text — might be a custom div filter
        // This is a breadth-first scan of all visible elements with "Ativo" or "Status" text
        const statusDebug = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const elems = all.filter(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.width < 300 && r.height < 60 &&
                   e.children.length <= 2 && (t === 'Ativo' || t === 'Status' || t === 'Filtros');
          }).map(e => {
            const r = e.getBoundingClientRect();
            return { tag: e.tagName, text: (e.textContent||'').trim().slice(0,20), x: Math.round(r.left), y: Math.round(r.top) };
          });
          return elems.slice(0, 8);
        }).catch(() => []);
        log.info('Status/filter elements: ' + JSON.stringify(statusDebug));

        // 3. Search the current page for our product by title
        for (let attempt = 0; attempt < 2 && !productUrl; attempt++) {
          if (attempt > 0) await sleep(2000);

          const found = await page.evaluate((sTitle) => {
            // a. Any pay.cakto.com.br link matching our product
            const links = Array.from(document.querySelectorAll('a[href*="pay.cakto"], a[href*="cakto.com.br/"]'));
            if (links.length > 0) {
              const match = links.find(l => {
                const row = l.closest('tr, [class*="row"], [class*="product"], li') || l.parentElement;
                return row && row.textContent.toLowerCase().includes(sTitle);
              });
              if (match) return match.href;
            }
            // b. Pay URL pattern in page HTML
            const html = document.documentElement.innerHTML || '';
            const pm = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
            if (pm && pm.length > 0) {
              // Log all found (to pick right one)
              return pm[0]; // return first — might not be right product
            }
            // c. Product row by title — count ALL rows and check title
            const rows = Array.from(document.querySelectorAll('tr, [class*="row"], li'));
            const allTitles = rows.filter(r => r.textContent.length < 800).map(r => r.textContent.toLowerCase().slice(0,50));
            const row = rows.find(r => r.textContent.toLowerCase().includes(sTitle) && r.textContent.length < 800);
            return row ? '__row:' + allTitles.join('|') : '__notfound:' + allTitles.slice(0,5).join('|');
          }, shortTitle).catch(() => null);

          log.info('Product search ' + (attempt+1) + ': ' + (found || 'null').slice(0, 200));

          if (found && found.includes('pay.cakto')) {
            productUrl = found;
            const m = found.match(/\/([A-Za-z0-9]{5,})$/);
            if (m) caktoProductId = m[1];
            log.info('Pay URL from list: ' + productUrl);
            break;
          } else if (found && found.startsWith('__row:')) {
            // Product row found — click it to navigate to product detail page
            log.info('Produto encontrado — clicando na linha...');
            const beforeClickUrl = page.url();
            await page.evaluate((sTitle) => {
              const rows = Array.from(document.querySelectorAll('tr, [class*="row"], li'));
              const row = rows.find(r => r.textContent.toLowerCase().includes(sTitle) && r.textContent.length < 800);
              if (!row) return;
              // Click the row's link or the row itself
              const link = row.querySelector('a[href*="/products/"]') || row.querySelector('a') || row;
              link.click();
            }, shortTitle).catch(() => {});
            // Wait for navigation to product detail page
            await page.waitForFunction(
              (prev) => window.location.href !== prev,
              { timeout: 8000 }, beforeClickUrl
            ).catch(() => {});
            await sleep(2000);
            await screenshot(page, 'cakto_product_detail');
            const detailUrl = page.url();
            log.info('Detail URL after click: ' + detailUrl);
            // Extract product ID from detail URL (e.g. /dashboard/products/manage/ID/info)
            const idFromUrl = detailUrl.match(/\/products\/(?:manage\/)?([a-zA-Z0-9_-]{4,})(?:\/|$)/);
            if (idFromUrl) {
              log.info('Product ID from URL: ' + idFromUrl[1]);
            }
            // Search detail page for pay URL
            const payUrl = await page.evaluate(() => {
              const html = document.documentElement.innerHTML || '';
              const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
              if (m) return m[0];
              const links = Array.from(document.querySelectorAll('a[href*="pay.cakto"], a[href*="cakto.com.br/"]'));
              return links.length > 0 ? links[0].href : null;
            }).catch(() => null);
            if (payUrl) {
              productUrl = payUrl;
              const m = payUrl.match(/\/([A-Za-z0-9]{5,})$/);
              if (m) caktoProductId = m[1];
              log.info('Pay URL from detail: ' + payUrl);
            } else {
              // Try clicking "Publicar" / "Ativar" to activate the draft product
              log.info('Tentando ativar produto rascunho...');
              const activated = await clickByText(page, ['Publicar', 'Ativar', 'Publish', 'Activate', 'Salvar e publicar'], 6000);
              if (activated) {
                await sleep(4000);
                const payAfter = await page.evaluate(() => {
                  const html = document.documentElement.innerHTML || '';
                  const m = html.match(/https?:\/\/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/g);
                  return m ? m[0] : null;
                }).catch(() => null);
                if (payAfter) {
                  productUrl = payAfter;
                  const m = payAfter.match(/\/([A-Za-z0-9]{5,})$/);
                  if (m) caktoProductId = m[1];
                  log.info('Pay URL after publish: ' + payAfter);
                }
              }
              if (!productUrl) {
                caktoProductId = idFromUrl ? idFromUrl[1] : 'created';
                log.warn('Pay URL not found — product exists but URL unavailable');
              }
            }
            break;
          }
        }

        // 4. Fallback: query api.cakto.com.br/api/offers/ — offer.id IS the pay shortcode
        if (!productUrl) {
          const apiMatch = await getCaktoPayUrlFromApi(page, shortTitle).catch(() => null);
          if (apiMatch && apiMatch.payUrl) {
            productUrl = apiMatch.payUrl;
            caktoProductId = apiMatch.offerId;
            log.info('Pay URL from offers API: ' + productUrl);
          } else {
            log.info('findAndPublish: offers API returned no match');
          }
        }
      };

      await findAndPublishProduct();

      if (!caktoProductId) {
        // Product was created but we couldn't locate via list — still success
        caktoProductId = 'created';
        log.warn('productCreatedViaWizard mas checkout URL não encontrada — marcando como sucesso');
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
      } else if (!productCreatedViaWizard) {
        // For non-wizard path, use finalUrl as fallback
        productUrl = finalUrl;
      }
      // For productCreatedViaWizard with no pay URL found, leave productUrl null
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
    // productCreatedViaWizard = explicit success (card selected + Cadastrar clicked)
    let realSuccess = productCreatedViaWizard;
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

    log.info('Success: ' + realSuccess + ' wizardDone=' + productCreatedViaWizard + ' step2=' + step2reached + ' prodId=' + caktoProductId + ' url=' + productUrl);

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
