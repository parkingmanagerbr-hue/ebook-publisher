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

const { resolveSessionFile } = require('../core/sessionPath');
const SESSION_FILE = resolveSessionFile('hotmart', 'HOTMART_SESSION_FILE');
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/app/data/landing_screenshots';
const DEFAULT_PRICE = process.env.HOTMART_PRICE || '4,99';

let log;
try {
  const { createLogger } = require('../core/logger');
  log = createLogger('hotmart');
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
  // URL de servico REAL do app (a mesma do login humano). Antes usava
  // redirect_uri=/logout, que devolve o token MAS DESLOGA o browser — o wizard
  // caia em sso.hotmart.com/login e queimava 90s de timeout POR CICLO
  // ("eBook card not found after 90s"). Com /auth/login o browser autentica.
  const oauth2Service = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize' +
    '?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d' +
    '&scope=openid+profile+authorities+email+user+address' +
    '&redirect_uri=' + encodeURIComponent('https://app.hotmart.com/auth/login?realm=hotmart&branding_id=bw') +
    '&response_type=code&response_mode=query&state=' + Math.abs(Date.now() | 0).toString(16) +
    '&client_name=CasOAuthClient';
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
  const { title, description, topic, coverPath } = ebook;
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

  // Poll for eBook type card -- renders as DIV with exact text "eBook" after OAM redirects settle
  // Extend to 90s because OAM redirect cycles can delay SPA rendering significantly
  let ebookBtn = null;
  let lastBodyLen = 0;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (i % 5 === 4) {
      const bLen = await page.evaluate(()=>document.body?document.body.innerHTML.length:0).catch(()=>0);
      log.info('wizard poll t='+(i+1)+'s bodyLen='+bLen+' url='+page.url().slice(0,60));
      lastBodyLen = bLen;
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
  if (!ebookBtn) throw new Error('eBook card not found after 90s -- wizard not rendered. URL: ' + page.url().slice(0,80));

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

  // Dismiss cookie banner on /info page BEFORE interacting with category/Continuar
  // (cookie banner covers the bottom of the page and can block clicks)
  const cookieDismissedOnInfo = await page.evaluate(() => {
    const cookieEl = document.querySelector('hotmart-cookie-policy');
    if (cookieEl) {
      const roots = [cookieEl.shadowRoot, cookieEl];
      for (const root of roots) {
        if (!root) continue;
        const btns = Array.from(root.querySelectorAll('button'));
        const necessary = btns.find(b => {
          const t = (b.textContent||'').toLowerCase();
          return t.includes('necessário') || t.includes('somente') || t.includes('aceitar') || t.includes('permitir');
        });
        if (necessary) { necessary.click(); return 'shadow:'+necessary.textContent.trim().slice(0,30); }
        // Click any button to close (prefer last = "Permitir todos")
        if (btns.length > 0) { btns[btns.length-1].click(); return 'shadow-last:'+btns[btns.length-1].textContent.trim().slice(0,30); }
      }
    }
    // Fallback: scan all shadow roots
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const btns = Array.from(el.shadowRoot.querySelectorAll('button'));
        const allow = btns.find(b => { const t=(b.textContent||'').toLowerCase(); return t.includes('permitir')||t.includes('aceitar')||t.includes('necessário'); });
        if (allow) { allow.click(); return 'any-shadow:'+allow.textContent.trim().slice(0,30); }
      }
    }
    // Check for regular (non-shadow) cookie buttons
    const regularBtns = Array.from(document.querySelectorAll('button')).filter(b => {
      const t = (b.textContent||'').toLowerCase();
      return (t.includes('necessário') || t.includes('aceitar') || t.includes('permitir')) && b.getBoundingClientRect().width > 0;
    });
    if (regularBtns.length > 0) { regularBtns[0].click(); return 'regular:'+regularBtns[0].textContent.trim().slice(0,30); }
    return 'no-cookie';
  }).catch(()=>'err');
  log.info('Cookie banner /info: ' + cookieDismissedOnInfo);
  if (!cookieDismissedOnInfo.startsWith('no-cookie')) await sleep(800);

  // Screenshot before category to debug what's on the page
  await page.screenshot({path:'/app/category_before.png'}).catch(()=>{});
  log.info('Category debug screenshot saved: /app/category_before.png');

  // Click category — Step 1: open the dropdown by clicking the category trigger
  // CRITICAL: use TRUSTED page.mouse.click() — hot-select web components check event.isTrusted
  // and ignore untrusted evaluate().click() calls. Return bounding rect from evaluate, then click outside.
  //
  // NOTE: "Category panel already open" with ["selecione um arquivo","cancelar","continuar"] means
  // the FILE UPLOAD panel is open, NOT the category dropdown. We must distinguish these two cases.
  const CAT_KW = ['saude','esporte','financas','investimento','relacionamento','negocio','carreira',
                   'espiritual','educacao','tecnologia','programacao','desenvolvimento','pessoal',
                   'estetica','idioma','gastronomia','animal','humor','saude e esportes',
                   'negocios e carreira','desenvolvimento pessoal'];
  const catTriggerRect = await page.evaluate((catKw) => {
    function norm(s){return(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();}
    // Priority 1: ANY hot-select element — search light DOM + shadow DOM (Hotmart nests components)
    function findHotSelect(root) {
      const els = Array.from(root.querySelectorAll ? root.querySelectorAll('hot-select') : []);
      for (const el of els) { const r = el.getBoundingClientRect(); if (r.width > 50) return el; }
      const all = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
      for (const el of all) {
        if (el.shadowRoot) { const r = findHotSelect(el.shadowRoot); if (r) return r; }
      }
      return null;
    }
    const hotSel = findHotSelect(document);
    if (hotSel) {
      hotSel.scrollIntoView({behavior:'instant',block:'center'});
      const r = hotSel.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2, src:'hot-select(ph='+hotSel.getAttribute('placeholder')+')'};
    }
    // Priority 2: look for category trigger button by class/attribute
    const trigger = document.querySelector(
      '[class*="categor"] button, [class*="category"] button, button[id*="categor"], ' +
      'select[name*="categor"], [aria-label*="ategori"], [placeholder*="ategori"]'
    );
    if (trigger && trigger.getBoundingClientRect().width > 0) {
      trigger.scrollIntoView({behavior:'instant',block:'center'});
      const r = trigger.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2, src:'trigger:'+trigger.tagName};
    }
    // Priority 3: label text "Categoria" adjacent to clickable element
    const labels = Array.from(document.querySelectorAll('label, span, div, p, h3, h4'));
    const catLabel = labels.find(el => {
      const t = norm(el.textContent||'').trim();
      return (t === 'categoria' || t === 'category') && el.getBoundingClientRect().width > 0;
    });
    if (catLabel) {
      catLabel.scrollIntoView({behavior:'instant',block:'center'});
      const r = catLabel.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2, src:'label:'+catLabel.tagName};
    }
    // Priority 4: check if a REAL category panel is already open (contains category keywords)
    // Do NOT treat the file-upload panel ("selecione um arquivo") as an open category panel
    const visibleOpts = Array.from(document.querySelectorAll('button, li, [role="option"]'))
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => norm(el.textContent||'').slice(0,40)).filter(t=>t.length>2);
    const hasCatOptions = visibleOpts.some(t => catKw.some(k => t.includes(k)));
    if (hasCatOptions) {
      return {alreadyOpen: true, visibleBtns: visibleOpts.slice(0,20)};
    }
    // Fallback: return debug info (category panel NOT open yet, trigger not found)
    return {notFound: true, visibleBtns: visibleOpts.slice(0,10)};
  }, CAT_KW).catch(()=>null);

  if (catTriggerRect && catTriggerRect.x) {
    await page.mouse.click(catTriggerRect.x, catTriggerRect.y);
    log.info('Category trigger clicked (trusted): ' + catTriggerRect.src);
    await sleep(1200); // wait for dropdown to render
  } else if (catTriggerRect && catTriggerRect.alreadyOpen) {
    log.info('Category panel already open: ' + JSON.stringify(catTriggerRect.visibleBtns).slice(0,120));
  } else {
    log.warn('Category trigger not found — debug: ' + JSON.stringify(catTriggerRect));
    // Try scrolling to find the hot-select and clicking at a fixed offset from "Categoria" text
    const scrollAndClick = await page.evaluate(() => {
      // Scroll down slowly to find the category section
      window.scrollTo(0, document.body.scrollHeight / 2);
      return {scrolled: true, bodyLen: document.body.innerText.length};
    }).catch(()=>null);
    if (scrollAndClick) { await sleep(800); }
  }

  // Step 2: find and click the correct category option — TRUSTED page.mouse.click()
  // Get bounding rect from evaluate, click from outside (bypasses isTrusted check)
  const catRect = await page.evaluate((cat) => {
    function norm(s){return(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();}
    const catNorm = norm(cat);
    const catFirst = catNorm.split(' ')[0]; // e.g. "negocios" from "Negocios e Carreira"

    const candidates = Array.from(document.querySelectorAll('button, li, [role="option"], [role="listitem"], hot-select-option'));
    // Priority 1: exact match
    let el = candidates.find(b => {
      const t = norm(b.textContent||'');
      return b.getBoundingClientRect().width > 0 && (t === catNorm || t === catFirst);
    });
    // Priority 2: partial match
    if (!el) el = candidates.find(b => {
      const t = norm(b.textContent||'');
      const r = b.getBoundingClientRect();
      return r.width > 0 && t.length < 60 && catFirst.length > 4 && t.includes(catFirst);
    });
    // Priority 3: any element including divs/spans
    if (!el) {
      const all = Array.from(document.querySelectorAll('*'));
      el = all.find(b => {
        const t = norm(b.textContent||'');
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height < 80 && t.length > 3 && t.length < 60 && catFirst.length > 4 && t.includes(catFirst) && b.children.length < 3;
      });
    }
    if (el) {
      el.scrollIntoView({behavior:'instant', block:'center'});
      const r = el.getBoundingClientRect();
      if (r.width > 0) return {x:r.left+r.width/2, y:r.top+r.height/2, text:el.textContent.trim().slice(0,40), tag:el.tagName};
    }
    const debug = candidates.filter(b=>b.getBoundingClientRect().width>0).map(b=>norm(b.textContent||'').slice(0,25)).filter(t=>t.length>2).slice(0,20);
    return {notFound:true, catNorm, catFirst, visibleOptions:debug};
  }, category);

  if (catRect && catRect.x) {
    await page.mouse.click(catRect.x, catRect.y);
    log.info('Category clicked (trusted): ' + catRect.text + ' @(' + Math.round(catRect.x)+','+Math.round(catRect.y)+')');
    await sleep(1200); // wait for subcategory panel to appear
  } else {
    log.warn('Category NOT found — debug: ' + JSON.stringify(catRect).slice(0,200));
  }

  // After category click, Hotmart may show a 2-step panel:
  // Step A — category panel has its OWN Continuar (confirms category selection)
  // Step B — main /info form has a Continuar (navigates to /pricing)
  // Strategy: click ALL visible Continuar buttons in reverse DOM order (panel last → main),
  // then if still on /info, retry with main Continuar using trusted mouse click.

  // Step A: click first subcategory if visible (Hotmart requires subcategory after main category)
  // Use TRUSTED page.mouse.click() — hot-select ignores untrusted clicks
  const subCatRect = await page.evaluate(() => {
    function norm(s){return(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();}
    // After clicking main category, subcategories appear as a new list of buttons/options
    // Look for hot-select-option, li, or button elements that appeared after category selection
    // (they'll be the SECOND set of options visible — smaller, specific sub-categories)
    const allOptions = Array.from(document.querySelectorAll(
      'hot-select-option, [class*="subcategor"] button, [class*="subcategor"] li, ' +
      '[class*="subCategory"] button, [class*="sub-category"] button, [class*="subc"] button'
    )).filter(el => {
      const r = el.getBoundingClientRect();
      const t = (el.textContent||'').trim();
      return r.width > 0 && r.height > 0 && t.length > 2;
    });
    if (allOptions.length > 0) {
      const el = allOptions[0];
      el.scrollIntoView({behavior:'instant',block:'center'});
      const r = el.getBoundingClientRect();
      return r.width > 0 ? {x:r.left+r.width/2, y:r.top+r.height/2, text:el.textContent.trim().slice(0,40)} : null;
    }
    // Fallback: look for a second hot-select dropdown that appeared (subcategory)
    const hotSels = Array.from(document.querySelectorAll('hot-select')).filter(el => {
      const ph = (el.getAttribute('placeholder')||'').toLowerCase();
      return (ph.includes('subcategor') || ph.includes('sub')) && el.getBoundingClientRect().width > 0;
    });
    if (hotSels.length > 0) {
      const el = hotSels[0];
      el.scrollIntoView({behavior:'instant',block:'center'});
      const r = el.getBoundingClientRect();
      return r.width > 0 ? {x:r.left+r.width/2, y:r.top+r.height/2, text:'hot-select-sub'} : null;
    }
    return null;
  }).catch(()=>null);

  if (subCatRect && subCatRect.x) {
    await page.mouse.click(subCatRect.x, subCatRect.y);
    log.info('Subcategory clicked (trusted): ' + subCatRect.text);
    await sleep(1000);
    // If we clicked a hot-select trigger for subcategory, now click the first option
    const subOptRect = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('hot-select-option, [role="option"], li[class*="option"]'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (opts.length > 0) {
        const el = opts[0];
        el.scrollIntoView({behavior:'instant',block:'center'});
        const r = el.getBoundingClientRect();
        return r.width > 0 ? {x:r.left+r.width/2, y:r.top+r.height/2, text:el.textContent.trim().slice(0,40)} : null;
      }
      return null;
    }).catch(()=>null);
    if (subOptRect && subOptRect.x) {
      await page.mouse.click(subOptRect.x, subOptRect.y);
      log.info('Subcategory option clicked (trusted): ' + subOptRect.text);
      await sleep(800);
    }
  } else {
    log.info('No subcategory panel found (may not be required or already selected)');
  }

  // After category+subcategory, look for a panel Confirmar/Selecionar button to close the category panel
  const catConfirmRect = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => {
      const t = (b.textContent||'').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
      const r = b.getBoundingClientRect();
      return r.width > 0 && (t === 'confirmar' || t === 'selecionar' || t === 'ok' || t === 'aplicar' || t.includes('confirm') || t.includes('select'));
    });
    if (btns.length > 0) {
      const b = btns[0];
      b.scrollIntoView({behavior:'instant',block:'center'});
      const r = b.getBoundingClientRect();
      return r.width > 0 ? {x:r.left+r.width/2, y:r.top+r.height/2, text:b.textContent.trim().slice(0,30)} : null;
    }
    return null;
  }).catch(()=>null);
  if (catConfirmRect && catConfirmRect.x) {
    await page.mouse.click(catConfirmRect.x, catConfirmRect.y);
    log.info('Category panel confirm clicked: ' + catConfirmRect.text);
    await sleep(800);
  }

  // === COVER UPLOAD DURING WIZARD ===
  // NOTE: Disabled — uploading cover during the wizard interferes with the Continuar navigation
  // and causes numericId=null (URL stays on /info instead of navigating to /pricing).
  // The post-creation approach (/manage/<id>/info with 45s wait) is used instead.
  // TODO: Investigate why the wizard Continuar doesn't navigate after cover upload.
  let wizardCoverUploaded = false;
  if (false && coverPath && fs.existsSync(coverPath)) {
    log.info('Attempting wizard cover upload on /add/4/info...');
    // Wait up to 5s for any file input to appear (cover section may be below the fold)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{});
    await sleep(500);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(()=>{});
    await sleep(500);
    // Try direct selector first
    let wizCoverInput = null;
    for (const sel of ['input[accept*="image"][type="file"]', 'input[type="file"]', 'input[id*="cover"]', 'input[id*="imagem"]', 'input[id*="image"]']) {
      wizCoverInput = await page.$(sel).catch(()=>null);
      if (wizCoverInput) { log.info('Wizard cover input found via: '+sel); break; }
    }
    // Deep shadow DOM search
    if (!wizCoverInput) {
      const handle = await page.evaluateHandle(() => {
        function findFileInput(root) {
          if (!root) return null;
          const inputs = Array.from(root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : []);
          if (inputs.length > 0) {
            inputs[0].style.cssText = 'display:block!important;visibility:visible!important;opacity:1!important;position:fixed!important;top:0;left:0;width:1px;height:1px;';
            return inputs[0];
          }
          const all = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
          for (const el of all) { if (el.shadowRoot) { const r = findFileInput(el.shadowRoot); if (r) return r; } }
          return null;
        }
        return findFileInput(document);
      }).catch(()=>null);
      if (handle) {
        const el = handle.asElement ? handle.asElement() : null;
        if (el) { log.info('Wizard cover input found via shadow DOM'); wizCoverInput = el; }
        else await handle.dispose().catch(()=>{});
      }
    }
    if (wizCoverInput) {
      try {
        await wizCoverInput.uploadFile(coverPath);
        // Wait for upload to process — do NOT click any save buttons here,
        // the form saves automatically when 'Continuar' is clicked below.
        await sleep(4000);
        wizardCoverUploaded = true;
        log.info('Wizard cover upload OK!');
      } catch(e) {
        log.warn('Wizard cover upload error: '+e.message);
      }
    } else {
      log.info('Wizard cover input not found on /add/4/info — will try post-creation fallback');
    }
  }

  // Step B: find ALL visible Continuar buttons and click them in order (panel first, then main)
  const continList = await page.evaluate(()=>{
    const btns = Array.from(document.querySelectorAll('button')).filter(b => {
      const t = (b.textContent||'').trim().toLowerCase();
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (t === 'continuar' || t === 'salvar e continuar' || t.includes('continu'));
    });
    return btns.map(b => { const r = b.getBoundingClientRect(); return {x: r.left+r.width/2, y: r.top+r.height/2, text: b.textContent.trim()}; });
  }).catch(()=>[]);
  log.info('Continuar buttons found: ' + continList.length + ' — ' + continList.map(b=>b.text.slice(0,20)).join(' | '));

  // Click each found Continuar in order (panel's then main's)
  for (const btn of continList) {
    if (btn.x > 0 && btn.y > 0) {
      await page.mouse.click(btn.x, btn.y);
      log.info('Continuar click: ' + btn.text + ' @(' + Math.round(btn.x) + ',' + Math.round(btn.y) + ')');
      await sleep(800);
    }
  }
  // Also try untrusted click on any remaining Continuar (redundant but safe)
  if (continList.length === 0) {
    const fallbackClicked = await page.evaluate(()=>{
      const b = Array.from(document.querySelectorAll('button')).reverse()
        .find(b => { const t=(b.textContent||'').trim().toLowerCase(); return t==='continuar'||t.includes('continu'); });
      if (b) { b.click(); return b.textContent.trim().slice(0,30); }
      return null;
    }).catch(()=>null);
    if (fallbackClicked) log.info('Continuar fallback click: ' + fallbackClicked);
  }
  await sleep(4000);

  // Handle "Seus dados não foram salvos" confirmation modal.
  // Hotmart shows this when navigating away from a page with "unsaved" changes.
  // We must click "Sair mesmo assim" (Leave anyway) to proceed to /pricing.
  const dismissConfirmModal = async (label) => {
    // Returns {x,y,text} coords of the leave button (in shadow DOM), or null if no modal
    const btnPos = await page.evaluate(() => {
      // Deep shadow DOM search — hot-modal uses hot-modal-footer whose shadow root holds buttons
      function findLeaveBtn(root) {
        if (!root) return null;
        const btns = Array.from(root.querySelectorAll('button, [role=button]'));
        const found = btns.find(b => {
          const t = (b.textContent||'').toLowerCase().trim();
          const r = b.getBoundingClientRect();
          // Accept any "proceed" button: sair/leave/descartar = explicit leave buttons
          // 'continuar' = proceed in Hotmart's "continue without cover" type dialogs
          return r.width > 0 && (t.includes('sair') || t.includes('leave') || t.includes('descartar') || t.includes('discard') || t.includes('continuar mesmo') || t === 'continuar');
        });
        if (found) {
          const r = found.getBoundingClientRect();
          return {x: r.left+r.width/2, y: r.top+r.height/2, text: found.textContent.trim().slice(0,30)};
        }
        // Fallback: primary/danger button (the proceed one)
        const primary = btns.find(b => {
          const cls = (b.className||'').toLowerCase();
          const r = b.getBoundingClientRect();
          return r.width > 0 && (cls.includes('primary') || cls.includes('danger'));
        });
        if (primary) {
          const r = primary.getBoundingClientRect();
          return {x: r.left+r.width/2, y: r.top+r.height/2, text: 'primary:'+primary.textContent.trim().slice(0,30)};
        }
        // Recurse into shadow roots of child elements
        const all = Array.from(root.querySelectorAll('*'));
        for (const el of all) {
          if (el.shadowRoot) {
            const r = findLeaveBtn(el.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      }

      const modal = document.querySelector('hot-modal.confirmation-modal, hot-modal[class*=confirm], hot-modal[open]');
      if (!modal) return null;
      // Accept any confirmation modal — the content filter was too restrictive
      // (Hotmart shows different modal texts for different scenarios)
      // 1. Search hot-modal-footer shadow root (most likely location)
      const footer = modal.querySelector('hot-modal-footer');
      if (footer && footer.shadowRoot) {
        const r = findLeaveBtn(footer.shadowRoot);
        if (r) return r;
      }
      // 2. Search hot-modal shadow root
      if (modal.shadowRoot) {
        const r = findLeaveBtn(modal.shadowRoot);
        if (r) return r;
      }
      // 3. Search modal light DOM
      const r = findLeaveBtn(modal);
      if (r) return r;
      // 4. Last resort: return visible buttons inside the modal + page for debugging
      const modalBtns = Array.from(modal.querySelectorAll('button')).filter(b=>b.getBoundingClientRect().width>0).map(b=>b.textContent.trim().slice(0,20));
      const pageBtns = Array.from(document.querySelectorAll('button')).filter(b=>b.getBoundingClientRect().width>0).map(b=>b.textContent.trim().slice(0,20));
      return {x: 0, y: 0, text: 'no-btn-modal:'+modalBtns.join('|')+'|page:'+pageBtns.join('|').slice(0,200)};
    }).catch(() => null);

    if (!btnPos) { return null; } // no modal visible
    if (btnPos.x > 0 && btnPos.y > 0) {
      await page.mouse.click(btnPos.x, btnPos.y);
      log.info('[' + label + '] Modal leave btn clicked: ' + btnPos.text + ' @(' + Math.round(btnPos.x) + ',' + Math.round(btnPos.y) + ')');
      return 'clicked:' + btnPos.text;
    }
    // No "Sair/leave" button found in modal shadow DOM — this is likely a category dropdown
    // or file panel (not an "unsaved data" confirmation). Press Escape to close it.
    log.warn('[' + label + '] modal-no-shadow-btn (likely category/file panel) — pressing Escape');
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 600));
    return 'escape-modal';
  };

  // Immediate check after Continuar clicks
  const modalResult1 = await dismissConfirmModal('post-continuar');
  if (modalResult1) await sleep(2000);

  // Check for inline validation errors (e.g., duplicate title) — log them
  const validationErrors = await page.evaluate(()=>{
    const errors = Array.from(document.querySelectorAll(
      '[class*="error" i], [class*="invalid" i], [aria-invalid="true"], [class*="alert" i]'
    )).filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map(e => (e.textContent||'').trim().slice(0,80)).filter(Boolean);
    return errors.slice(0, 5);
  }).catch(()=>[]);
  if (validationErrors.length > 0) log.warn('Validation errors on /info: ' + JSON.stringify(validationErrors));

  // If required-field validation fires AND we have a cover — try wizard cover upload to satisfy it
  if (validationErrors.some(e => /obrigat|required|campo/i.test(e)) && ebook.coverPath && fs.existsSync(ebook.coverPath)) {
    log.info('Validation: required field — attempting wizard cover upload to satisfy validator...');
    try {
      // Expose hidden file input via shadow DOM trick
      const handle = await page.evaluateHandle(() => {
        function findFileInput(root) {
          if (!root) return null;
          const inputs = Array.from(root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : []);
          if (inputs.length) {
            inputs[0].style.cssText = 'display:block!important;visibility:visible!important;opacity:1!important;position:fixed!important;top:0;left:0;width:200px;height:60px;z-index:9999;';
            return inputs[0];
          }
          const all = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
          for (const el of all) { if (el.shadowRoot) { const r = findFileInput(el.shadowRoot); if (r) return r; } }
          return null;
        }
        return findFileInput(document);
      }).catch(() => null);
      const el = handle && (handle.asElement ? handle.asElement() : null);
      if (el) {
        await el.uploadFile(ebook.coverPath);
        log.info('Wizard cover uploaded via shadow file input — waiting 20s...');
        await sleep(20000);
      } else {
        // FileChooser approach
        const fcPromise = page.waitForFileChooser({ timeout: 6000 });
        await page.evaluate(() => {
          const btn = document.querySelector('#input-file-cover, [id*="cover" i][id*="input" i], button[id*="cover" i]');
          if (btn) btn.click();
        });
        const chooser = await fcPromise;
        await chooser.accept([ebook.coverPath]);
        log.info('Wizard cover uploaded via file chooser — waiting 20s...');
        await sleep(20000);
      }
      // Retry Continuar after cover upload
      const retryPos2 = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(b => /continuar/i.test((b.textContent||'').trim()));
        if (b) { const r = b.getBoundingClientRect(); return r.width > 0 ? {x:r.left+r.width/2, y:r.top+r.height/2} : null; }
        return null;
      }).catch(() => null);
      if (retryPos2) {
        log.info('Retrying Continuar after cover upload...');
        await page.mouse.click(retryPos2.x, retryPos2.y);
        await sleep(5000);
      }
    } catch(e) {
      log.warn('Wizard cover upload attempt failed: ' + e.message.slice(0, 100));
    }
  }

  // Wait for pricing step to appear (URL may stay /4/info — detect by pricing UI appearing)
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const u = page.url();
    const pm = u.match(/\/products\/manage\/(\d+)/);
    if (pm) capturedNumericId = capturedNumericId || pm[1];
    if (u.includes('/4/pricing') || u.includes('/pricing') || pm) {
      log.info('Pricing/manage URL t='+(i+1)+'s: '+u.slice(0,80));
      break;
    }
    // ALSO break if pricing UI is visible (currency dropdown or "Precificação" heading)
    // Hotmart SPA sometimes stays at /4/info URL while rendering the pricing step
    const pricingVisible = await page.evaluate(() => {
      const hasCurrencyDropdown = !!(
        document.querySelector('hot-select#currency') ||
        document.querySelector('[placeholder*="moeda" i]') ||
        document.querySelector('[placeholder*="Moeda"]')
      );
      const hasPricingHeading = Array.from(document.querySelectorAll('h1, h2, h3, [class*="title"]'))
        .some(el => (el.textContent || '').trim().toLowerCase().includes('precifica'));
      return hasCurrencyDropdown || hasPricingHeading;
    }).catch(() => false);
    if (pricingVisible) {
      log.info('Pricing UI detected at t='+(i+1)+'s — breaking wait loop');
      break;
    }
    // Check for REAL confirmation modal (only if it contains "dados não foram salvos" text)
    const hasRealModal = await page.evaluate(() => {
      const modal = document.querySelector('hot-modal.confirmation-modal, hot-modal[class*="confirm"]');
      if (!modal) return false;
      const txt = (modal.textContent || '').toLowerCase();
      return txt.includes('não foram salvos') || txt.includes('dados não') || txt.includes('sair') || txt.includes('leave');
    }).catch(() => false);
    if (hasRealModal) {
      await dismissConfirmModal('wait-loop-t' + (i+1));
    }

    // If still on /info after 10s, try clicking Continuar again
    if (i === 9 && u.includes('/4/info')) {
      log.warn('Still on /info after 10s — retrying Continuar...');
      const retryPos = await page.evaluate(()=>{
        const b = Array.from(document.querySelectorAll('button')).find(b => {
          const t = (b.textContent||'').trim().toLowerCase();
          return t === 'continuar' || t.includes('continu');
        });
        if (b) { b.scrollIntoView({behavior:'instant',block:'center'}); const r=b.getBoundingClientRect(); return r.width>0?{x:r.left+r.width/2,y:r.top+r.height/2}:null; }
        return null;
      }).catch(()=>null);
      if (retryPos) { await page.mouse.click(retryPos.x, retryPos.y); log.info('Continuar retry (trusted)'); }
    }
  }

  // If still stuck on /info after full loop — force navigate to /4/pricing
  if (page.url().includes('/4/info') && !capturedNumericId) {
    log.warn('Still on /info after full loop — forcing navigation to /4/pricing...');
    await page.goto('https://app.hotmart.com/products/add/4/pricing', {waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    await sleep(3000);
    const afterForce = page.url();
    log.info('After forced /4/pricing nav: ' + afterForce.slice(0,80));
    const pm2 = afterForce.match(/\/products\/manage\/(\d+)/);
    if (pm2) capturedNumericId = capturedNumericId || pm2[1];
    // Check if a CDP response already captured an ID
    if (!capturedNumericId) {
      const pm3 = afterForce.match(/\/4\/club\/(\d+)/);
      if (pm3) capturedNumericId = capturedNumericId || pm3[1];
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
    // 3. All visible inputs as last resort — skip name/title/text-type inputs that are clearly not price
    const SKIP_NAMES = new Set(['name', 'title', 'nome', 'titulo', 'subject', 'description', 'desc', 'search']);
    const allInputs = Array.from(document.querySelectorAll('input')).map(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height <= 5) return null;
      const n = (el.getAttribute('name') || el.name || '').toLowerCase();
      if (SKIP_NAMES.has(n)) return null; // skip clearly non-price inputs
      if (el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio') return null;
      return { x: r.left+r.width/2, y: r.top+r.height/2, tag: el.tagName, name: el.getAttribute('name')||el.name||el.id||'', type: el.type, source: 'all' };
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
             t.includes('continuar') ||
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
  log.info('createProduct done: numericId=' + capturedNumericId + ' category=' + category + ' wizardCover=' + wizardCoverUploaded);
  return { numericId: capturedNumericId, category, wizardCoverUploaded };
}

async function uploadCoverImage(page, numericId, coverPath) {
  if (!coverPath || !fs.existsSync(coverPath)) { log.warn('No cover image at: '+coverPath); return false; }
  log.info('Uploading cover to product '+numericId+'...');
  try {
    // ── CDP: capture exact headers from any SPA cover upload that succeeds ──────────────────
    // If the SPA manages to upload on its own (e.g. after a wizard step), this records the
    // auth headers so the API fallback can replay them with our file.
    let _coverCdp = null;
    let _capturedSpaRequest = null; // { url, headers } from a successful SPA cover POST
    let _coverApiSuccessViaCdp = false; // true when CDP sees 200 on cover endpoint
    try {
      _coverCdp = await page.createCDPSession();
      await _coverCdp.send('Network.enable');
      _coverCdp.on('Network.requestWillBeSent', (evt) => {
        const u = evt.request.url, m = evt.request.method;
        if (m !== 'GET' && !u.startsWith('data:') && (u.includes('cover') || u.includes('thumbnail') || u.includes('upload') || u.includes('media'))) {
          log.info('🔍 COVER_API_INTERCEPT: ' + m + ' ' + u.slice(0, 150));
          // Capture auth headers from the first non-GET upload request
          if (!_capturedSpaRequest && m === 'POST' && u.includes('cover')) {
            _capturedSpaRequest = { url: u, headers: evt.request.headers || {} };
            log.info('🔍 COVER_API_HEADERS: ' + JSON.stringify(Object.keys(_capturedSpaRequest.headers)));
          }
        }
      });
      _coverCdp.on('Network.responseReceived', async(evt) => {
        const u = evt.response.url, m = evt.response.status;
        if ([200,201,204].includes(m) && !u.startsWith('data:') && (u.includes('cover') || u.includes('thumbnail') || u.includes('upload') || u.includes('media'))) {
          log.info('🔍 COVER_API_RESPONSE OK: ' + m + ' ' + u.slice(0, 150));
          // Mark success via CDP — used as fallback when page.evaluate context is destroyed
          if (u.includes('cover')) _coverApiSuccessViaCdp = true;
          try {
            const rb = await _coverCdp.send('Network.getResponseBody', {requestId: evt.requestId}).catch(()=>null);
            if (rb && rb.body) log.info('🔍 COVER_API_BODY: ' + rb.body.slice(0, 200));
          } catch(_) {}
        }
      });
    } catch(e) { log.warn('Cover CDP setup failed: ' + e.message.slice(0,50)); }

    // ── Helper: find and return coordinates of the visible upload button/area ──────────────
    async function findUploadAreaPos() {
      return page.evaluate(() => {
        const known = document.querySelector('#input-file-cover');
        if (known) { known.scrollIntoView({behavior:'instant',block:'center'}); const r=known.getBoundingClientRect(); if(r.width>0) return {x:r.left+r.width/2, y:r.top+r.height/2, src:'#input-file-cover'}; }
        const byId = document.querySelector('[id*="cover" i], [id*="imagem" i], [id*="thumbnail" i]');
        if (byId) { byId.scrollIntoView({behavior:'instant',block:'center'}); const r=byId.getBoundingClientRect(); if(r.width>0) return {x:r.left+r.width/2, y:r.top+r.height/2, src:'id:'+byId.id}; }
        const classSels = ['[class*="upload-image"]','[class*="image-upload"]','[class*="upload"][class*="cover"]','[class*="cover"][class*="upload"]'];
        for (const sel of classSels) { const el=document.querySelector(sel); if(el) { el.scrollIntoView({behavior:'instant',block:'center'}); const r=el.getBoundingClientRect(); if(r.width>0) return {x:r.left+r.width/2, y:r.top+r.height/2, src:sel}; } }
        // Try shadow DOM — look for any visible upload-like element inside shadow roots
        function findInShadow(root) {
          if (!root) return null;
          const all = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
          for (const el of all) {
            const t = (el.textContent||'').toLowerCase().trim();
            const r = el.getBoundingClientRect();
            if (r.width > 0 && (t.includes('imagem')||t.includes('foto')||t.includes('capa')||t.includes('selecione um arquivo')||t.includes('cover')||t.includes('upload'))) {
              return {x:r.left+r.width/2, y:r.top+r.height/2, src:'shadow:'+el.tagName+':'+t.slice(0,20)};
            }
            if (el.shadowRoot) { const found = findInShadow(el.shadowRoot); if (found) return found; }
          }
          return null;
        }
        const shadowResult = findInShadow(document);
        if (shadowResult) return shadowResult;
        const btn = Array.from(document.querySelectorAll('button,[role="button"],label')).find(b => {
          const t=(b.textContent||'').toLowerCase(); const r=b.getBoundingClientRect();
          return r.width>0 && (t.includes('imagem')||t.includes('foto')||t.includes('capa')||t.includes('selecione um arquivo')||t.includes('cover'));
        });
        if (btn) { btn.scrollIntoView({behavior:'instant',block:'center'}); const r=btn.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, src:'btn:'+btn.textContent.trim().slice(0,30)}; }
        return null;
      }).catch(() => null);
    }

    // ── Approach A: waitForFileChooser + click visible upload area ────────────────────────
    // This bypasses shadow DOM entirely — we intercept the native OS file dialog that the
    // upload button triggers, regardless of whether the <input type="file"> is reachable.
    async function tryFileChooser() {
      const pos = await findUploadAreaPos();
      if (!pos) { log.info('Cover: upload area not found for file chooser approach'); return false; }
      log.info('Cover upload area pos: ' + JSON.stringify(pos));

      try {
        // Register listener BEFORE the click, then click — race condition safe this way
        const chooserPromise = page.waitForFileChooser({ timeout: 12000 });
        await page.mouse.click(pos.x, pos.y);
        const fileChooser = await chooserPromise;
        await fileChooser.accept([coverPath]);
        log.info('Cover uploaded via file chooser (pos: ' + pos.src + ')');
        await sleep(4000); // wait for upload to process
        // Save after upload
        await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button')).find(b => {
            const t = b.textContent.trim().toLowerCase();
            return t === 'salvar' || t === 'save' || t === 'confirmar' || t.includes('salvar');
          });
          if (b) b.click();
        }).catch(()=>{});
        await sleep(2000);
        return true;
      } catch(e) {
        log.info('File chooser approach failed: ' + e.message.slice(0, 80));
        return false;
      }
    }

    // ── Approach B: expose file input from shadow DOM and call uploadFile ─────────────────
    async function tryShadowDomInput() {
      const shadowHandle = await page.evaluateHandle(() => {
        function findFileInput(root) {
          if (!root) return null;
          const inputs = Array.from(root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : []);
          if (inputs.length > 0) {
            inputs[0].style.cssText = 'display:block!important;visibility:visible!important;opacity:1!important;position:fixed!important;top:0;left:0;width:1px;height:1px;';
            return inputs[0];
          }
          const all = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
          for (const el of all) {
            if (el.shadowRoot) { const r = findFileInput(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        return findFileInput(document);
      }).catch(() => null);
      if (!shadowHandle) return false;
      const el = shadowHandle.asElement ? shadowHandle.asElement() : null;
      if (!el) { await shadowHandle.dispose().catch(()=>{}); return false; }
      log.info('Cover input found via shadow DOM expose');
      await el.uploadFile(coverPath);
      await sleep(4000);
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(b => {
          const t = b.textContent.trim().toLowerCase();
          return t === 'salvar' || t === 'save' || t === 'confirmar' || t.includes('salvar');
        });
        if (b) b.click();
      }).catch(()=>{});
      await sleep(2000);
      return true;
    }

    // ── Navigate to /info and wait for SPA to mount ───────────────────────────────────────
    await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',
      {waitUntil:'load', timeout:35000}).catch(()=>{});
    await sleep(4000);
    await page.screenshot({path:'/app/cover_debug_'+numericId+'.png', fullPage:false}).catch(()=>{});
    await page.evaluate(() => { window.scrollTo(0,500); window.scrollTo(0,0); }).catch(()=>{});
    await sleep(1000);
    // Expand cover section if collapsed
    await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('h2,h3,h4,button,[role="button"],[role="tab"],label,span,div'));
      const capaEl = allElements.find(el => {
        const t = (el.textContent||'').trim().toLowerCase();
        const r = el.getBoundingClientRect();
        return r.width > 0 && (t === 'capa do produto' || t === 'imagem do produto' || t === 'image' || (t.includes('capa') && t.length < 30));
      });
      if (capaEl) { capaEl.scrollIntoView({behavior:'instant',block:'center'}); capaEl.click(); }
    }).catch(()=>{});
    await sleep(1500);

    // Try approach A (file chooser) — works even with deep shadow DOM
    if (await tryFileChooser()) { if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }

    // Try approach B (shadow DOM input expose) — last-resort DOM approach
    if (await tryShadowDomInput()) { if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }

    // Re-navigate (not reload — reload triggers OAM redirect to home) — SPA can take >45s to mount on slow VPS
    log.info('Cover: re-navigating to /info to help SPA mount...');
    await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',
      {waitUntil:'domcontentloaded', timeout:20000}).catch(()=>{});
    await sleep(3000);
    if (await tryFileChooser()) { if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }
    if (await tryShadowDomInput()) { if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }

    // Warm up via /overview → tab-click to /info as soft SPA nav, then retry
    await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/overview',
      {waitUntil:'domcontentloaded', timeout:25000}).catch(()=>{});
    await page.waitForFunction(() => document.querySelectorAll('button').length > 3, {timeout:15000}).catch(()=>{});
    await sleep(1500);
    const tabClicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button, a, [role="tab"], [href*="/info"]'));
      const infoTab = tabs.find(t => { const txt=(t.textContent||'').toLowerCase().trim(); return txt==='informações'||txt==='informacoes'||txt==='info'||txt.includes('informa'); });
      if (infoTab) { infoTab.scrollIntoView({behavior:'instant',block:'center'}); infoTab.click(); return true; }
      return false;
    });
    log.info('Informações tab clicked: ' + tabClicked);
    await sleep(3000);
    if (await tryFileChooser()) { if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }
    if (await tryShadowDomInput()) { if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }

    // Debug what we actually see
    const dbg = await page.evaluate(() => {
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(i=>({id:i.id,accept:i.accept}));
      return {url: location.href.slice(-60), fileInputs};
    }).catch(() => null);
    log.info('Cover upload DOM debug: ' + JSON.stringify(dbg));

    // ── API FALLBACK ── Direct multipart POST using the JWT from localStorage.
    // The SPA uses cookies+Bearer for auth. We try both, plus any headers captured from SPA requests.
    log.info('SPA cover input unreachable — trying direct API upload...');
    try {
      const coverBase64 = fs.readFileSync(coverPath).toString('base64');
      if (!page.url().includes('hotmart.com')) {
        await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/overview',
          {waitUntil:'domcontentloaded', timeout:15000}).catch(()=>{});
        await sleep(2000);
      }

      // Build extra headers from any SPA request we captured via CDP
      const spaHeaders = _capturedSpaRequest ? _capturedSpaRequest.headers : {};
      const capturedUrl = _capturedSpaRequest ? _capturedSpaRequest.url : null;
      if (capturedUrl) log.info('Using captured SPA url: ' + capturedUrl.slice(0, 120));

      const apiResult = await page.evaluate(async (b64, id, extraHeaders, capturedUrl) => {
        const token = localStorage.getItem('token') ||
                      localStorage.getItem('access_token') ||
                      localStorage.getItem('hotmart_token') ||
                      localStorage.getItem('@hotmart:token') ||
                      localStorage.getItem('_hotmart_token') ||
                      sessionStorage.getItem('token') ||
                      sessionStorage.getItem('access_token');
        const tokenInfo = token ? 'JWT:' + token.slice(0,20) + '...' : 'NO_TOKEN';

        const binary = atob(b64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], {type: 'image/jpeg'});

        // If CDP captured the real SPA URL, put it first
        const endpoints = [
          ...(capturedUrl ? [['POST', capturedUrl]] : []),
          ['POST', `https://api-product.vulcano.hotmart.com/product/v2/products/${id}/cover`],
          ['PUT',  `https://api-product.vulcano.hotmart.com/product/v2/products/${id}/cover`],
          ['POST', `https://api-product.vulcano.hotmart.com/product/v1/products/${id}/cover`],
          ['POST', `https://api-product.vulcano.hotmart.com/product/v2/user/product/${id}/cover`],
          ['PUT',  `https://api-product.vulcano.hotmart.com/product/v2/user/product/${id}/cover`],
          ['PATCH',`https://api-product.vulcano.hotmart.com/product/v2/products/${id}`],
        ];

        // Filter CDP-captured headers to only auth/content-type headers (drop host, content-length)
        const safeExtra = Object.fromEntries(
          Object.entries(extraHeaders||{}).filter(([k]) =>
            /^(authorization|x-hotmart|x-csrf|x-request|origin|referer)$/i.test(k)
          )
        );

        const results = [];
        for (const [method, url] of endpoints) {
          const variants = [
            { credentials: 'include', headers: { ...(token ? {'Authorization':'Bearer '+token} : {}), ...safeExtra } },
            { credentials: 'include', headers: token ? { 'Authorization': 'Bearer ' + token } : {} },
            { credentials: 'include', headers: {} },
            { credentials: 'omit',    headers: token ? { 'Authorization': 'Bearer ' + token } : {} },
          ];
          for (const variant of variants) {
            try {
              const fd = new FormData();
              fd.append('cover', blob, 'cover.jpg');
              fd.append('file',  blob, 'cover.jpg');
              const r = await fetch(url, { method, headers: variant.headers, credentials: variant.credentials, body: fd });
              const text = await r.text().catch(() => '');
              const entry = { method, url: url.slice(-60), status: r.status, body: text.slice(0, 150), creds: variant.credentials, token: tokenInfo };
              results.push(entry);
              if (r.ok || r.status === 201 || r.status === 204) return { ok: true, ...entry, results };
              if (r.status !== 401 && r.status !== 403) break;
            } catch(e) {
              results.push({ method, url: url.slice(-40), error: e.message.slice(0, 60) });
            }
          }
        }
        return { ok: false, tokenInfo, results };
      }, coverBase64, numericId, spaHeaders, capturedUrl);

      log.info('API cover result: ' + JSON.stringify({
        ok: apiResult.ok, status: apiResult.status, method: apiResult.method, url: apiResult.url,
        results: (apiResult.results||[]).map(r=>r.method+' '+r.status+' '+r.url).join(' | ')
      }).slice(0, 400));

      if (apiResult && apiResult.ok) { log.info('Cover uploaded via API!'); if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }
      // Even if page.evaluate returned ok:false, CDP may have seen 200 — trust CDP
      if (_coverApiSuccessViaCdp) { log.info('Cover uploaded via API (CDP 200 confirmed)!'); if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }
    } catch(e) {
      // "Execution context was destroyed" means a navigation fired mid-evaluate — check CDP flag
      if (_coverApiSuccessViaCdp) { log.info('Cover API 200 confirmed via CDP (context destroyed mid-eval)'); if (_coverCdp) await _coverCdp.detach().catch(()=>{}); return true; }
      log.warn('API cover upload error: ' + e.message.slice(0, 100));
    }

    log.warn('Cover upload failed — skipping (non-fatal)');
    if (_coverCdp) await _coverCdp.detach().catch(()=>{});
    return false;
  } catch(e) {
    log.warn('Cover upload error: '+e.message);
    return false;
  }
}

