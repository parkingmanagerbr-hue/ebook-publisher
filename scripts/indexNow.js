'use strict';
/**
 * indexNow.js — avisa os buscadores das paginas da vitrine.
 *
 * A vitrine passou de 23 para ~3.460 paginas em 28/09/2026. O sitemap no
 * robots.txt e o caminho padrao, mas so vale quando o robo resolve passar; o
 * IndexNow avisa na hora, e sem credencial nenhuma do dono (basta hospedar um
 * arquivo com a chave na raiz do site).
 *
 * O GOOGLE NAO participa do IndexNow e aposentou o ping de sitemap em 2023 —
 * para submeter la e preciso o Search Console, que e login do dono. Este
 * script nunca diz "indexado no Google": ele avisa Bing, Yandex e os demais
 * que aceitam o protocolo, e registra o que cada um respondeu.
 *
 * Uso (no container):
 *   node scripts/indexNow.js --dry-run
 *   node scripts/indexNow.js                 # envia o sitemap inteiro
 *   node scripts/indexNow.js --limite=100
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chaveValida, arquivoDaChave, corpoDoPedido, lerResposta } = require('../src/agents/indexNow');

let log;
try { log = require('../src/core/logger').createLogger('indexNow'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const SITE = process.env.SITE_ROOT || '/app/landing_pages';
const HOST = process.env.INDEXNOW_HOST || 'veloxisit.com.br';
// Um endpoint basta: os participantes compartilham o aviso entre si.
const DESTINOS = ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow'];
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const temFlag = n => process.argv.includes('--' + n);
const umaLinha = (s, n = 160) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** A chave fica em disco: trocar a chave a cada rodada invalida o arquivo publicado. */
function obterChave() {
  const arquivo = path.join(SITE, '.indexnow-key');
  try {
    const guardada = fs.readFileSync(arquivo, 'utf8').trim();
    if (chaveValida(guardada)) return guardada;
  } catch (_) { /* primeira vez */ }
  const nova = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(arquivo, nova);
  return nova;
}

/** URLs do sitemap de livros (e do indice da vitrine). */
function urlsDoSitemap() {
  const urls = [];
  for (const nome of fs.readdirSync(SITE)) {
    if (!/^sitemap-livros.*\.xml$/.test(nome)) continue;
    const xml = fs.readFileSync(path.join(SITE, nome), 'utf8');
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(m[1]);
  }
  return urls;
}

async function principal() {
  const seco = temFlag('dry-run');
  const limite = Number(arg('limite', '0')) || 0;
  const chave = obterChave();

  // O arquivo da chave PRECISA estar publico antes do aviso: sem ele a
  // resposta e 403 ("chave nao confere").
  const arq = arquivoDaChave(chave);
  const destino = path.join(SITE, arq.nome);
  if (!fs.existsSync(destino)) fs.writeFileSync(destino, arq.conteudo);

  const todas = urlsDoSitemap();
  const urls = limite ? todas.slice(0, limite) : todas;
  const corpo = corpoDoPedido({ host: HOST, chave, urls });
  if (!corpo) { log.warn('nada a enviar (sem URL propria ou chave invalida)'); return { enviadas: 0 }; }

  log.info('IndexNow: ' + corpo.urlList.length + ' URLs | chave publicada em ' + corpo.keyLocation + (seco ? ' (dry-run)' : ''));
  if (seco) return { enviadas: 0, previstas: corpo.urlList.length };

  const resultados = [];
  for (const url of DESTINOS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(corpo),
      });
      const leitura = lerResposta(r.status);
      resultados.push({ destino: url, status: r.status, ...leitura });
      log.info((leitura.ok ? 'aceito' : 'RECUSADO') + ' por ' + url + ': HTTP ' + r.status + ' — ' + leitura.motivo);
    } catch (e) {
      resultados.push({ destino: url, ok: false, motivo: umaLinha(e && e.message, 80) });
      log.warn('falhou ao avisar ' + url + ': ' + umaLinha(e && e.message, 80));
    }
  }
  const aceitos = resultados.filter(r => r.ok).length;
  return { enviadas: corpo.urlList.length, aceitos, destinos: resultados.length, resultados };
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r).slice(0, 300)); console.log(JSON.stringify(r)); process.exit(r.aceitos ? 0 : 1); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); });
}

module.exports = { principal, obterChave, urlsDoSitemap };
