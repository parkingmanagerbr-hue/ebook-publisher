'use strict';
/**
 * hotmartFinalizeAgent — tira produtos Hotmart do estado RASCUNHO.
 *
 * Produtos criados pelo publisherHotmart nascem em DRAFT: aparecem no painel
 * mas não vendem. O "Finalizar cadastro" do SPA chama
 * POST /product/v1/product/{id}/approval, que aceita Bearer puro — então dá
 * pra rodar sem browser e sem cookies (logo, sem 2FA no VPS).
 *
 * Validado em 28/07/2026: DRAFT → ACTIVE / situation=APPROVE_PRODUCT.
 *
 * O token sai do localStorage do painel (chave oidc.user:...) e vale ~2 dias.
 * Quando expirar (401), renove HOTMART_ACCESS_TOKEN em
 * /opt/platform/secrets/ebook-publisher.runtime.env.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');
const { createLogger } = require('../core/logger');
const log = createLogger('hotmartFinalize');

const API = 'https://api-product.vulcano.hotmart.com';
const STATE_FILE = process.env.HOTMART_FINALIZE_STATE || '/app/data/hotmart_finalize_state.json';
const MAX_PER_RUN = parseInt(process.env.HOTMART_FINALIZE_MAX || '150', 10);
const DELAY_MS = parseInt(process.env.HOTMART_FINALIZE_DELAY || '1200', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

let _tokenMemoria = '';

// Arquivo de token: alternativa a variavel de ambiente.
//
// O access_token vive ~2 dias e a renovacao automatica via CAS parou de
// funcionar — a Hotmart amarra a sessao a origem, entao o TGT guardado no VPS
// e recusado (o CAS responde 404). O token novo so se obtem na maquina do
// login, lendo localStorage["token"] do navegador autenticado.
//
// Trocar variavel de ambiente exigiria RECRIAR o container, e segredo que mora
// dentro do container se perde nisso. Um arquivo permite renovar o token sem
// derrubar nada.
const TOKEN_FILE = process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt';

/**
 * Um JWT utilizavel: tres partes e `exp` no futuro.
 *
 * Precedencia cega por ordem de fonte nao serve aqui. O ambiente do container
 * tinha HOTMART_ACCESS_TOKEN com 42 caracteres — nem JWT era — e vencia o
 * arquivo com o token bom de 2.146. O agente reportava "token expirado (401)"
 * enquanto o token valido estava em disco, ao lado.
 */
function jwtUtilizavel(t) {
  if (!t || t.length < 100) return false;
  const partes = t.split('.');
  if (partes.length !== 3) return false;
  try {
    const p = JSON.parse(Buffer.from(partes[1], 'base64').toString());
    // 60s de folga: token que morre no meio do lote nao serve.
    return !p.exp || p.exp * 1000 > Date.now() + 60_000;
  } catch { return false; }
}

function token() {
  const candidatos = [_tokenMemoria, (process.env.HOTMART_ACCESS_TOKEN || '').trim()];
  try { candidatos.push(require('fs').readFileSync(TOKEN_FILE, 'utf8').trim()); } catch {}
  // Escolhe pelo que PRESTA, nao pela ordem da fonte.
  for (const c of candidatos) if (jwtUtilizavel(c)) return c;
  return '';
}

/**
 * Renova o access_token sozinho, sem senha e sem 2FA.
 *
 * O cookie hmSsoExp guarda um TGT do CAS que emite Service Tickets
 * indefinidamente. Resgatando um ST contra a URL de serviço REAL do app
 * (callbackAuthorize com redirect_uri=/auth/login — NÃO a de /logout, que
 * derruba a sessão), o SPA autentica e grava o token no localStorage.
 */
async function renovarToken() {
  const SESSION = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
  let sess;
  try { sess = JSON.parse(fs.readFileSync(SESSION, 'utf8')); }
  catch (e) { log.warn('[token] sessão ilegível: ' + e.message); return null; }

  const c = (sess.cookies || []).find(x => x.name === 'hmSsoExp');
  if (!c) { log.warn('[token] hmSsoExp ausente — não dá para renovar'); return null; }
  const tgt = String(c.value).split('|').slice(1).join('|');

  const svc = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize' +
    '?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d' +
    '&scope=openid+profile+authorities+email+user+address' +
    '&redirect_uri=' + encodeURIComponent('https://app.hotmart.com/auth/login?realm=hotmart&branding_id=bw') +
    '&response_type=code&response_mode=query&state=' + Math.abs(Date.now() | 0).toString(16) +
    '&client_name=CasOAuthClient';

  const st = await new Promise(res => {
    const body = 'service=' + encodeURIComponent(svc);
    const req = https.request({
      hostname: 'sso.hotmart.com', path: '/v1/tickets/' + tgt, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain', 'Content-Length': Buffer.byteLength(body) },
    }, r => { let d = ''; r.on('data', k => d += k); r.on('end', () => res({ status: r.statusCode, body: d.trim() })); });
    req.on('error', () => res(null));
    req.write(body); req.end();
  });
  if (!st || st.status !== 200 || !st.body) { log.warn('[token] CAS falhou: ' + (st ? st.status : 'sem resposta')); return null; }

  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true, executablePath: process.env.CHROME_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(svc + '&ticket=' + st.body, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(8000);
    await page.goto('https://app.hotmart.com/products/producer', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(10000);

    const novo = await page.evaluate(() => (localStorage.getItem('token') || '').replace(/^"|"$/g, '')).catch(() => '');
    if (!novo) { log.warn('[token] SPA não gravou token'); return null; }

    // Persiste sessão + TGT para a próxima renovação.
    // page.cookies() só devolve o domínio atual — os cookies do SSO
    // (sso.hotmart.com, httpOnly) se perdiam. CDP pega todos.
    let cookies;
    try {
      const cdp = await page.target().createCDPSession();
      const all = (await cdp.send('Network.getAllCookies')).cookies || [];
      cookies = all.filter(x => /hotmart\.com/i.test(x.domain));
    } catch (_) {
      cookies = await page.cookies();
    }
    const localStorage_ = await page.evaluate(() => {
      const o = {}; for (let i = 0; i < window.localStorage.length; i++) { const k = window.localStorage.key(i); o[k] = window.localStorage.getItem(k); } return o;
    }).catch(() => ({}));
    if (!cookies.find(x => x.name === 'hmSsoExp')) cookies.push(c);   // o CAS não devolve o TGT
    fs.writeFileSync(SESSION, JSON.stringify({
      platform: 'hotmart', savedAt: Date.now(), savedAtHuman: new Date().toLocaleString('pt-BR'),
      url: page.url(), cookies, localStorage: localStorage_,
    }, null, 2));

    _tokenMemoria = novo;
    log.info('[token] ✅ renovado via CAS (sem senha/2FA)');
    return novo;
  } catch (e) {
    log.warn('[token] erro: ' + e.message.slice(0, 90));
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function headers() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token(),
    Origin: 'https://app.hotmart.com',
    Referer: 'https://app.hotmart.com/',
  };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { done: [], failed: {} }; }
}

