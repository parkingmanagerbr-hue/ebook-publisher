'use strict';
/**
 * garantir_aba_hotmart.js — mantem uma aba do app da Hotmart aberta no Chrome 9223.
 *
 * O token de acesso so e renovado pelo proprio app (sessao OIDC) enquanto ha uma
 * aba dele viva. Sem aba, o token do navegador vence e renovar_token_local.js
 * passa a copiar um token morto para o servidor.
 */
const puppeteer = require('puppeteer-core');

(async () => {
  const b = await puppeteer.connect({ browserURL: process.env.HOTMART_CDP || 'http://127.0.0.1:9223', defaultViewport: null, protocolTimeout: 60000 });
  try {
    const abas = (await b.pages()).filter(p => /^https:\/\/app\.hotmart\.com/.test(p.url()));
    if (abas.length) { console.log('aba do app ja aberta'); return; }
    const p = await b.newPage();
    await p.goto('https://app.hotmart.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    console.log('aba do app aberta: ' + p.url());
  } finally { b.disconnect(); }
})().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
