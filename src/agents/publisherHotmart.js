/**
 * publisherHotmart.js — GENIA E-book Publisher
 * Proven flow: wizard type-select -> /4/info fill -> /4/pricing -> upload cover -> upload PDF -> Finalizar
 *
 * KEY FIXES (verified via isolated Puppeteer tests on 2026-05-24):
 * 1. Promise.all([goto('/products/add'), waitForNavigation()]) -- handles SPA double-nav,
 *    keeps mainFrame non-detached (confirmed: detached=false, bodyLen=66KB+, eBook found at t=26s)
 * 2. eBook card is a DIV with exact text "eBook", appears ~26s after nav
 * 3. CDP setup AFTER eBook click (before causes "Target closed" crash on Puppeteer v23)
 * 4. React inputs: native setter via Object.getOwnPropertyDescriptor + dispatchEvent
 * 5. Object.prototype.replace polyfill required or Hotmart SPA crashes
 * 6. page.createCDPSession() not page.target().createCDPSession() (Puppeteer v23)
 */
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SESSION_FILE = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/app/data/landing_screenshots';
const DEFAULT_PRICE = process.env.HOTMART_PRICE || '4,99';

let log;
try {
  const L = require('../core/Logger');
  log = L.createLogger ? L.createLogger('hotmart') : { info: console.log, warn: console.warn, error: console.error };
} catch(e) {
  log = { info: (...a) => console.log('[hotmart]', ...a), warn: (...a) => console.warn('[hotmart]', ...a), error: (...a) => console.error('[hotmart]', ...a) };
}

const TECH_KW = ['web3','blockchain','programar','chatbot','cloud','saas','tecnologia','inteligencia artificial',' ia ','python','javascript','codigo','algoritmo','digital','nft','criptomoeda','linux','docker'];
const HEALTH_KW = ['saude','sono','depressao','panico','menopausa','hipertrofia','pressao','alcalina','alimentac','dieta','emagrecimento','fitness','exercicio','musculacao','mental','ansiedade','yoga','meditacao','hormonio','diabetes','colesterol'];
const FINANCE_KW = ['investimento','financ','dinheiro','consorcio','franquia','airbnb','freelancer','renda','patrimonio','aposentadoria','acoes','fundo','bitcoin','trading','bolsa','credito','emprestimo'];
const BUSINESS_KW = ['nomade','negocio','empreend','carreira','marketing','vendas','produtividade','lideranca','gestao','startup','cliente','lucro','estrategia','branding','copywriting','persona'];

function norm(s) { return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
function getCategoryPT(title, topic) {
  const t = norm(title + ' ' + (topic||''));
  if (TECH_KW.some(k => t.includes(k)))     return 'Tecnologia e Programacao';
  if (HEALTH_KW.some(k => t.includes(k)))   return 'Saude e Esportes';
  if (FINANCE_KW.some(k => t.includes(k)))  return 'Negocios e Carreira';
  if (BUSINESS_KW.some(k => t.includes(k))) return 'Negocios e Carreira';
  return 'Desenvolvimento Pessoal';
}

function getCASTicket(tgt, serviceUrl) {
  return new Promise((resolve, reject) => {
    const body = 'service=' + encodeURIComponent(serviceUrl);
    const opts = { hostname: 'sso.hotmart.com', path: '/v1/tickets/' + tgt, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/plain', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d.trim()})); });
    req.on('error',reject); req.write(body); req.end();
  });
}

async function refreshJWT(browser, session) {
  const hmSso = session.cookies.find(c => c.name === 'hmSsoExp');
  if (!hmSso) throw new Error('hmSsoExp cookie not found');
  const tgt = hmSso.value.split('|').slice(1).join('|');
  const oauth2Service = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d&scope=openid+profile+email&redirect_uri=https%3A%2F%2Fapp.hotmart.com%2Flogout&response_type=code';
  const st = await getCASTicket(tgt, oauth2Service);
  log.info('CAS ST: ' + st.status);
  const lp = await browser.newPage();
  for (const c of session.cookies) {
    try { const x={...c}; delete x.sameSite; delete x.sameParty; if(x.expires===-1)delete x.expires; if(!x.url)x.url=x.domain&&x.domain.startsWith('.')?'https://'+x.domain.slice(1):'https://'+(x.domain||'hotmart.com'); await lp.setCookie(x); } catch(e) {}
  }
  try { await lp.goto(oauth2Service+'&ticket='+st.body,{waitUntil:'networkidle2',timeout:30000}); } catch(e) {}
  await sleep(6000);
  const tok = await lp.evaluate(()=>localStorage.getItem('token')).catch(()=>null);
  await lp.close();
  if (tok) { log.info('JWT: OK (via CAS)'); return tok; }
  const existingTok = session.localStorage && session.localStorage.token;
  if (existingTok) { log.info('JWT: using existing session token (CAS expired)'); return existingTok; }
  log.warn('JWT: MISSING');
  return null;
}

async function setupPage(page, session, jwt) {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  // CRITICAL: Object.prototype.replace polyfill -- Hotmart SPA calls replace() on non-string values
  await page.evaluateOnNewDocument(() => {
    const orig = String.prototype.replace;
    Object.defineProperty(Object.prototype, 'replace', {
      value: function(...a) { return orig.apply(String(this == null ? '' : this), a); },
      writable: true, configurable: true, enumerable: false
    });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  const ls = {...(session.localStorage||{})}; if(jwt) ls.token=jwt;
  await page.evaluateOnNewDocument((ls)=>{Object.entries(ls).forEach(([k,v])=>{try{localStorage.setItem(k,v);}catch{}});}, ls);
  for (const c of session.cookies) {
    try { const x={...c}; delete x.sameSite; delete x.sameParty; if(x.expires===-1)delete x.expires; if(!x.url)x.url=x.domain&&x.domain.startsWith('.')?'https://'+x.domain.slice(1):'https://'+(x.domain||'hotmart.com'); await page.setCookie(x); } catch(e) {}
  }
}

// Fill a React controlled input using native property setter
// (keyboard.type doesn't update React state; native setter + dispatchEvent does)
async function fillReactInput(page, selector, value) {
  return page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value.length > 0;
  }, selector, value);
}

async function fillReactTextarea(page, selector, value) {
  return page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value);
}

async function handleSessionDialog(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[class*="modal"],[class*="dialog"],[role="dialog"]');
    if (!modal) return null;
    const btn = Array.from(modal.querySelectorAll('button')).find(b =>
      ['fechar','close','ok','continuar','entendi'].includes((b.textContent||'').trim().toLowerCase())
    );
    if (btn) { btn.click(); return btn.textContent.trim(); }
    return 'modal-found-no-btn';
  }).catch(() => null);
}