async function uploadPDF(page, numericId, pdfPath) {
  log.info('Uploading PDF to '+numericId);
  // Navigate to info page; Hotmart SPA may redirect via OAM — catch context destruction
  await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  // Wait for SPA to mount — allow OAM redirects to complete; body len often stays 0 due to SPA redirects
  for(let i=0;i<40;i++){
    await sleep(1000);
    const len = await page.evaluate(()=>document.body&&document.body.innerText?document.body.innerText.length:0).catch(()=>0);
    if(i%5===4) log.info('PDF-page t='+(i+1)+'s len='+len);
    if(len>=1200) break;
    // If still empty after 20s, reload and give up on waiting for full content
    if(i===19 && len===0){
      log.info('PDF-page empty after 20s — re-navigating to /info (avoid reload OAM redirect)...');
      await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',
        {waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
      await sleep(5000);
      break;
    }
  }
  // Wrap evaluate calls to avoid crash on OAM navigation
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Painel');if(b)b.click();}).catch(()=>{});
  await sleep(3000);
  let configs=[];
  for(let i=0;i<20;i++){
    await sleep(1000);
    configs=await page.evaluate(()=>Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Configurar').map(b=>{const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,vis:r.width>0};}).filter(b=>b.vis)).catch(()=>[]);
    if(configs.length>0){log.info('Configurar at t='+(i+1)+'s');break;}
  }
  if(!configs.length){log.warn('No Configurar button found');return false;}
  const cfg=configs.find(c=>c.y<700)||configs[0];
  await page.mouse.click(cfg.x,cfg.y);
  await sleep(4000);
  for(let att=0;att<3;att++){
    const inp=await page.$('input[type="file"]').catch(()=>null);
    if(inp){log.info('File input found!');await inp.uploadFile(pdfPath);await sleep(15000);return true;}
    const bi=await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['selecione','upload','enviar','arquivo','escolher'].some(k=>(b.textContent||'').toLowerCase().includes(k)));if(b){const r=b.getBoundingClientRect();return{text:b.textContent.trim(),x:r.left+r.width/2,y:r.top+r.height/2};}return null;}).catch(()=>null);
    if(bi){log.info('Clicking "'+bi.text+'"');await page.mouse.click(bi.x,bi.y);await sleep(2000);const i2=await page.$('input[type="file"]').catch(()=>null);if(i2){log.info('Input appeared!');await i2.uploadFile(pdfPath);await sleep(15000);return true;}}
    await sleep(3000);
  }
  log.warn('PDF upload failed');return false;
}

