/**
 * publisherAmazon.js — Publica e-book no Amazon KDP via Puppeteer
 *
 * Features:
 *  - Auto step-up signin (KDP requires fresh auth for new-title creation)
 *  - Amazon a-button UI kit selectors
 *  - Screenshots at each step for debugging
 *  - Session refresh after successful signin
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

const BASE_URL        = 'https://kdp.amazon.com';
const BOOKSHELF_URL   = 'https://kdp.amazon.com/pt_BR/bookshelf';
// KDP locale-agnostic URLs (try pt_BR first, fall back to en_US)
const NEW_TITLE_URLS  = [
  'https://kdp.amazon.com/en_US/title-setup/kindle/new',
  'https://kdp.amazon.com/pt_BR/title-setup/kindle/new',
];
const SESSION_FILE    = process.env.AMAZON_SESSION_FILE || '/app/data/sessions/amazon.json';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR   || '/app/data/landing_screenshots';
const LOGS_DIR        = '/app/data/logs';
const AUTHOR_NAME     = process.env.KDP_AUTHOR_NAME || process.env.AUTHOR_NAME || 'GENIA Publishing';
const KDP_EMAIL       = process.env.KDP_EMAIL    || '';
const KDP_PASSWORD    = process.env.KDP_PASSWORD || '';
const DEFAULT_PRICE   = parseFloat(process.env.EBOOK_PRICE || '4.99');
const OTP_FILE        = '/app/data/amazon_otp.txt';

// ── Amazon auth-challenge URL detection ───────────────────────────────────────
function isAuthUrl(url) {
  const authPatterns = [
    'signin', 'ap/signin', '/ap/cvf', 'ap/mfa', 'ap/oa',
    'forgotpassword', 'reverification', 'ap/challenge',
    'signin/identifier', 'account/login',
  ];
  return authPatterns.some(p => url.includes(p));
}

// ── OTP wait (polls OTP_FILE for up to maxMs) ─────────────────────────────────
async function waitForOtp(page, maxMs = 300_000) {
  // Step 0: If we're on the OTP-delivery-choice page (no input yet), click "Send OTP" button first
  try {
    const sendBtnPos = await page.evaluate(() => {
      // Look for "Envie a senha de uso único" or similar send buttons on the pre-OTP page
      const texts = ['envie a senha de uso único', 'send one-time password', 'send otp', 'enviar código', 'enviar senha', 'continue'];
      const all = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], .a-button-primary input, .a-button-primary button, a-button'));
      for (const el of all) {
        const t = (el.value || el.textContent || '').toLowerCase().trim();
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && texts.some(tx => t.includes(tx))) {
          return { x: r.left + r.width/2, y: r.top + r.height/2, t: t.slice(0,50) };
        }
      }
      // Also check if there's a submit button on a page with radio buttons (delivery choice page)
      const radios = document.querySelectorAll('input[type="radio"]');
      if (radios.length > 0) {
        const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
        if (submitBtn) {
          const r = submitBtn.getBoundingClientRect();
          if (r.width > 0) return { x: r.left + r.width/2, y: r.top + r.height/2, t: (submitBtn.value || submitBtn.textContent || 'submit').slice(0,50) };
        }
      }
      return null;
    });
    if (sendBtnPos) {
      log.info('OTP: clicando "' + sendBtnPos.t + '" para enviar código via WhatsApp/SMS...');
      await page.mouse.click(sendBtnPos.x, sendBtnPos.y);
      await sleep(4000);
      await screenshot(page, 'otp_sent');
      log.info('OTP: código enviado para o telefone. URL: ' + page.url().slice(0, 80));
    }
  } catch(e) { log.warn('OTP send-button step: ' + e.message.slice(0, 60)); }

  // Write WAITING flag
  try {
    fs.mkdirSync(path.dirname(OTP_FILE), { recursive: true });
    fs.writeFileSync(OTP_FILE, 'WAITING');
  } catch {}
  log.info(`⏳ Amazon pedindo código OTP — aguardando até ${maxMs/60000} min`);
  log.info(`   Envie o código via: curl -X POST http://localhost:3100/api/amazon-otp -H "Content-Type: application/json" -d '{"code":"XXXXXX"}'`);
  log.info(`   Ou escreva no arquivo: echo XXXXXX > /app/data/amazon_otp.txt`);

  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const txt = fs.readFileSync(OTP_FILE, 'utf8').trim();
      if (/^\d{4,8}$/.test(txt)) {
        log.info('✅ Código OTP recebido: ' + txt);
        fs.writeFileSync(OTP_FILE, 'USED:' + txt); // mark used

        // Find OTP/CVF input on current page and type code
        const otpInput = await page.$(
          'input[name="otpCode"], input[id*="otp" i], input[id*="cvf" i], input[id*="code" i], input[name="code"], input[type="number"]'
        ).catch(() => null);
        if (otpInput) {
          await otpInput.click({ clickCount: 3 });
          await sleep(200);
          await otpInput.type(txt, { delay: 50 });
          await sleep(500);
          await screenshot(page, 'otp_filled');
          // Mark "Don't require OTP on this browser" to avoid 2FA on future logins
          try {
            await page.evaluate(() => {
              const cb = document.querySelector('input[name="rememberDevice"], input[id*="remember" i], input[type="checkbox"]');
              if (cb && !cb.checked) cb.click();
            });
          } catch {}
          // Submit
          await page.evaluate(() => {
            const btn = document.querySelector('input[type="submit"], button[type="submit"], .a-button-primary input');
            if (btn) btn.click();
          });
          await sleep(6000);
          await screenshot(page, 'otp_submitted');
          return txt;
        } else {
          log.warn('OTP input não encontrado na página após receber código');
          await screenshot(page, 'otp_no_input');
        }
        return txt;
      }
    } catch {}
  }
  log.warn('Timeout aguardando OTP (5 min)');
  return null;
}

// ── Session ──────────────────────────────────────────────────────────────────
function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch(e) { log.warn('Erro sessão Amazon: '+e.message); return null; }
}

async function saveSession(page) {
  try {
    const cookies = await page.cookies();
    const session = loadSession() || {};
    session.cookies = cookies;
    session.savedAt = Date.now();
    session.savedAtHuman = new Date().toLocaleString('pt-BR');
    session.lastRenewed = new Date().toISOString();
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    log.info('Sessão Amazon atualizada (' + cookies.length + ' cookies)');
  } catch(e) { log.warn('Erro ao salvar sessão: ' + e.message); }
}

// ── Screenshot helper ─────────────────────────────────────────────────────────
async function screenshot(page, label) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const f = path.join(LOGS_DIR, 'amazon_' + label + '.png');
    // Race against 12s timeout to prevent page.screenshot() from hanging indefinitely
    await Promise.race([
      page.screenshot({ path: f, fullPage: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 12000)),
    ]);
    log.info('Screenshot: ' + f);
  } catch {}
}

// ── Signin helper ─────────────────────────────────────────────────────────────
async function doSignin(page) {
  if (!KDP_EMAIL || !KDP_PASSWORD) {
    log.warn('Sem credenciais KDP (KDP_EMAIL/KDP_PASSWORD não configurados)');
    return false;
  }
  log.info('Fazendo login no KDP com ' + KDP_EMAIL);

  // Check if we're on a signin page
  const url = page.url();
  if (!url.includes('signin') && !url.includes('ap/signin') && !url.includes('/auth')) {
    log.info('Não está na página de signin, pulando');
    return true;
  }

  await screenshot(page, 'signin_before');

  // Detect if page shows a different account and click "Trocar contas" to switch
  try {
    const pageInfo = await page.evaluate((kdpEmail) => {
      // Check what account/email is shown on the page
      const shownEmail = (document.querySelector('.ap_customer_name + *, .displayEmail, [class*="email" i]') || {}).textContent || '';
      // Look for "Trocar contas" or "Change account" link
      const allLinks = Array.from(document.querySelectorAll('a, button, span[role="link"]'));
      const switchEl = allLinks.find(el => {
        const t = (el.textContent || '').toLowerCase().trim();
        return t.includes('trocar conta') || t.includes('change account') || t.includes('mudar conta');
      });
      const switchPos = switchEl ? (() => {
        const r = switchEl.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width/2, y: r.top + r.height/2 } : null;
      })() : null;
      return { shownEmail: shownEmail.trim().slice(0, 80), switchPos };
    }, KDP_EMAIL);

    if (pageInfo.shownEmail) log.info('Conta na página: "' + pageInfo.shownEmail + '" (KDP_EMAIL: ' + KDP_EMAIL + ')');

    if (pageInfo.switchPos && (!pageInfo.shownEmail || !pageInfo.shownEmail.includes(KDP_EMAIL))) {
      log.info('Trocar contas link encontrado (email=' + (pageInfo.shownEmail||'?') + ') — clicando...');
      await page.mouse.click(pageInfo.switchPos.x, pageInfo.switchPos.y);
      // Wait for page to fully load after account switch (loading spinner needs time)
      await sleep(2000);
      try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }); } catch(e) {}
      await sleep(3000);
      await screenshot(page, 'signin_after_switch');
      // After "Trocar contas" we may land on an ACCOUNT SELECTION page showing current accounts.
      // Need to click "Adicionar contas" (+ button) to get to the email signin form.
      const adicionarPos = await page.evaluate(() => {
        // Only look at near-leaf elements (likely buttons/links) — avoid script-containing containers
        const all = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"], span, div, p'))
          .filter(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            // Must be visible, short text (not script), no JS-looking content
            return r.width > 0 && r.height > 0 && r.height < 80 &&
                   t.length > 3 && t.length < 120 &&
                   !t.includes('{') && !t.includes('function ') && !t.includes('var ') &&
                   e.children.length <= 3; // near-leaf node only
          });
        const targets = ['adicionar conta', 'add account', 'use another', 'sign in with a different', 'mudar de conta', 'switch account', 'trocar conta'];
        const el = all.find(e => {
          const t = (e.textContent || '').toLowerCase().trim();
          return targets.some(tgt => t.includes(tgt));
        });
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width/2, y: r.top + r.height/2, text: (el.textContent||'').trim().slice(0,60) };
        }
        // Debug: log visible elements
        const visible = all.slice(0, 15).map(e => (e.textContent||'').trim().slice(0, 30));
        return { notFound: true, visible };
      }).catch(() => null);
      if (adicionarPos && !adicionarPos.notFound) {
        log.info('Página de seleção de conta — clicando "' + adicionarPos.text + '"...');
      } else if (adicionarPos && adicionarPos.notFound) {
        log.info('Adicionar conta btn not found. Visible: ' + JSON.stringify(adicionarPos.visible));
      }
      if (adicionarPos && !adicionarPos.notFound) {
        await page.mouse.click(adicionarPos.x, adicionarPos.y);
        await sleep(2000);
        try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }); } catch(e) {}
        await sleep(2000);
        await screenshot(page, 'signin_after_add_account');
      }
    }
  } catch(e) { log.warn('Switch account check: ' + e.message); }

  // Email step
  try {
    // Use coordinates-based click to avoid "not clickable" element handle issues
    const emailPos = await page.evaluate(() => {
      const sel = ['input[type="email"]', 'input[name="email"]', '#ap_email', 'input[id*="email"]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }
      }
      return null;
    });
    if (emailPos) {
      await page.mouse.click(emailPos.x, emailPos.y, { clickCount: 3 });
      await sleep(200);
      await page.keyboard.type(KDP_EMAIL, { delay: 30 });
      await sleep(400);
      // Click "Continuar" / "Continue" button
      const contPos = await page.evaluate(() => {
        const sel = ['#continue', 'input[id="continue"]', 'input[type="submit"]', 'button[type="submit"]'];
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
          }
        }
        return null;
      });
      if (contPos) { await page.mouse.click(contPos.x, contPos.y); await sleep(3000); }
      else { log.warn('Email continue button not found'); }
    } else { log.warn('Email input not found on signin page — skipping email step (password-only page)'); }
  } catch(e) { log.warn('Email step error: ' + e.message); }

  await screenshot(page, 'signin_after_email');

  // Password step
  try {
    const passPos = await page.evaluate(() => {
      const sel = ['input[type="password"]', 'input[name="password"]', '#ap_password', 'input[id*="password"]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }
      }
      return null;
    });
    if (passPos) {
      await page.mouse.click(passPos.x, passPos.y, { clickCount: 3 });
      await sleep(200);
      await page.keyboard.type(KDP_PASSWORD, { delay: 30 });
      await sleep(400);
      const signInPos = await page.evaluate(() => {
        const sel = ['#signInSubmit', 'input[id="signInSubmit"]', 'input[type="submit"]', 'button[type="submit"]'];
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
          }
        }
        return null;
      });
      if (signInPos) { await page.mouse.click(signInPos.x, signInPos.y); await sleep(6000); }
      else { log.warn('Password submit button not found'); }
    } else { log.warn('Password input not found'); }
  } catch(e) { log.warn('Password step error: ' + e.message); }

  await screenshot(page, 'signin_after_password');

  // Check for OTP / MFA / CVF challenge
  const postPasswordUrl = page.url();
  const hasChallengeInput = await page.$(
    'input[name="otpCode"], input[id*="otp" i], input[id*="mfa" i], input[id*="cvf" i], input[id*="code" i], input[name="code"]'
  ).catch(() => null);

  if (hasChallengeInput || isAuthUrl(postPasswordUrl)) {
    log.info('Amazon OTP/CVF challenge — aguardando código. URL: ' + postPasswordUrl.slice(0, 80));
    await screenshot(page, 'otp_challenge');
    const code = await waitForOtp(page);
    if (!code) {
      log.warn('OTP não recebido em tempo hábil');
      return false;
    }
    // After OTP, wait for navigation to non-auth page
    await sleep(3000);
    const postOtpUrl = page.url();
    if (isAuthUrl(postOtpUrl)) {
      log.warn('Ainda em auth após OTP: ' + postOtpUrl.slice(0, 80));
      return false;
    }
    log.info('OTP aceito! URL: ' + postOtpUrl.slice(0, 80));
    await saveSession(page);
    return true;
  }

  // Check if we're now logged in
  const finalUrl = page.url();
  const isSignedIn = !isAuthUrl(finalUrl);
  log.info('Signin resultado: ' + (isSignedIn ? 'OK' : 'FALHOU') + ' url=' + finalUrl.slice(0, 80));

  if (isSignedIn) {
    await saveSession(page);
  }
  return isSignedIn;
}

// ── Click Amazon-style button by text ─────────────────────────────────────────
// Puppeteer-native click (ElementHandle.click()) dispatches real CDP mouse events
// with isTrusted=true. KDP's React form requires isTrusted events — programmatic
// element.click() in page.evaluate() is isTrusted=false and gets ignored.
async function clickKdpButton(page, texts, timeout = 20000) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    // ── Strategy A: Puppeteer native click (isTrusted=true, works with React) ──
    // Try .a-button-primary containers with matching text
    try {
      const containers = await page.$$('.a-button-primary');
      for (const container of containers) {
        const cText = await container.evaluate(el => (el.textContent || '').toLowerCase().trim()).catch(() => '');
        const matches = arr.some(t => cText.includes(t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')));
        if (!matches) continue;
        // Prefer inner clickable element (input/anchor/button)
        const inner = await container.$('input.a-button-input, a.a-button-anchor, button').catch(() => null);
        const target = inner || container;
        const box = await target.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          await target.click();
          log.info('KDP button clicked (native-A): "' + cText.slice(0, 40) + '"');
          return true;
        }
      }
    } catch(e) { /* fall through */ }

    // ── Strategy B: Puppeteer native click on button/input/anchor by text ──
    try {
      const handles = await page.$$('button, input[type="submit"], input.a-button-input, a.a-button-anchor');
      for (const h of handles) {
        const info = await h.evaluate((el, arr) => {
          const t = (el.textContent || el.value || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const r = el.getBoundingClientRect();
          return { t, ok: arr.some(x => t === x.toLowerCase() || t.includes(x.toLowerCase())), vis: r.width > 0 && r.height > 0 };
        }, arr).catch(() => ({ ok: false, vis: false }));
        if (info.ok && info.vis) {
          await h.click();
          log.info('KDP button clicked (native-B): "' + info.t.slice(0, 40) + '"');
          return true;
        }
      }
    } catch(e) { /* fall through */ }

    // ── Strategy C: JS click fallback (isTrusted=false — last resort) ──
    const result = await page.evaluate((arr) => {
      // 1. .a-button-primary container
      const primaryContainer = document.querySelector('.a-button-primary, .a-button-submit');
      if (primaryContainer) {
        const inner = primaryContainer.querySelector('input.a-button-input, a.a-button-anchor, button, input[type="submit"]');
        if (inner) {
          const r = inner.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { inner.click(); return 'js-primary'; }
        }
      }
      // 2. Button-like by text
      for (const text of arr) {
        const tl = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        for (const el of Array.from(document.querySelectorAll('button, input[type="submit"], input.a-button-input, a.a-button-anchor'))) {
          const et = (el.textContent || el.value || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (et === tl || et.includes(tl))) { el.click(); return et.slice(0, 40); }
        }
        // span leaf nodes
        for (const el of Array.from(document.querySelectorAll('span.a-button-text, span'))) {
          if (el.children.length > 0) continue;
          const et = (el.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.height < 80 && et.includes(tl)) { el.click(); return et.slice(0, 40); }
        }
      }
      return null;
    }, arr);

    if (result) {
      log.info('KDP button clicked (js-C): "' + result + '"');
      return true;
    }
    await sleep(600);
  }

  // Debug: dump visible buttons
  const visible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, input[type="submit"], .a-button-text'))
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => (e.textContent || e.value || '').trim().slice(0, 40))
      .filter(Boolean)
  ).catch(() => []);
  log.warn('KDP button not found. Texts: ' + arr.join(', ') + '. Visible: ' + visible.join(' | '));
  return false;
}

