/**
 * setup-sessions.js — Login manual e salvar sessão
 * Uso: node scripts/setup-sessions.js [hotmart|cakto|amazon]
 *
 * Requer: ambiente com display (DISPLAY=:99 com Xvfb, ou rodar localmente)
 * Se no VPS: DISPLAY=:99 xvfb-run node scripts/setup-sessions.js cakto
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, '../data/sessions');
const platform = (process.argv[2] || 'hotmart').toLowerCase();

const PLATFORMS = {
  hotmart: { url: 'https://app.hotmart.com', name: 'Hotmart' },
  cakto:   { url: 'https://app.cakto.com.br', name: 'Cakto' },
  amazon:  { url: 'https://kdp.amazon.com', name: 'Amazon KDP' },
};

async function waitForEnter(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => { rl.question(msg, () => { rl.close(); resolve(); }); });
}

async function saveSession(page, platform) {
  const outPath = path.join(SESSIONS_DIR, platform+'.json');
  fs.mkdirSync(SESSIONS_DIR, {recursive:true});

  const cookies = await page.cookies();
  let localStorage = {};
  let sessionStorage = {};
  try {
    localStorage = await page.evaluate(()=>{
      const obj={};
      for(let i=0;i<window.localStorage.length;i++){const k=window.localStorage.key(i);obj[k]=window.localStorage.getItem(k);}
      return obj;
    });
  } catch {}
  try {
    sessionStorage = await page.evaluate(()=>{
      const obj={};
      for(let i=0;i<window.sessionStorage.length;i++){const k=window.sessionStorage.key(i);obj[k]=window.sessionStorage.getItem(k);}
      return obj;
    });
  } catch {}

  const data = { platform, savedAt: Date.now(), url: page.url(), cookies, localStorage, sessionStorage };
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log('Session saved: '+outPath);
  console.log('   Cookies: '+cookies.length+' | localStorage: '+Object.keys(localStorage).length+' keys');
  return outPath;
}

(async () => {
  const cfg = PLATFORMS[platform];
  if (!cfg) {
    console.error('Platform não reconhecida. Use: hotmart, cakto, amazon');
    process.exit(1);
  }

  console.log('');
  console.log('=== Setup de Sessão: '+cfg.name+' ===');
  console.log('');
  console.log('Abrindo browser para login manual...');
  console.log('Faça login em '+cfg.url);
  console.log('Quando terminar, pressione ENTER aqui para salvar a sessão.');
  console.log('');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox','--disable-setuid-sandbox','--start-maximized'],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.goto(cfg.url, {waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});

  await waitForEnter('Pressione ENTER após fazer login em '+cfg.name+'...');

  await saveSession(page, platform);
  await browser.close();
  console.log('Pronto! Reinicie o container para usar a nova sessão.');
})().catch(e=>{ console.error('FATAL:', e.message); process.exit(1); });