async function createProduct(page, session, ebook) {
  const { title, description, topic } = ebook;
  const category = getCategoryPT(title, topic);
  log.info('Creating: "' + title + '" => ' + category);

  let capturedNumericId = null, capturedUcode = null;
  let client = null;

  // Step 1: Navigate to /products/add using Promise.all to handle the SPA double-navigation.
  // Hotmart SPA fires TWO full navigations for /products/add. Sequential goto+waitForNavigation
  // leaves Puppeteer tracking the FIRST (detached) frame. Promise.all([goto, waitForNav])
  // waits for BOTH navigations, so page.mainFrame() references the final live frame.
  // Verified: mainFrame.isDetached()=false, bodyLen=66KB+, eBook card found at ~26s.
  try {
    await Promise.all([
      page.goto('https://app.hotmart.com/products/add', {waitUntil:'domcontentloaded', timeout:35000}),
      page.waitForNavigation({waitUntil:'domcontentloaded', timeout:35000})
    ]);
    log.info('products/add double-nav OK, frame detached=' + page.mainFrame().isDetached());
  } catch(e) {
    log.warn('products/add nav partial: ' + e.message.slice(0,60));
  }
  await sleep(1000);
  const preD = await handleSessionDialog(page);
  if (preD) { log.info('Pre-wizard dialog: ' + preD); await sleep(3000); }

  // Poll for eBook type card -- renders as DIV with exact text "eBook" at ~26s after nav
  let ebookBtn = null;
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    if (i % 10 === 9) {
      const bLen = await page.evaluate(()=>document.body?document.body.innerHTML.length:0).catch(()=>0);
      log.info('wizard poll t='+(i+1)+'s bodyLen='+bLen+' url='+page.url().slice(0,60));
    }
    ebookBtn = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('*')).find(e => {
        const t = (e.textContent||'').trim();
        return (t === 'eBook' || t === 'E-book') && e.children.length < 3;
      });
      if (b) {
        const r = b.getBoundingClientRect();
        return r.width > 0 ? {x:r.left+r.width/2, y:r.top+r.height/2, text:b.textContent.trim().slice(0,40), tag:b.tagName} : null;
      }
      return null;
    }).catch(()=>null);
    if (ebookBtn) { log.info('eBook card t='+(i+1)+'s tag='+ebookBtn.tag+' text="'+ebookBtn.text+'"'); break; }
  }
  if (!ebookBtn) throw new Error('eBook card not found after 50s -- wizard not rendered. URL: ' + page.url().slice(0,80));

  await page.mouse.click(ebookBtn.x, ebookBtn.y);
  log.info('eBook clicked');

  // Wait for /products/add/4/info URL (click triggers SPA route change)
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const u = page.url();
    if (u.includes('/4/info') || u.includes('/add/4')) { log.info('Info URL t='+(i+1)+'s: '+u.slice(0,60)); break; }
  }
  const urlAfterClick = page.url();
  log.info('URL after eBook click: ' + urlAfterClick.slice(0,80));
  if (urlAfterClick.includes('/auth/login') || urlAfterClick.includes('/login')) {
    throw new Error('Session expired after eBook click');
  }

  // Set up CDP network interceptor NOW (page is stable on /4/info).
  // Setting it up before /products/add causes "Protocol error: Target closed" on Puppeteer v23
  // due to async Network.getResponseBody racing with the double-navigation.
  try {
    client = await page.createCDPSession();
    await client.send('Network.enable');
    client.on('Network.responseReceived', async(evt) => {
      const u = evt.response.url;
      const isProductApi = u.includes('/product') || u.includes('/rest/v2') || u.includes('vulcano') || u.includes('/api/v') || u.includes('/wizard');
      if (isProductApi && [200,201].includes(evt.response.status)) {
        try {
          const rb = await client.send('Network.getResponseBody', {requestId: evt.requestId}).catch(()=>null);
          if (rb && rb.body && rb.body.length < 200000) {
            try {
              const d = JSON.parse(rb.body);
              // Try multiple response structures
              const id = d.id || d.productId || d.numericId || (d.data && (d.data.id||d.data.productId)) || (d.result && (d.result.id||d.result.productId)) || (d.product && (d.product.id||d.product.numericId));
              const uc = d.ucode || d.productUcode || (d.data && d.data.ucode) || (d.product && d.product.ucode);
              if (id) log.info('CDP api='+u.slice(0,70)+' id='+id);
              if (id && !capturedNumericId) { capturedNumericId = String(id); }
              if (uc && !capturedUcode) capturedUcode = uc;
            } catch(_) {}
          }
        } catch(e) {}
      }
    });
    log.info('CDP interceptor active on /4/info');
  } catch(e) { log.warn('CDP setup failed: ' + e.message.slice(0,50)); }

  // Step 2: Wait for name input on /products/add/4/info
  let nameInput = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (i % 5 === 4) { log.info('name-wait t='+(i+1)+'s url='+page.url().slice(0,60)); }
    nameInput = await page.$('input#name, input[name="name"], input[type="text"]').catch(()=>null);
    if (nameInput) { log.info('Name input t='+(i+1)+'s'); break; }
    // If SPA redirected back to type selector, re-click eBook
    const cu = page.url();
    if (!cu.includes('/4/') && cu.includes('/products/add')) {
      log.warn('Redirected to type selector -- re-clicking eBook');
      await page.evaluate(()=>{
        const b = Array.from(document.querySelectorAll('*')).find(e=>{
          const t=(e.textContent||'').trim();
          return (t==='eBook'||t==='E-book')&&e.children.length<3;
        });
        if(b){const r=b.getBoundingClientRect();if(r.width>0)b.click();}
      }).catch(()=>{});
      await sleep(3000);
    }
  }
  if (!nameInput) {
    nameInput = await page.waitForSelector('input#name, input[type="text"]', {timeout:15000, visible:true}).catch(()=>null);
  }
  if (!nameInput) throw new Error('Name input not found after 45s. URL: ' + page.url().slice(0,60));

  // Fill name using React-compatible native property setter
  const nameFilled = await fillReactInput(page, 'input#name, input[name="name"], input[type="text"]', title);
  log.info('Name filled: ' + nameFilled + ' "' + title.slice(0,30) + '"');
  await sleep(500);

  // Fill description
  const descFilled = await fillReactTextarea(page,
    'textarea#description, textarea[name="description"], textarea[placeholder*="descri"], textarea',
    (description || title).slice(0, 500)
  );
  log.info('Desc filled: ' + descFilled);
  await sleep(400);

  // Click category button
  const catClicked = await page.evaluate((cat) => {
    const all = Array.from(document.querySelectorAll('button, [class*="categor"], [class*="option"], li, [role="option"]'));
    const b = all.find(b => {
      const t = (b.textContent||'').trim();
      return t === cat || t.includes(cat.split(' ')[0]);
    });
    if (b) { b.click(); return b.textContent.trim().slice(0,40); }
    return false;
  }, category);
  log.info('Category clicked: ' + catClicked);
  await sleep(800);

  // Click first subcategory if visible
  await page.evaluate(()=>{
    const s = document.querySelectorAll('[class*="subcategor"] button, [class*="subcategor"] li');
    if(s.length>0) s[0].click();
  }).catch(()=>{});
  await sleep(500);

  // Click Continuar button
  const contClicked = await page.evaluate(()=>{
    const b = Array.from(document.querySelectorAll('button')).find(b => {
      const t = (b.textContent||'').trim().toLowerCase();
      return t === 'continuar' || t === 'next' || t === 'salvar e continuar' || t.includes('continu');
    });
    if (b) { b.click(); return b.textContent.trim(); }
    return false;
  });
  log.info('Continuar: ' + contClicked);
  await sleep(4000);

  // Wait for /4/pricing URL and capture product ID
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const u = page.url();
    const pm = u.match(/\/products\/manage\/(\d+)/);
    if (pm) capturedNumericId = capturedNumericId || pm[1];
    if (u.includes('/4/pricing') || u.includes('/pricing') || pm) {
      log.info('Pricing/manage URL t='+(i+1)+'s: '+u.slice(0,80));
      break;
    }
  }

  // Step 3: Fill pricing form
  log.info('Pricing URL: ' + page.url().slice(0,80));
  await sleep(3000);

  // STEP 3a: Dismiss cookie banner
  // Cookie banner uses <hotmart-cookie-policy> custom element with buttons in its SHADOW DOM
  // Regular document.querySelectorAll('button') cannot find them
  const cookieDismissed = await page.evaluate(() => {
    // Try shadow DOM of hotmart-cookie-policy
    const cookieEl = document.querySelector('hotmart-cookie-policy');
    if (cookieEl) {
      const roots = [cookieEl.shadowRoot, cookieEl];
      for (const root of roots) {
        if (!root) continue;
        const btns = Array.from(root.querySelectorAll('button'));
        // "Permitir todos" is the last/rightmost button (accept all)
        const allow = btns.find(b => {
          const t = (b.textContent||'').trim().toLowerCase();
          return t.includes('permitir todos') || t.includes('allow all') || t.includes('accept all') || t.includes('aceitar');
        });
        if (allow) { allow.click(); return 'shadow:'+allow.textContent.trim().slice(0,30); }
        if (btns.length > 0) {
          const last = btns[btns.length-1];
          if (last.getBoundingClientRect().width > 0) { last.click(); return 'shadow-last:'+last.textContent.trim().slice(0,30); }
        }
      }
    }
    // Fallback: scroll all buttons in document including inside all shadow roots
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        const btns = Array.from(el.shadowRoot.querySelectorAll('button'));
        const allow = btns.find(b => {
          const t = (b.textContent||'').trim().toLowerCase();
          return t.includes('permitir') || t.includes('allow') || t.includes('accept');
        });
        if (allow) { allow.click(); return 'any-shadow:'+allow.textContent.trim().slice(0,30); }
      }
    }
    return 'no-cookie-banner';
  }).catch(e=>'err:'+e.message.slice(0,30));
  log.info('Cookie banner: ' + cookieDismissed);
  await sleep(1500);

  // STEP 3b: Click the currency dropdown ("Selecione uma moeda") and select BRL
  // Take a screenshot and dump full HTML for debugging
  try {
    await page.screenshot({path: '/app/pricing_debug.png', fullPage: true});
    log.info('Screenshot saved: /app/pricing_debug.png');
    const fullHtml = await page.evaluate(()=>document.documentElement.outerHTML);
    require('fs').writeFileSync('/app/pricing_debug.html', fullHtml);
    log.info('HTML saved: /app/pricing_debug.html (' + fullHtml.length + ' bytes)');
  } catch(e) { log.warn('Screenshot/HTML dump failed: '+e.message); }

  // Dump visible interactive elements for debugging
  const pageDebug = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const vis = all.filter(e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>10&&['INPUT','SELECT','BUTTON','HOT-SELECT','HOT-INPUT','TEXTAREA'].includes(e.tagName); });
    const texts = all.filter(e => { const t=(e.textContent||'').trim(); const r=e.getBoundingClientRect(); return r.width>0&&r.height>5&&t.length>0&&t.length<80&&e.children.length<3; }).map(e=>(e.textContent||'').trim().slice(0,50)).filter((v,i,a)=>a.indexOf(v)===i).slice(0,40);
    return { interactive: vis.map(e=>({tag:e.tagName,name:e.name||e.getAttribute('name')||'',id:e.id||'',text:e.textContent.trim().slice(0,30)})), texts };
  }).catch(()=>null);
  log.info('Page debug: ' + JSON.stringify(pageDebug).slice(0,500));

  // Currency info removed — now handled directly via hot-select-option[value="BRL"]

  // STEP 3b: Open hot-select currency dropdown and select BRL
  // The hot-select web component renders options in its shadow DOM when opened.
  // hot-select-option elements in the light DOM are templates, not directly clickable.
  // Strategy: click the hot-select → it opens → interact with shadow DOM options OR use keyboard.

  // Click the hot-select to open it and focus it
  const hotSelectPos = await page.evaluate(() => {
    const el = document.querySelector('hot-select#currency, hot-select[placeholder*="moeda"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? {x: r.left+r.width/2, y: r.top+r.height/2} : null;
  }).catch(()=>null);
  log.info('hot-select pos: ' + JSON.stringify(hotSelectPos));

  if (hotSelectPos) {
    await page.mouse.click(hotSelectPos.x, hotSelectPos.y);
    await sleep(1000); // Wait for dropdown to open

    // Try 1: shadow DOM items now rendered after opening
    const shadowBRL = await page.evaluate(() => {
      const el = document.querySelector('hot-select#currency');
      if (el && el.shadowRoot) {
        const items = Array.from(el.shadowRoot.querySelectorAll('[role="option"], li, [class*="option-item"], [class*="list-item"]'));
        const brl = items.find(i => (i.textContent||'').toLowerCase().includes('real'));
        if (brl) { brl.click(); return 'shadow:'+brl.textContent.trim().slice(0,30); }
        // Log shadow DOM structure for debugging
        return 'shadow-html:'+el.shadowRoot.innerHTML.slice(0,200);
      }
      return null;
    }).catch(()=>null);
    log.info('Shadow BRL result: ' + (shadowBRL||'null').slice(0,100));
    await sleep(500);

    // Try 2: Keyboard — type "Real" to filter, then ArrowDown + Enter
    if (!shadowBRL || shadowBRL.startsWith('shadow-html:')) {
      // Type to filter — the hot-select has a search input in its shadow DOM
      log.info('Typing "Real" to filter dropdown options');
      await page.keyboard.type('Real', {delay: 80});
      await sleep(1000); // Wait for dropdown to render matching option

      // NOW: get the bounding rect of the visible "Real Brasileiro" option
      // Then use page.mouse.click() (creates trusted events — web component responds)
      const brlRect = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          const t = (el.textContent||'').trim();
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.height < 60 && t.length < 50 &&
              (t === 'Real Brasileiro' || t.toLowerCase().includes('real brasileiro'))) {
            return {x: r.left+r.width/2, y: r.top+r.height/2, tag: el.tagName, text: t.slice(0,30)};
          }
        }
        return null;
      }).catch(()=>null);
      log.info('BRL option rect: ' + JSON.stringify(brlRect));

      if (brlRect && brlRect.x) {
        // Use page.mouse.click() for trusted event (web components check isTrusted)
        await page.mouse.click(brlRect.x, brlRect.y);
        log.info('Trusted mouse click on BRL option at (' + Math.round(brlRect.x) + ',' + Math.round(brlRect.y) + ')');
        await sleep(2500);
      } else {
        // Fallback: ArrowDown+Enter
        log.info('BRL not found — trying ArrowDown+Enter');
        await page.keyboard.press('ArrowDown');
        await sleep(300);
        await page.keyboard.press('Enter');
        await sleep(2000);
      }
    }
  }

  // Take screenshot after currency interaction
  await page.screenshot({path: '/app/pricing_after_brl.png', fullPage: false}).catch(()=>{});
  log.info('Screenshot after BRL: /app/pricing_after_brl.png');
  const hotSelectValue = await page.evaluate(()=>{
    const el = document.querySelector('hot-select#currency');
    return el ? (el.value || el.getAttribute('value') || 'no-value') : 'not-found';
  }).catch(()=>'err');
  log.info('hot-select value after BRL: ' + hotSelectValue);

  // STEP 3c: Wait for price field to appear (dynamic — only shows after currency selected)
  // Price field takes ~15-25s to appear after BRL selection. Poll up to 35s.
  // Wait for any visible input to appear (price field name is a JS property, not HTML attr)
  let priceAppeared = false;
  for (let pi = 0; pi < 10; pi++) {
    await sleep(1000);
    priceAppeared = await page.evaluate(() => {
      // Check all inputs — field may have name as JS property not HTML attribute
      const inputs = Array.from(document.querySelectorAll('input, hot-input'));
      return inputs.some(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 5 && el.type !== 'hidden' && el.type !== 'checkbox' && el.type !== 'radio';
      });
    }).catch(()=>false);
    if (priceAppeared) { log.info('Price field appeared at t='+(pi+1)+'s'); break; }
    if (pi % 3 === 2) log.info('Waiting for price field t='+(pi+1)+'s');
  }
  log.info('Price field appeared: ' + priceAppeared);
  log.info('Pricing page body len=' + await page.evaluate(()=>document.body?document.body.innerHTML.length:0).catch(()=>0));

  const priceFieldInfo = await page.evaluate(() => {
    // 1. Regular input selectors
    const directCandidates = [
      document.querySelector('input[name="price"],input[name="amount"],input[type="number"],input[name="valor"]'),
      document.querySelector('[class*="price"] input,[class*="valor"] input,[class*="amount"] input'),
    ].filter(Boolean);
    for (const el of directCandidates) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) return { x: r.left+r.width/2, y: r.top+r.height/2, tag: el.tagName, name: el.getAttribute('name')||el.name||'', source: 'direct' };
    }
    // 2. HOT-INPUT web components (check shadow DOM)
    const hotInputs = document.querySelectorAll('hot-input');
    for (const el of hotInputs) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) {
        // Check shadow DOM for an input
        const shadowInput = el.shadowRoot && el.shadowRoot.querySelector('input');
        if (shadowInput) {
          const ri = shadowInput.getBoundingClientRect();
          if (ri.width > 0) return {x: ri.left+ri.width/2, y: ri.top+ri.height/2, tag: 'HOT-INPUT(shadow)', name: shadowInput.name||el.getAttribute('name')||'', source: 'shadow'};
        }
        // No shadow - click the hot-input itself
        return {x: r.left+r.width/2, y: r.top+r.height/2, tag: 'HOT-INPUT', name: el.getAttribute('name')||el.id||'', source: 'hot-input', el: el.outerHTML.slice(0,100)};
      }
    }
    // 3. All visible inputs as last resort
    const allInputs = Array.from(document.querySelectorAll('input')).map(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 5 ? { x: r.left+r.width/2, y: r.top+r.height/2, tag: el.tagName, name: el.getAttribute('name')||el.name||el.id||'', type: el.type, source: 'all' } : null;
    }).filter(Boolean);
    if (allInputs.length > 0) return allInputs[0];
    // 4. Check ALL custom elements for shadow inputs
    const allCustom = document.querySelectorAll('*');
    for (const el of allCustom) {
      if (el.shadowRoot) {
        const sinp = el.shadowRoot.querySelector('input[type="number"],input[type="text"]');
        if (sinp) {
          const r = sinp.getBoundingClientRect();
          if (r.width > 0) return {x: r.left+r.width/2, y: r.top+r.height/2, tag: el.tagName+'[shadow]', name: sinp.name||'', source: 'deep-shadow'};
        }
      }
    }
    return null;
  }).catch(()=>null);
  log.info('Price field: ' + JSON.stringify(priceFieldInfo).slice(0,200));

  // STEP 3d: Select "Forma de pagamento" (payment method) — appears after BRL selected
  // Usually a hot-select with options like "Boleto e cartão de crédito", "Cartão de crédito", etc.
  await sleep(500);
  const paymentPos = await page.evaluate(() => {
    // Find hot-select with placeholder "Selecione uma forma de pagamento"
    const all = document.querySelectorAll('hot-select');
    for (const el of all) {
      const ph = el.getAttribute('placeholder')||'';
      if (ph.toLowerCase().includes('pagamento') || ph.toLowerCase().includes('payment')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) return {x: r.left+r.width/2, y: r.top+r.height/2, ph};
      }
    }
    return null;
  }).catch(()=>null);
  log.info('Payment method pos: ' + JSON.stringify(paymentPos));

  if (paymentPos) {
    // Click to open payment method dropdown
    await page.mouse.click(paymentPos.x, paymentPos.y);
    await sleep(1000);
    // Find and click first available payment option via mouse (trusted click)
    // CRITICAL: must constrain x > 300 to avoid sidebar nav items (Carteira at x=36)
    const paymentOptRect = await page.evaluate((minX) => {
      const all = Array.from(document.querySelectorAll('*'));
      // First pass: look for HOT-SELECT-OPTION elements (most reliable)
      for (const el of all) {
        if (el.tagName === 'HOT-SELECT-OPTION') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.x > minX) {
            const t = (el.textContent||'').trim();
            return {x: r.left+r.width/2, y: r.top+r.height/2, text: t.slice(0,40), tag: el.tagName, rx: Math.round(r.x)};
          }
        }
      }
      // Second pass: visible payment-keyword elements strictly in form area (x > 300)
      for (const el of all) {
        const t = (el.textContent||'').trim();
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.height < 60 && r.x > minX && t.length > 0 && t.length < 80 &&
            (t.toLowerCase().includes('cartão') || t.toLowerCase().includes('boleto') ||
             t.toLowerCase().includes('cartao') || t.toLowerCase().includes('credit') ||
             t.toLowerCase().includes('pix') || t.toLowerCase().includes('débito') ||
             t.toLowerCase().includes('debito'))) {
          return {x: r.left+r.width/2, y: r.top+r.height/2, text: t.slice(0,40), tag: el.tagName, rx: Math.round(r.x)};
        }
      }
      return null;
    }, 300).catch(()=>null);
    log.info('Payment option: ' + JSON.stringify(paymentOptRect));
    if (paymentOptRect) {
      await page.mouse.click(paymentOptRect.x, paymentOptRect.y);
      log.info('Payment method clicked: ' + paymentOptRect.text);
      await sleep(1500);
    } else {
      // Try ArrowDown+Enter
      await page.keyboard.press('ArrowDown');
      await sleep(300);
      await page.keyboard.press('Enter');
      await sleep(1500);
      log.info('Payment: ArrowDown+Enter');
    }
  } else {
    log.info('Payment method not found (may not be required or already set)');
  }

  if (priceFieldInfo && priceFieldInfo.x) {
    // Click to focus the price field (single click — no triple-click!)
    // Currency mask is RIGHT-TO-LEFT: typing "4","9","9" shifts digits:
    //   "0,04" → "0,49" → "4,99"   ✓
    // Triple-click selects all and breaks the mask (resets to 0,00 on any replacement)
    await page.mouse.click(priceFieldInfo.x, priceFieldInfo.y);
    await sleep(400);
    // Move cursor to end of field so digits append correctly
    await page.keyboard.press('End');
    await sleep(100);
    // Type only digits — currency mask handles formatting
    const priceDigits = DEFAULT_PRICE.replace(/[^0-9]/g, ''); // "4,99" → "499"
    await page.keyboard.type(priceDigits, {delay:150});
    await sleep(600);
    // Read back what was entered
    const priceEntered = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 5 && el.type !== 'hidden';
      });
      return inputs.map(el => ({name: el.name||el.getAttribute('name')||el.id||'', val: el.value, type: el.type}));
    }).catch(()=>null);
    log.info('Price fields state: ' + JSON.stringify(priceEntered).slice(0,200));
    // Take screenshot to verify
    await page.screenshot({path: '/app/pricing_with_price.png', fullPage: false}).catch(()=>{});
    log.info('Price screenshot saved: /app/pricing_with_price.png');
  } else {
    log.warn('Price field not found after currency selection');
    await page.screenshot({path: '/app/pricing_with_price.png', fullPage: false}).catch(()=>{});
  }
  await sleep(1000);

  // Click save/next button via TRUSTED mouse.click() — hot-button ignores untrusted evaluate().click()
  // CRITICAL: scrollIntoView BEFORE getBoundingClientRect — button may be below 800px viewport
  const saveBtnPos = await page.evaluate(()=>{
    const allBtns = Array.from(document.querySelectorAll('button[type="submit"], button, hot-button'));
    const b = allBtns.find(b => {
      const t = (b.textContent||'').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
      return t.includes('salvar') || t.includes('criar') || t.includes('proximo') ||
             t.includes('avanc') || t.includes('publicar') || t.includes('finaliz') ||
             t === 'next' || t === 'save';
    });
    if (b) {
      // Scroll into viewport FIRST so mouse.click() coordinates are on-screen
      b.scrollIntoView({behavior: 'instant', block: 'center'});
      const r = b.getBoundingClientRect();
      if (r.width > 0) return {x: r.left+r.width/2, y: r.top+r.height/2, text: b.textContent.trim().slice(0,30)};
    }
    // Log what buttons exist for debugging
    const visible = allBtns.filter(b=>b.getBoundingClientRect().width>0).map(b=>b.textContent.trim().slice(0,20));
    return {x:0, y:0, text: 'NOT_FOUND:'+visible.join('|')};
  });
  await sleep(400); // let scroll settle before mouse.click
  log.info('Save btn pos: ' + JSON.stringify(saveBtnPos));
  if (saveBtnPos && saveBtnPos.x > 0) {
    await page.mouse.click(saveBtnPos.x, saveBtnPos.y);
    log.info('Save pricing clicked (trusted): ' + saveBtnPos.text);
  } else {
    log.warn('Save button not found: ' + (saveBtnPos && saveBtnPos.text));
  }

  // Wait for URL to change after save — product ID often appears in the URL
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const u = page.url();
    const m = u.match(/\/products\/manage\/(\d+)/) || u.match(/\/products\/add\/4\/[^\/]+\/(\d+)/) || u.match(/[?&]productId=(\d+)/) || u.match(/\/(\d{7,})(?:\/|$|\?)/);
    if (m) { capturedNumericId = capturedNumericId || m[1]; log.info('URL id='+m[1]+' at t='+(i+1)+'s: '+u.slice(0,80)); break; }
    if (i % 3 === 2) log.info('Pricing save wait t='+(i+1)+'s url='+u.slice(0,60));
  }

  // Capture product ID from final URL
  const finalUrl = page.url();
  const urlM = finalUrl.match(/\/products\/manage\/(\d+)/);
  if (urlM) capturedNumericId = capturedNumericId || urlM[1];
  // Also check URL for product ID in /products/add pattern
  const addM = finalUrl.match(/\/products\/add\/4\/[^\/]+\/(\d+)/) || finalUrl.match(/\/(\d{7,})(?:\/|$|\?)/);
  if (addM) capturedNumericId = capturedNumericId || addM[1];
  log.info('After pricing: numericId=' + capturedNumericId + ' url=' + finalUrl.slice(0,80));

  // Fallback 1: look up by ucode from CDP
  if (!capturedNumericId && capturedUcode) {
    const token = await page.evaluate(()=>localStorage.getItem('token')).catch(()=>null);
    if (token) {
      try {
        const resp = await page.evaluate(async(tok) => {
          const r = await fetch('https://api-product.vulcano.hotmart.com/product/v2/user/product/list?max=200&page=0',
            {headers:{'Authorization':'Bearer '+tok}});
          const txt = await r.text();
          try { return JSON.parse(txt); } catch(e) { return {_raw: txt.slice(0,100)}; }
        }, token);
        const item = (resp.items||resp.content||resp.list||[]).find(x => x.ucode === capturedUcode);
        if (item) { capturedNumericId = String(item.id); log.info('ID from ucode lookup: '+capturedNumericId); }
        else log.info('Ucode lookup response: '+JSON.stringify(resp).slice(0,100));
      } catch(e) { log.warn('Ucode lookup failed: '+e.message.slice(0,50)); }
    }
  }

  // Fallback 2: query product list APIs (try multiple endpoints)
  if (!capturedNumericId) {
    log.warn('No ID from CDP/URL — querying product list for most recent product...');
    const token = await page.evaluate(()=>localStorage.getItem('token')).catch(()=>null);
    if (token) {
      const listUrls = [
        'https://api-product.vulcano.hotmart.com/product/v2/user/product/list?max=10&page=0',
        'https://api-product.vulcano.hotmart.com/product/v1/user/product/list?max=10&page=0',
        'https://app.hotmart.com/api/v1/products?max=10&page=0',
      ];
      for (const url of listUrls) {
        try {
          const resp = await page.evaluate(async(tok, u) => {
            const r = await fetch(u, {headers:{'Authorization':'Bearer '+tok}});
            const txt = await r.text();
            try { return {ok:true, data:JSON.parse(txt)}; } catch(e) { return {ok:false, raw:txt.slice(0,120)}; }
          }, token, url);
          log.info('List URL '+url.slice(40)+' => '+JSON.stringify(resp).slice(0,120));
          if (resp.ok) {
            const data = resp.data;
            const items = data.items || data.list || data.content || data.products || [];
            if (items.length > 0) {
              const match = items.find(x => (x.name||x.productName||'').toLowerCase().includes((title||'').toLowerCase().slice(0,15)));
              const candidate = match || items[0];
              if (candidate && (candidate.id||candidate.productId)) {
                capturedNumericId = String(candidate.id || candidate.productId);
                log.info('ID from list ('+url.slice(40)+'): '+capturedNumericId+' name='+(candidate.name||candidate.productName));
                break;
              }
            }
          }
        } catch(e) { log.warn('List API '+url.slice(40)+' error: '+e.message.slice(0,60)); }
      }
    }
  }

  if (client) await client.detach().catch(()=>{});
  log.info('createProduct done: numericId=' + capturedNumericId + ' category=' + category);
  return { numericId: capturedNumericId, category };
}

