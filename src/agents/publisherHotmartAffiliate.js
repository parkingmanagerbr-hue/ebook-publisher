'use strict';
/**
 * publisherHotmartAffiliate.js
 * Automates enabling the Hotmart affiliate program for all published products.
 * Sets commission to 50% (configurable) on each product.
 *
 * Usage (from API):
 *   const { setupAllAffiliates } = require('./publisherHotmartAffiliate');
 *   await setupAllAffiliates({ commission: 50, autoApprove: true });
 */

const path    = require('path');
const fs      = require('fs');
const puppeteer = require('puppeteer');
const { createLogger } = require('../core/logger');
const log = createLogger('hotmart-affiliate');

const SESSION_FILE = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Launch browser with Hotmart session ─────────────────────────────────────
async function launchHotmartBrowser() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error('Session not found: ' + SESSION_FILE);
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();

  // Set cookies
  await page.setCookie(...(session.cookies || []));

  // Set localStorage (JWT token etc.)
  const ls = { ...(session.localStorage || {}) };
  await page.evaluateOnNewDocument((lsData) => {
    Object.keys(lsData).forEach(k => localStorage.setItem(k, lsData[k]));
  }, ls);

  // Navigate to Hotmart to establish session
  await page.goto('https://app.hotmart.com/products/producer', {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(() => {});
  await sleep(4000);

  return { browser, page, session };
}

// ── Navigate to product affiliate tab and configure ─────────────────────────
async function configureProductAffiliate(page, numericId, opts = {}) {
  const commission  = opts.commission  ?? 50;
  const autoApprove = opts.autoApprove ?? true;

  log.info(`Configuring affiliate for product ${numericId} — ${commission}%`);

  // Go to the affiliate management page for this product
  const url = `https://app.hotmart.com/products/manage/${numericId}/affiliate`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);
  } catch (e) {
    log.warn(`Nav error for ${numericId}: ${e.message.slice(0, 60)}`);
    return { ok: false, error: 'nav_error' };
  }

  const currentUrl = page.url();
  log.info(`Affiliate URL for ${numericId}: ${currentUrl}`);

  // Check page content
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => '');
  log.info(`Affiliate page body: ${bodyText.slice(0, 200)}`);

  // Attempt to configure affiliate settings via UI
  const result = await page.evaluate(async (commission, autoApprove) => {
    const actions = [];
    const pageText = document.body.innerText.toLowerCase();

    // ── STEP 1: Detect if we're on an affiliate settings page ──
    const hasAffContent = pageText.includes('afili') || pageText.includes('comissão') || pageText.includes('commission');
    if (!hasAffContent) {
      return { ok: false, reason: 'not_affiliate_page', url: window.location.href, pageText: pageText.slice(0, 100) };
    }

    // ── STEP 2: Look for "Ativar" toggle or button ──
    const activateEl = Array.from(document.querySelectorAll('button, [role=switch], input[type=checkbox], hot-toggle, hot-switch'))
      .find(el => {
        const txt = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-label') || '').toLowerCase();
        return txt.includes('ativar') || txt.includes('ativ') || (txt.includes('habilitar'));
      });

    if (activateEl) {
      actions.push('activate: ' + (activateEl.textContent || '').trim().slice(0, 40));
      activateEl.click();
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── STEP 3: Set commission percentage ──
    const commissionInput = Array.from(document.querySelectorAll('input[type=number], input[type=text], hot-input input'))
      .find(el => {
        const ctx = (el.name + el.id + el.placeholder + (el.closest('*')?.textContent || '')).toLowerCase();
        return ctx.includes('comissão') || ctx.includes('comissao') || ctx.includes('commission') || ctx.includes('percentual') || ctx.includes('%');
      });

    if (commissionInput) {
      actions.push('commission input found: ' + commissionInput.name);
      commissionInput.focus();
      commissionInput.select?.();
      commissionInput.value = '';
      commissionInput.dispatchEvent(new Event('input',  { bubbles: true }));
      commissionInput.value = String(commission);
      commissionInput.dispatchEvent(new Event('input',  { bubbles: true }));
      commissionInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ── STEP 4: Auto-approve toggle ──
    if (autoApprove) {
      const autoEl = Array.from(document.querySelectorAll('input[type=checkbox], hot-toggle, [role=switch]'))
        .find(el => {
          const ctx = (el.name + el.id + (el.textContent || '') + (el.closest('[class]')?.textContent || '')).toLowerCase();
          return ctx.includes('automátic') || ctx.includes('auto aprov') || ctx.includes('auto-aprov');
        });
      if (autoEl) {
        actions.push('auto-approve toggled');
        if (!autoEl.checked) autoEl.click();
      }
    }

    // ── STEP 5: Save ──
    const saveBtn = Array.from(document.querySelectorAll('button, hot-button'))
      .find(el => {
        const txt = (el.textContent || '').trim().toLowerCase();
        return txt.includes('salvar') || txt.includes('save') || txt.includes('confirmar') || txt.includes('aplicar');
      });

    if (saveBtn) {
      actions.push('save: ' + saveBtn.textContent.trim().slice(0, 30));
      saveBtn.click();
      await new Promise(r => setTimeout(r, 1000));
    }

    return {
      ok: true,
      activated: !!activateEl,
      commissionSet: !!commissionInput,
      saved: !!saveBtn,
      actions,
      url: window.location.href,
    };
  }, commission, autoApprove);

  log.info(`Product ${numericId} affiliate result: ${JSON.stringify(result)}`);

  // Screenshot for debugging
  try {
    const dir = '/app/data/affiliate_screenshots';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${numericId}_affiliate.png`, fullPage: false });
  } catch (_) {}

  await sleep(2000);
  return result;
}

// ── Get all published Hotmart product IDs from DB ───────────────────────────
function getPublishedHotmartProducts() {
  const Database = require('better-sqlite3');
  const db = new Database('/app/data/metrics.db');
  db.pragma('journal_mode = WAL');
  // hotmart_product_id is numeric only
  const rows = db.prepare(`
    SELECT id, title, hotmart_product_id
    FROM ebooks
    WHERE status = 'published'
      AND hotmart_product_id IS NOT NULL
      AND hotmart_product_id != ''
    ORDER BY created_at DESC
  `).all();
  db.close();
  return rows.filter(r => /^\d+$/.test(String(r.hotmart_product_id || '')));
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

  let browser, page;
  try {
    ({ browser, page } = await launchHotmartBrowser());
  } catch (e) {
    log.error('Cannot launch Hotmart browser: ' + e.message);
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
        await sleep(2000); // Rate limit protection
      } catch (e) {
        log.error(`Error on product ${numericId}: ${e.message}`);
        results.push({ id: numericId, title: product.title, ok: false, error: e.message });
        failed++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log.info(`Affiliate setup done: ${done}/${products.length} OK, ${failed} failed`);
  return { ok: true, total: products.length, done, failed, results };
}

// ── Single product affiliate setup ─────────────────────────────────────────
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
