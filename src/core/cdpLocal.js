'use strict';
/**
 * cdpLocal.js — a ponte entre a decisao pura (navegadorLocal.js) e a rede.
 *
 * Todo script que dirige o Chrome do dono tinha a porta 9223 escrita no codigo.
 * Quando o navegador foi reaberto na 9222 (22/09/2026), publicacao, capas e
 * renovacao de token pararam juntas, cada uma com uma mensagem diferente.
 * Aqui a porta e descoberta uma vez e todo mundo usa a mesma.
 */
const http = require('http');
const { portasCandidatas, escolherPorta } = require('./navegadorLocal');

/** A porta responde ao protocolo de depuracao do Chrome? */
function responde(porta, { timeout = 4000, pedir = http.get } = {}) {
  return new Promise(resolve => {
    let pronto = false;
    const terminar = v => { if (!pronto) { pronto = true; resolve(v); } };
    let req;
    try {
      req = pedir({ host: '127.0.0.1', port: Number(porta), path: '/json/version', timeout }, res => {
        res.resume();
        terminar(res.statusCode === 200);
      });
    } catch (_) { return terminar(false); }
    req.on('error', () => terminar(false));
    req.on('timeout', () => { req.destroy(); terminar(false); });
  });
}

/**
 * URL do Chrome de automacao, ou null quando nenhuma porta responde.
 * `testar` existe para o teste nao depender de rede.
 */
async function urlCdpAuto(env = process.env, testar = responde) {
  const porta = await escolherPorta(testar, portasCandidatas(env));
  return porta ? 'http://127.0.0.1:' + porta : null;
}

/** Mesma coisa, mas explode com uma mensagem que diz o que fazer. */
async function urlCdpObrigatoria(env = process.env, testar = responde) {
  const url = await urlCdpAuto(env, testar);
  if (!url) throw new Error('CHROME_FORA_DO_AR: nenhuma porta de depuracao respondeu — rode "node scripts/vigia_navegador.js"');
  return url;
}

module.exports = { responde, urlCdpAuto, urlCdpObrigatoria };
