'use strict';
/**
 * hotmailOtpPuppeteer.js — Autonomous Hotmail/Outlook OTP reader via Puppeteer.
 *
 * Replaces the broken IMAP approach (Microsoft disabled basic-auth IMAP for personal
 * Hotmail accounts). Uses a headless browser to log into outlook.live.com,
 * search for the most recent Cakto 2FA email, and extract the 6-digit code.
 *
 * Design:
 *  - Saves an Outlook session file so login is only needed once / on session expiry
 *  - Full login flow with email + password + "Stay signed in" if session is missing
 *  - Circuit breaker: stops retrying after repeated failures to avoid hammering Outlook
 *  - Same Puppeteer args as other publishers (--no-sandbox for VPS/Docker)
 *
 * Config via env:
 *   HOTMAIL_EMAIL     default CAKTO_EMAIL || "mrovariz@hotmail.com"
 *   HOTMAIL_PASSWORD  default CAKTO_PASSWORD || ""
 *   HOTMAIL_SESSION_FILE  default "/app/data/sessions/hotmail.json"
 */

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const sleep     = ms => new Promise(r => setTimeout(r, ms));

let log;
try {
  const L = require('../core/Logger');
  log = L.createLogger ? L.createLogger('hotmailOtp') : null;
} catch {}
if (!log) log = {
  info:  (...a) => console.log('[hotmailOtp]',  ...a),
  warn:  (...a) => console.warn('[hotmailOtp]', ...a),
  error: (...a) => console.error('[hotmailOtp]', ...a),
};

// ── Config ────────────────────────────────────────────────────────────────────
function cfg() {
  return {
    email:    process.env.HOTMAIL_EMAIL    || process.env.CAKTO_EMAIL    || 'mrovariz@hotmail.com',
    password: process.env.HOTMAIL_PASSWORD || process.env.CAKTO_PASSWORD || '',
    session:  process.env.HOTMAIL_SESSION_FILE || '/app/data/sessions/hotmail.json',
  };
}

// ── Circuit breaker ────────────────────────────────────────────────────────────
let _blockedUntil       = 0;
let _consecutiveFails   = 0;

function isAvailable() {
  if (Date.now() < _blockedUntil) return false;
  const c = cfg();
  return !!(c.email && c.password);
}

/** Extract the first standalone 6-digit code from a text string. */
function extractCode(text) {
  if (!text) return null;
  const m = text.match(/(?<!\d)(\d{6})(?!\d)/);
  return m ? m[1] : null;
}

// ── Session helpers ────────────────────────────────────────────────────────────
function loadSession() {
  try {
    const c = cfg();
    if (!fs.existsSync(c.session)) return null;
    const data = JSON.parse(fs.readFileSync(c.session, 'utf8'));
    // Consider sessions good for 7 days
    if (data.savedAt && Date.now() - data.savedAt > 7 * 24 * 3600 * 1000) {
      log.warn('Sessão Hotmail com mais de 7 dias — reloginando');
      return null;
    }
    return data;
  } catch { return null; }
}

function saveSession(cookies) {
  try {
    const c = cfg();
    fs.mkdirSync(path.dirname(c.session), { recursive: true });
    fs.writeFileSync(c.session, JSON.stringify({ savedAt: Date.now(), cookies }, null, 2));
    log.info('Sessão Hotmail salva (' + cookies.length + ' cookies)');
  } catch (e) { log.warn('Erro ao salvar sessão Hotmail: ' + e.message); }
}

// ── Puppeteer browser launcher ─────────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
}

