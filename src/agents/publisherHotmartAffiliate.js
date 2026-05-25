'use strict';
/**
 * publisherHotmartAffiliate.js
 * Configures the Hotmart affiliate program for all published products.
 *
 * Uses the same CAS TGT → JWT refresh + anti-detection approach as publisherHotmart.js.
 */

const fs    = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');
const { createLogger } = require('../core/logger');
const log = createLogger('hotmart-affiliate');

const SESSION_FILE = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CAS TGT → Service Ticket (copied from publisherHotmart.js) ───────────────
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

// ── Refresh JWT via CAS TGT (copied from publisherHotmart.js) ────────────────
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
  await sleep(6000);

  const tok = await lp.evaluate(() => localStorage.getItem('token')).catch(() => null);
  await lp.close();

  if (tok) {
    log.info('JWT refreshed via CAS ✓');
    return tok;
  }

  const existingTok = session.localStorage && session.localStorage.token;
  if (existingTok) {
    log.info('JWT: using existing session token (CAS expired)');
    return existingTok;
  }

  log.warn('JWT: MISSING — session may be fully expired');
  return null;
}

// ── Setup page with anti-detection (copied from publisherHotmart.js) ──────────
async function setupPage(page, session, jwt) {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  // CRITICAL: Hotmart SPA calls replace() on non-string values — polyfill needed
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

// ── Safe page.evaluate with context-destroyed retry ──────────────────────────
async function safeEval(page, fn, ...args) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (e) {
      if ((e.message || '').includes('context') && attempt < 4) {
        log.warn(`Eval context destroyed (attempt ${attempt}), waiting ${attempt * 4}s...`);
        await sleep(attempt * 4000);
      } else {
        throw e;
      }
    }
  }
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

  // Refresh JWT via CAS TGT
  let jwt = null;
  try {
    jwt = await refreshJWT(browser, session);
  } catch (e) {
    log.warn('JWT refresh failed: ' + e.message);
    jwt = session.localStorage && session.localStorage.token;
  }

  // Setup main page
  const page = await browser.newPage();
  await setupPage(page, session, jwt);

  log.info('Loading Hotmart products page...');
  await page.goto('https://app.hotmart.com/products/producer', {
    waitUntil: 'domcontentloaded', timeout: 35000
  }).catch(() => {});

  // Wait for any OAuth redirects to settle
  try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (_) {}
  try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (_) {}
  await sleep(5000);

  // Verify page is on hotmart.com (not SSO login)
  const landedUrl = page.url();
  log.info(`Landed at: ${landedUrl.slice(0, 80)}`);

  if (landedUrl.includes('sso.hotmart.com') || landedUrl.includes('/login')) {
    log.warn('Still on SSO login — session may be fully expired');
  }

  // Verify token is available
  const token = await safeEval(page, () =>
    localStorage.getItem('token') ||
    localStorage.getItem('access_token') ||
    localStorage.getItem('@hotmart:token') || ''
  ).catch(() => '');
  log.info(`Token present: ${!!token} (${token ? token.slice(0, 20) + '...' : 'NONE'})`);

  return { browser, page, jwt, token };
}

