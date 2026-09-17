'use strict';
/**
 * agendaIa.js — quanto o agente espera quando a cota de IA acabou.
 *
 * Pedido do dono (16/09/2026): "sempre ter um schedule para continuar quando
 * voltar a cota, igual o ClipCaster". Em vez de repetir o ciclo a cada 5 min
 * so para falhar, o agente dorme ate a proxima chance real (marca vencendo ou
 * sondagem liberada) e registra o horario em nextRunAt.
 */
const { proximaTentativaIa } = require('./aiClient');

const MIN_MS = 60 * 1000;
const MAX_MS = 30 * 60 * 1000;

/** A falha e de cota/provedor esgotado? Pura. */
function ehFalhaDeCota(mensagem) {
  return /providers de (AI|IA) falharam|sem chave v[aá]lida|cota|quota/i.test(String(mensagem || ''));
}

/**
 * Milissegundos ate a proxima tentativa, ou null quando a falha nao e de cota
 * (quem chama usa o backoff de sempre). Pura.
 */
function esperaPorCota(mensagem, degraded, agora = Date.now(), { minMs = MIN_MS, maxMs = MAX_MS } = {}) {
  if (!ehFalhaDeCota(mensagem)) return null;
  const proxima = proximaTentativaIa(degraded, agora);
  // Falha de cota sem marca nenhuma (ex.: 402 em provedor sem chave): espera o maximo.
  const espera = proxima === null ? maxMs : proxima - agora;
  return Math.min(maxMs, Math.max(minMs, espera));
}

module.exports = { ehFalhaDeCota, esperaPorCota, MIN_MS, MAX_MS };
