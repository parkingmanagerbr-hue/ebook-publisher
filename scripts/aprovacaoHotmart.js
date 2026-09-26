'use strict';
/**
 * aprovacaoHotmart.js — revisa quem nao foi aprovado na Hotmart e reenvia para
 * analise o que ja esta em condicoes.
 *
 * Auditoria de 26/09/2026 (2.948 produtos): 3 NOT_APPROVED, 4
 * CHANGES_PENDING_ON_PRODUCT, 6 IN_REVIEW. Os TRES recusados eram exatamente
 * os tres sem capa — nenhum produto com capa foi recusado. Por isso o passe
 * nao reenvia quem esta sem capa: apenas lista, para o passe de capas resolver
 * primeiro (o envio de capa exige a sessao do navegador do dono).
 *
 * Uso (dentro do container):
 *   node scripts/aprovacaoHotmart.js            # so lista
 *   node scripts/aprovacaoHotmart.js --aplicar  # reenvia quem tem capa
 */
const fs = require('fs');
const { filaDeAprovacao, resumoDaDecisao } = require('../src/agents/aprovacaoHotmart');
const { baixarCatalogo } = require('../src/agents/hotmartCatalogo');

let log;
try { log = require('../src/core/logger').createLogger('aprovacaoHotmart'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const API = 'https://api-product.vulcano.hotmart.com/product/v1/product/';
const dormir = ms => new Promise(r => setTimeout(r, ms));
const umaLinha = (s, n = 160) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

function cabecalhos() {
  const token = fs.readFileSync(process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt', 'utf8').trim();
  if (!token) throw new Error('HOTMART_SEM_TOKEN: renove com scripts/renovar_token_local.js');
  return { authorization: 'Bearer ' + token, 'x-app-name': 'app-product', 'content-type': 'application/json' };
}

async function principal() {
  const aplicar = process.argv.includes('--aplicar');
  const H = cabecalhos();
  const catalogo = await baixarCatalogo(H.authorization.replace('Bearer ', ''));

  // O catalogo da listagem nao traz coverPhoto: vem do basic-information.
  const candidatos = catalogo.filter(p => ['NOT_APPROVED', 'CHANGES_PENDING_ON_PRODUCT'].includes(String(p.status)));
  log.info('catalogo com ' + catalogo.length + ' produtos; ' + candidatos.length + ' pedem acao' + (aplicar ? '' : ' (so listando)'));

  const detalhados = [];
  for (const p of candidatos) {
    try {
      const r = await fetch(API + p.id + '/basic-information', { headers: H });
      const j = r.ok ? await r.json() : {};
      detalhados.push({ ...p, coverPhoto: j.coverPhoto, name: j.name || p.name, status: j.status || p.status });
    } catch (e) {
      log.warn('nao deu para ler ' + p.id + ': ' + umaLinha(e && e.message, 80));
    }
    await dormir(700);
  }

  const fila = filaDeAprovacao(detalhados);
  let reenviados = 0, semCapa = 0, falhas = 0;
  for (const item of fila) {
    log.info(resumoDaDecisao(item.produto, item));
    if (item.acao === 'capa') { semCapa++; continue; }
    if (!aplicar) continue;
    try {
      const r = await fetch(API + item.produto.id + '/approval', { method: 'POST', headers: H });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + umaLinha(await r.text(), 120));
      reenviados++;
      log.info('reenviado para analise: ' + item.produto.id);
    } catch (e) {
      falhas++;
      log.error('FALHA ao reenviar ' + item.produto.id + ': ' + umaLinha(e && e.message, 160));
    }
    await dormir(1500);
  }
  return { pedemAcao: fila.length, reenviados, semCapa, falhas };
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); });
}

module.exports = { principal };
