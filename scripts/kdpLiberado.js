'use strict';
/**
 * kdpLiberado.js — confere a pagina da conta do KDP no Chrome do dono.
 * Sai com 0 quando a conta deixa publicar e 3 quando ainda nao (o motivo vai
 * ao log). Usado pela tarefa GENIA-Hotmart antes de publicar no KDP.
 */
const { urlCdpObrigatoria } = require('../src/core/cdpLocal');
const { contaLiberada } = require('../src/agents/kdpConta');
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

if (require.main === module) {
  principal()
    .then(r => { (r.liberada ? log.info : log.warn)('conta KDP: ' + (r.liberada ? 'liberada' : 'bloqueada — ' + r.motivo)); console.log(JSON.stringify(r)); process.exit(r.liberada ? 0 : 3); })
    .catch(e => { log.error('ERRO: ' + String(e && e.message).replace(/[\r\n\t]+/g, ' ').slice(0, 200)); process.exit(1); });
}

module.exports = { principal };
