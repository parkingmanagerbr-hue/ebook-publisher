'use strict';
/**
 * refresh_sessions.js — Abre o Chrome para renovar sessões do Hotmart e Cakto
 * Após login manual, salva os cookies no session file.
 * Executar UMA VEZ para renovar sessões.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = 'C:/Users/m_rov/ClaudeProjects/EbookPublisher';
const SESSIONS = path.join(BASE, 'data/sessions');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE_HOTMART = 'C:/Users/m_rov/AppData/Local/Temp/hotmart_profile';
const PROFILE_CAKTO   = 'C:/Users/m_rov/AppData/Local/Temp/cakto_profile';

const LOG = path.join('C:/Users/m_rov/AppData/Local/Temp', 'refresh_sessions.log');
const ls = fs.createWriteStream(LOG, { flags: 'w' });
function log(msg) { const l = `[${new Date().toISOString()}] ${msg}`; console.log(l); ls.write(l + '\n'); }

async function saveSession(page, platform, sessionFile) {
  const cookies = await page.cookies();
  let localStorage = {};
  try {
    localStorage = await page.evaluate(() => {
      const o = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        o[k] = window.localStorage.getItem(k);
      }
      return o;
    });
  } catch(e) {}
  const session = {
    platform,
    savedAt: Date.now(),
    savedAtHuman: new Date().toLocaleString('pt-BR'),
    url: page.url(),
    cookies,
    localStorage,
  };
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  log(`Sessão ${platform} salva: ${cookies.length} cookies → ${sessionFile}`);
}

async function waitForLogin(page, platform, successCheck, timeoutMs = 300000) {
  log(`[${platform}] Aguardando login manual... (${Math.round(timeoutMs/1000)}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const url = page.url();
    const ok = await successCheck(page).catch(() => false);
    if (ok) {
      log(`[${platform}] Login detectado! URL: ${url}`);
      return true;
    }
    log(`[${platform}] Aguardando... URL: ${url.slice(0, 80)}`);
  }
  log(`[${platform}] Timeout aguardando login`);
  return false;
}

(async () => {
  log('=== Refresh de Sessões: Hotmart + Cakto ===');

  // === HOTMART ===
  log('\n--- Hotmart ---');
  {
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      userDataDir: PROFILE_HOTMART,
      args: ['--no-sandbox', '--start-maximized'],
      defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    log('[Hotmart] Abrindo https://app.hotmart.com...');
    await page.goto('https://app.hotmart.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);

    // Verificar se já está logado
    const alreadyLogged = await page.evaluate(() => {
      return !window.location.href.includes('/auth') && !window.location.href.includes('/login');
    }).catch(() => false);

    if (alreadyLogged) {
      log('[Hotmart] Já está logado!');
    } else {
      log('[Hotmart] Faça login manualmente na janela do Chrome...');
      const ok = await waitForLogin(page, 'Hotmart', async (p) => {
        const url = p.url();
        return url.includes('app.hotmart.com') && !url.includes('/auth') && !url.includes('/login');
      });
      if (!ok) { log('[Hotmart] Login falhou — pulando'); await browser.close(); return; }
    }

    await sleep(2000);
    await saveSession(page, 'hotmart', path.join(SESSIONS, 'hotmart.json'));
    await browser.close();
    log('[Hotmart] Pronto!');
  }

  await sleep(2000);

  // === CAKTO ===
  log('\n--- Cakto ---');
  {
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      userDataDir: PROFILE_CAKTO,
      args: ['--no-sandbox', '--start-maximized'],
      defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    log('[Cakto] Abrindo https://app.cakto.com.br...');
    await page.goto('https://app.cakto.com.br', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);

    const alreadyLogged = await page.evaluate(() => {
      const url = window.location.href;
      return url.includes('cakto.com.br') && !url.includes('/login') && !url.includes('/auth');
    }).catch(() => false);

    if (alreadyLogged) {
      log('[Cakto] Já está logado!');
    } else {
      log('[Cakto] Faça login manualmente — use email mrovariz@hotmail.com + link mágico ou senha...');
      const ok = await waitForLogin(page, 'Cakto', async (p) => {
        const url = p.url();
        return url.includes('cakto.com.br') && !url.includes('/login') && !url.includes('/auth');
      });
      if (!ok) { log('[Cakto] Login falhou — pulando'); await browser.close(); return; }
    }

    await sleep(2000);
    await saveSession(page, 'cakto', path.join(SESSIONS, 'cakto.json'));
    await browser.close();
    log('[Cakto] Pronto!');
  }

  log('\n=== Sessões renovadas! Execute publish_multistore.js agora. ===');
})().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