async function uploadCoverImage(page, numericId, coverPath) {
  if (!coverPath || !fs.existsSync(coverPath)) { log.warn('No cover image at: '+coverPath); return false; }
  log.info('Uploading cover to product '+numericId+'...');
  try {
    await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
    await sleep(5000);
    await page.evaluate(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent.trim().includes('Informa')
      );
      if(b) b.click();
    });
    await sleep(3000);
    const imgAreaClicked = await page.evaluate(()=>{
      const selectors = ['[class*="upload"][class*="image"]','[class*="image"][class*="upload"]','[class*="cover"]','[class*="thumbnail"]','[class*="imagem"]','[class*="foto"]'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if(el && el.getBoundingClientRect().width > 0){el.click();return sel;}
      }
      const btn = Array.from(document.querySelectorAll('button,[role="button"]')).find(b=>{
        const t=(b.textContent||'').toLowerCase();
        return t.includes('imagem')||t.includes('foto')||t.includes('capa')||t.includes('image')||t.includes('cover');
      });
      if(btn){btn.click();return 'button:'+btn.textContent.trim().slice(0,30);}
      return null;
    });
    log.info('Image area clicked: '+imgAreaClicked);
    await sleep(1500);
    let fileInput = await page.$('input[type="file"][accept*="image"]').catch(()=>null);
    if(!fileInput) fileInput = await page.$('input[type="file"]').catch(()=>null);
    if(fileInput){
      await fileInput.uploadFile(coverPath);
      await sleep(4000);
      await page.evaluate(()=>{
        const b=Array.from(document.querySelectorAll('button')).find(b=>{const t=b.textContent.trim().toLowerCase();return t==='salvar'||t==='save'||t==='confirmar';});
        if(b)b.click();
      });
      await sleep(3000);
      log.info('Cover uploaded!');
      return true;
    }
    log.warn('Cover file input not found');
    return false;
  } catch(e) {
    log.warn('Cover upload error: '+e.message);
    return false;
  }
}

