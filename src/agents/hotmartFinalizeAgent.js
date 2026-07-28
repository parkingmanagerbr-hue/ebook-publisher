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
const axios = require('axios');
const { createLogger } = require('../core/logger');
const log = createLogger('hotmartFinalize');

const API = 'https://api-product.vulcano.hotmart.com';
const STATE_FILE = process.env.HOTMART_FINALIZE_STATE || '/app/data/hotmart_finalize_state.json';
const MAX_PER_RUN = parseInt(process.env.HOTMART_FINALIZE_MAX || '150', 10);
const DELAY_MS = parseInt(process.env.HOTMART_FINALIZE_DELAY || '1200', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function token() {
  return (process.env.HOTMART_ACCESS_TOKEN || '').trim();
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

async function finalizeDrafts() {
  const state = loadState();
  const done = new Set(state.done);
  const stats = { sent: 0, errors: 0, drafts: 0, remaining: 0 };

  let products;
  try { products = await listProducts(); }
  catch (e) { log.warn('[finalize] ' + e.message); return { error: e.message, ...stats }; }

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
