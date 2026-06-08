'use strict';
// regrab_full_cookies.js — re-exporta sessao do Chrome aberto capturando TODOS os cookies
// (inclui dominio do SSO via CDP Network.getAllCookies) e testa login headless na hora.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '9223';
const SESSIONS = path.join(__dirname, 'data/sessions');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
function log(m){ console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${m}`); }

const PLATFORMS = {
  hotmart: { home: 'https://app.hotmart.com/market', domains: /hotmart\.com$/i, test: 'https://app.hotmart.com/market', okSel: 'a[href*="/market/details"], .product-card' },
  cakto:   { home: 'https://app.cakto.com.br/dashboard/showcase', domains: /cakto\.com\.br$/i, test: 'https://app.cakto.com.br/dashboard/showcase', okSel: '.MuiCard-root' },
};

async function regrab(browser, name){
  const cfg = PLATFORMS[name];
  log(`\n===== ${name.toUpperCase()} =====`);
  const page = await browser.newPage();
  await page.goto(cfg.home, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(()=>{});
  await sleep(4000);
  if(/\/login|\/auth|sso\./i.test(page.url())){ log(`[${name}] NAO logado no Chrome (${page.url().slice(0,60)}) — pulando`); return false; }

  // TODOS os cookies do browser via CDP, filtrados pelo dominio da plataforma
  const client = await page.target().createCDPSession();
  const { cookies: allCookies } = await client.send('Network.getAllCookies');
  const cookies = allCookies.filter(c => cfg.domains.test((c.domain||'').replace(/^\./,'')));
  let localStorage = {};
  try { localStorage = await page.evaluate(()=>{const o={};for(let i=0;i<window.localStorage.length;i++){const k=window.localStorage.key(i);o[k]=window.localStorage.getItem(k);}return o;}); } catch(_){}
  fs.mkdirSync(SESSIONS,{recursive:true});
  fs.writeFileSync(path.join(SESSIONS,name+'.json'), JSON.stringify({platform:name,savedAt:Date.now(),savedAtHuman:new Date().toLocaleString('pt-BR'),url:page.url(),cookies,localStorage},null,2));
  const domains=[...new Set(cookies.map(c=>c.domain))];
  log(`[${name}] salvo: ${cookies.length} cookies / ${Object.keys(localStorage).length} localStorage`);
  log(`[${name}] dominios: ${domains.join(', ')}`);
  return true;
}

// testa a sessao salva num browser headless ISOLADO (simula VPS)
async function testHeadless(name){
  const cfg = PLATFORMS[name];
  const s = JSON.parse(fs.readFileSync(path.join(SESSIONS,name+'.json'),'utf8'));
  const b = await puppeteer.launch({headless:'new',executablePath:CHROME,args:['--no-sandbox','--disable-blink-features=AutomationControlled']});
  try {
    const p = await b.newPage();
    await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await p.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
    if(s.localStorage)await p.evaluateOnNewDocument(ls=>{Object.entries(ls).forEach(([k,v])=>{try{localStorage.setItem(k,v)}catch{}})},s.localStorage);
    // injeta cookies via CDP (preserva httpOnly/secure/domain corretamente)
    const client = await p.target().createCDPSession();
    await client.send('Network.setCookies',{cookies:s.cookies.map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,secure:c.secure,httpOnly:c.httpOnly,sameSite:['Strict','Lax','None'].includes(c.sameSite)?c.sameSite:undefined,expires:c.expires&&c.expires>0?c.expires:undefined}))});
    await p.goto(cfg.test,{waitUntil:'domcontentloaded',timeout:40000}).catch(()=>{});
    await sleep(6000);
    const url=p.url();
    const okEl=await p.waitForSelector(cfg.okSel,{timeout:15000}).then(()=>true).catch(()=>false);
    const n=await p.evaluate(sel=>document.querySelectorAll(sel).length, cfg.okSel).catch(()=>0);
    const loggedOut=/\/login|\/auth|sso\./i.test(url);
    log(`[${name}] HEADLESS TEST: url=${url.slice(0,55)} ${loggedOut?'[DESLOGADO]':'[LOGADO]'} elementos=${n}`);
    return !loggedOut && n>0;
  } finally { await b.close().catch(()=>{}); }
}

(async()=>{
  const browser = await puppeteer.connect({ browserURL:`http://localhost:${PORT}`, defaultViewport:null });
  log('conectado ao Chrome aberto.');
  for(const name of ['hotmart','cakto']){
    const ok = await regrab(browser, name);
    if(ok){ const headlessOk = await testHeadless(name); log(`[${name}] => headless ${headlessOk?'FUNCIONA ✅':'FALHOU ❌'}`); }
  }
  browser.disconnect();
  log('\nDONE'); process.exit(0);
})().catch(e=>{log('FATAL '+e.message);process.exit(1);});
