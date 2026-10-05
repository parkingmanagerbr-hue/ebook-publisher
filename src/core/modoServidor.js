'use strict';
/**
 * modoServidor.js — o publicador da Hotmart rodando DENTRO da VPS.
 *
 * Ate 05/10/2026 ele so rodava na maquina do dono: a Hotmart amarra a sessao ao
 * lugar do login, e o login era feito la. Quando o computador dormia (02 a
 * 04/10), a publicacao parava dois dias. Agora existe um Chrome na VPS
 * (container navegador-hotmart) onde o dono loga pela tela remota; a sessao
 * fica presa a VPS e o publicador roda aqui, sem ssh nem copia de arquivo.
 *
 * Liga com PUBLICAR_NO_SERVIDOR=1. Fora disso, nada muda.
 */
const dns = require('dns');
const net = require('net');

/** O publicador esta rodando dentro do container (e nao na maquina do dono)? Pura. */
function noServidor(env = process.env) {
  return String(env.PUBLICAR_NO_SERVIDOR || '') === '1';
}

/**
 * URL do DevTools do Chrome da VPS. O Chrome recusa pedido cujo Host nao e IP
 * nem localhost ("Host header is specified and is not an IP address"), entao o
 * nome do container vira IP antes. `resolver` existe para o teste.
 */
async function urlCdpDoServidor(env = process.env, resolver = (h) => dns.promises.lookup(h, { family: 4 })) {
  const host = env.HOTMART_CDP_HOST || 'navegador-hotmart';
  const porta = Number(env.HOTMART_CDP_PORTA || 9223);
  const ip = net.isIP(host) ? host : (await resolver(host)).address;
  if (!net.isIP(ip)) throw new Error('CHROME_FORA_DO_AR: nao resolvi ' + host);
  return 'http://' + ip + ':' + porta;
}

module.exports = { noServidor, urlCdpDoServidor };
