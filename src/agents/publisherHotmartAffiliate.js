'use strict';
/**
 * publisherHotmartAffiliate.js
 * Automates enabling the Hotmart affiliate program for all published products.
 * Sets commission to 50% (configurable) on each product.
 *
 * Usage:
 *   const { setupAllAffiliates } = require('./publisherHotmartAffiliate');
 *   await setupAllAffiliates({ commission: 50, autoApprove: true });
 */

const path = require('path');
const { createLogger } = require('../core/logger');
const log = createLogger('hotmart-affiliate');

// ── Reuse Hotmart session from publisherHotmart ─────────────────────────────
let _page = null;

async function getHotmartPage() {
  const { getBrowserSession } = require('./publisherHotmart');
  if (!_page || _page.isClosed()) {
    const result = await getBrowserSession();
    _page = result.page;
  }
  return _page;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Navigate to product affiliate settings ──────────────────────────────────
async function setupProductAffiliate(page, numericId, opts = {}) {
  const commission  = opts.commission  ?? 50;
  const autoApprove = opts.autoApprove ?? true;

  log.info(`Configuring affiliate for product ${numericId} — commission=${commission}%`);

  const affiliateUrl = `https://app.hotmart.com/products/manage/${numericId}/affiliate`;

  try {
    await page.goto(affiliateUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
  } catch (e) {
    log.warn(`Nav error for ${numericId}: ${e.message.slice(0, 60)}`);
    return { ok: false, error: e.message };
  }

  // Check if affiliate tab is accessible
  const pageContent = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
  log.info(`Affiliate page content: ${pageContent.slice(0, 120)}`);

  // Try to find and enable affiliate program toggle/button
  const result = await page.evaluate((commission, autoApprove) => {
    const actions = [];

    // --- 1) Look for "Ativar programa de afiliados" or similar toggle ---
    const toggleCandidates = Array.from(document.querySelectorAll(
      'hot-toggle, hot-switch, input[type=checkbox], button, hot-button'
    )).filter(el => {
      const txt = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
      return txt.includes('afili') || txt.includes('programa') || txt.includes('ativar');
    });

    let toggled = false;
    for (const el of toggleCandidates) {
      const txt = (el.textContent || '').trim();
      actions.push('found-toggle: ' + txt.slice(0, 40));
      if (!el.checked && el.type === 'checkbox') {
        el.click();
        toggled = true;
      } else if (el.tagName.toLowerCase() !== 'input') {
        // Already might be a button style toggle
        el.click();
        toggled = true;
      }
      if (toggled) break;
    }

    // --- 2) Find commission input ---
    const commInputs = Array.from(document.querySelectorAll('input[type=number], input[type=text]')).filter(el => {
      const name = (el.name || el.id || el.placeholder || '').toLowerCase();
      return name.includes('commission') || name.includes('comissao') || name.includes('comissão') || name.includes('percent');
    });

    let commSet = false;
    for (const inp of commInputs) {
      actions.push('found-comm-input: ' + inp.name + ' value=' + inp.value);
      inp.focus();
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.value = String(commission);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      commSet = true;
      break;
    }

    // --- 3) Auto-approve toggle ---
    if (autoApprove) {
      const autoToggle = Array.from(document.querySelectorAll('input[type=checkbox], hot-toggle')).find(el => {
        const txt = (el.textContent || el.getAttribute('aria-label') || el.name || '').toLowerCase();
        return txt.includes('auto') || txt.includes('automátic') || txt.includes('aprovar');
      });
      if (autoToggle && !autoToggle.checked) {
        autoToggle.click();
        actions.push('auto-approve toggled');
      }
    }

    // --- 4) Find Save button ---
    const saveBtn = Array.from(document.querySelectorAll('button, hot-button')).find(el => {
      const txt = (el.textContent || '').toLowerCase().trim();
      return txt.includes('salvar') || txt.includes('save') || txt.includes('confirmar');
    });
    if (saveBtn) {
      actions.push('save-btn: ' + saveBtn.textContent.trim().slice(0, 30));
      saveBtn.click();
    }

    return {
      toggled,
      commSet,
      actions,
      saveClicked: !!saveBtn,
      url: window.location.href,
    };
  }, commission, autoApprove);

  log.info(`Product ${numericId} affiliate actions: ${JSON.stringify(result)}`);
  await sleep(2000);

  // Take screenshot for debug
  try {
    const screenshotDir = '/app/data/affiliate_screenshots';
    const { mkdirSync } = require('fs');
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/${numericId}_affiliate.png`, fullPage: false });
  } catch (_) {}

  return { ok: true, ...result };
}

// ── Get all published Hotmart product IDs from DB ───────────────────────────
function getPublishedHotmartProducts() {
  const Database = require('better-sqlite3');
  const db = new Database('/app/data/metrics.db');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare(`
    SELECT id, title, hotmart_product_id
    FROM ebooks
    WHERE status = 'published'
      AND hotmart_product_id IS NOT NULL
      AND hotmart_product_id != ''
      AND hotmart_product_id REGEXP '^[0-9]+$'
    ORDER BY created_at DESC
  `).all();
  db.close();
  return rows;
}

// ── Main: setup affiliates for all published products ───────────────────────
async function setupAllAffiliates(opts = {}) {
  const commission  = opts.commission  ?? 50;
  const autoApprove = opts.autoApprove ?? true;
  const limit       = opts.limit       ?? 999;

  log.info(`Starting affiliate setup: commission=${commission}% autoApprove=${autoApprove}`);

  let products;
  try {
    products = getPublishedHotmartProducts().slice(0, limit);
  } catch (e) {
    log.error('Cannot load products from DB: ' + e.message);
    return { ok: false, error: e.message };
  }

  log.info(`Found ${products.length} products with Hotmart IDs`);

  let page;
  try {
    page = await getHotmartPage();
  } catch (e) {
    log.error('Cannot get Hotmart session: ' + e.message);
    return { ok: false, error: 'Session error: ' + e.message };
  }

  const results = [];
  let done = 0, failed = 0;

  for (const product of products) {
    const numericId = product.hotmart_product_id;
    if (!numericId || !/^\d+$/.test(String(numericId))) {
      log.warn(`Product ${product.id} has invalid hotmart_product_id: ${numericId}`);
      continue;
    }

    try {
      const r = await setupProductAffiliate(page, numericId, { commission, autoApprove });
      results.push({ id: numericId, title: product.title, ...r });
      if (r.ok) done++; else failed++;

      // Small pause between products to avoid rate limiting
      await sleep(3000);
    } catch (e) {
      log.error(`Error on product ${numericId}: ${e.message}`);
      results.push({ id: numericId, title: product.title, ok: false, error: e.message });
      failed++;
    }
  }

  log.info(`Affiliate setup complete: ${done} OK, ${failed} failed`);
  return { ok: true, total: products.length, done, failed, results };
}

// ── Single product affiliate setup ─────────────────────────────────────────
async function setupSingleAffiliate(hotmartProductId, opts = {}) {
  const page = await getHotmartPage();
  return setupProductAffiliate(page, hotmartProductId, opts);
}

module.exports = { setupAllAffiliates, setupSingleAffiliate };