// ── Login to Outlook ───────────────────────────────────────────────────────────
async function loginToOutlook(page, email, password) {
  log.info('Hotmail: fazendo login em login.live.com...');

  // IMPORTANT: navigating to outlook.live.com/mail when unauthenticated redirects to
  // the Microsoft 365 MARKETING page (no login form). Go straight to the Microsoft
  // account sign-in endpoint, which always presents the email/loginfmt field.
  await page.goto('https://login.live.com/login.srf?wa=wsignin1.0&rpsnv=13&ct=0&rver=7.0.6738.0&wp=MBI_SSL&wreply=https%3A%2F%2Foutlook.live.com%2Fowa%2F', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(() => {});
  await sleep(2500);

  let url = page.url();
  // If already on inbox (session cookie worked), we're done
  if (url.includes('outlook.live.com/mail') && !url.includes('login') && !url.includes('login.live.com')) {
    log.info('Hotmail: sessão válida, já está logado');
    return true;
  }

  // Sign in page — may be at login.live.com/login.srf or login.microsoftonline.com
  log.info('Hotmail: página de login detectada: ' + url.slice(0, 80));

  // Step 1: Enter email — if the field isn't present, retry with the bare login URL once
  try {
    await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 15000 });
  } catch {
    log.warn('Hotmail: campo de email não encontrado — tentando login.live.com direto');
    await page.goto('https://login.live.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    try {
      await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 15000 });
    } catch {
      log.warn('Hotmail: campo de email não encontrado em 15s (2ª tentativa) — URL: ' + page.url().slice(0, 80));
      return false;
    }
  }
  await page.type('input[type="email"], input[name="loginfmt"]', email, { delay: 50 });
  await sleep(500);

  // Click "Next" / "Avançar"
  const nextClicked = await page.evaluate(() => {
    const next = document.querySelector('input[type="submit"], button[type="submit"], #idSIButton9, input#idSIButton9');
    if (next) { next.click(); return true; }
    return false;
  });
  if (!nextClicked) {
    await page.keyboard.press('Enter');
  }
  await sleep(3000);

  // Step 2: Enter password
  try {
    await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 15000 });
  } catch {
    log.warn('Hotmail: campo de senha não encontrado');
    return false;
  }
  await page.type('input[type="password"], input[name="passwd"]', password, { delay: 50 });
  await sleep(500);

  // Click "Sign in"
  const signInClicked = await page.evaluate(() => {
    const btn = document.querySelector('input[type="submit"], button[type="submit"], #idSIButton9, input#idSIButton9');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!signInClicked) {
    await page.keyboard.press('Enter');
  }
  await sleep(4000);

  // Step 3: "Stay signed in?" prompt — click Yes/Sim
  const stayUrl = page.url();
  if (stayUrl.includes('kmsi') || stayUrl.includes('Stay') || stayUrl.includes('keepMeSignedIn')) {
    log.info('Hotmail: prompt "Stay signed in?" — clicando Sim');
    await page.evaluate(() => {
      const yes = document.querySelector('#idSIButton9, input[type="submit"][value*="Yes"], button#acceptButton');
      if (yes) yes.click();
    });
    await sleep(3000);
  }

  // Check if we're now on the inbox
  try {
    await page.waitForFunction(
      () => window.location.href.includes('outlook.live.com/mail') && !window.location.href.includes('login'),
      { timeout: 20000 }
    );
  } catch {
    const finalUrl = page.url();
    log.warn('Hotmail: login pode ter falhado. URL: ' + finalUrl.slice(0, 100));
    // Check if we hit a 2FA/security challenge (can't handle those)
    if (finalUrl.includes('proof') || finalUrl.includes('verify') || finalUrl.includes('twofactor')) {
      log.warn('Hotmail: Microsoft pediu 2FA/prova de identidade — impossível continuar sem interação humana');
    }
    return false;
  }

  log.info('Hotmail: login bem-sucedido!');
  return true;
}

