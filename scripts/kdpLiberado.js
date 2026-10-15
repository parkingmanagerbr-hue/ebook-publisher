'use strict';
/**
 * kdpLiberado.js — confere a pagina da conta do KDP no Chrome do dono.
 * Sai com 0 quando a conta deixa publicar e 3 quando ainda nao (o motivo vai
 * ao log). Usado pela tarefa GENIA-Hotmart antes de publicar no KDP.
 */
const { urlCdpObrigatoria } = require('../src/core/cdpLocal');
const { contaLiberada } = require('../src/agents/kdpConta');
const { respostaGuardadaKdp } = require('../src/agents/kdpRegras');
let log;
try { log = require('../src/core/logger').createLogger('kdpLiberado'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

async function principal() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({ browserURL: await urlCdpObrigatoria(), defaultViewport: null });
  const page = await browser.newPage();
  try {
    await page.goto('https://account.kdp.amazon.com/account', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));
    return contaLiberada(await page.evaluate(() => document.body.innerText));
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

const CACHE = process.env.KDP_CONTA_CACHE || '/app/data/kdp_conta_cache.json';

/** Le a resposta guardada; arquivo ausente ou ilegivel = conferir no navegador. */
function lerCache(fs = require('fs')) {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) { return null; }   // protocolo: sem cache, confere de novo
}

function gravarCache(r, fs = require('fs')) {
  try { fs.writeFileSync(CACHE + '.tmp', JSON.stringify({ liberada: r.liberada, motivo: r.motivo, quando: Date.now() })); fs.renameSync(CACHE + '.tmp', CACHE); }
  catch (e) { log.warn('cache da conta KDP nao gravado: ' + String(e.message).slice(0, 80)); }
}

async function conferir() {
  const guardada = respostaGuardadaKdp(lerCache());
  if (guardada) return guardada;   // bloqueada ha menos de 3 h: nao abre o Chrome de novo
  const r = await principal();
  gravarCache(r);
  return r;
}

if (require.main === module) {
  conferir()
    .then(r => { if (!r.guardada) (r.liberada ? log.info : log.warn)('conta KDP: ' + (r.liberada ? 'liberada' : 'bloqueada — ' + r.motivo)); console.log(JSON.stringify(r)); process.exit(r.liberada ? 0 : 3); })
    .catch(e => { log.error('ERRO: ' + String(e && e.message).replace(/[\r\n\t]+/g, ' ').slice(0, 200)); process.exit(1); });
}

module.exports = { principal, conferir, lerCache, gravarCache };
