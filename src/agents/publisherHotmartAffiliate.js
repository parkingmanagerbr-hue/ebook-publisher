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
    // ERR_ABORTED is common with SPAs doing client-side routing — not fatal
    log.warn(`[${productId}] goto error: ${e.message.slice(0, 60)}`);
  }
  await sleep(5000); // Wait longer for SPA to render shadow DOM

  // Check if we're on the right page (not redirected to login)
  const landedUrl = page.url();
  if (landedUrl.includes('sso.hotmart.com') || landedUrl.includes('/login')) {
    return { ok: false, reason: 'session_expired' };
  }
  if (landedUrl.includes('not-found') || landedUrl.includes('/404')) {
    log.warn(`[${productId}] Redirected to not-found: ${landedUrl.slice(-50)}`);
    return { ok: false, reason: 'product_not_found', url: landedUrl };
  }

  // Use shadow DOM button detection (document.body.innerText misses shadow DOM content)
  const btnState = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return {
      hasConfigurar: !!deepFindButton('Configurar programa'),
      hasEditar: !!deepFindButton('Editar programa'),
      hasContinuar: !!deepFindButton('Continuar'),
      hasFinalizar: !!deepFindButton('Finalizar'),
      hasRadio: !!deepFindRadio(0),
      hasInput: !!deepFindInput(),
      url: location.href,
    };
  `)).catch(e => ({ error: e.message }));

  log.info(`[${productId}] Page state: ${JSON.stringify(btnState)}`);

  // If already configured
  if (btnState.hasEditar) {
    log.info(`[${productId}] Affiliate already configured (Editar found), skipping`);
    return { ok: true, skipped: true, reason: 'already_configured' };
  }

  // If "Configurar programa" not found and no wizard buttons either → can't configure
  if (!btnState.hasConfigurar && !btnState.hasContinuar && !btnState.hasFinalizar) {
    log.warn(`[${productId}] No wizard buttons found. URL: ${landedUrl.slice(-60)}`);
    return { ok: false, reason: 'no_wizard_buttons', url: landedUrl };
  }

  // ── STEP 0: Click "Configurar programa" (if present — otherwise wizard may already be open) ──
  if (btnState.hasConfigurar) {
    log.info(`[${productId}] Step 0: Clicking "Configurar programa"`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Configurar programa')?.click();`));
    await sleep(2500);
  }

  // ── STEP 1: Choose affiliation type (look for radio buttons) ─────────────────
  const step1State = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return { hasRadio: !!deepFindRadio(0), hasContinuar: !!deepFindButton('Continuar') };
  `)).catch(() => ({}));

  if (step1State.hasRadio) {
    log.info(`[${productId}] Step 1: Selecting 1-click affiliation`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindRadio(0)?.click();`));
    await sleep(500);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
    await sleep(2500);
  } else if (step1State.hasContinuar) {
    // Already past step 1
    log.info(`[${productId}] Step 1: Already past radio selection`);
  }

  // ── STEP 2: Set commission (look for text input) ─────────────────────────────
  const step2State = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return { hasInput: !!deepFindInput(), hasContinuar: !!deepFindButton('Continuar') };
  `)).catch(() => ({}));

  if (step2State.hasInput) {
    log.info(`[${productId}] Step 2: Setting commission ${commission}% (typing "${commDigits}")`);
    await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      const inp = deepFindInput();
      if (inp) {
        inp.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, '');
        inp.dispatchEvent(new Event('input', {bubbles: true}));
      }
    `));
    await sleep(300);

    for (const digit of commDigits) {
      await page.keyboard.type(digit, { delay: 80 });
    }
    await sleep(500);

    const commValue = await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      const inp = deepFindInput();
      return inp ? inp.value : 'not_found';
    `));
    log.info(`[${productId}] Commission field value: "${commValue}"`);

    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
    await sleep(2500);
  }

  // ── STEP 3: Contact email (check for radio + Continuar, no textarea yet) ────
  const step3State = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return {
      hasRadio: !!deepFindRadio(0),
      hasInput: !!deepFindInput(),
      hasTextarea: !!deepFindTextarea(),
      hasContinuar: !!deepFindButton('Continuar'),
    };
  `)).catch(() => ({}));

  if (step3State.hasRadio && !step3State.hasTextarea) {
    log.info(`[${productId}] Step 3: Selecting Hotmart email`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindRadio(0)?.click();`));
    await sleep(500);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
    await sleep(2500);
  }

  // ── STEP 4: Benefits description (check for textarea) ─────────────────────
  const step4State = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return { hasTextarea: !!deepFindTextarea(), hasFinalizar: !!deepFindButton('Finalizar') };
  `)).catch(() => ({}));

  if (step4State.hasTextarea || step4State.hasFinalizar) {
    log.info(`[${productId}] Step 4: Entering description`);

    if (step4State.hasTextarea) {
      await page.evaluate(new Function(`
        ${SHADOW_HELPERS};
        const ta = deepFindTextarea();
        if (ta) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(ta, '');
          ta.dispatchEvent(new Event('input', {bubbles: true}));
          ta.focus();
        }
      `));
      await page.keyboard.type(description, { delay: 10 });
      await sleep(500);
    }

    log.info(`[${productId}] Step 4: Clicking Finalizar`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Finalizar')?.click();`));
    await sleep(4000);
  } else {
    log.warn(`[${productId}] Step 4 not reached — no textarea or Finalizar button found`);
  }

  // ── Verify result ───────────────────────────────────────────────────────────
  const finalUrl = page.url();
  const finalState = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return {
      hasEditar: !!deepFindButton('Editar programa'),
      hasFinalizar: !!deepFindButton('Finalizar'),
      hasConfigurar: !!deepFindButton('Configurar programa'),
    };
  `)).catch(() => ({}));

  // Success: wizard gone (no Finalizar), or "Editar programa" appeared
  const isSuccess = finalState.hasEditar || (!finalState.hasFinalizar && !finalState.hasConfigurar);

  log.info(`[${productId}] Final: url=${finalUrl.slice(-50)} editar=${finalState.hasEditar} finalizar=${finalState.hasFinalizar} success=${isSuccess}`);

  return { ok: isSuccess, finalUrl };
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
