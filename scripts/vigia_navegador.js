'use strict';
/**
 * vigia_navegador.js — mantem o Chrome de automacao de pe e diz o que falta logar.
 *
 * Em 22/09/2026 o Chrome foi reaberto em outra porta e a publicacao parou sem
 * ninguem notar. Agora: procura a porta (9222, 9223 ou a do ambiente), abre o
 * Chrome quando nenhuma responde, visita as quatro lojas e registra quais
 * pediram login. Senha e 2FA continuam com o dono — o vigia so avisa.
 *
 * Uso:
 *   node scripts/vigia_navegador.js            # checa (e abre o Chrome se caiu)
 *   node scripts/vigia_navegador.js --so-checar # nunca abre nada
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { LOJAS, portasCandidatas, escolherPorta, estaDeslogado, pendenciasDeLogin, argumentosDoChrome } = require('../src/core/navegadorLocal');

let log;
try { log = require('../src/core/logger').createLogger('vigiaNavegador'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const PERFIL = process.env.CHROME_PERFIL_AUTOMACAO || path.join(process.env.LOCALAPPDATA || '/tmp', 'chrome-automacao-genia');
const PORTA_NOVA = Number((process.env.CHROME_CDP_PORT || '').match(/\d{2,5}/) || 9223);
const CHROMES = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** A porta responde ao protocolo de depuracao? */
function responde(porta) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/json/version', timeout: 4000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function abrirChrome() {
  const exe = CHROMES.find(c => { try { return fs.existsSync(c); } catch (_) { return false; } });
  if (!exe) { log.error('nao achei o chrome.exe — defina CHROME_BIN'); return false; }
  const urls = Object.values(LOJAS).map(l => l.url);
  const filho = spawn(exe, argumentosDoChrome(PORTA_NOVA, PERFIL, urls), { detached: true, stdio: 'ignore' });
  filho.unref();
  log.info('Chrome de automacao aberto na porta ' + PORTA_NOVA + ' (perfil ' + umaLinha(PERFIL) + ')');
  return true;
}

async function estadoDasLojas(porta) {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + porta, defaultViewport: null, protocolTimeout: 120000 });
  const estados = {};
  try {
    for (const [nome, loja] of Object.entries(LOJAS)) {
      const pagina = await browser.newPage();
      try {
        await pagina.goto(loja.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await dormir(7000);
        const url = pagina.url();
        estados[nome] = estaDeslogado(nome, url) ? 'deslogado' : 'logado';
        log.info(nome + ': ' + estados[nome] + ' (' + umaLinha(url, 70) + ')');
      } catch (e) {
        estados[nome] = 'erro';
        log.warn(nome + ': nao deu para checar — ' + umaLinha(e && e.message));
      } finally { await pagina.close().catch(() => {}); }
    }
  } finally { browser.disconnect(); }
  return estados;
}

async function principal() {
  const soChecar = process.argv.includes('--so-checar');
  let porta = await escolherPorta(responde, portasCandidatas(process.env));
  if (!porta) {
    log.warn('nenhuma porta de depuracao respondeu');
    if (soChecar) return { porta: null, estados: {}, faltando: Object.keys(LOJAS) };
    if (!abrirChrome()) return { porta: null, estados: {}, erro: 'sem chrome' };
    await dormir(15000);
    porta = await escolherPorta(responde, portasCandidatas(process.env));
    if (!porta) { log.error('o Chrome abriu mas a porta nao respondeu'); return { porta: null, estados: {} }; }
  }
  log.info('Chrome de automacao na porta ' + porta);
  const estados = await estadoDasLojas(porta);
  const { faltando, mensagem } = pendenciasDeLogin(estados);
  (faltando.length ? log.warn : log.info)(mensagem);
  return { porta, estados, faltando };
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); console.error('ERRO: ' + e.message); process.exit(1); });
}

module.exports = { principal, responde, abrirChrome, estadoDasLojas };
