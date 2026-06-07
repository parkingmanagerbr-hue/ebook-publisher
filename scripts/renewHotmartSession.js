'use strict';
/**
 * renewHotmartSession.js — Login automático no Hotmart e captura de sessão JWT
 * Abre Chrome headful, faz login, navega para app.hotmart.com, salva sessão.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const puppeteer = require('puppeteer');
const fs        = require('fs');

const BASE        = path.join(__dirname, '..');
const SESSION_DIR = path.join(BASE, 'data', 'sessions');
const CHROME      = process.env.CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HM_EMAIL    = process.env.HOTMART_EMAIL    || 'mrovariz@hotmail.com';
const HM_PASS     = process.env.HOTMART_PASSWORD || 'Nu4qreq13$M';
const HM_2FA_EMAIL = process.env.HOTMART_2FA_EMAIL || 'mrovariz@gmail.com';

fs.mkdirSync(SESSION_DIR, { recursive: true });
const LOG = path.join(BASE, 'logs', 'renewHotmart.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const ls = fs.createWriteStream(LOG, { flags: 'a' });
function log(msg) { const l = `[${new Date().toISOString()}] ${msg}`; console.log(l); ls.write(l + '\n'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  log('=== Renovar Sessão Hotmart ===');
  log(`Email: ${HM_EMAIL}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: ['--no-sandbox', '--start-maximized', '--ignore-certificate-errors'],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  // Add Object.prototype.replace polyfill required by Hotmart SPA
  await page.evaluateOnNewDocument(() => {
    const orig = String.prototype.replace;
    Object.defineProperty(Object.prototype, 'replace', {
      value: function(...a) { return orig.apply(String(this == null ? '' : this), a); },
      writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  try {
    // Step 1: Go to SSO login
    log('Navegando para sso.hotmart.com/login...');
    await page.goto('https://sso.hotmart.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log('Nav: ' + e.message.slice(0,60)));
    await sleep(3000);
    log('URL: ' + page.url());

    // Step 2: Fill email
    const emailFilled = await page.evaluate((email) => {
      const sels = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', 'input[placeholder*="e-mail" i]', 'input[placeholder*="email" i]', '#username'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent !== null) {
          el.focus(); el.select();
          el.value = email;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return s;
        }
      }
      return null;
    }, HM_EMAIL);
    log('Email field: ' + (emailFilled || 'not found'));
    await sleep(600);

    // Step 3: Fill password
    const passFilled = await page.evaluate((pass) => {
      const sels = ['input[type="password"]', 'input[name="password"]', 'input[id*="pass" i]'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent !== null) {
          el.focus(); el.select();
          el.value = pass;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return s;
        }
      }
      return null;
    }, HM_PASS);
    log('Password field: ' + (passFilled || 'not found'));
    await sleep(600);

    // Step 4: Submit
    const submitted = await page.evaluate(() => {
      // Try submit button
      const btns = Array.from(document.querySelectorAll('button[type="submit"], button'));
      for (const b of btns) {
        const t = (b.textContent || '').toLowerCase().trim();
        if ((t.includes('entrar') || t.includes('login') || t.includes('sign') || t.includes('acessar')) && b.getBoundingClientRect().width > 0) {
          b.click(); return 'btn: ' + b.textContent.trim().slice(0,30);
        }
      }
      // Fallback: submit form
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'form.submit()'; }
      return null;
    });
    log('Submit: ' + (submitted || 'not found'));

    // Step 5: Wait for post-login redirect — handle 2FA automatically
    log(`Aguardando redirect pós-login (máx 180s)...`);
    let loggedIn = false;
    let code2faEntered = false;
    const deadline = Date.now() + 180000;

    while (Date.now() < deadline) {
      await sleep(2000);
      const url = page.url();
      log('URL: ' + url.slice(0, 80));

      // Check for 2FA code input field
      if (!code2faEntered && url.includes('sso.hotmart.com')) {
        const needs2FA = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input[type="number"], input[type="text"][maxlength="6"], input[name*="code" i], input[name*="otp" i], input[placeholder*="código" i], input[placeholder*="code" i]');
          return inputs.length > 0 ? inputs[0].placeholder || inputs[0].name || 'found' : null;
        }).catch(() => null);

        if (needs2FA) {
          log(`2FA detectado (campo: ${needs2FA}) — lendo código do Gmail...`);
          // Try automatic code reading
          const { execSync } = require('child_process');
          let code = null;
          try {
            const out = execSync(`"${process.execPath}" "${path.join(__dirname, 'readGmailCode.js')}"`, { timeout: 30000, encoding: 'utf8' });
            const m = out.match(/CODE:(\d{6})/);
            if (m) code = m[1];
          } catch(e) {
            log('Auto-leitura Gmail falhou: ' + e.message.slice(0, 60));
          }

          if (code) {
            log(`Inserindo código 2FA automaticamente: ${code}`);
            const entered = await page.evaluate((c) => {
              const sels = ['input[type="number"]', 'input[type="text"][maxlength="6"]', 'input[name*="code" i]', 'input[name*="otp" i]', 'input[placeholder*="código" i]'];
              for (const s of sels) {
                const el = document.querySelector(s);
                if (el) {
                  el.focus(); el.value = c;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  // Try submitting
                  const form = el.closest('form');
                  if (form) {
                    const btn = form.querySelector('button[type="submit"], button');
                    if (btn) btn.click();
                    else form.submit();
                  }
                  return true;
                }
              }
              return false;
            }, code);
            if (entered) { code2faEntered = true; log('Código 2FA inserido!'); }
          } else {
            log(`⚠️  Auto-leitura falhou — verifique ${HM_2FA_EMAIL} e insira o código manualmente.`);
          }
        }
      }

      // Check login success
      if (!url.includes('sso.hotmart.com/login') && (url.includes('hotmart.com') || url.includes('app.hotmart'))) {
        log('Login confirmado!');
        loggedIn = true;
        break;
      }
    }

    if (!loggedIn) {
      log('❌ Login falhou — ainda na página de login após 90s');
      await browser.close();
      process.exit(1);
    }

    // Step 6: Navigate to app.hotmart.com to capture JWT
    log('Navegando para app.hotmart.com para capturar JWT...');
    await page.goto('https://app.hotmart.com', { waitUntil: 'networkidle2', timeout: 30000 }).catch(e => log('Nav app: ' + e.message.slice(0,60)));
    await sleep(5000);
    log('URL app: ' + page.url());

    // Try products page too (to get full JWT hydration)
    const appUrl = page.url();
    if (!appUrl.includes('/login') && appUrl.includes('app.hotmart.com')) {
      try {
        await page.goto('https://app.hotmart.com/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);
      } catch(e) {}
    }

    // Step 7: Capture cookies + JWT
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
    log(`Cookies: ${cookies.length} | JWT: ${jwt ? 'OK (' + jwt.slice(0, 30) + '...)' : 'MISSING'}`);

    // Step 8: Save session
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
    log(`✅ Sessão salva: ${cookies.length} cookies, JWT=${jwt ? 'OK' : 'missing'} → ${sessionFile}`);

    await browser.close();
    log('=== Concluído ===');
    process.exit(0);
  } catch (e) {
    log('❌ ERRO: ' + e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
