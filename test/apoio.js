'use strict';
/**
 * Apoio dos testes. NAO e arquivo de teste (o gate so roda *.test.js).
 *
 * interceptar: troca UMA dependencia pesada (navegador, provedor de IA, banco
 * real) por um objeto falso, so enquanto o teste roda. O modulo testado e
 * sempre o real — o que se troca e o vizinho que faz I/O.
 */
const Module = require('module');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

/**
 * mapa: { 'pedido exato do require': exportsFalso }. Casa pelo texto do
 * require (ex.: './publisherHotmart'), entao so pega o vizinho pretendido.
 */
function interceptar(t, mapa) {
  const original = Module._load;
  Module._load = function (pedido, pai, ...resto) {
    if (Object.prototype.hasOwnProperty.call(mapa, pedido)) {
      const v = mapa[pedido];
      if (v instanceof Error) throw v;
      return v;
    }
    return original.call(this, pedido, pai, ...resto);
  };
  const restaurar = () => { Module._load = original; };
  if (t) t.after(restaurar);
  return restaurar;
}

/** Carrega o modulo do zero (constantes de ambiente sao lidas no require). */
function recarregar(relativo) {
  const alvo = require.resolve(path.join(RAIZ, relativo));
  delete require.cache[alvo];
  return require(alvo);
}

/** Define variaveis de ambiente so durante o teste (undefined remove). */
function comAmbiente(t, vars) {
  const antes = {};
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restaurar = () => {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  if (t) t.after(restaurar);
  return restaurar;
}

/** Gerador deterministico em (0,1): o teste nao pode depender da sorte. */
function semente(s) {
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return (s + 0.5) / 4294967296; };
}

/** Gerador que devolve a sequencia dada e depois cai no deterministico. */
function sequencia(valores, depois = semente(7)) {
  const fila = valores.slice();
  return () => (fila.length ? fila.shift() : depois());
}

/** Logger falso que guarda as linhas (para conferir o que o operador leria). */
function loggerFalso() {
  const linhas = [];
  const f = nivel => msg => linhas.push(nivel + ' ' + msg);
  return { linhas, info: f('info'), warn: f('warn'), error: f('error'), createLogger() { return this; } };
}

module.exports = { RAIZ, interceptar, recarregar, comAmbiente, semente, sequencia, loggerFalso };