// ── Fill field helper ─────────────────────────────────────────────────────────
async function fillField(page, selectors, value) {
  const arr = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of arr) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await sleep(100);
        await el.type(String(value), { delay: 20 });
        return true;
      }
    } catch {}
  }
  return false;
}

// ── Fill description (CKEditor / contenteditable / textarea) ─────────────────
async function fillDescription(page, text) {
  const desc = String(text).slice(0, 4000);

  // Try CKEditor iframe body
  try {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const body = await frame.$('body[contenteditable="true"]');
        if (body) {
          await body.click({ clickCount: 3 });
          await sleep(200);
          await body.type(desc, { delay: 10 });
          log.info('Description via CKEditor iframe');
          return true;
        }
      } catch {}
    }
  } catch {}

  // Try contenteditable div
  try {
    const ce = await page.$('[contenteditable="true"]');
    if (ce) {
      await ce.click({ clickCount: 3 });
      await sleep(200);
      await page.keyboard.type(desc, { delay: 10 });
      log.info('Description via contenteditable');
      return true;
    }
  } catch {}

  // Fallback: textarea
  const filled = await fillField(page, [
    'textarea[id*="description" i]',
    'textarea[name*="description" i]',
    'textarea[placeholder*="descrição" i]',
    'textarea[placeholder*="description" i]',
    'textarea',
  ], desc);
  if (filled) { log.info('Description via textarea'); return true; }

  log.warn('Description field not found');
  return false;
}

