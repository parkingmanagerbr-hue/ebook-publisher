'use strict';
/**
 * tentativas.js — repetir o que falha por motivo passageiro.
 *
 * 24/09/2026: um lote de 18 livros na Hotmart perdeu 5 — e nenhuma perda foi da
 * loja. Foram quedas de `ssh`/`scp` ao buscar o PDF e a capa no servidor
 * ("Command failed: ssh vps docker cp ..."). O livro ia para a fila de falhas e
 * gastava uma das tres tentativas por um soluco de rede.
 *
 * Aqui so a regra: quantas vezes, quanto esperar, e o que merece nova tentativa.
 */

/** Espera antes da tentativa n: 2s, 6s, 18s (teto 1 min). Pura. */
function esperaDaTentativa(n, base = 2000, teto = 60000) {
  const i = Math.max(1, Math.floor(Number(n) || 1));
  return Math.min(teto, base * Math.pow(3, i - 1));
}

/**
 * A falha parece passageira (rede, tempo esgotado, servidor ocupado)?
 * Erro de arquivo que nao existe, por exemplo, nao melhora tentando de novo. Pura.
 */
function valeTentarDeNovo(erro) {
  const m = String((erro && erro.message) || erro || '');
  if (/No such file|not found|nao existe|does not exist/i.test(m)) return false;
  return /ssh|scp|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|Connection closed|kex_exchange|broken pipe|Command failed/i.test(m);
}

/**
 * Executa `acao`, repetindo enquanto a falha parecer passageira.
 * `esperar` existe para o teste nao dormir de verdade.
 */
async function comTentativas(acao, { vezes = 3, esperar = ms => new Promise(r => setTimeout(r, ms)), aoFalhar } = {}) {
  let ultimo;
  for (let n = 1; n <= Math.max(1, vezes); n++) {
    try {
      return await acao(n);
    } catch (e) {
      ultimo = e;
      if (n >= vezes || !valeTentarDeNovo(e)) break;
      if (aoFalhar) aoFalhar(e, n);
      await esperar(esperaDaTentativa(n));
    }
  }
  throw ultimo;
}

module.exports = { comTentativas, valeTentarDeNovo, esperaDaTentativa };
