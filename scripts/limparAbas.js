'use strict';
/**
 * limparAbas.js — fecha as abas que sobraram no Chrome de automacao.
 *
 * 06/10/2026: o Chrome da VPS tinha 26 abas abertas (12 da Hotmart, 8 da
 * Kiwify...) e 1,36 de 1,5 GB de memoria; parou de responder no meio de um
 * cadastro. Cada script que morre no meio deixa a sua aba. Rodado no INICIO de
 * cada volta do laco, quando nada mais usa o navegador.
 *
 * Fica UMA aba por site (as sessoes sao do navegador, nao da aba; mas uma aba
 * viva do painel mantem a renovacao do login da Hotmart funcionando).
 *
 * Uso: node scripts/limparAbas.js
 */
const { urlCdpObrigatoria } = require('../src/core/cdpLocal');
let log;
try { log = require('../src/core/logger').createLogger('limparAbas'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

/** Quais abas fechar: todas menos a primeira de cada site; about:blank sempre. Pura. */
function abasParaFechar(urls) {
  const vistos = new Set();
  const fechar = [];
  urls.forEach((u, i) => {
    const m = String(u || '').match(/^https?:\/\/([^/]+)/);
    if (!m) { if (i > 0) fechar.push(i); return; } // about:blank, chrome://...: so fica se for a unica
    if (vistos.has(m[1])) fechar.push(i);
    else vistos.add(m[1]);
  });
  return fechar;
}

/** Marcador que o dono cria enquanto loga pela tela remota: a limpeza nao fecha as abas dele. */
const MARCADOR = process.env.LIMPAR_ABAS_MARCADOR || '/app/data/LOGIN_EM_ANDAMENTO';
const LIMITE_DE_ABAS = 20;   // valvula: com o marcador e abas demais, limpa mesmo assim (Chrome travou com 26 em 06/10/2026)

/** Mantem as abas? Marcador presente (sem prazo: o dono apaga quando quiser) e abas abaixo do limite. Pura. */
function loginEmAndamento(mtimeMs, totalAbas, limite = LIMITE_DE_ABAS) {
  if (mtimeMs === null || mtimeMs === undefined) return false;
  return Number(totalAbas) <= limite;
}

function mtimeDoMarcador(fs = require('fs')) {
  try { return fs.statSync(MARCADOR).mtimeMs; } catch (_) { return null; }   // protocolo: sem marcador = limpa
}

async function principal() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({ browserURL: await urlCdpObrigatoria(), defaultViewport: null, protocolTimeout: 60000 });
  try {
    const paginas = await browser.pages();
    if (loginEmAndamento(mtimeDoMarcador(), paginas.length)) {
      log.info('marcador LOGIN_EM_ANDAMENTO presente — abas mantidas (' + paginas.length + ' abertas)');
      return { puladas: true, abas: paginas.length };
    }
    const fechar = abasParaFechar(paginas.map(p => p.url()));
    for (const i of fechar) await paginas[i].close().catch(() => {});
    const r = { abas: paginas.length, fechadas: fechar.length };
    log.info('abas: ' + JSON.stringify(r));
    return r;
  } finally { browser.disconnect(); }
}

module.exports = { abasParaFechar, loginEmAndamento, principal };

if (require.main === module) principal().then(r => console.log(JSON.stringify(r))).catch(e => { log.error('ERRO ' + String(e && e.message).slice(0, 200)); process.exit(1); });
