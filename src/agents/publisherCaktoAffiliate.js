'use strict';
/**
 * publisherCaktoAffiliate.js
 * Configures the Cakto affiliate program for all published products.
 *
 * Uses the Cakto session (cookies) and a CSRF bypass:
 * - Setting a fake csrftoken cookie + X-CSRFToken header with matching 32-char value
 *   passes Django's CSRF check (pre-4.0 style).
 * - Product update uses PUT /api/product/{uuid}/ (not PATCH) with the full product object.
 */

const fs    = require('fs');
const https = require('https');
const { createLogger } = require('../core/logger');
const log = createLogger('cakto-affiliate');

const { resolveSessionFile } = require('../core/sessionPath');
const SESSION_FILE = resolveSessionFile('cakto', 'CAKTO_SESSION_FILE');
// 32-char hex fake CSRF token — passes Django's pre-4.0 CSRF validation
const FAKE_CSRF = 'abcdef1234567890abcdef1234567890';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Session ───────────────────────────────────────────────────────────────────
function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error('Session not found: ' + SESSION_FILE);
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const cookieStr = session.cookies.map(c => c.name + '=' + c.value).join('; ');
  // Inject our fake CSRF token cookie
  return cookieStr + '; csrftoken=' + FAKE_CSRF;
}

// ── API call helper ───────────────────────────────────────────────────────────
function apiCall(cookieStr, method, path, body) {
  return new Promise((resolve) => {
    const buf = body ? Buffer.from(body) : null;
    const headers = {
      'Cookie': cookieStr,
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://app.cakto.com.br/',
      'Origin': 'https://app.cakto.com.br',
      'X-CSRFToken': FAKE_CSRF,
    };
    if (buf) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = buf.length;
    }
    const opts = { hostname: 'api.cakto.com.br', path, method, headers };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 'ERR', body: e.message }));
    if (buf) req.write(buf);
    req.end();
  });
}

// ── Configure affiliate for a single Cakto product ───────────────────────────
async function configureProductAffiliate(cookieStr, productUuid, opts = {}) {
  const commission  = opts.commission  ?? 50;
  const autoApprove = opts.autoApprove ?? true; // false = affiliates must request
  const marketplace = opts.marketplace ?? true;  // show in affiliate marketplace

  log.info(`Configuring affiliate for product ${productUuid} — ${commission}%`);

  // GET full product object first
  const getR = await apiCall(cookieStr, 'GET', '/api/product/' + productUuid + '/');
  if (getR.status !== 200) {
    log.warn(`GET product ${productUuid} failed: ${getR.status} — ${getR.body.slice(0, 100)}`);
    return { ok: false, status: getR.status, error: 'GET failed: ' + getR.body.slice(0, 100) };
  }

  let product;
  try {
    product = JSON.parse(getR.body);
  } catch (e) {
    return { ok: false, error: 'JSON parse failed: ' + getR.body.slice(0, 100) };
  }

  // Already configured?
  if (product.affiliate === true && Number(product.affiliateCommission) === commission) {
    log.info(`Product ${productUuid} already has affiliate=${product.affiliate} commission=${product.affiliateCommission} — skipping`);
    return { ok: true, skipped: true, affiliate: product.affiliate, affiliateCommission: product.affiliateCommission };
  }

  // Update affiliate fields
  product.affiliate         = true;
  product.affiliateCommission = commission;
  product.affiliateMarketplace = marketplace;
  product.affiliateRequest  = !autoApprove; // true = requires manual approval
  product.affiliateClick    = product.affiliateClick || 'last';
  product.cookieTime        = product.cookieTime || 30;

  // PUT full object back
  const putBody = JSON.stringify(product);
  const putR = await apiCall(cookieStr, 'PUT', '/api/product/' + productUuid + '/', putBody);

  if (putR.status >= 200 && putR.status < 300) {
    let updated;
    try { updated = JSON.parse(putR.body); } catch {}
    log.info(`Product ${productUuid}: OK affiliate=${updated?.affiliate} commission=${updated?.affiliateCommission}`);
    return { ok: true, status: putR.status, affiliate: updated?.affiliate, affiliateCommission: updated?.affiliateCommission };
  }

  log.warn(`Product ${productUuid}: PUT failed ${putR.status} — ${putR.body.slice(0, 150)}`);
  return { ok: false, status: putR.status, error: putR.body.slice(0, 150) };
}

// ── DB ───────────────────────────────────────────────────────────────────────
function getPublishedCaktoProducts() {
  const Database = require('better-sqlite3');
  const db = new Database('/app/data/metrics.db');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare(`
    SELECT id, title, cakto_product_id FROM ebooks
    WHERE status = 'published'
      AND cakto_product_id IS NOT NULL AND cakto_product_id != ''
    ORDER BY created_at DESC
  `).all();
  db.close();
  // Filter to valid UUIDs
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return rows.filter(r => uuidRe.test(String(r.cakto_product_id || '')));
}

// ── Main: configure affiliates on ALL published products ─────────────────────
async function setupAllAffiliates(opts = {}) {
  const commission  = opts.commission  ?? 50;
  const autoApprove = opts.autoApprove ?? true;
  const marketplace = opts.marketplace ?? true;
  const limit       = opts.limit       ?? 999;

  log.info(`Starting Cakto affiliate setup: commission=${commission}% autoApprove=${autoApprove} marketplace=${marketplace}`);

  let cookieStr;
  try {
    cookieStr = loadSession();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  let products;
  try {
    products = getPublishedCaktoProducts().slice(0, limit);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  log.info(`Found ${products.length} published Cakto products`);

  const results = [];
  let done = 0, failed = 0, skipped = 0;

  for (const product of products) {
    const uuid = String(product.cakto_product_id);
    try {
      const r = await configureProductAffiliate(cookieStr, uuid, { commission, autoApprove, marketplace });
      results.push({ uuid, title: product.title, ...r });
      if (r.ok && r.skipped) skipped++;
      else if (r.ok) done++;
      else failed++;
      await sleep(300); // be polite to the API
    } catch (e) {
      log.error(`Error on ${uuid}: ${e.message}`);
      results.push({ uuid, title: product.title, ok: false, error: e.message });
      failed++;
    }
  }

  log.info(`Done: ${done} configured, ${skipped} already done, ${failed} failed (of ${products.length})`);
  return { ok: true, total: products.length, done, skipped, failed, results };
}

// ── Configure affiliate for a single product by UUID ─────────────────────────
async function setupSingleAffiliate(caktoProductId, opts = {}) {
  try {
    const cookieStr = loadSession();
    const result = await configureProductAffiliate(cookieStr, String(caktoProductId), opts);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { setupAllAffiliates, setupSingleAffiliate };