// ── Wait for URL change ───────────────────────────────────────────────────────
async function waitForUrlChange(page, fromUrl, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(1000);
    if (page.url() !== fromUrl) return true;
  }
  return false;
}

// ── Main publisher ────────────────────────────────────────────────────────────
async function publishToAmazon(ebook) {
  log.info('Amazon KDP: publicando "' + ebook.title + '"');

  const session = loadSession() || { cookies: [] }; // sessão vazia → login fresh
  if (!KDP_EMAIL || !KDP_PASSWORD) {
    log.warn('KDP_EMAIL/KDP_PASSWORD não configurados');
    return { success: false, error: 'Credenciais KDP não configuradas', platform: 'amazon' };
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--lang=pt-BR', '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });

  try {
    // ── Inject session ────────────────────────────────────────────────────────
    log.info('Injetando sessão Amazon...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(1000);

    for (const cookie of (session.cookies || [])) {
      try {
        const c = { ...cookie };
        // Ensure correct domain for amazon.com
        if (!c.domain) c.domain = '.amazon.com';
        if (c.domain === '.amazon.com.br') c.domain = '.amazon.com';
        await page.setCookie(c);
      } catch {}
    }

    // ── Verify session ────────────────────────────────────────────────────────
    await page.goto(BOOKSHELF_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    let currentUrl = page.url();

    if (currentUrl.includes('signin') || currentUrl.includes('ap/signin')) {
      log.warn('Sessão expirada no bookshelf — tentando login...');
      const ok = await doSignin(page);
      if (!ok) {
        await browser.close();
        return { success: false, error: 'Sessão expirada e login falhou', platform: 'amazon' };
      }
      await page.goto(BOOKSHELF_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(2000);
    }
    log.info('Sessão Amazon válida: ' + page.url().slice(0, 60));

    // ── Navigate to new title ────────────────────────────────────────────────
    // Try known direct URLs first; if all 404, click "Create" from bookshelf
    let navigatedToTitle = false;
    for (const url of NEW_TITLE_URLS) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      const u = page.url();
      if (!u.includes('/404') && !isAuthUrl(u)) {
        log.info('New title URL OK: ' + u.slice(0, 80));
        navigatedToTitle = true;
        break;
      }
      log.warn('New title URL returned 404/auth: ' + u.slice(0, 60));
    }
    if (!navigatedToTitle) {
      // Fall back: go to bookshelf and click "Create new Kindle eBook" button
      log.info('Direct URL failed — navigating via bookshelf create button...');
      await page.goto(BOOKSHELF_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      const clicked = await page.evaluate(() => {
        const keywords = ['criar novo título kindle', 'create a new kindle', 'kindle ebook', 'criar ebook', 'novo título', 'new title', 'criar novo', 'create new'];
        const els = Array.from(document.querySelectorAll('a, button, input[type="submit"], span[role="button"]'));
        for (const kw of keywords) {
          const el = els.find(e => {
            const t = (e.textContent || e.value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            const r = e.getBoundingClientRect();
            return r.width > 0 && t.includes(kw.normalize('NFD').replace(/[̀-ͯ]/g, ''));
          });
          if (el) { el.click(); return (el.textContent || el.value || '').trim().slice(0, 60); }
        }
        // last resort: any button/link with href containing title-setup
        const link = document.querySelector('a[href*="title-setup"]');
        if (link) { link.click(); return link.href; }
        return null;
      });
      if (clicked) {
        log.info('Bookshelf create btn clicked: ' + clicked);
        await sleep(4000);
        try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch {}
        await sleep(2000);
      } else {
        log.warn('Create button not found on bookshelf — dumping page buttons for debug');
        const btns = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a, button')).filter(e => e.getBoundingClientRect().width > 0).map(e => (e.textContent || e.href || '').trim().slice(0, 50)).filter(Boolean).slice(0, 30)
        ).catch(() => []);
        log.warn('Visible btns: ' + btns.join(' | '));
        await screenshot(page, 'bookshelf_no_create_btn');
      }
    }
    currentUrl = page.url();

    // Handle step-up auth if redirected to signin, CVF, OTP, or reverification
    if (isAuthUrl(currentUrl)) {
      log.info('Step-up auth necessário para criar título. URL: ' + currentUrl.slice(0, 80));
      // Check for OTP/CVF input immediately
      const hasCvfInput = await page.$(
        'input[name="otpCode"], input[id*="otp" i], input[id*="cvf" i], input[id*="code" i], input[name="code"]'
      ).catch(() => null);
      if (hasCvfInput || currentUrl.includes('/ap/cvf') || currentUrl.includes('reverification')) {
        log.info('CVF/OTP challenge direto — aguardando código do usuário...');
        await screenshot(page, 'stepup_cvf');

        // Se for página de redefinição — selecionar SMS (mais confiável que email) e enviar código
        try {
          // Tentar clicar no radio do telefone/SMS (segundo radio button)
          const radios = await page.$$('input[type="radio"]');
          if (radios.length >= 2) {
            log.info('Selecionando opção SMS (telefone) para receber código...');
            await radios[1].click();
            await sleep(1000);
          }
          // Clicar no botão de envio
          const sendBtn = await page.$('input[type="submit"], button[type="submit"], .a-button-input, input.a-button-input');
          if (sendBtn) {
            log.info('Clicando botão "Envie a senha de uso único" via SMS...');
            await sendBtn.click();
            await sleep(3000);
            await screenshot(page, 'stepup_after_send');
            log.info('Código SMS enviado para +5519*****8899 — aguardando usuário fornecer o código');
          } else {
            log.warn('Botão de envio não encontrado — aguardando código mesmo assim');
          }
        } catch (btnErr) {
          log.warn('Não foi possível clicar botão de envio: ' + btnErr.message);
        }

        const code = await waitForOtp(page);
        if (!code) {
          await browser.close();
          return { success: false, error: 'CVF/OTP timeout — envie código via /api/amazon-otp', platform: 'amazon' };
        }
        await sleep(4000);
        currentUrl = page.url();
        if (isAuthUrl(currentUrl)) {
          // Try full signin
          const ok = await doSignin(page);
          if (!ok) {
            await browser.close();
            return { success: false, error: 'Step-up auth falhou após OTP', platform: 'amazon' };
          }
        }
      } else {
        // Normal signin page
        const ok = await doSignin(page);
        if (!ok) {
          await screenshot(page, 'signin_failed');
          await browser.close();
          return { success: false, error: 'Step-up auth falhou (CVF/OTP — envie código via /api/amazon-otp)', platform: 'amazon' };
        }
      }
      // Navigate back to new title after signin
      for (const url of NEW_TITLE_URLS) {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await sleep(3000);
        currentUrl = page.url();
        if (!currentUrl.includes('/404') && !isAuthUrl(currentUrl)) break;
      }
      if (isAuthUrl(currentUrl)) {
        log.warn('Ainda em auth após signin: ' + currentUrl.slice(0, 80));
        await screenshot(page, 'still_signin');
        await browser.close();
        return { success: false, error: 'Amazon auth persistente — envie código via /api/amazon-otp', platform: 'amazon' };
      }
    }
    log.info('Etapa 1 URL: ' + currentUrl.slice(0, 80));
    await screenshot(page, 'step1_start');

    // ── STEP 0: Handle /create type-selection page ───────────────────────────
    // When direct new-title URLs return 404, KDP bookshelf "Create" button leads to /create
    // which is a type-selection page (Criar eBook / Criar livro com capa comum / etc).
    // We need to click "Criar eBook" to navigate to the actual details form.
    if (currentUrl.includes('/create') && !currentUrl.includes('title-setup')) {
      log.info('Tipo-seleção (/create) detectado — clicando Criar eBook...');
      const typeClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], .a-button-primary, a.a-button-anchor, span.a-button-text'));
        const btn = btns.find(e => {
          const t = (e.textContent || e.value || '').trim().toLowerCase();
          const r = e.getBoundingClientRect();
          return r.width > 0 && (t === 'criar ebook' || t === 'criar e-book' || t.includes('ebook') || t.includes('e-book'));
        });
        if (btn) { btn.click(); return (btn.textContent || btn.value || '').trim().slice(0,40); }
        // Fallback: first .a-button-primary is "Criar eBook"
        const firstBtn = document.querySelector('.a-button-primary .a-button-text, .a-button-primary input');
        if (firstBtn) { firstBtn.click(); return (firstBtn.textContent || firstBtn.value || '').slice(0,40); }
        return null;
      });
      log.info('Tipo-seleção clicado: ' + typeClicked);
      await sleep(3000);
      try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }); } catch {}
      await sleep(3000);
      currentUrl = page.url();
      log.info('Após tipo-seleção URL: ' + currentUrl.slice(0, 80));
      await screenshot(page, 'step1_after_type_select');
    }

    // ── STEP 1: Book details ─────────────────────────────────────────────────
    log.info('Etapa 1: Detalhes do livro');
    await sleep(3000); // let form render (extra time for new KDP SPA)

    // Debug: dump available inputs to understand the DOM structure
    const step1Debug = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
        .filter(el => {
          const r = el.getBoundingClientRect();
          return (r.width > 0 || el.type === 'hidden') && el.type !== 'checkbox' && el.type !== 'radio';
        })
        .map(el => ({
          tag: el.tagName, type: el.type, id: el.id, name: el.name,
          placeholder: el.placeholder, dataAttrs: Object.keys(el.dataset).join(','),
          rect: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)
        }));
      const buttons = Array.from(document.querySelectorAll('.a-button-primary, .a-button-submit, button[type="submit"]'))
        .map(el => ({tag: el.tagName, cls: el.className.slice(0,80), text: (el.textContent||'').trim().slice(0,40)}));
      return { inputs: inputs.slice(0,20), buttons: buttons.slice(0,5) };
    }).catch(() => ({}));
    log.info('Step1 DOM: inputs=' + JSON.stringify(step1Debug.inputs) + ' buttons=' + JSON.stringify(step1Debug.buttons));

    // Wait for the details form to render — at least one visible input required
    try {
      await page.waitForFunction(() => {
        const inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
        return Array.from(inputs).some(el => el.getBoundingClientRect().width > 0);
      }, { timeout: 15000 });
      log.info('Formulário de detalhes renderizado');
    } catch(e) {
      log.warn('Timeout esperando formulário renderizar: ' + e.message.slice(0,60));
    }

    // Language
    try {
      await page.select('select[name*="language" i], select[id*="language" i]', 'pt').catch(() => {});
    } catch {}

    // Title — exact KDP React ID first, then fallbacks
    // DOM dump confirmed: actual title field is #data-title (769×32), NOT the unnamed 244×32 input
    const titleFilled = await fillField(page, [
      '#data-title',
      'input[name="data[title]"]',
      'input[id*="title" i]:not([id*="sub" i]):not([id*="series" i]):not([id*="asin" i])',
      'input[name*="title" i]:not([name*="sub" i])',
      'input[placeholder*="título" i]',
      'input[placeholder*="title" i]',
      'input[data-a-input-name*="title" i]',
      'input[aria-label*="title" i]',
      '#data-asin-metadata-input-title',
      '#book_title',
    ], ebook.title);
    log.info('Title filled: ' + titleFilled);
    await sleep(300);

    // Subtitle (optional)
    if (ebook.subtitle) {
      await fillField(page, [
        '#data-subtitle',
        'input[id*="subtitle" i]',
        'input[name*="subtitle" i]',
        'input[placeholder*="subtítulo" i]',
      ], ebook.subtitle).catch(() => {});
      await sleep(300);
    }

    // Author — exact KDP field IDs from DOM dump:
    // first: #data-primary-author-first-name (placeholder="Nome")
    // last:  #data-primary-author-last-name  (placeholder="Sobrenome")
    const [authorFirst, authorLast] = (() => {
      const parts = AUTHOR_NAME.trim().split(/\s+/);
      return parts.length === 1 ? [parts[0], ''] : [parts[0], parts.slice(1).join(' ')];
    })();

    const authorFirstFilled = await fillField(page, [
      '#data-primary-author-first-name',
      'input[id*="author-first" i]',
      'input[id*="first_name" i]',
      'input[placeholder="Nome"]',
    ], authorFirst).catch(() => false);

    if (authorFirstFilled) {
      await fillField(page, [
        '#data-primary-author-last-name',
        'input[id*="author-last" i]',
        'input[id*="last_name" i]',
        'input[placeholder="Sobrenome"]',
      ], authorLast || '.').catch(() => {});
    } else {
      // Fallback: single author field
      await fillField(page, [
        'input[id*="author" i]',
        'input[name*="author" i]',
        'input[placeholder*="autor" i]',
      ], AUTHOR_NAME).catch(() => {});
    }
    log.info('Author filled: ' + authorFirstFilled + ' first="' + authorFirst + '" last="' + (authorLast||'.') + '"');
    await sleep(300);

    // Publishing rights — #non-public-domain = "own copyright / world rights"
    // DOM dump confirmed: id="non-public-domain" name="data-is-public-domain"
    try {
      const pubRadio = await page.$('#non-public-domain');
      if (pubRadio) {
        await pubRadio.click();
        log.info('Publishing rights: own copyright clicked');
      } else {
        const radios = await page.$$('input[type="radio"][name*="public" i]');
        if (radios.length > 0) { await radios[0].click(); log.info('Publishing rights fallback radio clicked'); }
        else log.warn('Publishing rights radio not found');
      }
    } catch(e) { log.warn('Publishing rights click error: ' + e.message); }
    await sleep(500);

    // Adult content — answer "Não" (index 1) BEFORE categories become available
    // DOM dump: name="data[is_adult_content]-radio" — index 0=Sim, index 1=Não
    try {
      const adultRadios = await page.$$('input[name="data[is_adult_content]-radio"]');
      log.info('Adult content radios found: ' + adultRadios.length);
      if (adultRadios.length >= 2) {
        await adultRadios[1].click();
        log.info('Adult content: Não clicked (index 1)');
      } else if (adultRadios.length === 1) {
        await adultRadios[0].click();
        log.info('Adult content: only 1 radio found, clicked index 0');
      } else {
        log.warn('Adult content radios not found on page');
      }
    } catch(e) { log.warn('Adult content click error: ' + e.message); }
    await sleep(1500); // wait for category button to unlock after answering

    // Description
    const desc = (ebook.description || ('Guia completo sobre ' + ebook.title)).slice(0, 4000);
    await fillDescription(page, desc);
    await sleep(400);

    // Keywords (up to 7) — KDP IDs: #data-keywords-0 through #data-keywords-6
    const kw = (ebook.keywords || ebook.topic || ebook.title);
    const kwArr = typeof kw === 'string' ? kw.split(',').map(k => k.trim()).slice(0, 7) : [String(kw)];
    for (let i = 0; i < kwArr.length; i++) {
      await fillField(page, [
        `#data-keywords-${i}`,
        `input[id*="keyword-${i}" i]`,
        `input[name*="keyword${i}" i]`,
        `input[id*="keywords-${i}" i]`,
        `#search-keywords-${i}`,
      ], kwArr[i]).catch(() => {});
    }
    await sleep(300);

    // Categories — click "Escolha as categorias" → navigate modal → select + confirm
    try {
      // First scroll down to the category section so it's in viewport
      await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label, h2, h3, .a-form-label, legend'));
        const catLabel = labels.find(el => (el.textContent || '').toLowerCase().includes('categor'));
        if (catLabel) catLabel.scrollIntoView({ behavior: 'instant', block: 'center' });
      }).catch(() => {});
      await sleep(800);

      // Find the category chooser button — exclude toast notifications (idioma/language warnings)
      // and sidebar links (Adicionar à série etc). Button must be in main form area.
      const allHandles = await page.$$('button, a, [role="button"], span.a-button-text');
      let catBtnClicked = false;
      for (const h of allHandles) {
        let info;
        try {
          info = await h.evaluate(el => {
            const t = (el.textContent || '').toLowerCase().trim();
            const r = el.getBoundingClientRect();
            return { t, x: r.x, vis: r.width > 0 && r.height > 0 && r.height < 80, childCount: el.children.length };
          });
        } catch { continue; }
        const isToast = info.t.includes('idioma') || info.t.includes('language') || info.t.includes('série');
        const isMainArea = info.x > 200; // exclude left sidebar
        if (info.vis && info.childCount <= 3 && isMainArea && !isToast &&
            (info.t === 'adicionar categoria' || info.t === 'add a category' ||
             info.t.includes('adicionar categoria') || info.t.includes('add a category') ||
             (info.t.includes('escolha') && info.t.includes('categor')) ||
             (info.t.includes('choose') && info.t.includes('categor')))) {
          await h.click();
          catBtnClicked = true;
          log.info('Category button clicked: "' + info.t.slice(0, 50) + '"');
          break;
        }
      }

      if (catBtnClicked) {
        await sleep(2500);
        await screenshot(page, 'step1_cat_modal');

        // Determine topic-based category priorities for KDP's category tree
        const topicStr = ((ebook.topic || ebook.title || '') + ' ' + (ebook.description || '')).toLowerCase();
        const catPriorities = [];
        if (/negoc|empreend|startup|gestão|administr/.test(topicStr))      catPriorities.push('negócios', 'business');
        if (/financ|invest|dinheiro|poupanç|renda/.test(topicStr))         catPriorities.push('finanças pessoais', 'financial');
        if (/saúde|saude|dieta|alimentaç|nutriç|emagr/.test(topicStr))     catPriorities.push('saúde', 'health', 'dieta');
        if (/autoajuda|auto-ajuda|motivaç|psicolog/.test(topicStr))        catPriorities.push('autoajuda', 'self-help');
        if (/tecnolog|programaç|software|digital/.test(topicStr))          catPriorities.push('computadores', 'tecnologia');
        // Always include broad fallbacks
        catPriorities.push('não-ficção', 'nonfiction', 'educação', 'negócios');

        // Multi-level category navigation — loop until leaf node is reached (up to 6 levels).
        // Tracks already-clicked items to skip parent nodes in both expandable and replacement tree UIs.
        const catClickedTexts = new Set();
        let catLeafReached = false;
        for (let catLevel = 1; catLevel <= 6; catLevel++) {
          await sleep(1500);
          const levelResult = await page.evaluate((alreadyClicked, lvl, priorities) => {
            const modal = document.querySelector(
              '[role="dialog"], .a-modal-wrapper, .a-modal-body, .a-popover-content, [class*="category-modal"], [class*="CategoryModal"]'
            );
            if (!modal) {
              if (lvl === 1) {
                const allClickable = Array.from(document.querySelectorAll('li, [role="option"], [role="treeitem"], button, a'))
                  .filter(el => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 5 && r.height < 80; });
                return 'no-modal-l1: ' + allClickable.map(e => (e.textContent||'').trim().slice(0,20)).join(' | ').slice(0,200);
              }
              return 'no-modal';
            }
            const items = Array.from(modal.querySelectorAll('li, [role="option"], [role="treeitem"], a, button, span, label'))
              .filter(el => {
                const r = el.getBoundingClientRect();
                const t = (el.textContent||'').trim().toLowerCase();
                if (!t || t.length < 3 || t.length > 80) return false;
                // Skip section header labels
                if (t === 'categorias' || t === 'categories' || t === 'categoria' || t === 'category') return false;
                // Skip help/info text
                if (t.includes('dica') || t.includes('tip') || t.includes('help') || t.includes('escolher') || t.includes('choose')) return false;
                // Skip buttons that reopen modal or navigate away
                if (t.includes('outra categoria') || t.includes('another category')) return false;
                if (t.includes('salvar categor') || t.includes('save categor')) return false;
                if (t.includes('série') || t.includes('serie') || t.includes('series')) return false;
                // Skip bare action-button labels (handled in confirm step)
                if (t === 'adicionar' || t === 'add' || t === 'selecionar' || t === 'select' || t === 'confirmar' || t === 'confirm' || t === 'ok') return false;
                // Skip items we already clicked in a previous level
                if (alreadyClicked.includes(t)) return false;
                if (r.width <= 30 || r.height <= 5 || r.height >= 100) return false;
                if (el.children.length > 4) return false;
                return true;
              });
            if (items.length === 0) return 'leaf-reached'; // no new items → leaf node
            // Try priority categories first, then fall back to first item
            for (const prio of priorities) {
              const el = items.find(e => (e.textContent||'').toLowerCase().includes(prio));
              if (el) { el.click(); return 'l' + lvl + '-priority:' + (el.textContent||'').trim().slice(0,50); }
            }
            items[0].click();
            return 'l' + lvl + ':' + (items[0].textContent||'').trim().slice(0,50);
          }, Array.from(catClickedTexts), catLevel, catPriorities).catch(() => 'err-l' + catLevel);

          log.info('Category level ' + catLevel + ': ' + levelResult);

          if (levelResult === 'leaf-reached' || levelResult === 'no-modal') {
            catLeafReached = (levelResult === 'leaf-reached');
            break;
          }
          if (levelResult.startsWith('err') || levelResult.startsWith('no-modal-l1')) break;
          // Track clicked text so we skip it on the next level
          const colonIdx = levelResult.indexOf(':');
          if (colonIdx >= 0) catClickedTexts.add(levelResult.slice(colonIdx + 1).toLowerCase().trim());
        }
        if (catLeafReached) log.info('Category navigation: leaf node reached after ' + catClickedTexts.size + ' levels, path: ' + Array.from(catClickedTexts).join(' → '));

        // Confirm / Add button — search ONLY inside the modal; prefer short/exact "Adicionar" over "Adicionar outra categoria"
        const confirmClicked = await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"], .a-modal-wrapper, .a-modal-body, .a-popover-content, .a-popover-wrapper');
          const searchRoot = modal || null;
          if (!searchRoot) return null; // No modal open — categories may not need explicit confirm
          const allBtns = Array.from(searchRoot.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"], .a-button-text'))
            .filter(el => {
              const r = el.getBoundingClientRect();
              const t = (el.textContent||el.value||'').toLowerCase().trim();
              // Exclude links that keep modal open ("outra categoria") or sidebar links ("série")
              if (t.includes('série') || t.includes('serie') || t.includes('series')) return false;
              if (t.includes('outra categoria') || t.includes('another category')) return false;
              return r.width > 0 && r.height > 0;
            });
          // Try short/exact matches first, then broader
          const addTexts = ['adicionar', 'add', 'selecionar', 'select', 'confirmar', 'confirm', 'ok', 'salvar'];
          for (const t of addTexts) {
            // Prefer shorter text (closer to exact match)
            const candidates = allBtns.filter(el => (el.textContent||el.value||'').toLowerCase().trim().includes(t));
            if (candidates.length > 0) {
              candidates.sort((a, b) => (a.textContent||a.value||'').length - (b.textContent||b.value||'').length);
              candidates[0].click();
              return (candidates[0].textContent||candidates[0].value||'').trim().slice(0,40);
            }
          }
          return null;
        }).catch(() => null);
        log.info('Category confirm: ' + confirmClicked);
        await sleep(1000);

        // Close any category modal that might still be open (e.g., "Adicionar outra categoria" reopened it)
        // MUST happen before clicking "Salvar e continuar" to avoid the modal blocking the save button
        try {
          const modalStillOpen = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], .a-modal-wrapper, .a-popover-wrapper, .a-modal');
            if (!modal || modal.getBoundingClientRect().width === 0) return false;
            const closeSelectors = ['[aria-label="Fechar"]', '[aria-label="Close"]', '[aria-label="close"]', '.a-modal-close', '.a-icon-close'];
            for (const sel of closeSelectors) {
              const btn = modal.querySelector(sel); if (btn) { btn.click(); return 'closed:' + sel; }
            }
            const xBtn = Array.from(modal.querySelectorAll('button, span, a')).find(e => {
              const t = (e.textContent || '').trim(); return t === '×' || t === 'X' || t === '✕' || t === 'Fechar';
            });
            if (xBtn) { xBtn.click(); return 'closed:X'; }
            return 'modal-open-no-close';
          });
          if (modalStillOpen) { log.info('Category modal closed after confirm: ' + modalStillOpen); await sleep(1000); }
        } catch(e) { /* ignore */ }
        await page.keyboard.press('Escape').catch(() => {});
      } else {
        log.warn('Category button not found — form may reject without category');
      }
    } catch(e) { log.warn('Category selection error: ' + e.message.slice(0, 80)); }

    await screenshot(page, 'step1_filled');

    // Save and continue (Step 1 → Step 2)
    // KDP is a SPA — "Salvar e continuar" either does a server POST (full reload to same URL)
    // or triggers an AJAX + React re-render on the same page. URL never changes between steps.
    const step1Url = page.url();
    const step1ok = await clickKdpButton(page, [
      'Salvar e continuar', 'Save and continue', 'Salvar e Continuar',
      'Continuar', 'Continue', 'Próximo', 'Next', 'Salvar',
    ]);
    if (step1ok) {
      // If KDP does a full server-side POST reload, waitForNavigation will catch it
      try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    }
    // Extended wait for SPA re-render (execution context may be briefly destroyed during React updates)
    await sleep(4000);

    // Check for Step 1 validation errors that prevented the form from saving
    try {
      const validationErrors = await page.evaluate(() => {
        const selectors = ['.a-alert-content', '.a-color-error', '[class*="error-message" i]',
                           '.a-box-error', '[role="alert"]', '.a-alert-error'];
        const errors = [];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            const r = el.getBoundingClientRect();
            const t = (el.textContent||'').trim();
            if (r.width > 0 && t.length > 3 && t.length < 300) errors.push(t.slice(0, 150));
          });
        }
        return [...new Set(errors)]; // dedupe
      });
      if (validationErrors.length > 0) log.warn('Step 1 validation errors: ' + JSON.stringify(validationErrors));
    } catch(e) { /* ignore */ }

    // ── Close any unexpected modal that opened during Step 1 (e.g., "Adicionar à série") ──
    try {
      const modalClosed = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], .a-modal-wrapper, .a-popover-wrapper, .a-modal');
        if (!modal || modal.getBoundingClientRect().width === 0) return false;
        // Try close button / X button inside modal
        const closeSelectors = [
          '[aria-label="Fechar"]', '[aria-label="Close"]', '[aria-label="close"]',
          '.a-modal-close', '.a-icon-close', 'button.a-button-close',
        ];
        for (const sel of closeSelectors) {
          const btn = modal.querySelector(sel);
          if (btn) { btn.click(); return 'closed:' + sel; }
        }
        // Find × / X button by text
        const xBtn = Array.from(modal.querySelectorAll('button, span, a')).find(e => {
          const t = (e.textContent || '').trim();
          return t === '×' || t === 'X' || t === '✕' || t === 'Fechar';
        });
        if (xBtn) { xBtn.click(); return 'closed:X'; }
        return 'modal-found-no-close';
      });
      if (modalClosed) {
        log.info('Step1 modal fechado: ' + modalClosed);
        await sleep(1500);
      }
    } catch(e) { log.warn('Modal close err: ' + e.message.slice(0, 50)); }
    // Also press Escape to dismiss any remaining overlay
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(2000);

    // Wait for Step 2 upload content — check body text, NOT just file input visibility
    // KDP file inputs are always hidden (display:none), triggered by button click
    try {
      await page.waitForFunction(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return text.includes('drm') ||
               text.includes('manuscrito') || text.includes('manuscript') ||
               text.includes('conteúdo do kindle') || text.includes('kindle content') ||
               text.includes('carregar') || text.includes('upload') ||
               document.querySelectorAll('input[type="file"]').length > 0;
      }, { timeout: 30000 });
      log.info('Step 2 conteúdo detectado');
    } catch (e) {
      log.warn('Step 2 detect timeout: ' + e.message.slice(0, 60));
      // If still on Step 1 /details with a real ASIN, navigate directly to /content (Step 2)
      try {
        const currentUrl = page.url();
        const asinMatch = currentUrl.match(/\/title-setup\/kindle\/([A-Z0-9]{10,})\//);
        if (asinMatch && currentUrl.includes('/details')) {
          const asin = asinMatch[1];
          const contentUrl = currentUrl.replace(/\/details(\?.*)?$/, '/content');
          log.info('Step1→2 direto: ASIN=' + asin + ' navigando para ' + contentUrl.slice(0, 80));
          await page.goto(contentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(3000);
          log.info('Step 2 URL após navegação direta: ' + page.url().slice(0, 80));
        }
      } catch (navErr) {
        log.warn('Step1→2 nav failed: ' + navErr.message.slice(0, 60));
      }
    }

    await screenshot(page, 'step2_start');
    log.info('Etapa 2 URL: ' + page.url().slice(0, 80));

    // ── STEP 2: Content upload ───────────────────────────────────────────────
    log.info('Etapa 2: Upload de conteúdo');

    // DRM — select "no DRM"
    try {
      await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const r of radios) {
          const v = (r.value || r.id || '').toLowerCase();
          if (v.includes('no_drm') || v.includes('none') || v.includes('false') || v === '0') {
            r.click();
            break;
          }
        }
      });
      await sleep(300);
    } catch {}

    // Debug step 2 DOM — retry up to 3× (execution context can be briefly destroyed during SPA updates)
    let step2Debug = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        step2Debug = await page.evaluate(() => {
          const allInputs = Array.from(document.querySelectorAll('input, textarea, select'))
            .map(el => ({ tag: el.tagName, type: el.type, id: el.id, name: el.name, accept: el.accept || '' }));
          const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
            .map(el => ({ name: el.name, id: el.id, accept: el.accept }));
          const btns = Array.from(document.querySelectorAll('button, label, .a-button-text, span.a-button-text'))
            .filter(el => el.getBoundingClientRect().width > 0)
            .map(el => (el.textContent || '').trim().slice(0, 40));
          const pageText = (document.body.innerText || '').slice(0, 300);
          return { allInputs: allInputs.slice(0, 20), fileInputs, visibleBtns: btns.slice(0, 10), pageText };
        });
        if (step2Debug.allInputs !== undefined) break;
      } catch (e) {
        log.warn('Step2 debug attempt ' + (attempt+1) + ' failed: ' + e.message.slice(0, 50));
        await sleep(3000);
      }
    }
    log.info('Step2 DOM: ' + JSON.stringify(step2Debug).slice(0, 600));

    // Upload manuscript (PDF)
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      log.info('Upload manuscrito: ' + ebook.pdfPath);
      let msUploaded = false;

      // Approach 1: waitForFileChooser — intercept native file dialog triggered by upload button
      try {
        const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
        await page.evaluate(() => {
          const texts = ['carregar manuscrito', 'upload manuscript', 'upload your manuscript',
                         'selecionar arquivo', 'escolher arquivo', 'choose file', 'browse',
                         'manuscrito', 'manuscript', 'upload', 'arquivo'];
          const btns = Array.from(document.querySelectorAll('button, a, [role="button"], label, span.a-button-text'));
          for (const text of texts) {
            const btn = btns.find(el => (el.textContent || '').toLowerCase().includes(text) && el.getBoundingClientRect().width > 0);
            if (btn) { btn.click(); return true; }
          }
          // Fallback: click first visible label
          const anyLabel = Array.from(document.querySelectorAll('label')).find(el => el.getBoundingClientRect().width > 0);
          if (anyLabel) { anyLabel.click(); return true; }
          return false;
        });
        const chooser = await chooserPromise;
        await chooser.accept([ebook.pdfPath]);
        log.info('Manuscrito enviado via file chooser');
        msUploaded = true;
        await sleep(40000); // KDP takes ~40s to process PDF
        await screenshot(page, 'step2_after_manuscript');
      } catch(e) {
        log.info('File chooser ms failed: ' + e.message.slice(0, 60));
      }

      // Approach 2: direct uploadFile on hidden input (page.$() finds hidden inputs too)
      if (!msUploaded) {
        const msInput = await page.$([
          'input[type="file"][name*="book_file" i]',
          'input[type="file"][name*="manuscript" i]',
          'input[type="file"][id*="manuscript" i]',
          'input[type="file"][id*="book_file" i]',
          'input[type="file"][id*="contentFile" i]',
          'input[type="file"][accept*="pdf" i]',
          'input[type="file"]:not([name*="cover" i]):not([name*="image" i]):not([id*="cover" i]):not([id*="thumbnail" i])',
        ].join(','))
          .catch(() => null)
          ?? await page.$('input[type="file"]').catch(() => null);

        if (msInput) {
          await msInput.uploadFile(ebook.pdfPath);
          log.info('Manuscrito enviado via file input');
          msUploaded = true;
          await sleep(40000);
          await screenshot(page, 'step2_after_manuscript');
        } else {
          log.warn('Manuscript file input not found via page.$');
        }
      }

      // Approach 3: CDP DOM.setFileInputFiles — works even on hidden/detached inputs
      if (!msUploaded) {
        try {
          const client = await page.target().createCDPSession();
          const { root } = await client.send('DOM.getDocument', { depth: 1 });
          const { nodeId } = await client.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: 'input[type="file"]'
          });
          if (nodeId > 0) {
            await client.send('DOM.setFileInputFiles', { files: [ebook.pdfPath], nodeId });
            log.info('Manuscrito via CDP setFileInputFiles');
            msUploaded = true;
            await sleep(40000);
            await screenshot(page, 'step2_after_manuscript');
          } else {
            log.warn('CDP: no file input found in DOM');
          }
          await client.detach().catch(() => {});
        } catch(e) {
          log.warn('CDP ms upload failed: ' + e.message.slice(0, 80));
        }
      }
    }

    // Upload cover
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      log.info('Upload capa KDP...');
      let cvUploaded = false;

      // Approach 1: waitForFileChooser
      try {
        const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
        await page.evaluate(() => {
          const texts = ['carregar capa', 'upload cover', 'upload your cover', 'capa', 'cover',
                         'imagem', 'image', 'thumbnail', 'foto'];
          const btns = Array.from(document.querySelectorAll('button, a, [role="button"], label, span.a-button-text'));
          for (const text of texts) {
            const btn = btns.find(el => (el.textContent || '').toLowerCase().includes(text) && el.getBoundingClientRect().width > 0);
            if (btn) { btn.click(); return true; }
          }
          return false;
        });
        const chooser = await chooserPromise;
        await chooser.accept([ebook.coverPath]);
        log.info('Capa enviada via file chooser');
        cvUploaded = true;
        await sleep(8000);
        await screenshot(page, 'step2_after_cover');
      } catch(e) {
        log.info('File chooser cover failed: ' + e.message.slice(0, 60));
      }

      // Approach 2: direct input (KDP cover uses data[cover] name)
      if (!cvUploaded) {
        const coverInput = await page.$([
          'input[type="file"][name*="cover" i]',
          'input[type="file"][id*="cover" i]',
          'input[type="file"][accept*="image" i]',
          'input[type="file"][id*="thumbnail" i]',
          'input[type="file"][accept*="jpeg" i]',
          'input[type="file"][accept*="jpg" i]',
        ].join(','))
          .catch(() => null);

        if (coverInput) {
          await coverInput.uploadFile(ebook.coverPath);
          log.info('Capa enviada via file input');
          cvUploaded = true;
          await sleep(8000);
          await screenshot(page, 'step2_after_cover');
        } else {
          log.warn('Cover file input not found via page.$');
        }
      }

      // Approach 3: CDP DOM.setFileInputFiles for cover
      if (!cvUploaded) {
        try {
          const client = await page.target().createCDPSession();
          const { root } = await client.send('DOM.getDocument', { depth: 1 });
          // Try cover-specific selectors first
          const coverSelectors = [
            'input[type="file"][name*="cover" i]',
            'input[type="file"][id*="cover" i]',
            'input[type="file"][accept*="image" i]',
          ];
          let coverNodeId = 0;
          for (const sel of coverSelectors) {
            const res = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel }).catch(() => ({ nodeId: 0 }));
            if (res.nodeId > 0) { coverNodeId = res.nodeId; break; }
          }
          if (coverNodeId > 0) {
            await client.send('DOM.setFileInputFiles', { files: [ebook.coverPath], nodeId: coverNodeId });
            log.info('Capa via CDP setFileInputFiles');
            cvUploaded = true;
            await sleep(8000);
            await screenshot(page, 'step2_after_cover');
          } else {
            // Last resort: pick 2nd file input (first is manuscript)
            const { nodeIds } = await client.send('DOM.querySelectorAll', {
              nodeId: root.nodeId, selector: 'input[type="file"]'
            }).catch(() => ({ nodeIds: [] }));
            if (nodeIds.length >= 2) {
              await client.send('DOM.setFileInputFiles', { files: [ebook.coverPath], nodeId: nodeIds[1] });
              log.info('Capa via CDP setFileInputFiles (2nd input)');
              cvUploaded = true;
              await sleep(8000);
              await screenshot(page, 'step2_after_cover');
            } else {
              log.warn('CDP: no cover file input found');
            }
          }
          await client.detach().catch(() => {});
        } catch(e) {
          log.warn('CDP cover upload failed: ' + e.message.slice(0, 80));
        }
      }
    }

    const step2Url = page.url();
    const step2ok = await clickKdpButton(page, [
      'Salvar e continuar', 'Save and continue', 'Salvar e Continuar',
      'Continuar', 'Continue', 'Próximo', 'Next', 'Salvar',
    ]);
    if (step2ok) await waitForUrlChange(page, step2Url, 20000);
    await sleep(5000);
    await screenshot(page, 'step3_start');
    log.info('Etapa 3 URL: ' + page.url().slice(0, 80));

    // ── STEP 3: Pricing ──────────────────────────────────────────────────────
    log.info('Etapa 3: Precificação');

    // Publishing rights: worldwide
    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const r of radios) {
        const v = (r.value || '').toUpperCase();
        if (v === 'WORLD' || v === 'WORLDWIDE' || r.id?.toLowerCase().includes('worldwide')) {
          r.click(); break;
        }
      }
    }).catch(() => {});
    await sleep(300);

    // Royalty: 35% (compatible with all prices)
    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const r of radios) {
        const v = (r.value || '').toLowerCase();
        if (v.includes('35') || r.id?.toLowerCase().includes('35')) { r.click(); break; }
      }
    }).catch(() => {});
    await sleep(300);

    // Price in USD (KDP's primary marketplace for global)
    const priceUsd = Math.max(0.99, DEFAULT_PRICE * 0.18).toFixed(2);
    const priceFilled = await fillField(page, [
      'input[id*="us-price" i]', 'input[id*="us_price" i]',
      'input[id*="USD" i]', 'input[id*="usd" i]',
      'input[id*="price-USD" i]',
    ], priceUsd);
    log.info('USD price: $' + priceUsd + ' filled=' + priceFilled);
    await sleep(500);

    await screenshot(page, 'step3_pricing');

    // Publish!
    log.info('Publicando no KDP...');
    const step3Url = page.url();
    const published = await clickKdpButton(page, [
      'Publicar e-book Kindle', 'Publish Your Kindle eBook',
      'Salvar e publicar', 'Save and publish',
      'Publicar', 'Publish',
      'Salvar e continuar', 'Save and continue',
    ], 25000);
    if (published) await waitForUrlChange(page, step3Url, 15000);
    await sleep(6000);

    const finalUrl = page.url();
    // True "published" means: button was clicked AND either URL changed away from setup page
    // or we landed on bookshelf/confirmation. A URL still at new/details means it likely saved as draft.
    const urlChanged = !finalUrl.includes('/title-setup/kindle/new') && !finalUrl.includes('/pt_BR/create');
    const reallyPublished = published && urlChanged;
    log.info('Amazon KDP done! buttonClicked=' + published + ' urlChanged=' + urlChanged +
             ' published=' + reallyPublished + ' URL: ' + finalUrl.slice(0, 80));
    await screenshot(page, 'step3_done');

    // Save updated session
    await saveSession(page);

    await browser.close();
    return { success: reallyPublished, url: reallyPublished ? finalUrl : null, platform: 'amazon' };

  } catch (err) {
    log.error('Amazon error: ' + err.message);
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(LOGS_DIR, 'amazon_error.png') }).catch(() => {});
    } catch {}
    await browser.close().catch(() => {});
    return { success: false, error: err.message, platform: 'amazon' };
  }
}

module.exports = { publishToAmazon };
