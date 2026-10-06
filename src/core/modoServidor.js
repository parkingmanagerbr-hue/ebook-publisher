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

/**
 * Roda um trecho de JS no proprio container (o equivalente local do
 * scp + docker exec que os scripts usam a partir da maquina do dono).
 * `dir` existe para o teste.
 */
function rodarAqui(js, { timeout = 180000, dir = '/app' } = {}) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const arq = path.join(dir, 'cmd_aqui_' + process.pid + '_' + Date.now() + '.js');
  fs.writeFileSync(arq, js);
  try {
    return execFileSync(process.execPath, [arq], { cwd: dir, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  } finally {
    try { fs.unlinkSync(arq); } catch (_) { /* protocolo: arquivo temporario */ }
  }
}

/**
 * Pasta de trabalho do script. Na VPS e a pasta MONTADA tambem no Chrome
 * (navegador-hotmart): upload de arquivo passa o CAMINHO e quem le e o Chrome,
 * que e outro container. Fora da VPS, a pasta temporaria do sistema.
 */
function pastaDeTrabalho(nome, env = process.env) {
  const path = require('path');
  if (noServidor(env)) return path.join(env.PUBLICAR_TMP || '/app/data/navegador_tmp', nome);
  return path.join(require('os').tmpdir(), nome);
}

module.exports = { noServidor, urlCdpDoServidor, rodarAqui, pastaDeTrabalho };
