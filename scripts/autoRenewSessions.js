'use strict';
/**
 * autoRenewSessions.js — Renova sessões do Hotmart e Cakto automaticamente
 *
 * Hotmart: login via CAS API (HTTP) + Puppeteer para capturar JWT/cookies
 * Cakto:   usa o fluxo de auto-login já embutido no publisherCakto
 *
 * Uso: node scripts/autoRenewSessions.js
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const puppeteer = require('puppeteer');
const https = require('https');
const http  = require('http');
const fs    = require('fs');

const BASE         = path.join(__dirname, '..');
const SESSION_DIR  = path.join(BASE, 'data', 'sessions');
const CHROME       = process.env.CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HM_EMAIL     = process.env.HOTMART_EMAIL    || process.env.CAKTO_EMAIL    || 'mrovariz@hotmail.com';
const HM_PASS      = process.env.HOTMART_PASSWORD  || process.env.CAKTO_PASSWORD || 'Genia2026$Kdp';
const CAKTO_EMAIL  = process.env.CAKTO_EMAIL       || 'mrovariz@hotmail.com';
const CAKTO_PASS   = process.env.CAKTO_PASSWORD    || 'Genia2026$Kdp';

fs.mkdirSync(SESSION_DIR, { recursive: true });

const LOG_FILE = path.join(BASE, 'logs', 'autoRenewSessions.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpPost(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = lib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d.trim() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Hotmart CAS login ─────────────────────────────────────────────────────────
async function renewHotmartSession() {
  log('\n── HOTMART ──────────────────────────────────────────────');

  // 1. Get TGT via CAS API
  log('[Hotmart] Obtendo TGT via CAS API...');
  const tgtBody = `username=${encodeURIComponent(HM_EMAIL)}&password=${encodeURIComponent(HM_PASS)}`;
  let tgtRes;
  try {
    tgtRes = await httpPost('https://sso.hotmart.com/v1/tickets/', tgtBody);
  } catch (e) {
    log('[Hotmart] ❌ Erro CAS API: ' + e.message);
    return false;
  }

  log('[Hotmart] CAS status: ' + tgtRes.status);

  let tgt;
  if (tgtRes.status === 201) {
    // Location header: /v1/tickets/TGT-xxxxxxx
    const loc = tgtRes.headers.location || '';
    tgt = loc.split('/').pop();
    log('[Hotmart] TGT obtido: ' + tgt.slice(0, 20) + '...');
  } else if (tgtRes.status === 200 && tgtRes.body.includes('TGT')) {
    tgt = tgtRes.body.trim();
    log('[Hotmart] TGT (body): ' + tgt.slice(0, 20) + '...');
  } else {
    log('[Hotmart] ❌ CAS falhou: ' + tgtRes.status + ' — ' + tgtRes.body.slice(0, 200));
    log('[Hotmart] ⚠️  Tentando login via browser (headless: false)...');
    return await renewHotmartViaBrowser();
  }

  // 2. Get Service Ticket
  const oauth2Service = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d&scope=openid+profile+email&redirect_uri=https%3A%2F%2Fapp.hotmart.com%2Flogout&response_type=code';
  log('[Hotmart] Obtendo Service Ticket...');
  const stRes = await httpPost(`https://sso.hotmart.com/v1/tickets/${tgt}`, `service=${encodeURIComponent(oauth2Service)}`);
  log('[Hotmart] ST status: ' + stRes.status + ' — ' + stRes.body.slice(0, 40));
  const st = stRes.body.trim();
  if (!st || stRes.status !== 200) {
    log('[Hotmart] ❌ ST falhou');
    return await renewHotmartViaBrowser();
  }

  // 3. Complete OAuth2 flow in browser to capture JWT + cookies
  log('[Hotmart] Completando OAuth2 via browser...');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    defaultViewport: { width: 1366, height: 768 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Navigate with service ticket to complete auth
    const authUrl = oauth2Service + '&ticket=' + st;
    log('[Hotmart] Navegando: ' + authUrl.slice(0, 80) + '...');
    await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e => log('[Hotmart] Nav error: ' + e.message));
    await sleep(5000);

    const url = page.url();
    log('[Hotmart] URL final: ' + url.slice(0, 100));

    // Try navigating to main app
    if (!url.includes('app.hotmart.com') || url.includes('/login')) {
      log('[Hotmart] Ainda não autenticado, navegando para app...');
      await page.goto('https://app.hotmart.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3000);
    }

    const finalUrl = page.url();
    log('[Hotmart] URL após app.hotmart.com: ' + finalUrl.slice(0, 100));

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
    log('[Hotmart] Cookies: ' + cookies.length + ' | JWT: ' + (jwt ? 'OK (' + jwt.slice(0, 20) + '...)' : 'MISSING'));

    const loggedIn = finalUrl.includes('app.hotmart.com') && !finalUrl.includes('/login');
    if (!loggedIn && !jwt) {
      log('[Hotmart] ❌ Login não confirmado — tentando browser visível');
      await browser.close();
      return await renewHotmartViaBrowser();
    }

    // Save session
    const session = {
      platform: 'hotmart',
      savedAt: Date.now(),
      savedAtHuman: new Date().toLocaleString('pt-BR'),
      url: finalUrl,
      cookies,
      localStorage: localSt,
    };
    const sessionFile = path.join(SESSION_DIR, 'hotmart.json');
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    log('[Hotmart] ✅ Sessão salva: ' + cookies.length + ' cookies → ' + sessionFile);
    await browser.close();
    return true;
  } catch (e) {
    log('[Hotmart] ❌ Browser error: ' + e.message);
    await browser.close().catch(() => {});
    return await renewHotmartViaBrowser();
  }
}

// ── Hotmart fallback: browser com login manual via SSO form ───────────────────
async function renewHotmartViaBrowser() {
  log('[Hotmart] Abrindo browser para login automático via formulário...');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: ['--no-sandbox', '--start-maximized', '--ignore-certificate-errors'],
    defaultViewport: null,
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  try {
    log('[Hotmart] Navegando para SSO login...');
    await page.goto('https://sso.hotmart.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);

    // Try to fill email
    const emailFilled = await page.evaluate((email) => {
      const sel = ['input[type="email"]', 'input[name="email"]', 'input[id*="email" i]', 'input[placeholder*="email" i]', 'input[placeholder*="e-mail" i]', '#username', 'input[name="username"]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el && el.offsetParent !== null) {
          el.focus();
          el.value = email;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return s;
        }
      }
      return null;
    }, HM_EMAIL);
    log('[Hotmart] Email field: ' + (emailFilled || 'not found'));

    if (emailFilled) {
      await sleep(500);
      // Try to fill password
      const passFilled = await page.evaluate((pass) => {
        const sel = ['input[type="password"]', 'input[name="password"]', 'input[id*="pass" i]'];
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el && el.offsetParent !== null) {
            el.focus();
            el.value = pass;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return s;
          }
        }
        return null;
      }, HM_PASS);
      log('[Hotmart] Password field: ' + (passFilled || 'not found'));

      if (passFilled) {
        await sleep(500);
        // Click submit
        const submitted = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          for (const b of btns) {
            const t = (b.textContent || b.value || '').toLowerCase();
            if (t.includes('entrar') || t.includes('login') || t.includes('sign in') || t.includes('continuar') || t.includes('acessar')) {
              b.click();
              return b.textContent || b.value;
            }
          }
          // Try submitting form
          const form = document.querySelector('form');
          if (form) { form.submit(); return 'form.submit()'; }
          return null;
        });
        log('[Hotmart] Submit: ' + (submitted || 'not found'));
      }
    }

    // Wait for login
    log('[Hotmart] Aguardando redirecionamento (máx 120s)...');
    const deadline = Date.now() + 120000;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const url = page.url();
      if (url.includes('app.hotmart.com') && !url.includes('/login') && !url.includes('/sso')) {
        ok = true;
        log('[Hotmart] Login detectado! URL: ' + url.slice(0, 80));
        break;
      }
      log('[Hotmart] Aguardando... ' + url.slice(0, 60));
    }

    if (!ok) {
      log('[Hotmart] ❌ Login falhou ou timeout');
      await browser.close();
      return false;
    }

    await sleep(2000);
    const cookies = await page.cookies();
    const localSt = await page.evaluate(() => {
      const o = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        o[k] = localStorage.getItem(k);
      }
      return o;
    }).catch(() => ({}));

    const session = {
      platform: 'hotmart',
      savedAt: Date.now(),
      savedAtHuman: new Date().toLocaleString('pt-BR'),
      url: page.url(),
      cookies,
      localStorage: localSt,
    };
    const sessionFile = path.join(SESSION_DIR, 'hotmart.json');
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    log('[Hotmart] ✅ Sessão salva via browser: ' + cookies.length + ' cookies');
    await browser.close();
    return true;
  } catch (e) {
    log('[Hotmart] ❌ Browser fallback error: ' + e.message);
    await browser.close().catch(() => {});
    return false;
  }
}

// ── Cakto auto-login ──────────────────────────────────────────────────────────
async function renewCaktoSession() {
  log('\n── CAKTO ────────────────────────────────────────────────');
  log('[Cakto] Abrindo browser para login automático...');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    defaultViewport: { width: 1366, height: 768 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    log('[Cakto] Navegando para login...');
    await page.goto('https://app.cakto.com.br/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);

    // Switch to password tab
    const pwTabClicked = await page.evaluate(() => {
      const targets = ['login with password', 'entrar com senha', 'senha', 'password'];
      const btns = Array.from(document.querySelectorAll('button, a, [role="tab"], li'));
      for (const b of btns) {
        const t = (b.textContent || '').toLowerCase().trim();
        if (targets.some(kw => t.includes(kw))) { b.click(); return b.textContent.trim(); }
      }
      return null;
    });
    log('[Cakto] Tab senha: ' + (pwTabClicked || 'não encontrada'));
    await sleep(1500);

    // Fill email
    const emailPos = await page.evaluate(() => {
      const sel = ['input[type="email"]', 'input[name="email"]', 'input[id*="email" i]', 'input[placeholder*="e-mail" i]', 'input[placeholder*="email" i]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) { const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; }
      }
      return null;
    });

    if (emailPos) {
      await page.mouse.click(emailPos.x, emailPos.y, { clickCount: 3 });
      await page.keyboard.type(CAKTO_EMAIL, { delay: 30 });
      log('[Cakto] Email preenchido');
    } else {
      log('[Cakto] ⚠️ Campo email não encontrado');
    }

    await sleep(500);

    // Fill password
    const passPos = await page.evaluate(() => {
      const sel = ['input[type="password"]', 'input[name="password"]', 'input[id*="pass" i]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) { const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; }
      }
      return null;
    });

    if (passPos) {
      await page.mouse.click(passPos.x, passPos.y, { clickCount: 3 });
      await page.keyboard.type(CAKTO_PASS, { delay: 30 });
      log('[Cakto] Password preenchido');
    } else {
      log('[Cakto] ⚠️ Campo password não encontrado');
    }

    await sleep(500);

    // Submit
    const submitted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], button'));
      for (const b of btns) {
        const t = (b.textContent || '').toLowerCase();
        if (t.includes('entrar') || t.includes('login') || t.includes('acessar') || t.includes('continuar') || t.includes('sign')) {
          if (b.getBoundingClientRect().width > 0) { b.click(); return b.textContent.trim(); }
        }
      }
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'form.submit()'; }
      return null;
    });
    log('[Cakto] Submit: ' + (submitted || 'não encontrado'));

    // Wait for login
    log('[Cakto] Aguardando login (máx 90s)...');
    const deadline = Date.now() + 90000;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const url = page.url();
      // Handle SSO devices (2FA)
      if (url.includes('/sso-devices') || url.includes('/login/device')) {
        log('[Cakto] 2FA: aguardando confirmação no email...');
        // Wait longer for email confirmation
        const d2 = Date.now() + 180000;
        while (Date.now() < d2) {
          await sleep(3000);
          const u2 = page.url();
          if (!u2.includes('/login') && !u2.includes('/auth') && !u2.includes('/sso')) {
            ok = true;
            log('[Cakto] 2FA confirmado! URL: ' + u2.slice(0, 80));
            break;
          }
        }
        break;
      }
      if (!url.includes('/login') && !url.includes('/auth') && url.includes('cakto.com.br')) {
        ok = true;
        log('[Cakto] Login detectado! URL: ' + url.slice(0, 80));
        break;
      }
    }

    if (!ok) {
      log('[Cakto] ❌ Login não confirmado');
      await browser.close();
      return false;
    }

    await sleep(2000);
    const cookies = await page.cookies();
    const localSt = await page.evaluate(() => {
      const o = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        o[k] = localStorage.getItem(k);
      }
      return o;
    }).catch(() => ({}));

    const session = {
      platform: 'cakto',
      savedAt: Date.now(),
      savedAtHuman: new Date().toLocaleString('pt-BR'),
      url: page.url(),
      cookies,
      localStorage: localSt,
    };
    const sessionFile = path.join(SESSION_DIR, 'cakto.json');
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    log('[Cakto] ✅ Sessão salva: ' + cookies.length + ' cookies → ' + sessionFile);
    await browser.close();
    return true;
  } catch (e) {
    log('[Cakto] ❌ Erro: ' + e.message);
    await browser.close().catch(() => {});
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  log('=== Auto-Renovação de Sessões GENIA ===');
  log('Hotmart: ' + HM_EMAIL);
  log('Cakto:   ' + CAKTO_EMAIL);

  const hmOk    = await renewHotmartSession();
  const caktoOk = await renewCaktoSession();

  log('\n=== RESULTADO ===');
  log('Hotmart: ' + (hmOk    ? '✅ Sessão renovada' : '❌ Falhou'));
  log('Cakto:   ' + (caktoOk ? '✅ Sessão renovada' : '❌ Falhou'));

  if (hmOk || caktoOk) {
    log('\n✅ Sessões renovadas! O megaAgent usará automaticamente nas próximas publicações.');
  } else {
    log('\n❌ Ambas as sessões falharam. Rode refresh_sessions.js manualmente.');
  }

  process.exit(0);
})().catch(e => {
  log('FATAL: ' + e.message + '\n' + e.stack);
  process.exit(1);
});