// ── Search inbox for Cakto OTP emails ─────────────────────────────────────────
async function findCaktoOtpEmail(page, maxAgeMs) {
  // Navigate to inbox search for cakto
  log.info('Hotmail: buscando email de verificação da Cakto...');

  // Use the Outlook search URL — search by sender/subject keyword
  await page.goto('https://outlook.live.com/mail/0/inbox', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  }).catch(() => {});
  await sleep(2000);

  // Wait for inbox to load
  try {
    await page.waitForFunction(
      () => document.readyState === 'complete' && !!document.querySelector('[placeholder*="Pesquisar" i], [placeholder*="Search" i], [aria-label*="Pesquisar" i], [aria-label*="Search" i]'),
      { timeout: 15000 }
    );
  } catch {}
  await sleep(1000);

  // Type "cakto" in search box and press Enter
  const searchTyped = await page.evaluate(() => {
    const searchBox = document.querySelector(
      '[placeholder*="Pesquisar" i], [placeholder*="Search" i], ' +
      '[aria-label*="Pesquisar" i], [aria-label*="Search" i], ' +
      'input[type="search"], input[role="searchbox"]'
    );
    if (!searchBox) return false;
    searchBox.focus();
    searchBox.click();
    return true;
  });

  if (!searchTyped) {
    log.warn('Hotmail: caixa de pesquisa não encontrada');
    // Try to get any email with cakto in its text from the visible inbox
    return await scanVisibleEmails(page, maxAgeMs);
  }

  await sleep(500);
  // Clear existing text and type "cakto"
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type('cakto', { delay: 60 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(3000);

  // Wait for search results to load
  try {
    await page.waitForFunction(
      () => {
        const items = document.querySelectorAll('[role="option"], [role="listitem"], [data-convid], [data-item-index]');
        return items.length > 0;
      },
      { timeout: 10000 }
    );
  } catch {
    log.info('Hotmail: sem resultados de pesquisa com seletores padrão — tentando scan via texto');
  }
  await sleep(1000);

  return await scanVisibleEmails(page, maxAgeMs);
}

// ── Scan visible emails in the list for OTP code ──────────────────────────────
async function scanVisibleEmails(page, maxAgeMs) {
  const sinceMs = Date.now() - maxAgeMs;

  // Try clicking the first email row that has "cakto" or looks like a verification email
  const clicked = await page.evaluate((sinceMs) => {
    // Outlook renders email rows as [role="option"] or with data-convid
    const rows = Array.from(document.querySelectorAll(
      '[role="option"], [data-convid], [class*="GG6"], [class*="mail-list-item"]'
    ));
    for (const row of rows) {
      const text = (row.textContent || '').toLowerCase();
      if (text.includes('cakto') || text.includes('verifica') || text.includes('código') ||
          text.includes('code') || text.includes('acesso')) {
        const r = row.getBoundingClientRect();
        if (r.width > 100 && r.height > 20) {
          row.click();
          return { found: true, text: text.slice(0, 100) };
        }
      }
    }
    return { found: false, rows: rows.length };
  }, sinceMs);

  if (!clicked.found) {
    log.info('Hotmail: nenhum email Cakto encontrado via seletor. Linhas visíveis: ' + (clicked.rows || 0));

    // Fallback: read all visible text and look for a 6-digit code
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const code = extractCode(pageText);
    if (code) {
      log.info('Hotmail: código encontrado no texto da página (fallback): ' + code);
      return code;
    }
    return null;
  }

  log.info('Hotmail: email Cakto clicado: "' + clicked.text.slice(0, 80) + '"');
  await sleep(2000);

  // Wait for email content to load in reading pane
  try {
    await page.waitForFunction(
      () => document.querySelector('[role="main"] [class*="body"], [aria-label*="Corpo" i], [aria-label*="Body" i], [class*="ReadingPane"]') !== null,
      { timeout: 8000 }
    );
  } catch {}
  await sleep(1000);

  // Extract OTP from the email body + subject
  const result = await page.evaluate(() => {
    const reading = document.querySelector(
      '[role="main"], [class*="ReadingPane"], [class*="reading-pane"], [aria-label*="Corpo" i]'
    );
    const text = reading ? reading.innerText : document.body.innerText;
    return { text: text.slice(0, 2000) };
  });

  const code = extractCode(result.text);
  if (code) {
    log.info('Hotmail: código OTP extraído do email: ' + code);
  } else {
    log.info('Hotmail: email aberto mas nenhum código encontrado. Texto: ' + result.text.slice(0, 200));
  }
  return code || null;
}

// ── Main exported function ─────────────────────────────────────────────────────
/**
 * Fetch the most recent Cakto OTP from Outlook via Puppeteer.
 * @param {object} opts
 * @param {number} opts.maxAgeMs  — Only consider emails newer than this (default 10 min)
 * @returns {Promise<string|null>}  6-digit code string or null
 */
async function fetchOtp({ maxAgeMs = 600_000 } = {}) {
  if (!isAvailable()) {
    if (Date.now() < _blockedUntil) {
      const mins = Math.ceil((_blockedUntil - Date.now()) / 60_000);
      log.warn('hotmailOtpPuppeteer desativado (circuit breaker) por ~' + mins + 'min');
    } else {
      log.warn('hotmailOtpPuppeteer: HOTMAIL_EMAIL/HOTMAIL_PASSWORD não configurados');
    }
    return null;
  }

  const c = cfg();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Inject saved session cookies (avoids login flow when possible)
    const session = loadSession();
    if (session && session.cookies && session.cookies.length > 0) {
      log.info('Hotmail: injetando ' + session.cookies.length + ' cookies de sessão...');
      // Navigate to outlook.live.com first so cookie domain is correct
      await page.goto('https://outlook.live.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(1000);
      for (const cookie of session.cookies) {
        try { await page.setCookie(cookie); } catch {}
      }
    }

    // Attempt to reach inbox (will redirect to login if session invalid)
    await page.goto('https://outlook.live.com/mail/0/inbox', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {});
    await sleep(2000);

    const afterGoto = page.url();
    const needsLogin = afterGoto.includes('login.live.com') ||
                       afterGoto.includes('login.microsoftonline') ||
                       afterGoto.includes('/login') ||
                       !afterGoto.includes('outlook.live.com/mail');

    if (needsLogin) {
      const ok = await loginToOutlook(page, c.email, c.password);
      if (!ok) {
        _consecutiveFails++;
        if (_consecutiveFails >= 2) {
          _blockedUntil = Date.now() + 15 * 60_000; // 15 min block
          log.warn('hotmailOtpPuppeteer: login falhou 2x — desativando por 15min');
        }
        return null;
      }
      // Save the new session
      const cookies = await page.cookies();
      saveSession(cookies);
    } else {
      log.info('Hotmail: sessão válida (sem login necessário). URL: ' + afterGoto.slice(0, 80));
    }

    const code = await findCaktoOtpEmail(page, maxAgeMs);
    _consecutiveFails = 0; // successful run resets breaker
    return code;

  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    _consecutiveFails++;
    if (_consecutiveFails >= 3) {
      _blockedUntil = Date.now() + 15 * 60_000;
      log.warn('hotmailOtpPuppeteer: ' + _consecutiveFails + ' falhas (' + msg.slice(0, 80) + ') — desativando por 15min');
    } else {
      log.warn('hotmailOtpPuppeteer: erro: ' + msg.slice(0, 120));
    }
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { fetchOtp, isAvailable, extractCode };
