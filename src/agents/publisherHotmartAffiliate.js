'use strict';
/**
 * publisherHotmartAffiliate.js
 * Configures the Hotmart affiliate program for all published products
 * using Puppeteer UI automation.
 *
 * Flow per product:
 *   1. Navigate to /products/manage/{id}/affiliation-setup
 *   2. If "Configurar programa" visible → run 4-step wizard
 *      Step 1: Select "Afiliação de 1 clique" (1-click) → Continuar
 *      Step 2: Enter commission % → Continuar
 *      Step 3: Select email → Continuar
 *      Step 4: Enter description → Finalizar
 *   3. If already configured → skip
 */

const fs      = require('fs');
const https   = require('https');
const puppeteer = require('puppeteer');
const { createLogger } = require('../core/logger');
const log = createLogger('hotmart-affiliate');

const SESSION_FILE = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CAS TGT → Service Ticket ─────────────────────────────────────────────────
function getCASTicket(tgt, serviceUrl) {
  return new Promise((resolve, reject) => {
    const body = 'service=' + encodeURIComponent(serviceUrl);
    const opts = {
      hostname: 'sso.hotmart.com',
      path: '/v1/tickets/' + tgt,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.trim() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Refresh JWT via CAS TGT ───────────────────────────────────────────────────
async function refreshJWT(browser, session) {
  const hmSso = session.cookies.find(c => c.name === 'hmSsoExp');
  if (!hmSso) {
    log.warn('hmSsoExp cookie not found — using existing token');
    return session.localStorage && session.localStorage.token;
  }

  const tgt = hmSso.value.split('|').slice(1).join('|');
  const oauth2Service = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d&scope=openid+profile+email&redirect_uri=https%3A%2F%2Fapp.hotmart.com%2Flogout&response_type=code';

  const st = await getCASTicket(tgt, oauth2Service);
  log.info('CAS ST status: ' + st.status);

  const lp = await browser.newPage();
  for (const c of session.cookies) {
    try {
      const x = { ...c };
      delete x.sameSite; delete x.sameParty;
      if (x.expires === -1) delete x.expires;
      if (!x.url) x.url = x.domain && x.domain.startsWith('.') ? 'https://' + x.domain.slice(1) : 'https://' + (x.domain || 'hotmart.com');
      await lp.setCookie(x);
    } catch (_) {}
  }

  try {
    await lp.goto(oauth2Service + '&ticket=' + st.body, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    log.warn('OAuth callback error: ' + e.message.slice(0, 60));
  }
  await sleep(5000);

  const tok = await lp.evaluate(() => localStorage.getItem('token')).catch(() => null);
  await lp.close();

  if (tok) { log.info('JWT refreshed via CAS ✓'); return tok; }
  const fallback = session.localStorage && session.localStorage.token;
  log.warn('JWT via CAS failed, using existing token');
  return fallback || null;
}

// ── Setup new page with anti-detection ───────────────────────────────────────
async function setupPage(page, session, jwt) {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  await page.evaluateOnNewDocument(() => {
    const orig = String.prototype.replace;
    Object.defineProperty(Object.prototype, 'replace', {
      value: function(...a) { return orig.apply(String(this == null ? '' : this), a); },
      writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const ls = { ...(session.localStorage || {}) };
  if (jwt) ls.token = jwt;
  await page.evaluateOnNewDocument((ls) => {
    Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
  }, ls);

  for (const c of session.cookies) {
    try {
      const x = { ...c };
      delete x.sameSite; delete x.sameParty;
      if (x.expires === -1) delete x.expires;
      if (!x.url) x.url = x.domain && x.domain.startsWith('.') ? 'https://' + x.domain.slice(1) : 'https://' + (x.domain || 'hotmart.com');
      await page.setCookie(x);
    } catch (_) {}
  }
}

// ── Shadow DOM helpers (run inside page.evaluate) ─────────────────────────────
const SHADOW_HELPERS = `
  function deepFindButton(text) {
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        for (const el of ctx.querySelectorAll('button,[role="button"]')) {
          const t = (el.textContent || el.innerText || '').trim();
          if (t === text || t.startsWith(text)) return el;
        }
        for (const child of ctx.querySelectorAll('*')) {
          if (child.shadowRoot) { const f = walk(child); if (f) return f; }
        }
      } catch(e) {}
      return null;
    }
    return walk(document.documentElement);
  }

  function deepFindInput() {
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        for (const el of ctx.querySelectorAll('input[type="text"],input[type="number"],input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])')) {
          return el;
        }
        for (const child of ctx.querySelectorAll('*')) {
          if (child.shadowRoot) { const f = walk(child); if (f) return f; }
        }
      } catch(e) {}
      return null;
    }
    return walk(document.documentElement);
  }

  function deepFindRadio(index) {
    const radios = [];
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        ctx.querySelectorAll('input[type="radio"],[role="radio"]').forEach(el => radios.push(el));
        ctx.querySelectorAll('*').forEach(child => { if (child.shadowRoot) walk(child); });
      } catch(e) {}
    }
    walk(document.documentElement);
    return radios[index] || null;
  }

  function deepFindTextarea() {
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        for (const el of ctx.querySelectorAll('textarea')) { return el; }
        for (const child of ctx.querySelectorAll('*')) {
          if (child.shadowRoot) { const f = walk(child); if (f) return f; }
        }
      } catch(e) {}
      return null;
    }
    return walk(document.documentElement);
  }

  function pageHasText(text) {
    return (document.body && document.body.innerText || '').includes(text);
  }
`;

// ── Configure a single product's affiliate via UI wizard ─────────────────────
async function configureProductAffiliateUI(page, productId, opts = {}) {
  const commission  = opts.commission  ?? 50;   // 50 = 50%
  const description = opts.description ?? 'Programa de afiliados com comissão competitiva. Promova este produto e ganhe por cada venda confirmada.';
  // Commission input mask: each keystroke appends a digit, shifting decimals
  // To get "50.00", type "5000" (4 digits)
  const commDigits = String(Math.round(commission * 100)).padStart(4, '0'); // 50 → "5000"

  const setupUrl = `https://app.hotmart.com/products/manage/${productId}/affiliation-setup`;
  log.info(`[${productId}] Navigating to ${setupUrl}`);

  try {
    await page.goto(setupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log.warn(`[${productId}] goto error: ${e.message.slice(0, 60)}`);
  }
  await sleep(4000);

  // Check if we're on the right page (not redirected to login)
  const landedUrl = page.url();
  if (landedUrl.includes('sso.hotmart.com') || landedUrl.includes('/login')) {
    return { ok: false, reason: 'session_expired' };
  }

  // Check page state
  const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

  // If already configured (has commission info showing), skip
  if (pageText.includes('Editar programa') || pageText.includes('Programa ativo') || pageText.includes('editar')) {
    log.info(`[${productId}] Affiliate already configured, skipping`);
    return { ok: true, skipped: true, reason: 'already_configured' };
  }

  // Check if "Configurar programa" is present
  if (!pageText.includes('Configurar programa')) {
    // Maybe the page shows an error or the product can't have affiliates
    log.warn(`[${productId}] "Configurar programa" not found. Page preview: ${pageText.substring(0, 100)}`);
    return { ok: false, reason: 'configurar_not_found', preview: pageText.substring(0, 100) };
  }

  // ── STEP 0: Click "Configurar programa" ────────────────────────────────────
  log.info(`[${productId}] Step 0: Clicking "Configurar programa"`);
  await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Configurar programa')?.click();`));
  await sleep(2000);

  // ── STEP 1: Choose affiliation type ────────────────────────────────────────
  const step1Text = await page.evaluate(() => document.body?.innerText || '');
  if (!step1Text.includes('Como o seu Programa de Afiliados funcionará')) {
    log.warn(`[${productId}] Step 1 not reached. Text: ${step1Text.substring(0, 80)}`);
    return { ok: false, reason: 'step1_not_reached' };
  }

  log.info(`[${productId}] Step 1: Selecting 1-click affiliation`);
  // Select first radio (1-click / auto-approve)
  await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindRadio(0)?.click();`));
  await sleep(500);

  // Click Continuar
  await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
  await sleep(2000);

  // ── STEP 2: Set commission ──────────────────────────────────────────────────
  const step2Text = await page.evaluate(() => document.body?.innerText || '');
  if (!step2Text.includes('comissão dos afiliados')) {
    log.warn(`[${productId}] Step 2 not reached. Text: ${step2Text.substring(0, 80)}`);
    return { ok: false, reason: 'step2_not_reached' };
  }

  log.info(`[${productId}] Step 2: Setting commission ${commission}% (typing "${commDigits}")`);
  // Find input and clear it, then type digits
  await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    const inp = deepFindInput();
    if (inp) {
      inp.focus();
      // Clear by selecting all and deleting
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(inp, '');
      inp.dispatchEvent(new Event('input', {bubbles: true}));
    }
  `));
  await sleep(300);

  // Type each digit to engage the mask
  for (const digit of commDigits) {
    await page.keyboard.type(digit, { delay: 80 });
  }
  await sleep(500);

  // Verify value
  const commValue = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    const inp = deepFindInput();
    return inp ? inp.value : 'not_found';
  `));
  log.info(`[${productId}] Commission field value: "${commValue}"`);

  await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
  await sleep(2000);

  // ── STEP 3: Contact email ───────────────────────────────────────────────────
  const step3Text = await page.evaluate(() => document.body?.innerText || '');
  if (step3Text.includes('entrar em contato')) {
    log.info(`[${productId}] Step 3: Selecting Hotmart email`);
    // Select first radio (use hotmart account email)
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindRadio(0)?.click();`));
    await sleep(500);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
    await sleep(2000);
  }

  // ── STEP 4: Benefits description ───────────────────────────────────────────
  const step4Text = await page.evaluate(() => document.body?.innerText || '');
  if (step4Text.includes('benefícios') || step4Text.includes('Finalizar')) {
    log.info(`[${productId}] Step 4: Entering description`);

    const hasTextarea = await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      const ta = deepFindTextarea();
      if (ta) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(ta, '');
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        ta.focus();
        return true;
      }
      return false;
    `));

    if (hasTextarea) {
      await page.keyboard.type(description, { delay: 10 });
      await sleep(500);
    }

    log.info(`[${productId}] Step 4: Clicking Finalizar`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Finalizar')?.click();`));
    await sleep(3000);
  } else {
    // Maybe the wizard went straight to Finalizar
    log.info(`[${productId}] Trying Finalizar directly`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Finalizar')?.click();`));
    await sleep(3000);
  }

  // ── Verify result ───────────────────────────────────────────────────────────
  const finalText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const finalUrl  = page.url();

  // Success indicators
  const isSuccess =
    finalText.includes('Programa criado') ||
    finalText.includes('sucesso') ||
    finalText.includes('Editar programa') ||
    finalText.includes('Programa ativo') ||
    !finalText.includes('Finalizar'); // wizard gone

  log.info(`[${productId}] Final URL: ${finalUrl.slice(-50)}, success: ${isSuccess}`);
  if (!isSuccess) {
    log.warn(`[${productId}] Final page preview: ${finalText.substring(0, 150)}`);
  }

  return { ok: isSuccess, finalUrl, commValue, preview: finalText.substring(0, 100) };
}

// ── Launch authenticated Hotmart browser ─────────────────────────────────────
async function launchHotmartBrowser() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error('Session not found: ' + SESSION_FILE);
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900 },
  });

  let jwt = null;
  try {
    jwt = await refreshJWT(browser, session);
  } catch (e) {
    log.warn('JWT refresh failed: ' + e.message);
    jwt = session.localStorage && session.localStorage.token;
  }

  const page = await browser.newPage();
  await setupPage(page, session, jwt);

  // Warm up session
  log.info('Warming up Hotmart session...');
  await page.goto('https://app.hotmart.com/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
  try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (_) {}
  await sleep(4000);

  const landedUrl = page.url();
  log.info(`Warmed up at: ${landedUrl.slice(0, 80)}`);

  if (landedUrl.includes('sso.hotmart.com') || landedUrl.includes('/login')) {
    await browser.close();
    throw new Error('Session expired — re-run capture-hotmart-session.js');
  }

  const token = await page.evaluate(() => localStorage.getItem('token') || '').catch(() => '');
  log.info(`Token present: ${!!token}`);

  return { browser, page, jwt, token };
}

