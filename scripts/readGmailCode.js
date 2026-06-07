'use strict';
/**
 * readGmailCode.js — Lê o último código de verificação do Hotmart no Gmail
 * Conecta ao Chrome via CDP (Chrome DevTools Protocol) sem precisar de login.
 *
 * Pré-requisito: Chrome rodando com --remote-debugging-port=9222
 * OU: Chrome aberto normalmente (tenta conectar na porta 9222 primeiro,
 *     se falhar usa Puppeteer com perfil real)
 *
 * Uso: node scripts/readGmailCode.js
 * Saída: escreve o código em data/hotmart_code.txt
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const puppeteer = require('puppeteer');

const BASE        = path.join(__dirname, '..');
const CODE_FILE   = path.join(BASE, 'data', 'hotmart_code.txt');
const CHROME      = process.env.CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_PROFILE = 'C:/Users/m_rov/AppData/Local/Google/Chrome/User Data';
const GMAIL_SEARCH_URL = 'https://mail.google.com/mail/u/0/#search/from%3Ahotmart+C%C3%B3digo+de+verifica%C3%A7%C3%A3o';

fs.mkdirSync(path.dirname(CODE_FILE), { recursive: true });

const LOG = path.join(BASE, 'logs', 'readGmailCode.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const ls = fs.createWriteStream(LOG, { flags: 'a' });
function log(msg) { const l = `[${new Date().toISOString()}] ${msg}`; console.log(l); ls.write(l + '\n'); }

// Extract 6-digit code from Gmail page via Puppeteer
async function extractCodeFromPage(page) {
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => {});
  const result = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr.zA');
    const codes = [];
    rows.forEach(row => {
      const subject = row.querySelector('.y6')?.textContent || '';
      const m = subject.match(/C[oó]digo de verifica[cç][aã]o\s*[\|—]\s*(\d{6})/i);
      if (m) {
        const time = row.querySelector('.xW span')?.getAttribute('title') || '';
        codes.push({ code: m[1], subject: subject.trim(), time });
      }
    });
    return codes[0] || null; // Latest code first
  });
  return result;
}

// Method 1: Connect to Chrome via CDP (remote debugging port)
async function tryViaCDP() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:9222/json/list', (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', async () => {
        try {
          const tabs = JSON.parse(data);
          const gmailTab = tabs.find(t => t.url.includes('mail.google.com'));
          if (!gmailTab) { resolve(null); return; }

          log('[CDP] Gmail tab encontrado: ' + gmailTab.url.slice(0, 60));
          const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' }).catch(() => null);
          if (!browser) { resolve(null); return; }

          const pages = await browser.pages();
          const gmailPage = pages.find(p => p.url().includes('mail.google.com'));
          if (!gmailPage) { resolve(null); return; }

          // Navigate to search
          await gmailPage.goto(GMAIL_SEARCH_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));

          const result = await extractCodeFromPage(gmailPage).catch(() => null);
          await browser.disconnect();
          resolve(result);
        } catch(e) {
          log('[CDP] Erro: ' + e.message);
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

// Method 2: Use real Chrome profile (only works when Chrome is CLOSED)
async function tryViaProfile() {
  if (!fs.existsSync(CHROME_PROFILE)) return null;
  log('[Profile] Tentando com perfil real do Chrome...');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: CHROME_PROFILE,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--profile-directory=Default'],
    defaultViewport: { width: 1366, height: 768 },
  }).catch(e => { log('[Profile] Falhou: ' + e.message.slice(0,60)); return null; });

  if (!browser) return null;

  try {
    const page = await browser.newPage();
    await page.goto(GMAIL_SEARCH_URL, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    const url = page.url();
    log('[Profile] URL: ' + url.slice(0, 80));
    if (url.includes('/login') || url.includes('/signin') || url.includes('accounts.google.com')) {
      log('[Profile] Não autenticado com perfil real');
      await browser.close();
      return null;
    }

    const result = await extractCodeFromPage(page).catch(() => null);
    await browser.close();
    return result;
  } catch(e) {
    await browser.close().catch(() => {});
    return null;
  }
}

// Method 3: Use Gmail IMAP (requires App Password in env)
async function tryViaIMAP() {
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  const gmailEmail  = process.env.HOTMART_2FA_EMAIL || 'mrovariz@gmail.com';
  if (!appPassword) { log('[IMAP] GMAIL_APP_PASSWORD não configurado'); return null; }

  try {
    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
      host: 'imap.gmail.com', port: 993, secure: true,
      auth: { user: gmailEmail, pass: appPassword },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const messages = [];
      for await (const msg of client.fetch('1:*', { envelope: true }, { uid: false })) {
        const subject = msg.envelope.subject || '';
        const m = subject.match(/C[oó]digo de verifica[cç][aã]o\s*[\|—]\s*(\d{6})/i);
        if (m) messages.push({ code: m[1], date: msg.envelope.date, subject });
      }
      // Sort by date desc, get latest
      messages.sort((a, b) => new Date(b.date) - new Date(a.date));
      const latest = messages[0] || null;
      if (latest) log('[IMAP] Código encontrado: ' + latest.code);
      return latest;
    } finally {
      lock.release();
      await client.logout();
    }
  } catch(e) {
    log('[IMAP] Erro: ' + e.message.slice(0, 80));
    return null;
  }
}

async function getLatestHotmartCode() {
  log('=== Lendo código Hotmart do Gmail ===');

  // Try methods in order
  let result = null;

  result = await tryViaCDP();
  if (result) { log('[CDP] ✅ Código via CDP: ' + result.code); return result; }
  log('[CDP] Não disponível');

  result = await tryViaProfile();
  if (result) { log('[Profile] ✅ Código via Profile: ' + result.code); return result; }

  result = await tryViaIMAP();
  if (result) { log('[IMAP] ✅ Código via IMAP: ' + result.code); return result; }

  log('❌ Nenhum método funcionou');
  return null;
}

// Main
(async () => {
  const result = await getLatestHotmartCode();

  if (result) {
    fs.writeFileSync(CODE_FILE, result.code);
    log(`✅ Código ${result.code} salvo em ${CODE_FILE}`);
    console.log('CODE:' + result.code); // stdout for piping
    process.exit(0);
  } else {
    log('❌ Código não encontrado');
    process.exit(1);
  }
})();

module.exports = { getLatestHotmartCode };
