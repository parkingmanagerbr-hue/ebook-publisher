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
// Resolve DB path portável (Docker vs dev local).
// Só usa /app/data quando realmente em Linux/Docker — no Windows C:\app\data pode existir
// por acidente e desviaria o DB para fora do projeto.
const _inDocker = process.platform !== 'win32' && fs.existsSync('/app/data');
const _defaultDbDir = _inDocker ? '/app/data/db' : path.join(__dirname, '../../data/db');
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
      commission_value REAL,
      temperature  REAL,
      status       TEXT,
      landing_page_url TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, product_id)
    )
  `);
  // Migração leve para bancos antigos (colunas novas)
  for (const [col, ddl] of [
    ['commission_value', 'REAL'], ['temperature', 'REAL'], ['status', 'TEXT'],
  ]) {
    try { _db.exec(`ALTER TABLE affiliate_products ADD COLUMN ${col} ${ddl}`); } catch (_) {}
  }
  return _db;
}

function upsertProduct(row) {
  const db = getDb();
  db.prepare(`
    INSERT INTO affiliate_products
      (platform, product_id, product_name, product_url, affiliate_link, category, price,
       commission_pct, commission_value, temperature, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, product_id) DO UPDATE SET
      product_name     = excluded.product_name,
      product_url      = COALESCE(excluded.product_url, product_url),
      affiliate_link   = COALESCE(excluded.affiliate_link, affiliate_link),
      category         = excluded.category,
      price            = excluded.price,
      commission_pct   = excluded.commission_pct,
      commission_value = excluded.commission_value,
      temperature      = excluded.temperature,
      status           = COALESCE(excluded.status, status)
  `).run(
    row.platform, row.product_id, row.product_name, row.product_url,
    row.affiliate_link, row.category, row.price, row.commission_pct,
    row.commission_value, row.temperature, row.status
  );
}

// ── Puppeteer launch config ───────────────────────────────────────────────────
function resolveChrome() {
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  const cands = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return undefined; // deixa o puppeteer usar o chromium embutido
}

function launchBrowser() {
  const opts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1366, height: 900 },
  };
  const exe = resolveChrome();
  if (exe) opts.executablePath = exe;
  return puppeteer.launch(opts);
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
  const cookies = (session.cookies || []);
  if (!cookies.length) return;
  // Injeta via CDP Network.setCookies — preserva httpOnly/secure/domain (essencial p/ cookies do SSO).
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.setCookies', {
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : undefined,
        expires: c.expires && c.expires > 0 ? c.expires : undefined,
      })),
    });
    return;
  } catch (e) {
    log.warn('injectSession CDP falhou (' + e.message.slice(0, 60) + ') — fallback page.setCookie');
  }
  // Fallback: setCookie por cookie
  for (const c of cookies) {
    try {
      const x = { ...c };
      delete x.sameParty;
      if (!['Strict', 'Lax', 'None'].includes(x.sameSite)) delete x.sameSite;
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
const HOTMART_MAX_PRODUCTS  = parseInt(process.env.AFFILIATE_MAX_PRODUCTS || '20');
// Pedir afiliação é uma AÇÃO REAL na conta — só roda se explicitamente habilitado.
const AUTO_REQUEST = String(process.env.AFFILIATE_AUTO_REQUEST || 'false').toLowerCase() === 'true';

/**
 * Solicita afiliação numa página de detalhe do Mercado de Afiliação do Hotmart.
 * Botão verde "Solicitar afiliação" -> modal -> "Sim, quero me afiliar".
 * Retorna { requested: bool, affiliateLink: string|null, approval: bool }.
 */
async function hotmartRequestAffiliation(detailPage) {
  // 1. Abrir o modal: botão verde "Afilie-se agora!" (instantâneo) ou "Solicitar afiliação" (aprovação).
  const opened = await clickByText(detailPage, [
    'Afilie-se agora', 'Afiliar-se agora', 'Solicitar afiliação', 'Solicitar afiliacao', 'Quero ser afiliado',
  ], 5000);
  if (!opened) return { requested: false, affiliateLink: null, approval: false };

  // 2. Esperar o modal (dialog com checkbox de termos) aparecer.
  await detailPage.waitForFunction(
    () => !!document.querySelector('[role="dialog"], [class*="modal" i]') &&
          document.querySelector('input[type="checkbox"]'),
    { timeout: 6000 }
  ).catch(() => {});

  // 3. Marcar o checkbox de termos via setter nativo + eventos React.
  //    (NÃO clicar no label/input depois — o checkbox é width:0/custom e o clique extra DESMARCA.)
  await detailPage.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (!cb.checked) {
        try { setter.call(cb, true); } catch (_) { cb.checked = true; }
        ['input', 'change', 'click'].forEach(t => cb.dispatchEvent(new Event(t, { bubbles: true })));
      }
    });
  }).catch(() => {});

  // 4. Esperar o botão "Sim, quero me afiliar" habilitar e clicar.
  let confirmed = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const r = await detailPage.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const b = btns.find(x => /sim,?\s*quero me afiliar|quero me afiliar|confirmar afilia/i.test((x.textContent || '').trim()));
      if (!b) return { found: false };
      const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled');
      if (disabled) return { found: true, disabled: true };
      b.click();
      return { found: true, clicked: true };
    }).catch(() => ({ found: false }));
    if (r.clicked) { confirmed = true; break; }
    await sleep(600);
  }

  await sleep(4000);
  // 5. Capturar link de divulgação (go.hotmart.com) se a afiliação foi imediata.
  const affiliateLink = await detailPage.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const m = html.match(/https?:\/\/go\.hotmart\.com\/[A-Za-z0-9?=&._-]+/i)
      || html.match(/https?:\/\/(?:pay|app)\.hotmart\.com\/[A-Za-z0-9?=&._-]*ref=[A-Za-z0-9_-]+/i);
    if (m) return m[0];
    for (const inp of document.querySelectorAll('input, textarea')) {
      if (inp.value && /hotmart\.com/.test(inp.value) && /(ref=|go\.hotmart)/.test(inp.value)) return inp.value;
    }
    const a = document.querySelector('a[href*="go.hotmart.com"], a[href*="hotmart.com"][href*="ref="]');
    return a ? a.href : null;
  }).catch(() => null);
  // 6. Detectar "pendente de aprovação".
  const approval = await detailPage.evaluate(() =>
    /aprova[çc][aã]o pendente|aguardando aprova|solicita[çc][aã]o enviada|pendente de aprova|sob an[áa]lise/i.test(document.body.innerText)
  ).catch(() => false);
  return { requested: confirmed, affiliateLink, approval };
}

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

    // Aguarda os cards do Mercado de Afiliação carregarem (carregam via XHR)
    await page.waitForSelector('a[href*="/market/details"], .product-card', { timeout: 25000 }).catch(() => {});
    await sleep(2000);

    // Scroll para carregar mais produtos ("Mais quentes" + grade)
    for (let s = 0; s < 5; s++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await sleep(900);
    }

    // Extrai produtos dos cards reais (.product-card / .product-name / link /market/details)
    const products = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('.product-card, .card-container').forEach(card => {
        const a = card.querySelector('a[href*="/market/details"]') || card.closest('a[href*="/market/details"]');
        const href = a ? a.getAttribute('href') : '';
        const nameEl = card.querySelector('.product-name, h2, h3, [class*="title"]');
        const name = (nameEl && nameEl.textContent.trim()) || '';
        if (!name || name.length < 3) return;
        const txt = (card.textContent || '').replace(/\s+/g, ' ');
        const tempM = txt.match(/(\d+)\s*°/);
        const commM = txt.match(/Comiss[aã]o[^R]*R\$\s*([\d.,]+)/i);
        const ucodeM = href.match(/productUcode=([a-f0-9-]+)/i);
        const comm = commM ? parseFloat(commM[1].replace(/\./g, '').replace(',', '.')) : 0;
        items.push({
          name,
          url: href ? new URL(href, location.origin).href : '',
          product_id: ucodeM ? ucodeM[1] : name.slice(0, 24).replace(/\s/g, '_'),
          temperature: tempM ? parseInt(tempM[1]) : 0,
          commission_value: comm,
        });
      });
      // dedup por product_id
      const seen = new Set();
      return items.filter(i => { if (seen.has(i.product_id)) return false; seen.add(i.product_id); return true; });
    });

    // Ordena por temperatura (mais quentes primeiro) e limita
    products.sort((a, b) => b.temperature - a.temperature);
    const top = products.slice(0, HOTMART_MAX_PRODUCTS);
    log.info('[Hotmart] ' + products.length + ' produtos no Mercado de Afiliação — processando top ' + top.length);

    for (const prod of top) {
      try {
        let affiliateLink = null;
        let status = 'discovered';

        if (AUTO_REQUEST && prod.url) {
          const prodPage = await browser.newPage();
          await injectSession(prodPage, session);
          await prodPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          await prodPage.goto(prod.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await sleep(3500);
          const r = await hotmartRequestAffiliation(prodPage);
          affiliateLink = r.affiliateLink;
          status = affiliateLink ? 'affiliated' : (r.approval ? 'pending_approval' : (r.requested ? 'requested' : 'discovered'));
          await prodPage.close();
        }

        const row = {
          platform: 'hotmart',
          product_id: prod.product_id,
          product_name: prod.name,
          product_url: prod.url,
          affiliate_link: affiliateLink,
          category: 'Mercado de Afiliação',
          price: 0,
          commission_pct: 0,
          commission_value: prod.commission_value,
          temperature: prod.temperature,
          status,
        };
        upsertProduct(row);
        results.push(row);
        log.info('[Hotmart] ' + status + ': "' + prod.name.slice(0, 42) + '" R$' + prod.commission_value + ' temp=' + prod.temperature + (affiliateLink ? ' link=' + affiliateLink.slice(0, 45) : ''));
      } catch (pe) {
        log.warn('[Hotmart] produto error: ' + pe.message.slice(0, 90));
      }
      await sleep(800);
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

/**
 * Solicita afiliação a um produto da Vitrine Cakto.
 * Abre o card pelo nome -> modal -> "Solicitar Afiliação" -> confirma.
 * Retorna { requested, affiliateLink, approval }.
 */
async function caktoRequestAffiliation(page, productName) {
  // 1. Abrir o modal do produto: clique de mouse REAL no centro do card (React não reage a el.click()).
  const box = await page.evaluate((name) => {
    const cards = [...document.querySelectorAll('.MuiCard-root')];
    const card = cards.find(c => (c.textContent || '').includes(name) && /Você recebe/i.test(c.textContent || ''));
    if (!card) return null;
    card.scrollIntoView({ block: 'center' });
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 60 };   // topo do card (imagem/nome), evita botões de baixo
  }, productName.slice(0, 30)).catch(() => null);
  if (!box) return { requested: false, affiliateLink: null, approval: false };
  await page.mouse.click(box.x, box.y).catch(() => {});

  await page.waitForFunction(
    () => /Solicitar Afilia|Afiliar-se|Quero me afiliar/i.test(document.body.innerText) &&
          !!document.querySelector('[role="dialog"], [class*="Dialog"], [class*="Modal"]'),
    { timeout: 6000 }
  ).catch(() => {});
  await sleep(800);

  // 2. Clicar "Solicitar Afiliação" dentro do modal.
  const reqClicked = await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"], [class*="Dialog"], [class*="Modal"]') || document;
    const b = [...modal.querySelectorAll('button, a, [role="button"]')]
      .find(x => /solicitar afilia|afiliar-se|quero me afiliar|participar/i.test((x.textContent || '').trim()));
    if (b) { b.click(); return true; }
    return false;
  }).catch(() => false);
  if (!reqClicked) { await page.keyboard.press('Escape').catch(() => {}); return { requested: false, affiliateLink: null, approval: false }; }
  await sleep(1500);

  // 3. Aceitar termos (checkbox) se houver + confirmar.
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (!cb.checked) { try { setter.call(cb, true); } catch (_) { cb.checked = true; } ['input', 'change'].forEach(t => cb.dispatchEvent(new Event(t, { bubbles: true }))); }
    });
  }).catch(() => {});
  await sleep(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, [role="button"]')]
      .find(x => /confirmar|sim,?\s*quero|aceitar|solicitar$/i.test((x.textContent || '').trim()) &&
                 !(x.disabled || x.getAttribute('aria-disabled') === 'true'));
    if (b) b.click();
  }).catch(() => {});
  await sleep(3000);

  // 4. Capturar link de divulgação (pay/go.cakto) ou detectar pendência.
  const affiliateLink = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const m = html.match(/https?:\/\/(?:pay|go|app)\.cakto\.com\.br\/[A-Za-z0-9?=&._\/-]*(?:ref|aff)[A-Za-z0-9?=&._\/-]*/i);
    if (m) return m[0];
    for (const inp of document.querySelectorAll('input, textarea')) {
      if (inp.value && /cakto\.com\.br/.test(inp.value) && /(ref|aff)/.test(inp.value)) return inp.value;
    }
    return null;
  }).catch(() => null);
  const approval = await page.evaluate(() =>
    /solicita[çc][aã]o enviada|aguardando aprova|pendente|sob an[áa]lise|em an[áa]lise/i.test(document.body.innerText)
  ).catch(() => false);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
  return { requested: true, affiliateLink, approval };
}

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

    // Vitrine = marketplace de afiliação da Cakto (em /dashboard/showcase)
    const SHOWCASE_URL = 'https://app.cakto.com.br/dashboard/showcase';
    await page.goto(SHOWCASE_URL, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await sleep(4000);

    let curUrl = page.url();
    if (/\/login|\/auth|sso\./i.test(curUrl)) {
      // Sessão expirada — tenta login com credenciais do .env
      const email = process.env.CAKTO_EMAIL;
      const pass  = process.env.CAKTO_PASSWORD;
      if (email && pass) {
        log.info('[Cakto] Sessão expirada — tentando login...');
        try {
          const passEl = await page.$('input[type="password"]');
          if (passEl) {
            const emailEl = await page.$('input[type="email"], input[type="text"]');
            if (emailEl) { await emailEl.click({ clickCount: 3 }); await page.keyboard.type(email, { delay: 30 }); }
            await passEl.click({ clickCount: 3 });
            await page.keyboard.type(pass, { delay: 30 });
            await page.keyboard.press('Enter');
            await sleep(6000);
          }
        } catch (le) { log.warn('[Cakto] Login error: ' + le.message); }
      }
      await page.goto(SHOWCASE_URL, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await sleep(4000);
      curUrl = page.url();
    }

    if (/\/login|\/auth|sso\./i.test(curUrl)) {
      log.warn('[Cakto] Não foi possível autenticar — pulando');
      await browser.close().catch(() => {});
      return [];
    }
    log.info('[Cakto] Vitrine: ' + curUrl.slice(0, 80));

    // Aguarda os cards MUI carregarem e faz scroll
    await page.waitForSelector('.MuiCard-root', { timeout: 20000 }).catch(() => {});
    for (let s = 0; s < 5; s++) {
      await page.evaluate(() => window.scrollBy(0, 700));
      await sleep(700);
    }

    // Extrai produtos da Vitrine.
    // Texto do card: "🔮 IA Academy150°Você recebe atéR$ 145,77Order bumpPágina do afiliado"
    const products = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('.MuiCard-root').forEach(card => {
        const txt = (card.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/Você recebe/i.test(txt)) return;
        if (/categorias|todas as categorias/i.test(txt)) return;   // bloco de filtro, não é produto
        const nameM = txt.match(/^(.*?)(\d{1,3})\s*°/);     // nome até a temperatura (1-3 dígitos)
        let name = nameM ? nameM[1].trim().replace(/\d+$/, '').trim() : '';
        if (!name || name.length < 2 || name.length > 120) return;
        const temp = nameM ? parseInt(nameM[2]) : 0;
        const commM = txt.match(/recebe at[ée][^R]*R\$\s*([\d.,]+)/i);
        const comm = commM ? parseFloat(commM[1].replace(/\./g, '').replace(',', '.')) : 0;
        const tags = ['Order bump', 'Upsell', 'Recorrente', 'Página do afiliado', 'Dupl']
          .filter(t => txt.includes(t));
        const a = card.querySelector('a[href^="http"]');
        items.push({
          name,
          product_url: a ? a.getAttribute('href') : '',
          product_id: name.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_'),
          temperature: temp,
          commission_value: comm,
          tags: tags.join(','),
        });
      });
      const seen = new Set();
      return items.filter(i => { if (seen.has(i.product_id)) return false; seen.add(i.product_id); return true; });
    });

    products.sort((a, b) => b.temperature - a.temperature);
    const top = products.slice(0, parseInt(process.env.AFFILIATE_MAX_PRODUCTS || '20'));
    log.info('[Cakto] ' + products.length + ' produtos na Vitrine — salvando top ' + top.length);

    for (const prod of top) {
      try {
        let affiliateLink = null;
        let status = 'discovered';
        if (AUTO_REQUEST) {
          const r = await caktoRequestAffiliation(page, prod.name);
          affiliateLink = r.affiliateLink;
          status = affiliateLink ? 'affiliated' : (r.approval ? 'pending_approval' : (r.requested ? 'requested' : 'discovered'));
        }
        const row = {
          platform: 'cakto',
          product_id: prod.product_id,
          product_name: prod.name,
          product_url: prod.product_url || '',
          affiliate_link: affiliateLink,
          category: prod.tags || 'Vitrine',
          price: 0,
          commission_pct: 0,
          commission_value: prod.commission_value,
          temperature: prod.temperature,
          status,
        };
        upsertProduct(row);
        results.push(row);
        log.info('[Cakto] ' + status + ': "' + prod.name.slice(0, 42) + '" R$' + prod.commission_value + (affiliateLink ? ' link=' + affiliateLink.slice(0, 40) : ''));
      } catch (pe) {
        log.warn('[Cakto] produto error: ' + pe.message.slice(0, 90));
      }
      await sleep(AUTO_REQUEST ? 800 : 300);
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
// Busca por palavra-chave (bestseller zgbs muda layout e retorna 0). Link de afiliado
// é instantâneo via tag (?tag=...), sem aprovação — diferente de Hotmart/Cakto.
const AMAZON_KEYWORDS = (process.env.AMAZON_KEYWORDS ||
  'air fryer,fone bluetooth,smartwatch,aspirador robo,cafeteira,liquidificador,' +
  'panela eletrica,echo dot,webcam,caixa de som bluetooth,kindle,umidificador'
).split(',').map(s => s.trim()).filter(Boolean);
const _hiresImg = u => (u || '').replace(/\._[^.]+_\./, '.'); // remove modificador de tamanho

/**
 * Importa produtos já capturados em amazon_products.json (gerado por scrape_amazon_affiliate.js)
 * para a tabela affiliate_products. Idempotente (upsert por ASIN).
 */
function importAmazonJson() {
  const file = path.join(__dirname, '../../amazon_products.json');
  let imported = 0;
  try {
    if (!fs.existsSync(file)) return 0;
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of (Array.isArray(arr) ? arr : [])) {
      if (!p.asin || !p.affiliate_link) continue;
      upsertProduct({
        platform: 'amazon',
        product_id: p.asin,
        product_name: (p.name || '').slice(0, 100),
        product_url: 'https://www.amazon.com.br/dp/' + p.asin,
        affiliate_link: p.affiliate_link,
        category: p.category || 'importado',
        price: p.price_cents ? p.price_cents / 100 : 0,
        commission_pct: 4.0,
        commission_value: 0,
        temperature: 0,
        status: 'affiliated',
      });
      imported++;
    }
  } catch (e) { log.warn('[Amazon] importAmazonJson erro: ' + e.message.slice(0, 80)); }
  return imported;
}

async function runAmazonAffiliate() {
  log.info('[Amazon] Iniciando busca de afiliados...');
  // Primeiro importa o que já foi capturado anteriormente (não perde nada).
  const imp = importAmazonJson();
  if (imp) log.info('[Amazon] Importados ' + imp + ' produtos de amazon_products.json');
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

    // Tag de afiliado: usa AMAZON_AFFILIATE_TAG do .env; tenta SiteStripe como fallback.
    let resolvedTag = process.env.AMAZON_AFFILIATE_TAG || '';
    if (!resolvedTag) {
      await page.goto('https://www.amazon.com.br', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3000);
      resolvedTag = await page.evaluate(() => {
        const stripe = document.querySelector('#swissKnifeStripeContainer, #navbar-sitestripe, [id*="sitestripe"]');
        if (stripe) {
          const tagMatch = (stripe.textContent || '').match(/(?:tag|store)=([A-Za-z0-9_-]+)/i);
          if (tagMatch) return tagMatch[1];
        }
        const m = document.documentElement.innerHTML.match(/(?:"tag"|'tag'|tag=)\s*[:"']?\s*([A-Za-z0-9_-]+-[0-9]+)/i);
        return m ? m[1] : '';
      }).catch(() => '');
    }
    log.info('[Amazon] Affiliate tag: ' + (resolvedTag || 'NÃO definida (configure AMAZON_AFFILIATE_TAG)'));
    if (!resolvedTag) { log.warn('[Amazon] Sem tag — pulando (links de afiliado precisam da tag)'); await browser.close().catch(() => {}); return []; }

    const seen = new Set();
    for (const kw of AMAZON_KEYWORDS) {
      try {
        await page.goto('https://www.amazon.com.br/s?k=' + encodeURIComponent(kw), { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
        await sleep(2500 + Math.floor(Math.random() * 1500));

        const products = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('div[data-asin]').forEach(d => {
            const asin = d.getAttribute('data-asin');
            if (!asin || asin.length !== 10) return;
            const t = d.querySelector('h2 span, .a-size-medium, .a-size-base-plus');
            const img = d.querySelector('img.s-image');
            const price = d.querySelector('.a-price .a-offscreen');
            if (t && img) out.push({ asin, name: t.textContent.trim(), img: img.src, price: price ? price.textContent.trim() : '' });
          });
          return out.slice(0, 6);
        });

        let kept = 0;
        for (const p of products) {
          if (seen.has(p.asin) || !p.price) continue;
          seen.add(p.asin);
          const price = parseFloat(p.price.replace(/[^0-9,]/g, '').replace(',', '.')) || 0;
          const row = {
            platform: 'amazon',
            product_id: p.asin,
            product_name: p.name.slice(0, 100),
            product_url: 'https://www.amazon.com.br/dp/' + p.asin,
            affiliate_link: 'https://www.amazon.com.br/dp/' + p.asin + '?tag=' + resolvedTag,
            category: kw,
            price,
            commission_pct: 4.0,           // Amazon Associates ~4%
            commission_value: 0,
            temperature: 0,
            status: 'affiliated',          // link instantâneo via tag
          };
          upsertProduct(row);
          results.push(row);
          kept++;
        }
        log.info('[Amazon] "' + kw + '": ' + kept + ' produtos com link');
      } catch (ce) {
        log.warn('[Amazon] keyword "' + kw + '" error: ' + ce.message.slice(0, 80));
      }
      await sleep(800);
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

module.exports = {
  runAffiliateAgent, getAffiliateLinks,
  runHotmartAffiliate, runCaktoAffiliate, runAmazonAffiliate, importAmazonJson,
};
