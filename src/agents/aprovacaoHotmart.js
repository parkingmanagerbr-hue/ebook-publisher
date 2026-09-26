'use strict';
/**
 * aprovacaoHotmart.js — quem pode voltar para a analise da Hotmart.
 *
 * Auditoria de 26/09/2026 (2.948 produtos): 13 fora de ACTIVE/PAUSED —
 * 3 NOT_APPROVED, 6 IN_REVIEW, 4 CHANGES_PENDING_ON_PRODUCT. Os TRES recusados
 * sao exatamente os tres com `coverPhoto` VAZIO; nenhum produto com capa foi
 * recusado. (Dois deles sao ainda o mesmo titulo cadastrado duas vezes.)
 *
 * Dai a regra: reenviar para analise sem capa so gasta a fila e coleciona
 * recusa. Primeiro a capa sobe (passe de capas), depois o reenvio.
 *
 * Tudo aqui e puro.
 */

/** Status que pedem uma acao nossa (o resto ja esta resolvido ou em analise). */
const PRECISAM_DE_ACAO = new Set(['NOT_APPROVED', 'CHANGES_PENDING_ON_PRODUCT']);

/** O produto tem capa de verdade? `coverPhoto: {}` conta como nao ter. */
function temCapa(produto) {
  const c = (produto && produto.coverPhoto) || null;
  if (!c || typeof c !== 'object') return false;
  return !!(c.id || c.webPath || c.url || c.fileName || c.name);
}

/**
 * Decide o que fazer com um produto. Devolve
 * { acao: 'reenviar' | 'capa' | 'nada', motivo }. Pura.
 */
function decidirAprovacao(produto) {
  const status = String((produto && produto.status) || '').toUpperCase();
  if (!PRECISAM_DE_ACAO.has(status)) return { acao: 'nada', motivo: 'status ' + (status || '?') + ' nao pede acao' };
  if (!temCapa(produto)) return { acao: 'capa', motivo: 'sem capa — reenviar assim so coleciona recusa' };
  return { acao: 'reenviar', motivo: 'tem capa e esta em ' + status };
}

/** Fila do passe: quem precisa de capa primeiro, depois quem so falta reenviar. Pura. */
function filaDeAprovacao(produtos) {
  const peso = { capa: 2, reenviar: 1, nada: 0 };
  return (produtos || []).filter(Boolean)
    .map(p => ({ produto: p, ...decidirAprovacao(p) }))
    .filter(x => x.acao !== 'nada')
    .sort((a, b) => peso[b.acao] - peso[a.acao]);
}

/** Uma linha de log, sem quebra vinda do nome do produto. Pura. */
function resumoDaDecisao(produto, decisao) {
  const p = produto || {};
  const nome = String(p.name == null ? '' : p.name).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 50);
  const d = decisao || {};
  return String(p.id == null ? '?' : p.id) + ' [' + String(p.status || '?') + '] ' + (d.acao || '?') + ': ' + (d.motivo || '') + ' | "' + nome + '"';
}

module.exports = { decidirAprovacao, filaDeAprovacao, temCapa, resumoDaDecisao, PRECISAM_DE_ACAO };