// ── Configure affiliate via Hotmart APIs ─────────────────────────────────────
async function configureProductAffiliate(page, numericId, opts = {}) {
  const commission  = opts.commission  ?? 50;
  const autoApprove = opts.autoApprove ?? true;

  log.info(`Configuring affiliate for product ${numericId} — ${commission}%`);

  const result = await safeEval(page, async (productId, commission, autoApprove) => {
    const token =
      localStorage.getItem('token') ||
      localStorage.getItem('access_token') ||
      localStorage.getItem('@hotmart:token') ||
      localStorage.getItem('hotmart_token') ||
      sessionStorage.getItem('token') || '';

    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
    };

    const body1 = JSON.stringify({ enabled: true, commissionPercentage: commission, commissionType: 'PERCENTAGE', autoApproval: autoApprove });
    const body2 = JSON.stringify({ active: true, commissionRate: commission, approvalType: autoApprove ? 'AUTO' : 'MANUAL' });
    const body3 = JSON.stringify({ affiliateEnabled: true, commissionPercentage: commission });
    const body4 = JSON.stringify({ enabled: true, commission: { percentage: commission, type: 'PERCENTAGE' }, autoApproval: autoApprove });

    const endpoints = [
      // Vulcano v2 - various path patterns
      ['PUT',   `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}/affiliateProgram`, body1],
      ['POST',  `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}/affiliateProgram`, body1],
      ['PATCH', `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}/affiliateProgram`, body1],
      ['PUT',   `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}/affiliate-program`, body1],
      ['POST',  `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}/affiliate-program`, body1],
      ['PUT',   `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}/affiliates/settings`, body1],
      ['POST',  `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}/affiliates/settings`, body1],
      // Vulcano v1
      ['PUT',   `https://api-product.vulcano.hotmart.com/product/v1/products/${productId}/affiliate`, body2],
      ['POST',  `https://api-product.vulcano.hotmart.com/product/v1/products/${productId}/affiliate`, body2],
      ['PUT',   `https://api-product.vulcano.hotmart.com/product/v1/products/${productId}/affiliateProgram`, body1],
      // Affiliate-specific service
      ['PUT',   `https://api-product.vulcano.hotmart.com/affiliate/v1/products/${productId}/program`, body4],
      ['POST',  `https://api-product.vulcano.hotmart.com/affiliate/v1/products/${productId}/program`, body4],
      ['PUT',   `https://api-product.vulcano.hotmart.com/affiliate/v2/products/${productId}/program`, body4],
      // App API
      ['PUT',   `https://app.hotmart.com/api/products/${productId}/affiliate`, body1],
      ['POST',  `https://app.hotmart.com/api/products/${productId}/affiliate`, body1],
      ['PUT',   `https://app.hotmart.com/api/v1/affiliate/products/${productId}`, body1],
      ['PUT',   `https://app.hotmart.com/api/v2/affiliate/products/${productId}`, body1],
      // Patch the product itself
      ['PATCH', `https://api-product.vulcano.hotmart.com/product/v2/products/${productId}`, body3],
    ];

    const results = [];
    for (const [method, url, body] of endpoints) {
      try {
        const r = await fetch(url, { method, headers: h, credentials: 'include', body });
        const text = await r.text().catch(() => '');
        results.push({ method, url: url.slice(45), status: r.status, body: text.slice(0, 120) });
        if (r.status >= 200 && r.status < 300) {
          return { ok: true, method, url, status: r.status, body: text.slice(0, 200), results };
        }
        // Interesting non-404: stop and report
        if (r.status !== 404 && r.status !== 405 && r.status !== 403) {
          return { ok: false, interesting: true, method, url, status: r.status, body: text.slice(0, 200), results };
        }
      } catch (e) {
        results.push({ method, url: url.slice(45), error: e.message.slice(0, 50) });
      }
    }
    return { ok: false, reason: 'all_404', results };
  }, numericId, commission, autoApprove).catch(e => ({ ok: false, error: e.message }));

  log.info(`Product ${numericId}: ok=${result.ok}${result.status ? ' status=' + result.status : ''}${result.interesting ? ' (INTERESTING)' : ''}`);
  if (result.interesting || result.error) {
    log.info(`  → ${JSON.stringify(result).slice(0, 300)}`);
  } else if (!result.ok) {
    // Show first few non-error results
    const sample = (result.results || [])
      .filter(r => r.status && r.status !== 404 && r.status !== 405)
      .slice(0, 3)
      .map(r => `${r.method} ${r.status} ${r.url} ${(r.body || '').slice(0, 50)}`);
    if (sample.length > 0) log.info(`  Interesting: ${sample.join(' | ')}`);
  }

  return result;
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
  const autoApprove = opts.autoApprove ?? true;
  const limit       = opts.limit       ?? 999;

  log.info(`Starting affiliate setup: commission=${commission}% autoApprove=${autoApprove}`);

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
  let done = 0, failed = 0;

  try {
    for (const product of products) {
      const numericId = String(product.hotmart_product_id);
      try {
        const r = await configureProductAffiliate(page, numericId, { commission, autoApprove });
        results.push({ id: numericId, title: product.title, ...r });
        if (r.ok) done++; else failed++;
        await sleep(1500);
      } catch (e) {
        log.error(`Error on ${numericId}: ${e.message}`);
        results.push({ id: numericId, title: product.title, ok: false, error: e.message });
        failed++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log.info(`Done: ${done}/${products.length} OK, ${failed} failed`);
  return { ok: true, total: products.length, done, failed, results };
}

async function setupSingleAffiliate(hotmartProductId, opts = {}) {
  let browser, page;
  try {
    ({ browser, page } = await launchHotmartBrowser());
    const result = await configureProductAffiliate(page, String(hotmartProductId), opts);
    await browser.close().catch(() => {});
    return result;
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: e.message };
  }
}

module.exports = { setupAllAffiliates, setupSingleAffiliate };
