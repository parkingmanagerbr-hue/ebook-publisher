'use strict';
/**
 * gravar_upload_capa.js — grava a requisicao real de upload de capa.
 *
 * POR QUE ISTO EXISTE: o upload de capa da Hotmart so acontece por selecao de
 * arquivo REAL no dialogo nativo. Toda injecao programatica falha em silencio —
 * testado com uploadFile do Puppeteer, file_upload da extensao, override de
 * showOpenFilePicker e nove endpoints de API (404 ou no-op). E o `PUT
 * basic-information` devolve 200 sem gravar NADA, nem a descricao.
 *
 * Falta uma unica peca para automatizar: o `basePath` do servico de assinatura
 * (nos bundles aparece so como `signerURL = basePath + "/upload/aws4sign"`).
 * Ele se revela quando um upload de verdade acontece.
 *
 * Este script abre a pagina do produto na janela de automacao, fica ouvindo a
 * rede e escreve TUDO que nao for GET num arquivo. O humano faz UM upload nessa
 * janela; o resto (500 capas) passa a ser replicavel por API.
 *
 * Uso:  node scripts/gravar_upload_capa.js 8487838
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';
const SAIDA = path.join(os.tmpdir(), 'captura_upload_capa.log');

// Ruido conhecido: telemetria e chat nao interessam e enterrariam o sinal.
const RUIDO = /nr-data|clarity|google|doubleclick|zendesk|bing|hotjar|facebook|segment|bam\.nr/i;

async function main() {
  const id = process.argv[2] || '8487838';
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  const page = await browser.newPage();

  fs.writeFileSync(SAIDA, '=== captura iniciada ' + new Date().toISOString() + ' ===\n');
  const registrar = linha => { fs.appendFileSync(SAIDA, linha + '\n'); console.log(linha); };

  page.on('request', r => {
    const u = r.url();
    if (r.method() === 'GET' || RUIDO.test(u)) return;
    const corpo = (r.postData() || '').slice(0, 400);
    registrar('>>> ' + r.method() + ' ' + u);
    if (corpo) registrar('    corpo: ' + corpo.replace(/\s+/g, ' '));
  });
  page.on('response', async r => {
    const u = r.url();
    if (r.request().method() === 'GET' || RUIDO.test(u)) return;
    let txt = '';
    try { txt = (await r.text()).slice(0, 300).replace(/\s+/g, ' '); } catch {}
    registrar('<<< ' + r.status() + ' ' + u.slice(0, 110) + (txt ? '  :: ' + txt : ''));
  });

  await page.bringToFront();
  await page.goto('https://app.hotmart.com/products/manage/' + id + '/info',
    { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('\n=== PRONTO ===');
  console.log('Nesta janela do Chrome, clique em "Alterar imagem" e escolha uma imagem.');
  console.log('Gravando em: ' + SAIDA);
  console.log('(o processo fica ouvindo; encerra sozinho em 12 min)\n');

  // Mantem vivo enquanto o humano opera. Sem isso o processo morreria antes.
  await new Promise(r => setTimeout(r, 12 * 60 * 1000));
  browser.disconnect();
}

if (require.main === module) {
  main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
