/**
 * publisherAmazon.js — Publica e-book no Amazon KDP via Puppeteer
 * Requires: data/sessions/amazon.json (run scripts/setup-sessions.js amazon)
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let log;
try {
  const L = require('../core/Logger');
  log = L.createLogger ? L.createLogger('amazon') : { info: console.log, warn: console.warn, error: console.error };
} catch(e) {
  log = { info: (...a) => console.log('[amazon]', ...a), warn: (...a) => console.warn('[amazon]', ...a), error: (...a) => console.error('[amazon]', ...a) };
}

const BASE_URL      = 'https://kdp.amazon.com';
const BOOKSHELF_URL = 'https://kdp.amazon.com/pt_BR/bookshelf';
const NEW_TITLE_URL = 'https://kdp.amazon.com/pt_BR/title-setup/kindle/new';
const SESSION_FILE  = process.env.AMAZON_SESSION_FILE || '/app/data/sessions/amazon.json';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/app/data/landing_screenshots';
const AUTHOR_NAME   = process.env.AUTHOR_NAME || 'GENIA Publishing';

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch(e) { log.warn('Erro sessão Amazon: '+e.message); return null; }
}

async function fillField(page, selectors, value) {
  const arr = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of arr) {
    try {
      const el = await page.$(sel);
      if(el){ await el.click({clickCount:3}); await el.type(String(value),{delay:20}); return true; }
    } catch {}
  }
  return false;
}

async function clickByText(page, texts, timeout = 15000) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((arr) => {
      const els = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a'));
      for (const t of arr) {
        const el = els.find(e => {
          const txt = (e.textContent||e.value||'').trim().toLowerCase();
          return txt === t.toLowerCase() || txt.includes(t.toLowerCase());
        });
        if(el && el.getBoundingClientRect().width > 0){ el.click(); return el.textContent.trim().slice(0,40)||el.value; }
      }
      return null;
    }, arr);
    if(clicked){ log.info('Clicked: "'+clicked+'"'); return true; }
    await sleep(500);
  }
  log.warn('Button not found: '+arr.join(', '));
  return false;
}

async function waitForNav(page, maxMs = 30000) {
  const start = Date.now();
  const initialUrl = page.url();
  while (Date.now() - start < maxMs) {
    await sleep(1000);
    if (page.url() !== initialUrl) return true;
  }
  return false;
}

async function publishToAmazon(ebook) {
  log.info('Amazon KDP: publicando "'+ebook.title+'"');

  const session = loadSession();
  if (!session) {
    log.warn('Sessão Amazon não encontrada. Execute: node scripts/setup-sessions.js amazon');
    return { success: false, error: 'Sessão não configurada', platform: 'amazon' };
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--lang=pt-BR'],
    defaultViewport: { width: 1366, height: 900 },
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(()=>{ Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); });
  await page.setExtraHTTPHeaders({'Accept-Language':'pt-BR,pt;q=0.9'});

  try {
    // Inject session
    log.info('Injetando sessão Amazon...');
    await page.goto(BASE_URL, {waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    await sleep(1000);

    for (const cookie of (session.cookies || [])) {
      try {
        const c = {...cookie};
        if(!c.domain) c.domain = '.amazon.com.br';
        await page.setCookie(c);
      } catch {}
    }

    if (session.localStorage) {
      await page.evaluate((ls)=>{ Object.entries(ls).forEach(([k,v])=>{ try{localStorage.setItem(k,v);}catch{} }); }, session.localStorage);
    }

    // Verify login
    await page.goto(BOOKSHELF_URL, {waitUntil:'networkidle2',timeout:30000}).catch(()=>{});
    await sleep(3000);
    const url = page.url();
    if (url.includes('signin') || url.includes('ap/signin') || url.includes('/auth')) {
      log.warn('Sessão Amazon expirada. Execute: node scripts/setup-sessions.js amazon');
      await browser.close();
      return { success: false, error: 'Sessão expirada', platform: 'amazon' };
    }
    log.info('Sessão Amazon válida');

    // Create new Kindle title
    await page.goto(NEW_TITLE_URL, {waitUntil:'networkidle2',timeout:30000}).catch(()=>{});
    await sleep(3000);

    // ── STEP 1: Book details ──────────────────────────────────────────────────
    log.info('Etapa 1: Detalhes do livro');

    // Language
    try {
      const langSel = await page.$('select[id*="language" i],select[name*="language" i]');
      if(langSel){ await langSel.select('por'); await sleep(300); }
    } catch {}

    // Title
    await fillField(page, ['input[id*="title" i]:not([id*="sub" i])','input[name*="title" i]:not([name*="sub" i])','input[placeholder*="título" i]','input[placeholder*="title" i]'], ebook.title);
    await sleep(300);

    // Subtitle (optional)
    if (ebook.subtitle) {
      await fillField(page, ['input[id*="subtitle" i]','input[name*="subtitle" i]','input[placeholder*="subtítulo" i]'], ebook.subtitle);
      await sleep(300);
    }

    // Author
    await fillField(page, ['input[id*="author" i]','input[name*="author" i]','input[placeholder*="autor" i]','input[placeholder*="author" i]'], AUTHOR_NAME);
    await sleep(300);

    // Description
    const desc = (ebook.description || ('Guia completo sobre '+ebook.title)).slice(0,4000);
    await fillField(page, ['textarea[id*="description" i]','textarea[name*="description" i]','textarea[placeholder*="descrição" i]','textarea[placeholder*="description" i]'], desc);
    await sleep(400);

    // Keywords (optional)
    try {
      const kw = (ebook.keywords || ebook.topic || ebook.title).slice(0,50);
      await fillField(page, ['input[id*="keyword" i]','input[name*="keyword" i]'], kw);
    } catch {}

    // Next step
    await clickByText(page, ['Salvar e continuar','Save and continue','Próximo','Next','Continuar']);
    await sleep(4000);

    // ── STEP 2: Content upload ────────────────────────────────────────────────
    log.info('Etapa 2: Upload de conteúdo');

    // DRM — select "no DRM" or just skip
    try {
      const noDrm = await page.$('input[value="digital_rights_management_none"],input[id*="no_drm" i]');
      if(noDrm){ await noDrm.click(); await sleep(300); }
    } catch {}

    // Upload manuscript (PDF)
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      log.info('Upload manuscrito...');
      // Click upload button area if needed
      await page.evaluate(()=>{
        const el = Array.from(document.querySelectorAll('button,[role="button"]')).find(e=>{
          const t=(e.textContent||'').toLowerCase();
          return t.includes('manuscrito')||t.includes('manuscript')||t.includes('upload')||t.includes('enviar');
        });
        if(el) el.click();
      });
      await sleep(1000);
      const msInput = await page.$('input[type="file"][id*="manuscript" i],input[type="file"][id*="book_file" i],input[type="file"]:not([id*="cover" i])').catch(()=>null)
        || await page.$('input[type="file"]').catch(()=>null);
      if(msInput){
        await msInput.uploadFile(ebook.pdfPath);
        log.info('Aguardando processamento KDP (~30s)...');
        await sleep(30000);
      } else { log.warn('Manuscript file input not found'); }
    }

    // Upload cover
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      log.info('Upload capa KDP...');
      await page.evaluate(()=>{
        const el = Array.from(document.querySelectorAll('button,[role="button"]')).find(e=>{
          const t=(e.textContent||'').toLowerCase();
          return t.includes('capa')||t.includes('cover')||t.includes('imagem');
        });
        if(el) el.click();
      });
      await sleep(1000);
      const coverInput = await page.$('input[type="file"][id*="cover" i],input[type="file"][accept*="image"]').catch(()=>null);
      if(coverInput){
        await coverInput.uploadFile(ebook.coverPath);
        await sleep(8000);
      } else { log.warn('Cover file input not found'); }
    }

    // Preview (click if available)
    try {
      const previewBtn = await page.$('input[id*="launch-previewer" i],button[id*="preview" i]');
      if(previewBtn){
        // Skip preview for automation
        log.info('Skipping preview step');
      }
    } catch {}

    await clickByText(page, ['Salvar e continuar','Save and continue','Próximo','Next']);
    await sleep(5000);

    // ── STEP 3: Pricing ───────────────────────────────────────────────────────
    log.info('Etapa 3: Precificação');

    // Publishing rights: worldwide
    try {
      const worldBtn = await page.$('input[value="WORLD"],input[id*="worldwide" i]');
      if(worldBtn){ await worldBtn.click(); await sleep(300); }
    } catch {}

    // Royalty: 35% (works for any price)
    try {
      const r35 = await page.$('input[value="35"],input[id*="royalty_35" i]');
      if(r35){ await r35.click(); await sleep(300); }
    } catch {}

    // Price USD
    const priceUsd = (Math.max(0.99, (ebook.price || 4.99) * 0.18)).toFixed(2);
    const filled = await fillField(page, [
      'input[id*="us-price" i]','input[id*="us_price" i]','input[name*="us_price" i]',
      'input[id*="USD" i]','input[id*="usd" i]',
    ], priceUsd);
    log.info('USD price set: $'+priceUsd+' (filled='+filled+')');
    await sleep(500);

    // Publish
    log.info('Publicando no KDP...');
    const published = await clickByText(page, [
      'Publicar e-book Kindle','Publish Your Kindle eBook','Salvar e publicar','Publicar','Publish'
    ], 20000);
    await sleep(6000);

    const finalUrl = page.url();
    log.info('Amazon KDP done! URL: '+finalUrl);

    // Screenshot
    try {
      fs.mkdirSync(SCREENSHOTS_DIR, {recursive:true});
      const safeTitle = ebook.title.replace(/[^a-zA-Z0-9]/g,'_').slice(0,40);
      await page.screenshot({path:path.join(SCREENSHOTS_DIR, 'amazon_'+safeTitle+'.png')});
    } catch {}

    await browser.close();
    return { success: published, url: finalUrl, platform: 'amazon' };

  } catch(err) {
    log.error('Amazon error: '+err.message);
    try {
      fs.mkdirSync('/app/data/logs', {recursive:true});
      await page.screenshot({path:'/app/data/logs/amazon_error.png'}).catch(()=>{});
    } catch {}
    await browser.close().catch(()=>{});
    return { success: false, error: err.message, platform: 'amazon' };
  }
}

module.exports = { publishToAmazon };