async function uploadPDF(page, numericId, pdfPath) {
  log.info('Uploading PDF to '+numericId);
  await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  for(let i=0;i<40;i++){
    await sleep(1000);
    const len = await page.evaluate(()=>document.body&&document.body.innerText?document.body.innerText.length:0).catch(()=>0);
    if(i%5===4) log.info('PDF-page t='+(i+1)+'s len='+len);
    if(len>=1200) break;
  }
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Painel');if(b)b.click();});
  await sleep(3000);
  let configs=[];
  for(let i=0;i<20;i++){
    await sleep(1000);
    configs=await page.evaluate(()=>Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Configurar').map(b=>{const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,vis:r.width>0};}).filter(b=>b.vis));
    if(configs.length>0){log.info('Configurar at t='+(i+1)+'s');break;}
  }
  if(!configs.length){log.warn('No Configurar button found');return false;}
  const cfg=configs.find(c=>c.y<700)||configs[0];
  await page.mouse.click(cfg.x,cfg.y);
  await sleep(4000);
  for(let att=0;att<3;att++){
    const inp=await page.$('input[type="file"]').catch(()=>null);
    if(inp){log.info('File input found!');await inp.uploadFile(pdfPath);await sleep(15000);return true;}
    const bi=await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['selecione','upload','enviar','arquivo','escolher'].some(k=>(b.textContent||'').toLowerCase().includes(k)));if(b){const r=b.getBoundingClientRect();return{text:b.textContent.trim(),x:r.left+r.width/2,y:r.top+r.height/2};}return null;});
    if(bi){log.info('Clicking "'+bi.text+'"');await page.mouse.click(bi.x,bi.y);await sleep(2000);const i2=await page.$('input[type="file"]').catch(()=>null);if(i2){log.info('Input appeared!');await i2.uploadFile(pdfPath);await sleep(15000);return true;}}
    await sleep(3000);
  }
  log.warn('PDF upload failed');return false;
}