async function finalizarCadastro(page, numericId) {
  log.info('Finalizing '+numericId);
  // Go directly to /overview — that's where "Finalizar cadastro" button lives
  // (the old /info → Painel approach was unreliable for newly-created products)
  await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/overview',
    {waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await sleep(3000);
  const overviewUrl = 'https://app.hotmart.com/products/manage/'+numericId+'/overview';
  let fInfo=null;
  for(let i=0;i<90;i++){
    await sleep(1000);
    // After OAM redirects, page may land on home — re-navigate to overview
    const curUrl = page.url();
    if (curUrl === 'https://app.hotmart.com/' || curUrl.endsWith('/') && !curUrl.includes('/manage/') && !curUrl.includes('/products/')) {
      log.info('Finalizar t='+(i+1)+'s — OAM redirected to home, re-navigating to overview...');
      await page.goto(overviewUrl, {waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
      await sleep(3000);
    }
    // At t=20s, goto overview to help lazy-mounting SPA components (avoid reload which triggers OAM)
    if(i===19){
      log.info('Finalizar t=20s — re-navigating to overview to help SPA mount');
      await page.goto(overviewUrl, {waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
      await sleep(4000);
    }
    // At t=50s, navigate again if button still not enabled
    if(i===49){
      log.info('Finalizar t=50s — second navigation to overview (PDF still processing?)');
      await page.goto(overviewUrl, {waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
      await sleep(4000);
    }
    fInfo=await page.evaluate(()=>{
      // Search both light DOM and through shadow roots
      function findFinalizarBtn(root) {
        if (!root) return null;
        const btns = Array.from(root.querySelectorAll ? root.querySelectorAll('button') : []);
        const found = btns.find(b => {
          const t = (b.textContent||'').trim();
          return t === 'Finalizar cadastro' || t === 'Finalizar' || t === 'Ativar produto' || t === 'Publicar';
        });
        if (found) { const r = found.getBoundingClientRect(); if(r.width>0) return {disabled:found.disabled,x:r.left+r.width/2,y:r.top+r.height/2,text:found.textContent.trim()}; }
        const all = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
        for (const el of all) { if (el.shadowRoot) { const r = findFinalizarBtn(el.shadowRoot); if(r) return r; } }
        return null;
      }
      return findFinalizarBtn(document);
    }).catch(()=>null);
    if(fInfo && !fInfo.disabled){
      log.info('Finalizar t='+(i+1)+'s ENABLED: "'+fInfo.text+'"');
      break;
    }
    if(fInfo){ log.info('Finalizar t='+(i+1)+'s disabled — waiting for PDF processing...'); fInfo=null; }
  }
  if(!fInfo){log.warn('Finalizar not found or still disabled after 60s');return false;}
  await page.mouse.click(fInfo.x,fInfo.y);
  await sleep(5000);
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['confirmar','sim','ok','publicar','finalizar','ativar'].includes((b.textContent||'').trim().toLowerCase()));if(b)b.click();});
  await sleep(4000);
  const after=await page.evaluate(()=>document.body&&document.body.innerText?document.body.innerText.slice(0,200):'').catch(()=>'');
  log.info('After finalize: '+after.replace(/\n/g,' ').slice(0,100));
  return true;
}

// Decide se um <input type=file> pode receber o mp3 do audiobook.
//
// Errar aqui e caro: mandar audio no campo do manuscrito TROCA o e-book pelo mp3
// (foi assim que se corromperam manuscritos no KDP). Na duvida, recusa — perder o
// bonus e barato, perder o e-book nao. Pura de proposito, para ser testavel.
function aceitaAudiobook(info) {
  if (!info || info.preenchido) return false;              // ja usado por pdf/capa
  const accept = (info.accept || '').toLowerCase();
  if (accept.includes('image')) return false;              // campo de capa
  const aceitaAudio = accept.includes('audio') || accept.includes('mp3');
  if (aceitaAudio) return true;
  return accept === '';                                    // campo livre (sem accept)
}

// Sobe o audiobook como material extra do produto.
//
// Roda DEPOIS do Finalizar de proposito: o botao "Finalizar cadastro" so habilita
// quando a Hotmart termina de processar o arquivo enviado, entao mandar o mp3 antes
// so faria o gate esperar mais (o uploadPDF ja custa ate 60s de espera ali).
//
// Mesma trava do Cakto: NUNCA reusar o input do PDF/capa. Mandar mp3 no campo do
// manuscrito troca o e-book pelo audio — foi assim que se corromperam manuscritos
// no KDP. So aceita input VAZIO que nao seja exclusivo de imagem ou de PDF.
async function uploadAudiobook(page, numericId, audiobookPath) {
  log.info('Uploading audiobook to ' + numericId);
  await page.goto('https://app.hotmart.com/products/manage/' + numericId + '/info',
    { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(5000);

  // Abre o painel de conteudo (mesmo caminho do PDF: Painel -> Configurar)
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Painel');
    if (b) b.click();
  }).catch(() => {});
  await sleep(3000);

  let configs = [];
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    configs = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
      .filter(b => b.textContent.trim() === 'Configurar')
      .map(b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vis: r.width > 0 }; })
      .filter(b => b.vis)).catch(() => []);
    if (configs.length) break;
  }
  if (!configs.length) { log.info('Audiobook: painel de conteudo indisponivel — e-book segue normalmente'); return false; }
  await page.mouse.click((configs.find(c => c.y < 700) || configs[0]).x, (configs.find(c => c.y < 700) || configs[0]).y);
  await sleep(4000);

  // Tenta revelar um campo novo (o do PDF ja esta ocupado)
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, [role="button"], label'))
      .find(e => {
        const t = (e.textContent || '').toLowerCase();
        return (t.includes('adicionar arquivo') || t.includes('novo arquivo') || t.includes('adicionar material') ||
                t.includes('bônus') || t.includes('bonus') || t.includes('anexo') || t.includes('audio')) &&
               e.getBoundingClientRect().width > 0;
      });
    if (el) el.click();
  }).catch(() => {});
  await sleep(1500);

  const inputs = await page.$$('input[type="file"]');
  for (const inp of inputs) {
    const info = await inp.evaluate(el => ({
      accept: (el.accept || '').toLowerCase(),
      preenchido: !!(el.files && el.files.length),
    })).catch(() => null);
    if (!aceitaAudiobook(info)) continue;

    await inp.uploadFile(audiobookPath);
    log.info('Audiobook upload disparado');
    await sleep(12000);
    return true;
  }

  log.info('Audiobook: sem campo livre nesta etapa — e-book segue normalmente');
  return false;
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

