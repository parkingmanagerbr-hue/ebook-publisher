'use strict';
/**
 * vigia-lojas.logic.js — REGRA PURA do vigia de publicação das lojas.
 *
 * O produto decide o que é problema; o relay (e-mail) só repassa. Esta função
 * recebe os FATOS medidos (backlog, token, horas sem publicar por loja, falhas
 * nas últimas 24h) e devolve UMA entrada por problema — nada quando está tudo
 * bem (aviso que aparece sempre ensina a não ler aviso).
 *
 * Cada problema traz a AÇÃO que resolve — "o chamado ao dono resolve o caso e
 * ensina a resolver a causa" (padrão do CLAUDE.md). `item` é a chave de dedup.
 *
 * Lojas pausadas DE PROPÓSITO (amazon = conta/banco; gplay = em revisão) NÃO
 * viram alarme: alarmar o que está parado por decisão vira ruído diário.
 */

const LIMITES_PADRAO = {
  readyMax: 500,          // acima disso, o backlog não está sendo escoado
  readyDiasMax: 7,        // ready parado há mais de 7 dias é cauda presa
  lojaParadaHoras: 12,    // loja ATIVA que não publica há 12h está travada
  kiwifySemEntregaMin: 3, // falhas de entrega em 24h a partir das quais avisa
  caktoWizardFailMin: 3,  // falhas do wizard (form mudou) em 24h
};

// Lojas que DEVERIAM estar publicando. amazon/gplay ficam fora (pausadas).
const LOJAS_ATIVAS = ['hotmart', 'cakto', 'kiwify'];

/**
 * @param {object} fatos
 * @param {{total:number, diasMaisAntigo:number}} fatos.ready
 * @param {{hotmartExpiraMin:number|null, hotmartTemHmSsoExp:boolean}} fatos.token
 * @param {Record<string,{horasSemPublicar:number|null}>} fatos.lojas
 * @param {{kiwifySemEntrega:number, caktoWizard:number}} fatos.falhas24h
 * @param {object} [limites]
 * @returns {{item:string, texto:string, acao:string}[]}
 */
function detectarProblemas(fatos, limites = {}) {
  const L = { ...LIMITES_PADRAO, ...limites };
  const probs = [];
  const f = fatos || {};
  const ready = f.ready || {};
  const token = f.token || {};
  const lojas = f.lojas || {};
  const falhas = f.falhas24h || {};

  // 1) Hotmart: token expirado é a causa nº1 de "parou de publicar na Hotmart".
  if (token.hotmartExpiraMin == null) {
    probs.push({
      item: 'hotmart-token',
      texto: 'Hotmart: HOTMART_ACCESS_TOKEN ausente — a finalização de rascunho (API) não roda.',
      acao: 'Logar na Hotmart no Chrome de debug e renovar o token (regrab de sessão → renovar).',
    });
  } else if (token.hotmartExpiraMin <= 0) {
    const semRenovar = token.hotmartTemHmSsoExp === false;
    probs.push({
      item: 'hotmart-token',
      texto: `Hotmart: token EXPIRADO há ${Math.abs(token.hotmartExpiraMin)} min` +
        (semRenovar ? ' e sem hmSsoExp para auto-renovar — a Hotmart parou de finalizar.' : '.'),
      acao: 'Logar na Hotmart (Chrome debug) e renovar a sessão/token; sem hmSsoExp o auto-renovar não resolve.',
    });
  }

  // 2) Backlog de publicação preso.
  if ((ready.total || 0) > L.readyMax) {
    probs.push({
      item: 'ready-volume',
      texto: `Backlog: ${ready.total} e-books em "ready" (limite ${L.readyMax}) — não estão sendo escoados.`,
      acao: 'Ver qual loja parou (token/forms) — o backlog só cai quando a loss travada voltar.',
    });
  }
  if ((ready.diasMaisAntigo || 0) > L.readyDiasMax) {
    probs.push({
      item: 'ready-idade',
      texto: `Backlog: o "ready" mais antigo tem ${ready.diasMaisAntigo} dias (limite ${L.readyDiasMax}) — cauda presa.`,
      acao: 'Esses nunca publicaram em loja nenhuma; investigar o motivo da falha original.',
    });
  }

  // 3) Loja ativa travada (não publica há muitas horas).
  for (const loja of LOJAS_ATIVAS) {
    const h = lojas[loja] && lojas[loja].horasSemPublicar;
    if (h != null && h > L.lojaParadaHoras) {
      probs.push({
        item: `loja-parada-${loja}`,
        texto: `${cap(loja)}: sem publicar há ${h}h (limite ${L.lojaParadaHoras}h) — provavelmente travada.`,
        acao: `Checar o log do publicador da ${cap(loja)} (sessão/token/mudança de form).`,
      });
    }
  }

  // 4) Kiwify: entrega (approved_url) voltando vazia repetidamente.
  if ((falhas.kiwifySemEntrega || 0) >= L.kiwifySemEntregaMin) {
    probs.push({
      item: 'kiwify-entrega',
      texto: `Kiwify: ${falhas.kiwifySemEntrega} produtos com approved_url vazio em 24h — não marcam como publicado.`,
      acao: 'Revisar a conferência de entrega (lê antes de a Kiwify refletir o PUT); aumentar o retry/espera.',
    });
  }

  // 5) Cakto: wizard por navegador falhando (o form da página mudou).
  if ((falhas.caktoWizard || 0) >= L.caktoWizardFailMin) {
    probs.push({
      item: 'cakto-wizard',
      texto: `Cakto: ${falhas.caktoWizard} falhas do wizard em 24h (input de PDF/capa não encontrado) — o form da Cakto mudou.`,
      acao: 'Atualizar os seletores do publicador Cakto por navegador; a via API segue como reserva.',
    });
  }

  return probs;
}

// `loja` vem sempre de LOJAS_ATIVAS (string não-vazia), então sem ramo defensivo.
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

module.exports = { detectarProblemas, LIMITES_PADRAO, LOJAS_ATIVAS };
