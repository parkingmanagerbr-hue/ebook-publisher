'use strict';
/**
 * sessaoHotmart.js — agente que cuida da sessao da Hotmart sozinho.
 *
 * Em 26/09/2026 oito lotes seguidos publicaram ZERO. O vigia dizia
 * "hotmart: deslogado" e o catalogo respondia HTTP 401 — mas o painel, aberto
 * de verdade, estava LOGADO. O que morrera foi a aba do app (a sessao OIDC so
 * se renova com aba viva) e, por tabela, o token do servidor. Abrir o painel e
 * renovar resolveu, sem senha nenhuma.
 *
 * O que este agente faz, nesta ordem:
 *   1. abre o painel e OLHA o que a tela mostra (nao confia no vigia);
 *   2. se abriu logado, renova o token e pronto;
 *   3. se a tela oferece continuar com a conta ja guardada, clica e renova;
 *   4. se pede senha ou codigo, PARA e avisa — credencial e do dono.
 *
 * O robo nao digita senha nem codigo de verificacao, em nenhuma hipotese.
 *
 * Uso:
 *   node scripts/sessaoHotmart.js            # conserta o que der
 *   node scripts/sessaoHotmart.js --so-olhar # diagnostico, sem clicar
 */
const { execFileSync } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { urlCdpObrigatoria } = require('../src/core/cdpLocal');
const { diagnosticarTela, resumoDaSessao } = require('../src/agents/sessaoHotmart');

let log;
try { log = require('../src/core/logger').createLogger('sessaoHotmart'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const PAINEL = 'https://app.hotmart.com/products';
const dormir = ms => new Promise(r => setTimeout(r, ms));

/** O que a tela mostra agora. So leitura. */
async function lerTela(page) {
  return page.evaluate(() => ({
    url: location.href,
    campos: [...document.querySelectorAll('input')].map(i => ({
      tipo: i.type, nome: i.name || i.id, ph: i.placeholder || '', visivel: !!i.offsetParent,
    })),
    botoes: [...document.querySelectorAll('button, a[role=button], input[type=submit]')]
      .map(x => (x.innerText || x.value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30),
  })).catch(() => ({ url: page.url(), campos: [], botoes: [] }));
}

async function clicarPorTexto(page, texto) {
  return page.evaluate(t => {
    const alvo = [...document.querySelectorAll('button, a[role=button], input[type=submit]')]
      .find(x => (x.innerText || x.value || '').replace(/\s+/g, ' ').trim() === t);
    if (!alvo) return false;
    alvo.click();
    return true;
  }, texto).catch(() => false);
}

async function principal() {
  const soOlhar = process.argv.includes('--so-olhar');
  const browser = await puppeteer.connect({ browserURL: await urlCdpObrigatoria(), defaultViewport: null });
  const page = await browser.newPage();
  try {
    await page.goto(PAINEL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await dormir(6000);

    let tela = await lerTela(page);
    let d = diagnosticarTela(tela);
    log.info(resumoDaSessao(d, tela.url));

    if (d.estado === 'sessao-salva' && !soOlhar) {
      log.info('clicando em "' + d.botao + '" (a conta ja esta guardada no navegador; nenhum segredo e digitado)');
      await clicarPorTexto(page, d.botao);
      await dormir(8000);
      tela = await lerTela(page);
      d = diagnosticarTela(tela);
      log.info('depois do clique: ' + resumoDaSessao(d, tela.url));
    }

    if (d.estado === 'precisa-humano') {
      log.warn('a Hotmart pede login humano: ' + d.motivo + ' — o robo nao digita senha nem codigo');
      return { estado: d.estado, token: false };
    }
    if (soOlhar) return { estado: d.estado, token: false };

    // Painel de pe: renovar o token do servidor (e o que o catalogo usa).
    const saida = execFileSync(process.execPath, [path.join(__dirname, 'renovar_token_local.js')], { encoding: 'utf8', timeout: 180000 });
    const linha = String(saida).trim().split('\n').pop();
    log.info('token: ' + linha.replace(/[\r\n\t]+/g, ' ').slice(0, 120));
    return { estado: d.estado, token: /instalado/.test(linha) };
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(r.estado === 'precisa-humano' ? 2 : 0); })
    .catch(e => { log.error('ERRO: ' + String(e && e.message).replace(/[\r\n\t]+/g, ' ').slice(0, 200)); process.exit(1); });
}

module.exports = { principal, lerTela };