function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch (e) { log.warn('saveState: ' + e.message); }
}

/** Lista todos os produtos. A API ignora max/size: sempre 10 itens por página. */
async function listProducts() {
  if (!token()) throw new Error('HOTMART_ACCESS_TOKEN ausente');
  const all = [];
  for (let p = 1; p <= 300; p++) {
    let data;
    try {
      const r = await axios.get(API + '/product/v2/product?page=' + p, { headers: headers(), timeout: 30000 });
      data = r.data;
    } catch (e) {
      if (e.response && e.response.status === 401) throw new Error('token expirado (401) — renove HOTMART_ACCESS_TOKEN');
      log.warn('[finalize] página ' + p + ': ' + e.message.slice(0, 60));
      break;
    }
    if (!data || !data.data || !data.data.length) break;
    all.push(...data.data);
    if (data.size && all.length >= data.size) break;
    await sleep(200);
  }
  return all;
}

/** Envia um produto para aprovação. Retorna true se aceito. */
async function approveProduct(id) {
  await axios.post(API + '/product/v1/product/' + id + '/approval', {}, { headers: headers(), timeout: 30000 });
  return true;
}

/**
 * Sessão do wizard (cookies de app.hotmart.com) apodrece em ~1 dia mesmo com
 * TGT válido — e aí o publisherHotmart cai no login e falha TODA publicação.
 * Renova preventivamente quando o arquivo passa de 8h.
 */
async function refreshSessionIfStale() {
  const SESSION = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
  const MAX_AGE_MS = parseInt(process.env.HOTMART_SESSION_MAX_AGE_MS || String(8 * 3600 * 1000), 10);
  try {
    const j = JSON.parse(fs.readFileSync(SESSION, 'utf8'));
    const idade = Date.now() - (j.savedAt || 0);
    if (idade < MAX_AGE_MS) return false;
    log.info('[sessao] ' + (idade / 3600000).toFixed(1) + 'h — renovando preventivamente via CAS');
    return !!(await renovarToken());
  } catch (e) {
    log.warn('[sessao] ' + e.message.slice(0, 80));
    return false;
  }
}

async function finalizeDrafts() {
  const state = loadState();
  const done = new Set(state.done);
  const stats = { sent: 0, errors: 0, drafts: 0, remaining: 0 };

  await refreshSessionIfStale();

  let products;
  try { products = await listProducts(); }
  catch (e) {
    // Token expira ~2 dias. Em vez de parar, renova sozinho pelo TGT do CAS.
    if (/401|expirado|ausente/i.test(e.message)) {
      log.info('[finalize] token inválido — renovando via CAS...');
      const novo = await renovarToken();
      if (!novo) { log.warn('[finalize] renovação falhou: ' + e.message); return { error: e.message, ...stats }; }
      try { products = await listProducts(); }
      catch (e2) { log.warn('[finalize] após renovar: ' + e2.message); return { error: e2.message, ...stats }; }
    } else {
      log.warn('[finalize] ' + e.message);
      return { error: e.message, ...stats };
    }
  }

  const drafts = products.filter(p => p.status === 'DRAFT' && !done.has(p.id));
  stats.drafts = drafts.length;
  log.info('[finalize] ' + products.length + ' produtos | ' + drafts.length + ' rascunhos pendentes');
  if (!drafts.length) return stats;

  for (const p of drafts.slice(0, MAX_PER_RUN)) {
    try {
      await approveProduct(p.id);
      done.add(p.id);
      stats.sent++;
      log.info('[finalize] ✅ ' + p.id + ' "' + (p.name || '').slice(0, 45) + '"');
    } catch (e) {
      const st = e.response ? e.response.status : 0;
      if (st === 401) {
        log.warn('[finalize] token expirou no meio da rodada — parando');
        break;
      }
      stats.errors++;
      state.failed[p.id] = (state.failed[p.id] || 0) + 1;
      log.warn('[finalize] ❌ ' + p.id + ': ' + (st || e.message.slice(0, 60)));
    }
    state.done = Array.from(done);
    saveState(state);
    await sleep(DELAY_MS);
  }

  stats.remaining = Math.max(0, drafts.length - stats.sent);
  log.info('[finalize] Concluído: ' + JSON.stringify(stats));
  return stats;
}

module.exports = { finalizeDrafts, listProducts };

if (require.main === module) {
  finalizeDrafts()
    .then(s => { console.log(JSON.stringify(s)); process.exit(0); })
    .catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
