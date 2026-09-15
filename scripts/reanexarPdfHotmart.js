'use strict';
/**
 * reanexarPdfHotmart.js — anexa o PDF a produto Hotmart que foi a venda sem ele.
 *
 * Roda LOCAL, no Chrome de automacao ja logado (porta 9223): a sessao Hotmart
 * fica presa a origem do login. Confere antes e depois pela API de conteudo —
 * nunca sobe arquivo em produto que ja tem, e so declara sucesso com a API.
 *
 * Uso: node scripts/reanexarPdfHotmart.js --token=<bearer> 8483671=caminho.pdf 8428728=outro.pdf
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { uploadPDF } = require('../src/agents/publisherHotmart');
const { consultarConteudo, aguardarConteudo } = require('../src/agents/hotmartConteudo');

async function main() {
  const tokenArg = process.argv.find(a => a.startsWith('--token='));
  const token = tokenArg ? tokenArg.slice(8) : undefined;
  const pares = process.argv.slice(2).filter(a => /^\d+=/.test(a)).map(a => a.split('='));
  if (!pares.length) throw new Error('informe PRODUTO=arquivo.pdf');

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  try {
    for (const [pid, arquivo] of pares) {
      const abs = path.resolve(arquivo);
      if (!fs.existsSync(abs) || fs.readFileSync(abs).slice(0, 5).toString() !== '%PDF-') { console.log(pid, 'arquivo invalido', abs); continue; }
      const antes = await consultarConteudo(pid, { token });
      if (antes === true) { console.log(pid, 'ja tem arquivo — nada a fazer'); continue; }
      const page = await browser.newPage();
      try {
        const enviado = await uploadPDF(page, pid, abs).catch(e => { console.log(pid, 'erro no envio:', e.message.slice(0, 120)); return false; });
        const depois = await aguardarConteudo(pid, { token });
        console.log(pid, 'uploadPDF=' + enviado, 'API confirma arquivo=' + depois);
      } finally { await page.close().catch(() => {}); }
    }
  } finally { browser.disconnect(); }
}

main().catch(e => { console.error('ERRO', e.message); process.exit(1); });