// Pergunta ao proprio CAS da Hotmart se o TGT da sessao ainda vale.
//
// POR QUE: quando o TGT (48h, fixo) morre, todo publish entra no fluxo caro —
// sobe o Chromium, navega, espera 90s por um wizard que NUNCA vai renderizar
// (a URL vira sso.hotmart.com/login) e so entao falha. Medido em producao
// (10/08/2026): 3-4 min desperdicados POR CICLO, ~40% de um ciclo de 8 min,
// numa tentativa que nao tinha como dar certo. Esse tempo sai do Cakto, que
// esta publicando normalmente.
//
// Uma chamada HTTPS de ~1s responde a mesma pergunta. Retorna:
//   true  = sessao viva      false = morta (exige login humano)
//   null  = indeterminado    -> NUNCA bloquear nesse caso (ver chamador)
const TGT_CACHE_MS = 5 * 60 * 1000;
let _tgtCache = { em: 0, valor: null };

async function sessaoHotmartViva() {
  if (Date.now() - _tgtCache.em < TGT_CACHE_MS) return _tgtCache.valor;
  let resultado = null;
  try {
    const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const c = (sess.cookies || []).find(x => x.name === 'hmSsoExp');
    if (!c) return (_tgtCache = { em: Date.now(), valor: false }).valor;
    const tgt = String(c.value).split('|').slice(1).join('|');

    const svc = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize'
      + '?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d'
      + '&scope=openid+profile+authorities+email+user+address'
      + '&redirect_uri=' + encodeURIComponent('https://app.hotmart.com/auth/login?realm=hotmart&branding_id=bw')
      + '&response_type=code&response_mode=query&state=chk&client_name=CasOAuthClient';
    const body = 'service=' + encodeURIComponent(svc);

    resultado = await new Promise(resolve => {
      const req = https.request({
        hostname: 'sso.hotmart.com',
        path: '/v1/tickets/' + encodeURIComponent(tgt),
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      }, res => {
        let d = '';
        res.on('data', x => d += x);
        res.on('end', () => {
          if (res.statusCode === 200 && d.startsWith('ST-')) resolve(true);
          else if (res.statusCode === 404 || /invalid|could not be found/i.test(d)) resolve(false);
          else resolve(null);                       // resposta inesperada: nao arrisca
        });
      });
      // Rede instavel NAO pode virar "sessao morta": bloquear um publisher que
      // funciona e pior do que desperdicar um ciclo.
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  } catch { resultado = null; }
  _tgtCache = { em: Date.now(), valor: resultado };
  return resultado;
}

async function publishToHotmart(ebook) {
  const { title, topic, pdfPath, coverPath, description, audiobookPath } = ebook;
  if(!fs.existsSync(SESSION_FILE)) throw new Error('Session not found: '+SESSION_FILE);

  // Fast-fail: so aborta quando o CAS respondeu explicitamente que o TGT morreu.
  // `null` (indeterminado) segue o fluxo normal de proposito.
  const viva = await sessaoHotmartViva();
  if (viva === false) {
    log.warn('Sessao Hotmart EXPIRADA (TGT invalido no CAS) — pulando sem gastar o ciclo. Exige login humano.');
    return { success:false, platform:'hotmart', error:'SESSAO_EXPIRADA_LOGIN_HUMANO',
             hotmartProductId:null, url:null, needsHumanLogin:true };
  }
  if(!pdfPath||!fs.existsSync(pdfPath)) throw new Error('PDF not found: '+pdfPath);
  const session=JSON.parse(fs.readFileSync(SESSION_FILE,'utf8'));
  const browser=await puppeteer.launch({
    headless:true, executablePath:process.env.CHROME_EXECUTABLE||process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',
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
    // Step 1: Create product (wizard + pricing) — OR resume from existing if we have a product ID
    // An ebook can have a hotmartProductId but no hotmartUrl when: product was created but Finalizar
    // failed (e.g. PDF processing took too long). In that case, skip creation and resume.
    let numericId, category, wizardCoverUploaded;
    const existingId = ebook.hotmartProductId || null;
    if (existingId && /^\d+$/.test(String(existingId))) {
      log.info('Resuming existing product ' + existingId + ' (was created but not finalized)');
      numericId = String(existingId);
      category = ebook.category || 'Outros';
      wizardCoverUploaded = false;
    } else {
      const created = await createProduct(page,session,{title,topic,description,coverPath,pdfPath});
      numericId = created.numericId; category = created.category; wizardCoverUploaded = created.wizardCoverUploaded;
      if(!numericId || !/^\d+$/.test(String(numericId))) throw new Error('No product ID after creation (got: '+numericId+')');
    }
    // Step 2: Upload cover image (skip if already done during wizard)
    let coverUploaded = wizardCoverUploaded || false;
    if (!coverUploaded) {
      coverUploaded = await uploadCoverImage(page, numericId, coverPath);
    } else {
      log.info('Cover already uploaded during wizard — skipping post-creation upload');
    }
    log.info('Cover uploaded: '+coverUploaded);
    // Step 3: Upload PDF content (non-fatal — context-destroyed errors during OAM redirects)
    const uploaded=await uploadPDF(page,numericId,pdfPath).catch(e=>{
      log.warn('PDF upload exception (non-fatal): '+e.message.slice(0,100));
      return false;
    });
    if(!uploaded) log.warn('PDF upload failed — continuing to finalize');
    // Step 4: Finalizar cadastro
    const finalized=await finalizarCadastro(page,numericId);
    // Step 4b: Retry cover upload after finalization (product has been live for 60-120s now)
    if (!coverUploaded && finalized && coverPath && fs.existsSync(coverPath)) {
      log.info('Cover not uploaded yet — retrying after finalization...');
      coverUploaded = await uploadCoverImage(page, numericId, coverPath);
      log.info('Cover retry after finalize: '+coverUploaded);
    }
    // Step 4c: Audiobook como material extra (nao critico — o e-book vale mais que o bonus)
    let audiobookUploaded = false;
    if (audiobookPath && fs.existsSync(audiobookPath)) {
      audiobookUploaded = await uploadAudiobook(page, numericId, audiobookPath).catch(e => {
        log.warn('Audiobook upload falhou (nao critico): ' + e.message.slice(0, 100));
        return false;
      });
      log.info('Audiobook uploaded: ' + audiobookUploaded);
    }
    // Step 5: Screenshot
    const screenshot=await screenshotLandingPage(page,numericId,title);
    await browser.close();
    log.info('Done: "'+title+'" id='+numericId+' finalized='+finalized+' cover='+coverUploaded);
    // Only return url if finalized — if not finalized, product is in draft and cannot be purchased.
    // Returning url=null when not finalized ensures autonomousAgent retries finalization next cycle.
    return{success:finalized,hotmartProductId:numericId,url:finalized?'https://hotmart.com/product/'+numericId:null,screenshot,category,platform:'hotmart',uploaded,coverUploaded,audiobookUploaded};
  }catch(err){
    await browser.close().catch(()=>{});
    log.error('publishToHotmart error: '+err.message);
    throw err;
  }
}

module.exports = { publishToHotmart, getCategory: getCategoryPT, aceitaAudiobook, sessaoHotmartViva };
