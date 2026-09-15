'use strict';
/**
 * hotmartConteudo.js — o produto Hotmart tem o arquivo que o comprador recebe?
 *
 * O publisher tratava falha no envio do PDF como "nao fatal" e seguia para
 * finalizar o cadastro: o produto ia para venda sem arquivo. Medido em
 * 15/09/2026 numa amostra de 115 produtos: 6 sem conteudo, 3 deles JA VENDIDOS
 * (8483671, 8423597, 8428728) — o comprador pagou e nao recebeu nada.
 *
 * E o uploadPDF devolvia true so por ter achado o campo de arquivo, sem saber
 * se o envio terminou. A prova e a API de conteudo do produto.
 */
const fs = require('fs');

const TOKEN_FILE = process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt';

/** Interpreta a resposta de /product/v1/product/{id}/content. Pura. */
function temArquivo(resposta) {
  if (!resposta || typeof resposta !== 'object') return false;
  const lista = Array.isArray(resposta.contents) ? resposta.contents : [];
  return lista.some(c => c && Number(c.size) > 0) || Number(resposta.totalSize) > 0;
}

/**
 * Consulta a API. Devolve true/false, ou null quando nao da para saber (token
 * ausente, rede, HTTP de erro) — quem chama decide; nao se conclui "sem arquivo"
 * por falha de consulta.
 */
async function consultarConteudo(produtoId, { fetchImpl = fetch, token } = {}) {
  let tok = token;
  if (!tok) { try { tok = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return null; } }
  if (!tok) return null;
  try {
    const r = await fetchImpl('https://api-product.vulcano.hotmart.com/product/v1/product/' + produtoId + '/content', {
      headers: { authorization: 'Bearer ' + tok, accept: 'application/json' },
    });
    if (!r.ok) return null;
    return temArquivo(await r.json());
  } catch { return null; }
}

/** Espera o arquivo aparecer (o processamento do upload leva alguns segundos). */
async function aguardarConteudo(produtoId, { tentativas = 6, intervaloMs = 10000, dormir, ...opts } = {}) {
  const espera = dormir || (ms => new Promise(r => setTimeout(r, ms)));
  let ultimo = null;
  for (let i = 0; i < tentativas; i++) {
    ultimo = await consultarConteudo(produtoId, opts);
    if (ultimo === true) return true;
    if (i < tentativas - 1) await espera(intervaloMs);
  }
  return ultimo;
}

module.exports = { temArquivo, consultarConteudo, aguardarConteudo };
