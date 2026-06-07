'use strict';
/**
 * affiliateAgent.js — Descobre e registra produtos de afiliados
 *
 * Plataformas: Hotmart, Cakto, Amazon Associados
 * Para cada plataforma:
 *   1. Navega ao marketplace de afiliados
 *   2. Lista os top produtos (até 20)
 *   3. Registra como afiliado (clica "Quero ser afiliado" / similar)
 *   4. Captura o link de afiliado gerado
 *   5. Salva no SQLite (tabela affiliate_products)
 */

const fs       = require('fs');
const path     = require('path');
const puppeteer = require('puppeteer');

let log;
try {
  const { createLogger } = require('../core/logger');
  log = createLogger('affiliateAgent');
} catch (_) {
  const winston = require('winston');
  log = winston.createLogger({
    transports: [new winston.transports.Console({ format: winston.format.simple() })]
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── DB setup ──────────────────────────────────────────────────────────────────
const { resolveSessionFile } = require('../core/sessionPath');
// Resolve DB path portável (Docker vs dev local)
const _defaultDbDir = fs.existsSync('/app/data') ? '/app/data/db' : path.join(__dirname, '../../data/db');
const DB_PATH = process.env.AFFILIATE_DB_PATH || path.join(_defaultDbDir, 'ebooks.db');

let _db;
function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  // Ensure directory exists
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) {}
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_products (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      platform     TEXT NOT NULL,
      product_id   TEXT,
      product_name TEXT NOT NULL,
      product_url  TEXT,
      affiliate_link TEXT,
      category     TEXT,
      price        REAL,
      commission_pct REAL,
      landing_page_url TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, product_id)
    )
  `);
  return _db;
}

function upsertProduct(row) {
  const db = getDb();
  db.prepare(`
    INSERT INTO affiliate_products
      (platform, product_id, product_name, product_url, affiliate_link, category, price, commission_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, product_id) DO UPDATE SET
      product_name   = excluded.product_name,
      product_url    = excluded.product_url,
      affiliate_link = COALESCE(excluded.affiliate_link, affiliate_link),
      category       = excluded.category,
      price          = excluded.price,
      commission_pct = excluded.commission_pct
  `).run(
    row.platform, row.product_id, row.product_name, row.product_url,
    row.affiliate_link, row.category, row.price, row.commission_pct
  );
}

// ── Puppeteer launch config ───────────────────────────────────────────────────
function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  });
}

// ── Session loader ────────────────────────────────────────────────────────────
function loadSession(sessionFile) {
  try {
    if (!fs.existsSync(sessionFile)) return null;
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!data.cookies || !Array.isArray(data.cookies)) return null;
    return data;
  } catch (e) {
    log.warn('loadSession error (' + sessionFile + '): ' + e.message);
    return null;
  }
}

async function injectSession(page, session) {
  if (!session) return;
  if (session.localStorage) {
    await page.evaluateOnNewDocument((ls) => {
      Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
    }, session.localStorage);
  }
  for (const c of (session.cookies || [])) {
    try {
      const x = { ...c };
      delete x.sameSite; delete x.sameParty;
      if (x.expires === -1) delete x.expires;
      if (!x.url) x.url = x.domain && x.domain.startsWith('.')
        ? 'https://' + x.domain.slice(1)
        : 'https://' + (x.domain || 'hotmart.com');
      await page.setCookie(x);
    } catch (_) {}
  }
}

// ── Generic: click element by text ───────────────────────────────────────────
async function clickByText(page, texts, timeoutMs = 10000) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pos = await page.evaluate((arr) => {
      function norm(s) { return (s || '').toLowerCase().trim(); }
      const all = Array.from(document.querySelectorAll('*'));
      for (const text of arr) {
        const tl = norm(text);
        for (const el of all) {
          const t = norm(el.textContent || '');
          if (!t || t.length > 120 || el.children.length > 5) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.height < 100 && (t === tl || t.includes(tl))) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t.slice(0, 40) };
          }
        }
      }
      return null;
    }, arr);
    if (pos) {
      log.info('Clicking "' + pos.text + '"');
      await page.mouse.click(pos.x, pos.y);
      return true;
    }
    await sleep(500);
  }
  return false;
}

// ── HOTMART affiliate discovery ───────────────────────────────────────────────
const HOTMART_SESSION_FILE = resolveSessionFile('hotmart', 'HOTMART_SESSION_FILE');
const HOTMART_CATEGORIES   = ['Negócios e Carreira', 'Saúde e Esportes', 'Desenvolvimento Pessoal'];

async function runHotmartAffiliate() {
  log.info('[Hotmart] Iniciando busca de afiliados...');
  const session = loadSession(HOTMART_SESSION_FILE);
  if (!session) {
    log.warn('[Hotmart] Sessão não encontrada: ' + HOTMART_SESSION_FILE);
    return [];
  }

  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      const orig = String.prototype.replace;
      Object.defineProperty(Object.prototype, 'replace', {
        value: function(...a) { return orig.apply(String(this == null ? '' : this), a); },
        writable: true, configurable: true, enumerable: false,
      });
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Inject session BEFORE first navigation
    await injectSession(page, session);

    // Navigate to marketplace
    await page.goto('https://app.hotmart.com/market', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log.warn('[Hotmart] nav: ' + e.message));
    await sleep(4000);

    const url = page.url();
    log.info('[Hotmart] URL: ' + url.slice(0, 80));

    // If redirected to login, attempt login
    if (url.includes('/login') || url.includes('/auth')) {
      const email = process.env.HOTMART_EMAIL;
      const pass  = process.env.HOTMART_PASSWORD;
      if (email && pass) {
        log.info('[Hotmart] Sessão expirada — tentando login...');
        try {
          await page.evaluate((e, p) => {
            const inputs = Array.from(document.querySelectorAll('input[type="email"],input[type="text"]'));
            if (inputs[0]) { inputs[0].value = e; inputs[0].dispatchEvent(new Event('input', {bubbles:true})); }
            const pw = document.querySelector('input[type="password"]');
            if (pw) { pw.value = p; pw.dispatchEvent(new Event('input', {bubbles:true})); }
          }, email, pass);
          await page.keyboard.press('Enter');
          await sleep(6000);
        } catch (le) { log.warn('[Hotmart] Login error: ' + le.message); }
      } else {
        log.warn('[Hotmart] Credenciais não configuradas');
        await browser.close();
        return [];
      }
    }

    // Wait for marketplace to load
    await page.waitForFunction(
      () => document.querySelectorAll('[class*="product"], [class*="card"], article').length > 2,
      { timeout: 20000 }
    ).catch(() => {});
    await sleep(2000);

    for (const category of HOTMART_CATEGORIES) {
      log.info('[Hotmart] Categoria: ' + category);
      try {
        // Try to click the category filter
        await clickByText(page, [category], 5000);
        await sleep(2500);

        // Scroll to load more products
        for (let s = 0; s < 3; s++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await sleep(800);
        }

        // Extract products from page
        const products = await page.evaluate(() => {
          const items = [];
          // Try various selectors for product cards
          const cards = Array.from(document.querySelectorAll(
            '[class*="product-card"], [class*="ProductCard"], [class*="card-product"], ' +
            '[data-testid*="product"], article[class*="product"], [class*="marketplace-product"]'
          ));
          for (const card of cards.slice(0, 25)) {
            const nameEl = card.querySelector('h2, h3, [class*="title"], [class*="name"]');
            const priceEl = card.querySelector('[class*="price"], [class*="valor"]');
            const linkEl = card.querySelector('a[href*="/product"], a[href*="hotmart"]') || card.closest('a');
            const commEl = card.querySelector('[class*="commission"], [class*="comissao"]');
            const name = (nameEl && nameEl.textContent.trim()) || '';
            if (!name || name.length < 3) continue;
            const priceText = priceEl ? priceEl.textContent.trim() : '';
            const price = parseFloat(priceText.replace(/[^0-9,.]/g, '').replace(',', '.')) || 0;
            const commText = commEl ? commEl.textContent.trim() : '';
            const comm = parseFloat(commText.replace(/[^0-9]/g, '')) || 0;
            const url = linkEl ? linkEl.href : '';
            items.push({ name, price, commission: comm, url });
          }
          return items.slice(0, 20);
        });

        log.info('[Hotmart] ' + category + ': ' + products.length + ' produtos encontrados');

        for (const prod of products) {
          if (!prod.url) continue;
          try {
            // Navigate to product detail page
            const prodPage = await browser.newPage();
            await injectSession(prodPage, session);
            await prodPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await prodPage.goto(prod.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await sleep(2500);

            // Look for "Quero ser afiliado" / affiliate request button
            const affiliateClicked = await clickByText(prodPage, [
              'Quero ser afiliado', 'Pedir afiliação', 'Ser afiliado', 'Pedir afiliacao',
              'Solicitar afiliação', 'Quero me afiliar',
            ], 5000);

            await sleep(3000);

            // Capture affiliate link from page
            const affiliateLink = await prodPage.evaluate(() => {
              // Look for ref= link in page content
              const allText = document.documentElement.innerHTML;
              const refMatch = allText.match(/https?:\/\/(?:app\.)?hotmart\.com\/product\/(?:checkout|pay)\/[A-Z0-9]+\?ref=[A-Z0-9_-]+/i);
              if (refMatch) return refMatch[0];
              // Look in inputs/textareas
              const inputs = Array.from(document.querySelectorAll('input, textarea'));
              for (const inp of inputs) {
                if (inp.value && inp.value.includes('hotmart.com') && inp.value.includes('ref=')) return inp.value;
              }
              // Look for confirmation that affiliate link was generated
              const links = Array.from(document.querySelectorAll('a[href*="hotmart.com"][href*="ref="]'));
              if (links.length > 0) return links[0].href;
              return null;
            });

            const productId = (prod.url.match(/\/product\/([A-Z0-9]+)/i) || [])[1] || prod.name.slice(0, 20).replace(/\s/g, '_');

            const row = {
              platform: 'hotmart',
              product_id: productId,
              product_name: prod.name,
              product_url: prod.url,
              affiliate_link: affiliateLink,
              category,
              price: prod.price,
              commission_pct: prod.commission,
            };
            upsertProduct(row);
            results.push(row);
            log.info('[Hotmart] Salvo: "' + prod.name.slice(0, 40) + '" link=' + (affiliateLink || 'pendente'));

            await prodPage.close();
          } catch (pe) {
            log.warn('[Hotmart] produto error: ' + pe.message.slice(0, 80));
          }
          await sleep(1000);
        }
      } catch (ce) {
        log.warn('[Hotmart] categoria "' + category + '" error: ' + ce.message.slice(0, 80));
      }
    }
  } catch (e) {
    log.error('[Hotmart] runHotmartAffiliate error: ' + e.message);
  } finally {
    await browser.close().catch(() => {});
  }
  log.info('[Hotmart] Concluído: ' + results.length + ' produtos');
  return results;
}

// ── CAKTO affiliate discovery ─────────────────────────────────────────────────
const CAKTO_SESSION_FILE = resolveSessionFile('cakto', 'CAKTO_SESSION_FILE');

async function runCaktoAffiliate() {
  log.info('[Cakto] Iniciando busca de afiliados...');
  const session = loadSession(CAKTO_SESSION_FILE);
  if (!session) {
    log.warn('[Cakto] Sessão não encontrada: ' + CAKTO_SESSION_FILE);
    return [];
  }

  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await injectSession(page, session);

    // Try marketplace URLs
    const marketUrls = [
      'https://app.cakto.com.br/affiliate/marketplace',
      'https://app.cakto.com.br/marketplace',
      'https://app.cakto.com.br/dashboard/marketplace',
    ];

    let marketLoaded = false;
    for (const url of marketUrls) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3000);
      const curUrl = page.url();
      if (!curUrl.includes('/login') && !curUrl.includes('/auth')) {
        marketLoaded = true;
        log.info('[Cakto] Marketplace URL: ' + curUrl.slice(0, 80));
        break;
      }
    }

    if (!marketLoaded) {
      // Try login
      const email = process.env.CAKTO_EMAIL;
      const pass  = process.env.CAKTO_PASSWORD;
      if (email && pass) {
        log.info('[Cakto] Tentando login...');
        await page.goto('https://app.cakto.com.br/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(2000);
        try {
          const passEl = await page.$('input[type="password"]');
          if (passEl) {
            const emailEl = await page.$('input[type="email"], input[type="text"]');
            if (emailEl) { await emailEl.click({ clickCount: 3 }); await page.keyboard.type(email, { delay: 30 }); }
            await passEl.click({ clickCount: 3 });
            await page.keyboard.type(pass, { delay: 30 });
            await page.keyboard.press('Enter');
            await sleep(5000);
          }
        } catch (le) { log.warn('[Cakto] Login error: ' + le.message); }
      }
      await page.goto('https://app.cakto.com.br/affiliate/marketplace', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3000);
    }

    // Scroll to load products
    for (let s = 0; s < 5; s++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(700);
    }

    // Extract products
    const products = await page.evaluate(() => {
      const items = [];
      const cards = Array.from(document.querySelectorAll(
        '[class*="product-card"], [class*="ProductCard"], [class*="affiliate-product"], ' +
        '[class*="marketplace-item"], article, [class*="card"]'
      ));
      for (const card of cards.slice(0, 30)) {
        const nameEl = card.querySelector('h2, h3, [class*="title"], [class*="name"], strong');
        const priceEl = card.querySelector('[class*="price"], [class*="valor"]');
        const linkEl = card.querySelector('a') || (card.tagName === 'A' ? card : null);
        const commEl = card.querySelector('[class*="commission"], [class*="comissao"], [class*="percent"]');
        const name = (nameEl && nameEl.textContent.trim()) || '';
        if (!name || name.length < 3 || name.length > 200) continue;
        const priceText = (priceEl && priceEl.textContent) || '';
        const price = parseFloat(priceText.replace(/[^0-9,.]/g, '').replace(',', '.')) || 0;
        const commText = (commEl && commEl.textContent) || '';
        const comm = parseFloat(commText.replace(/[^0-9]/g, '')) || 0;
        const url = linkEl ? linkEl.href : '';
        items.push({ name, price, commission: comm, url });
      }
      return items.slice(0, 20);
    });

    log.info('[Cakto] ' + products.length + ' produtos encontrados no marketplace');

    for (const prod of products) {
      try {
        let affiliateLink = null;
        let productId = '';

        if (prod.url && prod.url.includes('cakto')) {
          const prodPage = await browser.newPage();
          await injectSession(prodPage, session);
          await prodPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          await prodPage.goto(prod.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await sleep(2500);

          await clickByText(prodPage, [
            'Ser afiliado', 'Quero ser afiliado', 'Solicitar', 'Afiliar-se',
            'Participar', 'Quero participar',
          ], 5000);
          await sleep(3000);

          affiliateLink = await prodPage.evaluate(() => {
            const allText = document.documentElement.innerHTML;
            const m = allText.match(/https?:\/\/(?:pay|app)\.cakto\.com\.br\/[A-Za-z0-9]+\?[^"'\s]*(?:ref|aff|affiliate)[^"'\s]*/i)
              || allText.match(/https?:\/\/(?:pay|app)\.cakto\.com\.br\/[A-Za-z0-9_-]+/i);
            if (m) return m[0];
            const inputs = Array.from(document.querySelectorAll('input, textarea'));
            for (const inp of inputs) {
              if (inp.value && inp.value.includes('cakto.com.br')) return inp.value;
            }
            return null;
          });

          const urlM = prod.url.match(/\/([A-Za-z0-9_-]{4,})(?:\/|$)/);
          productId = urlM ? urlM[1] : prod.name.slice(0, 20).replace(/\s/g, '_');
          await prodPage.close();
        } else {
          productId = prod.name.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_');
        }

        const row = {
          platform: 'cakto',
          product_id: productId,
          product_name: prod.name,
          product_url: prod.url || '',
          affiliate_link: affiliateLink,
          category: 'Geral',
          price: prod.price,
          commission_pct: prod.commission,
        };
        upsertProduct(row);
        results.push(row);
        log.info('[Cakto] Salvo: "' + prod.name.slice(0, 40) + '" link=' + (affiliateLink || 'pendente'));
      } catch (pe) {
        log.warn('[Cakto] produto error: ' + pe.message.slice(0, 80));
      }
      await sleep(800);
    }
  } catch (e) {
    log.error('[Cakto] runCaktoAffiliate error: ' + e.message);
  } finally {
    await browser.close().catch(() => {});
  }
  log.info('[Cakto] Concluído: ' + results.length + ' produtos');
  return results;
}

// ── AMAZON Associates affiliate discovery ────────────────────────────────────
const AMAZON_SESSION_FILE = resolveSessionFile('amazon', 'AMAZON_SESSION_FILE');
const AMAZON_CATEGORIES = [
  { name: 'Livros', url: 'https://www.amazon.com.br/best-sellers-books-br/zgbs/livros' },
  { name: 'Eletronicos', url: 'https://www.amazon.com.br/gp/bestsellers/electronics' },
  { name: 'Casa', url: 'https://www.amazon.com.br/gp/bestsellers/casa' },
];

async function runAmazonAffiliate() {
  log.info('[Amazon] Iniciando busca de afiliados...');
  const session = loadSession(AMAZON_SESSION_FILE);
  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    if (session) {
      await injectSession(page, session);
    }

    // Check if already logged into Amazon Associates
    await page.goto('https://associados.amazon.com.br', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(4000);

    const assocUrl = page.url();
    log.info('[Amazon] Associates URL: ' + assocUrl.slice(0, 80));

    // Login if not authenticated
    if (assocUrl.includes('/ap/signin') || assocUrl.includes('/login') || !assocUrl.includes('amazon')) {
      const email = process.env.KDP_EMAIL;
      const pass  = process.env.KDP_PASSWORD;
      if (email && pass) {
        log.info('[Amazon] Login no Associates...');
        try {
          await page.goto('https://associados.amazon.com.br/sign-in', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await sleep(2000);
          const emailEl = await page.$('#ap_email, input[name="email"]');
          if (emailEl) {
            await emailEl.click({ clickCount: 3 });
            await page.keyboard.type(email, { delay: 40 });
            const contBtn = await page.$('#continue, [name="continue"]');
            if (contBtn) { await contBtn.click(); await sleep(2000); }
          }
          const passEl = await page.$('#ap_password, input[name="password"]');
          if (passEl) {
            await passEl.click({ clickCount: 3 });
            await page.keyboard.type(pass, { delay: 40 });
            await page.keyboard.press('Enter');
            await sleep(6000);
          }
        } catch (le) { log.warn('[Amazon] Login error: ' + le.message); }
      }
    }

    const affiliateTag = process.env.AMAZON_AFFILIATE_TAG || '';

    // Get affiliate tag from SiteStripe if not set
    let resolvedTag = affiliateTag;
    if (!resolvedTag) {
      await page.goto('https://www.amazon.com.br', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3000);
      resolvedTag = await page.evaluate(() => {
        // SiteStripe bar at top of page when logged into Associates
        const stripe = document.querySelector('#swissKnifeStripeContainer, #navbar-sitestripe, [id*="sitestripe"]');
        if (stripe) {
          const tagMatch = (stripe.textContent || '').match(/(?:tag|store)=([A-Za-z0-9_-]+)/i);
          if (tagMatch) return tagMatch[1];
        }
        // Check URL params or page content
        const allText = document.documentElement.innerHTML;
        const m = allText.match(/(?:"tag"|'tag'|tag=)\s*[:"']?\s*([A-Za-z0-9_-]+-[0-9]+)/i);
        return m ? m[1] : '';
      }).catch(() => '');
      log.info('[Amazon] Affiliate tag: ' + (resolvedTag || 'não encontrada'));
    }

    for (const cat of AMAZON_CATEGORIES) {
      log.info('[Amazon] Categoria: ' + cat.name);
      try {
        await page.goto(cat.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await sleep(3000);

        // Scroll to load more
        for (let s = 0; s < 3; s++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await sleep(600);
        }

        const products = await page.evaluate(() => {
          const items = [];
          // Best sellers list items
          const cards = Array.from(document.querySelectorAll(
            '[class*="zg-item"], [class*="p13n-sc-uncoverable"], #zg-ordered-list li, ' +
            '[class*="bestseller-item"], .a-list-item, .s-result-item'
          ));
          for (const card of cards.slice(0, 20)) {
            const nameEl = card.querySelector('[class*="p13n-sc-line-clamp"], [class*="a-link-normal"], [class*="s-title-instructions"], h2 a, .a-size-small.a-link-normal');
            const priceEl = card.querySelector('[class*="a-price"], [class*="p13n-sc-price"]');
            const linkEl = card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]') || card.querySelector('a');
            const name = (nameEl && nameEl.textContent.trim()) || (nameEl && nameEl.getAttribute('alt')) || '';
            if (!name || name.length < 3) continue;
            const priceText = (priceEl && priceEl.textContent.trim()) || '';
            const price = parseFloat(priceText.replace(/[^0-9,.]/g, '').replace(',', '.')) || 0;
            const url = linkEl ? (linkEl.href.split('?')[0]) : '';
            // Extract ASIN
            const asinM = url.match(/\/dp\/([A-Z0-9]{10})/) || url.match(/\/gp\/product\/([A-Z0-9]{10})/);
            const asin = asinM ? asinM[1] : '';
            if (!asin) continue;
            items.push({ name: name.slice(0, 100), price, url, asin });
          }
          return items.slice(0, 20);
        });

        log.info('[Amazon] ' + cat.name + ': ' + products.length + ' produtos');

        for (const prod of products) {
          try {
            // Build affiliate link with tag
            let affiliateLink = null;
            if (resolvedTag) {
              affiliateLink = prod.url + '?tag=' + resolvedTag;
            } else if (prod.asin) {
              // Try SiteStripe API to get link
              const stripeLinkUrl = 'https://www.amazon.com.br/gp/associates/sitestripe/createUrlForASIN'
                + '?asin=' + prod.asin + '&tag=' + (resolvedTag || 'yourstore-20');
              affiliateLink = prod.url + (resolvedTag ? '?tag=' + resolvedTag : '');
            }

            const row = {
              platform: 'amazon',
              product_id: prod.asin || prod.name.slice(0, 20).replace(/\s/g, '_'),
              product_name: prod.name,
              product_url: prod.url,
              affiliate_link: affiliateLink,
              category: cat.name,
              price: prod.price,
              commission_pct: 4.0, // Amazon Associates default ~4%
            };
            upsertProduct(row);
            results.push(row);
            log.info('[Amazon] Salvo: "' + prod.name.slice(0, 40) + '" asin=' + prod.asin);
          } catch (pe) {
            log.warn('[Amazon] produto error: ' + pe.message.slice(0, 80));
          }
          await sleep(500);
        }
      } catch (ce) {
        log.warn('[Amazon] categoria "' + cat.name + '" error: ' + ce.message.slice(0, 80));
      }
    }
  } catch (e) {
    log.error('[Amazon] runAmazonAffiliate error: ' + e.message);
  } finally {
    await browser.close().catch(() => {});
  }
  log.info('[Amazon] Concluído: ' + results.length + ' produtos');
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retorna os links de afiliado salvos para uma plataforma.
 * @param {string} platform - 'hotmart' | 'cakto' | 'amazon'
 * @returns {{ product_name: string, affiliate_link: string }[]}
 */
function getAffiliateLinks(platform) {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT product_name, affiliate_link FROM affiliate_products WHERE platform = ? AND affiliate_link IS NOT NULL'
    ).all(platform);
    return rows;
  } catch (e) {
    log.warn('getAffiliateLinks error: ' + e.message);
    return [];
  }
}

/**
 * Executa o agente de afiliados para todas as plataformas.
 * Respeita AFFILIATE_RUN_INTERVAL_HOURS para não rodar mais de 1x por dia.
 */
async function runAffiliateAgent() {
  const intervalHours = parseInt(process.env.AFFILIATE_RUN_INTERVAL_HOURS || '24');
  log.info('[AffiliateAgent] Iniciando (intervalo=' + intervalHours + 'h)...');

  // Check last run time via sentinel file
  const sentinelFile = path.join(path.dirname(DB_PATH), 'affiliate_last_run.txt');
  try {
    if (fs.existsSync(sentinelFile)) {
      const lastRun = parseInt(fs.readFileSync(sentinelFile, 'utf8').trim() || '0');
      const elapsed = (Date.now() - lastRun) / 3600000;
      if (elapsed < intervalHours) {
        log.info('[AffiliateAgent] Rodou há ' + elapsed.toFixed(1) + 'h — pulando (intervalo=' + intervalHours + 'h)');
        return;
      }
    }
  } catch (_) {}

  const allResults = [];

  // Run each platform independently (failures are isolated)
  try {
    const hotmartResults = await runHotmartAffiliate();
    allResults.push(...hotmartResults);
  } catch (e) { log.error('[AffiliateAgent] Hotmart falhou: ' + e.message); }

  try {
    const caktoResults = await runCaktoAffiliate();
    allResults.push(...caktoResults);
  } catch (e) { log.error('[AffiliateAgent] Cakto falhou: ' + e.message); }

  try {
    const amazonResults = await runAmazonAffiliate();
    allResults.push(...amazonResults);
  } catch (e) { log.error('[AffiliateAgent] Amazon falhou: ' + e.message); }

  // Write sentinel file
  try {
    fs.mkdirSync(path.dirname(sentinelFile), { recursive: true });
    fs.writeFileSync(sentinelFile, String(Date.now()));
  } catch (_) {}

  log.info('[AffiliateAgent] Concluído: ' + allResults.length + ' produtos de afiliado salvos');
  return allResults;
}

module.exports = { runAffiliateAgent, getAffiliateLinks };