async function finalizarCadastro(page, numericId) {
  log.info('Finalizing '+numericId);
  await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  for(let i=0;i<40;i++){
    await sleep(1000);
    const len = await page.evaluate(()=>document.body&&document.body.innerText?document.body.innerText.length:0).catch(()=>0);
    if(len>=1200) break;
  }
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Painel');if(b)b.click();});
  let fInfo=null;
  for(let i=0;i<30;i++){
    await sleep(1000);
    fInfo=await page.evaluate(()=>{const btn=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Finalizar cadastro');if(!btn)return null;const r=btn.getBoundingClientRect();return{disabled:btn.disabled,x:r.left+r.width/2,y:r.top+r.height/2};}).catch(()=>null);
    if(fInfo){log.info('Finalizar t='+(i+1)+'s disabled='+fInfo.disabled);break;}
  }
  if(!fInfo){log.warn('Finalizar not found');return false;}
  if(fInfo.disabled){log.warn('Finalizar disabled');return false;}
  await page.mouse.click(fInfo.x,fInfo.y);
  await sleep(5000);
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['confirmar','sim','ok','publicar','finalizar','ativar'].includes((b.textContent||'').trim().toLowerCase()));if(b)b.click();});
  await sleep(4000);
  const after=await page.evaluate(()=>document.body&&document.body.innerText?document.body.innerText.slice(0,200):'').catch(()=>'');
  log.info('After finalize: '+after.replace(/\n/g,' ').slice(0,100));
  return true;
}