// ── DB ───────────────────────────────────────────────────────────────────────
function getPublishedHotmartProducts() {
  const Database = require('better-sqlite3');
  const db = new Database('/app/data/metrics.db');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare(`
    SELECT id, title, hotmart_product_id FROM ebooks
    WHERE status = 'published'
      AND hotmart_product_id IS NOT NULL AND hotmart_product_id != ''
    ORDER BY created_at DESC
  `).all();
  db.close();
  return rows.filter(r => /^\d+$/.test(String(r.hotmart_product_id || '')));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function setupAllAffiliates(opts = {}) {
  const commission  = opts.commission  ?? 50;
  const limit       = opts.limit       ?? 999;

  log.info(`Starting UI-based affiliate setup: commission=${commission}%`);

  let products;
  try {
    products = getPublishedHotmartProducts().slice(0, limit);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  log.info(`Found ${products.length} products with Hotmart IDs`);

  let browser, page;
  try {
    ({ browser, page } = await launchHotmartBrowser());
  } catch (e) {
    return { ok: false, error: 'Browser launch failed: ' + e.message };
  }

  const results = [];
  let done = 0, skipped = 0, failed = 0;

  try {
    for (const product of products) {
      const numericId = String(product.hotmart_product_id);
      try {
        const r = await configureProductAffiliateUI(page, numericId, { commission });
        results.push({ id: numericId, title: product.title, ...r });
        if (r.ok && r.skipped) skipped++;
        else if (r.ok) done++;
        else failed++;
        await sleep(2000);
      } catch (e) {
        log.error(`Error on ${numericId}: ${e.message}`);
        results.push({ id: numericId, title: product.title, ok: false, error: e.message });
        failed++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log.info(`Done: ${done} configured, ${skipped} skipped (already done), ${failed} failed`);
  return { ok: true, total: products.length, done, skipped, failed, results };
}

async function setupSingleAffiliate(hotmartProductId, opts = {}) {
  let browser, page;
  try {
    ({ browser, page } = await launchHotmartBrowser());
    const result = await configureProductAffiliateUI(page, String(hotmartProductId), opts);
    await browser.close().catch(() => {});
    return result;
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: e.message };
  }
}

module.exports = { setupAllAffiliates, setupSingleAffiliate };
