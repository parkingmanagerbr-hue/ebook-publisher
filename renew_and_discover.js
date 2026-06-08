'use strict';
/**
 * renew_and_discover.js — Renova sessões (login manual no Chrome visível) E, já logado,
 * descobre a URL real do marketplace de afiliados + dumpa os seletores de card de produto.
 *
 * Uso: node renew_and_discover.js [hotmart|cakto|all]
 * Perfis persistentes => próximas execuções não pedem login.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: __dirname + '/.env' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = __dirname;
const SESSIONS = path.join(BASE, 'data/sessions');
const CHROME = process.env.CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TMP = 'C:/Users/m_rov/AppData/Local/Temp';
const which = (process.argv[2] || 'all').toLowerCase();

function log(m) { console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${m}`); }

const DOMAIN_RE = { hotmart: /hotmart\.com$/i, cakto: /cakto\.com\.br$/i };

async function saveSession(page, platform) {
  // CDP getAllCookies captura TODOS os cookies (inclui dominio do SSO httpOnly) — essencial p/ headless.
  let cookies;
  try {
    const client = await page.target().createCDPSession();
    const { cookies: all } = await client.send('Network.getAllCookies');
    const re = DOMAIN_RE[platform];
    cookies = re ? all.filter(c => re.test((c.domain || '').replace(/^\./, ''))) : all;
  } catch (_) {
    cookies = await page.cookies();
  }
  let localStorage = {};
  try {
    localStorage = await page.evaluate(() => {
      const o = {}; for (let i = 0; i < window.localStorage.length; i++) { const k = window.localStorage.key(i); o[k] = window.localStorage.getItem(k); } return o;
    });
  } catch (_) {}
  const file = path.join(SESSIONS, platform + '.json');
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ platform, savedAt: Date.now(), savedAtHuman: new Date().toLocaleString('pt-BR'), url: page.url(), cookies, localStorage }, null, 2));
  log(`[${platform}] sessão salva: ${cookies.length} cookies`);
}

async function waitForLogin(page, platform, isLoggedIn, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page).catch(() => false)) { log(`[${platform}] login detectado: ${page.url().slice(0, 70)}`); return true; }
    log(`[${platform}] aguardando login... (${page.url().slice(0, 70)})`);
    await sleep(4000);
  }
  return false;
}

// dump dos candidatos a "card de produto"
async function dumpCards(page) {
  return page.evaluate(() => {
    const counts = {}, sample = {};
    document.querySelectorAll('*').forEach(el => {
      (typeof el.className === 'string' ? el.className.split(/\s+/) : []).forEach(c => {
        if (c && /product|card|item|market|afili|affili|comiss|commission|offer|oferta|produto/i.test(c)) {
          counts[c] = (counts[c] || 0) + 1;
          if (!sample[c]) sample[c] = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 55);
        }
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([c, n]) => ({ c, n, ex: sample[c] }));
  });
}

// varre a página por links/itens de menu que pareçam afiliados/marketplace
async function discoverAffiliateLinks(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (/afili|affili|market|produt|loja|catalog/i.test(href + ' ' + txt)) {
        out.push({ href, txt });
      }
    });
    // dedup
    const seen = new Set();
    return out.filter(x => { const k = x.href; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
  });
}

async function handlePlatform(platform, opts) {
  log(`\n===== ${platform.toUpperCase()} =====`);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    userDataDir: path.join(TMP, platform + '_profile'),
    args: ['--no-sandbox', '--start-maximized'], defaultViewport: null,
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.goto(opts.home, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await sleep(4000);

    if (!(await opts.isLoggedIn(page).catch(() => false))) {
      log(`[${platform}] >>> FAÇA LOGIN na janela do Chrome que abriu (você tem 5 min) <<<`);
      const ok = await waitForLogin(page, platform, opts.isLoggedIn);
      if (!ok) { log(`[${platform}] timeout — abortando`); return; }
    } else {
      log(`[${platform}] já logado (perfil persistente)`);
    }
    await sleep(2000);
    await saveSession(page, platform);

    // descobrir links de afiliado/marketplace a partir do dashboard
    log(`[${platform}] descobrindo links de afiliados/marketplace...`);
    const links = await discoverAffiliateLinks(page);
    links.forEach(l => log(`   link: ${l.href}   "${l.txt}"`));

    // tentar as URLs candidatas conhecidas + descobertas
    const candidates = [...new Set([...(opts.marketUrls || []), ...links.map(l => {
      try { return new URL(l.href, page.url()).href; } catch { return null; }
    }).filter(Boolean)])];

    for (const url of candidates) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (e) { continue; }
      await sleep(3500);
      const finalUrl = page.url();
      if (/\/404|\/login|\/auth|sso\./i.test(finalUrl)) { log(`   [skip] ${url} -> ${finalUrl.slice(0,60)}`); continue; }
      for (let s = 0; s < 4; s++) { await page.evaluate(() => window.scrollBy(0, 700)); await sleep(700); }
      const cards = await dumpCards(page);
      log(`\n   >>> MARKETPLACE: ${finalUrl}`);
      log(`       title="${await page.title()}"`);
      cards.forEach(c => log(`       .${c.c} x${c.n}  | ${c.ex}`));
      const shot = path.join(BASE, `mkt_${platform}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      log(`       screenshot: ${path.basename(shot)}`);
      if (cards.length > 2) break; // achou conteúdo de produtos
    }
  } finally {
    await sleep(1500);
    await browser.close().catch(() => {});
  }
}

(async () => {
  if (which === 'hotmart' || which === 'all') {
    await handlePlatform('hotmart', {
      home: 'https://app.hotmart.com/market',
      isLoggedIn: async p => { const u = p.url(); return /app\.hotmart\.com/.test(u) && !/\/login|\/auth|sso\./i.test(u); },
      marketUrls: ['https://app.hotmart.com/market', 'https://app.hotmart.com/market/search'],
    });
  }
  if (which === 'cakto' || which === 'all') {
    await handlePlatform('cakto', {
      home: 'https://app.cakto.com.br/',
      isLoggedIn: async p => { const u = p.url(); return /cakto\.com\.br/.test(u) && !/\/login|\/auth|sso\.|\/404/i.test(u); },
      marketUrls: ['https://app.cakto.com.br/affiliate/marketplace', 'https://app.cakto.com.br/marketplace'],
    });
  }
  log('\nDONE — sessões renovadas e marketplace mapeado.');
  process.exit(0);
})().catch(e => { log('FATAL ' + e.message); process.exit(1); });