async function screenshotLandingPage(page, numericId, title) {
  try {
    const safeTitle = title.replace(/[^a-zA-Z0-9]/g,'_').slice(0,40);
    fs.mkdirSync(SCREENSHOTS_DIR, {recursive:true});
    const urls = [
      'https://app.hotmart.com/products/manage/'+numericId+'/overview',
      'https://app.hotmart.com/products/manage/'+numericId+'/info',
    ];
    for (const url of urls) {
      try {
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
        await sleep(4000);
        const outPath = path.join(SCREENSHOTS_DIR, numericId+'_'+safeTitle+'.png');
        await page.screenshot({path:outPath, fullPage:false});
        log.info('Screenshot saved: '+outPath);
        return outPath;
      } catch(e) { log.warn('Screenshot attempt failed: '+e.message); }
    }
    return null;
  }catch(e){log.warn('Screenshot failed: '+e.message);return null;}
}

async function publishToHotmart(ebook) {
  const { title, topic, pdfPath, coverPath, description } = ebook;
  if(!fs.existsSync(SESSION_FILE)) throw new Error('Session not found: '+SESSION_FILE);
  if(!pdfPath||!fs.existsSync(pdfPath)) throw new Error('PDF not found: '+pdfPath);
  const session=JSON.parse(fs.readFileSync(SESSION_FILE,'utf8'));
  const browser=await puppeteer.launch({
    headless:true, executablePath:'/usr/bin/chromium',
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
          '--disable-blink-features=AutomationControlled','--window-size=1280,900'],
    defaultViewport:{width:1280,height:900}
  });
  try {
    const jwt=await refreshJWT(browser,session);
    const page=await browser.newPage();
    await setupPage(page,session,jwt);
    page.on('framenavigated',f=>{if(f===page.mainFrame())log.info('NAV',f.url().slice(0,90));});
    // Establish session on products/producer (wait for #search-input = session ready)
    log.info('Establishing session on products/producer...');
    await page.goto('https://app.hotmart.com/products/producer',{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    let sessionReady = false;
    for(let i=0;i<35;i++){
      await sleep(1000);
      sessionReady = await page.evaluate(()=>!!document.querySelector('#search-input')).catch(()=>false);
      if(sessionReady){log.info('Session established t='+(i+1)+'s'); break;}
    }
    if (!sessionReady) log.warn('Session not confirmed -- proceeding anyway');
    // Step 1: Create product (wizard + pricing)
    const {numericId,category}=await createProduct(page,session,{title,topic,description,coverPath,pdfPath});
    if(!numericId) throw new Error('No product ID after creation');
    // Step 2: Upload cover image
    const coverUploaded = await uploadCoverImage(page, numericId, coverPath);
    log.info('Cover uploaded: '+coverUploaded);
    // Step 3: Upload PDF content
    const uploaded=await uploadPDF(page,numericId,pdfPath);
    if(!uploaded) log.warn('PDF upload failed');
    // Step 4: Finalizar cadastro
    const finalized=await finalizarCadastro(page,numericId);
    // Step 5: Screenshot
    const screenshot=await screenshotLandingPage(page,numericId,title);
    await browser.close();
    log.info('Done: "'+title+'" id='+numericId+' finalized='+finalized+' cover='+coverUploaded);
    return{success:finalized,hotmartProductId:numericId,url:'https://hotmart.com/product/'+numericId,screenshot,category,platform:'hotmart',uploaded,coverUploaded};
  }catch(err){
    await browser.close().catch(()=>{});
    log.error('publishToHotmart error: '+err.message);
    throw err;
  }
}

module.exports = { publishToHotmart, getCategory: getCategoryPT };
