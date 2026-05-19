/**
 * publisherCakto.js — Publica e-book na Cakto via Puppeteer
 * Requires: data/sessions/cakto.json (run scripts/setup-sessions.js cakto)
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

const BASE_URL = 'https://app.cakto.com.br';
const SESSION_FILE = process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/app/data/landing_screenshots';

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (data.savedAt && Date.now() - data.savedAt > 7 * 24 * 60 * 60 * 1000) {
      log.warn('Sessão Cakto com mais de 7 dias — pode estar expirada');
    }
    return data;
  } catch(e) { log.warn('Erro ao carregar sessão Cakto: '+e.message); return null; }
}

async function setupPage(page, session) {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});});
  if (session.localStorage) {
    await page.evaluateOnNewDocument((ls)=>{Object.entries(ls).forEach(([k,v])=>{try{localStorage.setItem(k,v);}catch{}});}, session.localStorage);
  }
}

// Click button by exact or partial text match
async function clickByText(page, texts, timeout = 10000) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((arr) => {
      const btns = Array.from(document.querySelectorAll('button,[role="button"],a[class*="btn"],a[class*="button"]'));
      for (const t of arr) {
        const el = btns.find(b => (b.textContent||'').trim().toLowerCase().includes(t.toLowerCase()));
        if (el && el.getBoundingClientRect().width > 0) { el.click(); return el.textContent.trim().slice(0,40); }
      }
      return null;
    }, arr);
    if (clicked) { log.info('Clicked: "'+clicked+'"'); return true; }
    await sleep(500);
  }
  return false;
}

// Fill input by placeholder/name/label
async function fillInput(page, selectors, value) {
  const arr = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of arr) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({clickCount:3}); await el.type(String(value),{delay:20}); return true; }
    } catch {}
  }
  return false;
}

async function publishToCakto(ebook) {
  log.info('Cakto: publicando "'+ebook.title+'"');

  const session = loadSession();
  if (!session) {
    log.warn('Sessão Cakto não encontrada. Execute: node scripts/setup-sessions.js cakto');
    return { success: false, error: 'Sessão não configurada', platform: 'cakto' };
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  await setupPage(page, session);

  try {
    // Inject session
    log.info('Injetando sessão...');
    await page.goto(BASE_URL, {waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    await sleep(1000);

    for (const cookie of (session.cookies || [])) {
      try { await page.setCookie(cookie); } catch {}
    }

    // Navigate to products
    await page.goto(BASE_URL+'/dashboard/products', {waitUntil:'networkidle2',timeout:30000}).catch(()=>{});
    await sleep(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/auth') || currentUrl.includes('/signin')) {
      log.warn('Sessão Cakto expirada. Execute: node scripts/setup-sessions.js cakto');
      await browser.close();
      return { success: false, error: 'Sessão expirada', platform: 'cakto' };
    }

    log.info('Sessão válida. URL: '+currentUrl.slice(0,80));

    // Click "Criar produto" or navigate directly
    const createdDirectly = await page.goto(BASE_URL+'/dashboard/products/new', {waitUntil:'networkidle2',timeout:20000}).then(()=>true).catch(()=>false);
    if (!createdDirectly) {
      await clickByText(page, ['Criar produto', 'Novo produto', 'Adicionar produto', '+ Produto']);
    }
    await sleep(3000);

    // Fill product name
    const nameFilled = await fillInput(page, [
      'input[name="name"]', 'input[placeholder*="nome" i]', 'input[placeholder*="título" i]',
      'input[placeholder*="title" i]', 'input[id*="name" i]', 'input[id*="title" i]',
    ], ebook.title);
    log.info('Name filled: '+nameFilled);
    await sleep(400);

    // Select type: Ebook / Digital
    await page.evaluate(()=>{
      const all = Array.from(document.querySelectorAll('button,[role="button"],label,[class*="type"],[class*="tipo"],[class*="card"]'));
      const el = all.find(e=>{
        const t=(e.textContent||'').toLowerCase();
        return t.includes('e-book')||t.includes('ebook')||t.includes('digital');
      });
      if(el) el.click();
    });
    await sleep(500);

    // Fill description
    const desc = (ebook.description || ebook.subtitle || 'Guia completo sobre '+ebook.topic||ebook.title).slice(0,500);
    await fillInput(page, [
      'textarea[name="description"]', 'textarea[placeholder*="descri" i]',
      'textarea[name="desc"]', 'textarea[id*="desc" i]',
    ], desc);
    await sleep(400);

    // Fill price
    const price = String((ebook.price || 4.99).toFixed(2)).replace('.',',');
    await fillInput(page, [
      'input[name="price"]', 'input[placeholder*="preço" i]', 'input[placeholder*="valor" i]',
      'input[placeholder*="price" i]', 'input[id*="price" i]',
    ], price);
    await sleep(400);

    // Upload PDF
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      log.info('Upload PDF...');
      // Try clicking upload area first
      await page.evaluate(()=>{
        const el = Array.from(document.querySelectorAll('button,[role="button"],[class*="upload"],[class*="file"]')).find(e=>{
          const t=(e.textContent||'').toLowerCase();
          return t.includes('pdf')||t.includes('arquivo')||t.includes('file')||t.includes('upload')||t.includes('enviar');
        });
        if(el) el.click();
      });
      await sleep(1000);
      let fileInput = await page.$('input[type="file"][accept*="pdf"]').catch(()=>null);
      if(!fileInput) fileInput = await page.$('input[type="file"]:not([accept*="image"])').catch(()=>null);
      if(!fileInput) fileInput = await page.$('input[type="file"]').catch(()=>null);
      if(fileInput){ await fileInput.uploadFile(ebook.pdfPath); log.info('PDF upload triggered'); await sleep(8000); }
      else { log.warn('PDF file input not found'); }
    }

    // Upload cover image
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      log.info('Upload capa...');
      await page.evaluate(()=>{
        const el = Array.from(document.querySelectorAll('button,[role="button"],[class*="upload"],[class*="cover"],[class*="imagem"],[class*="thumbnail"]')).find(e=>{
          const t=(e.textContent||'').toLowerCase();
          return t.includes('imagem')||t.includes('capa')||t.includes('foto')||t.includes('cover')||t.includes('thumbnail');
        });
        if(el) el.click();
      });
      await sleep(1000);
      let coverInput = await page.$('input[type="file"][accept*="image"]').catch(()=>null);
      if(!coverInput){
        const all = await page.$$('input[type="file"]');
        if(all.length >= 2) coverInput = all[1];
      }
      if(coverInput){ await coverInput.uploadFile(ebook.coverPath); log.info('Cover upload triggered'); await sleep(5000); }
      else { log.warn('Cover file input not found'); }
    }

    // Save / Publish
    log.info('Publicando...');
    const published = await clickByText(page, ['Publicar','Salvar e publicar','Criar produto','Salvar','Save']);
    await sleep(5000);

    const finalUrl = page.url();
    log.info('Cakto done! URL: '+finalUrl);

    // Screenshot
    try {
      fs.mkdirSync(SCREENSHOTS_DIR, {recursive:true});
      const safeTitle = ebook.title.replace(/[^a-zA-Z0-9]/g,'_').slice(0,40);
      const ss = path.join(SCREENSHOTS_DIR, 'cakto_'+safeTitle+'.png');
      await page.screenshot({path:ss});
      log.info('Screenshot: '+ss);
    } catch(e) {}

    await browser.close();
    return { success: true, url: finalUrl, platform: 'cakto' };

  } catch(err) {
    log.error('Cakto error: '+err.message);
    try {
      fs.mkdirSync('/app/data/logs', {recursive:true});
      await page.screenshot({path:'/app/data/logs/cakto_error.png'}).catch(()=>{});
    } catch {}
    await browser.close().catch(()=>{});
    return { success: false, error: err.message, platform: 'cakto' };
  }
}

module.exports = { publishToCakto };
