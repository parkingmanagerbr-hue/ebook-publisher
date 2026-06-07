'use strict';
/**
 * captureSessionsFromChrome.js — Captura sessões do Hotmart e Cakto
 * usando o perfil REAL do Chrome do usuário (já logado).
 * Fecha o Chrome antes de rodar se estiver aberto!
 *
 * Uso: node scripts/captureSessionsFromChrome.js
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const puppeteer = require('puppeteer');
const fs        = require('fs');

const BASE        = path.join(__dirname, '..');
const SESSION_DIR = path.join(BASE, 'data', 'sessions');
const CHROME      = process.env.CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Perfil real do Chrome — já tem as sessões salvas do usuário
const CHROME_PROFILE = 'C:/Users/m_rov/AppData/Local/Google/Chrome/User Data';

fs.mkdirSync(SESSION_DIR, { recursive: true });

const LOG = path.join(BASE, 'logs', 'captureSessionsFromChrome.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const ls = fs.createWriteStream(LOG, { flags: 'a' });
function log(msg) { const l = `[${new Date().toISOString()}] ${msg}`; console.log(l); ls.write(l + '\n'); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function captureSession(browser, url, platform) {
  log(`[${platform}] Navegando para ${url}...`);
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log(`[${platform}] Nav: ${e.message.slice(0,60)}`));
    await sleep(4000);
    const finalUrl = page.url();
    log(`[${platform}] URL final: ${finalUrl.slice(0, 100)}`);

    const cookies = await page.cookies();
    const localSt = await page.evaluate(() => {
      const o = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        o[k] = localStorage.getItem(k);
      }
      return o;
    }).catch(() => ({}));

    const jwt = localSt.token || null;
    log(`[${platform}] Cookies: ${cookies.length} | JWT: ${jwt ? 'OK' : 'missing'}`);

    // Check if actually logged in
    const onLogin = finalUrl.includes('/login') || finalUrl.includes('/auth') || finalUrl.includes('sso.hotmart.com/login');
    if (onLogin && cookies.length < 3) {
      log(`[${platform}] ⚠️  Página de login detectada — aguardando login manual (90s)...`);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const u = page.url();
        log(`[${platform}] Aguardando... ${u.slice(0, 60)}`);
        if (!u.includes('/login') && !u.includes('/auth') && !u.includes('sso.hotmart.com/login')) {
          log(`[${platform}] Login detectado!`);
          break;
        }
      }
      // Re-capture after login
      const cookies2 = await page.cookies();
      const localSt2 = await page.evaluate(() => { const o={}; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);o[k]=localStorage.getItem(k);} return o; }).catch(()=>({}));
      const session2 = { platform, savedAt: Date.now(), savedAtHuman: new Date().toLocaleString('pt-BR'), url: page.url(), cookies: cookies2, localStorage: localSt2 };
      fs.writeFileSync(path.join(SESSION_DIR, `${platform}.json`), JSON.stringify(session2, null, 2));
      log(`[${platform}] ✅ Sessão salva: ${cookies2.length} cookies`);
      return true;
    }

    const session = { platform, savedAt: Date.now(), savedAtHuman: new Date().toLocaleString('pt-BR'), url: finalUrl, cookies, localStorage: localSt };
    fs.writeFileSync(path.join(SESSION_DIR, `${platform}.json`), JSON.stringify(session, null, 2));
    log(`[${platform}] ✅ Sessão salva: ${cookies.length} cookies → ${path.join(SESSION_DIR, platform + '.json')}`);
    return true;
  } catch(e) {
    log(`[${platform}] ❌ Erro: ${e.message}`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  log('=== Capturando sessões do Chrome real ===');
  log(`Perfil: ${CHROME_PROFILE}`);

  // Check if Chrome profile exists
  if (!fs.existsSync(CHROME_PROFILE)) {
    log(`⚠️  Perfil não encontrado: ${CHROME_PROFILE}`);
    log('Usando perfil temporário — faça login manualmente nas janelas que abrirem');
  }

  // Launch Chrome with real user profile
  // NOTE: Chrome must be closed first for userDataDir to work!
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.existsSync(CHROME_PROFILE) ? CHROME_PROFILE : undefined,
    args: [
      '--no-sandbox',
      '--start-maximized',
      '--ignore-certificate-errors',
      '--profile-directory=Default',
    ],
    defaultViewport: null,
  }).catch(async (e) => {
    log(`⚠️  Não conseguiu usar perfil real (Chrome aberto?): ${e.message.slice(0,80)}`);
    log('Abrindo com perfil temporário...');
    return puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      args: ['--no-sandbox', '--start-maximized', '--ignore-certificate-errors'],
      defaultViewport: null,
    });
  });

  // Capture Hotmart
  const hmOk    = await captureSession(browser, 'https://app.hotmart.com', 'hotmart');
  // Capture Cakto
  const caktoOk = await captureSession(browser, 'https://app.cakto.com.br/dashboard/home', 'cakto');

  log('\n=== RESULTADO ===');
  log(`Hotmart: ${hmOk    ? '✅ Sessão renovada' : '❌ Falhou'}`);
  log(`Cakto:   ${caktoOk ? '✅ Sessão renovada' : '❌ Falhou'}`);

  await browser.close().catch(() => {});
  process.exit(0);
})().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
