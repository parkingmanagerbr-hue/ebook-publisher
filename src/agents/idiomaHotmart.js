'use strict';
/**
 * idiomaHotmart.js — decide quando o idioma do produto na Hotmart esta errado.
 *
 * 24/09/2026: o unico produto NOT_APPROVED da conta era um livro em japones
 * cadastrado como `contentLocale: PT_BR`. Numa amostra de 8 estrangeiros, 1
 * estava errado — o idioma so e gravado no MESMO PUT da capa, entao produto que
 * ja tinha capa nunca era corrigido.
 *
 * Idioma errado nao e detalhe: o conteudo nao bate com o que foi declarado
 * (motivo de recusa) e o livro aparece no mercado errado.
 */

const LOCALE_POR_BASE = {
  pt: 'PT_BR', en: 'EN', es: 'ES', de: 'DE', fr: 'FR', it: 'IT',
  nl: 'NL', pl: 'PL', ja: 'JA', zh: 'ZH', ko: 'KO', ru: 'RU',
};

/** Idioma do banco no formato da Hotmart, ou null quando nao se sabe. Pura. */
function localeHotmart(idioma) {
  const base = String(idioma || '').toLowerCase().split(/[-_]/)[0].trim();
  if (!base) return null;
  return Object.prototype.hasOwnProperty.call(LOCALE_POR_BASE, base) ? LOCALE_POR_BASE[base] : null;
}

/**
 * O produto precisa de correcao de idioma? Pura.
 * Sem idioma conhecido no banco, nao mexe: melhor deixar como esta do que
 * gravar um palpite.
 */
function precisaCorrigirIdioma(idiomaDoBanco, localeNaHotmart) {
  const alvo = localeHotmart(idiomaDoBanco);
  if (!alvo) return false;
  const atual = String(localeNaHotmart || '').toUpperCase().trim();
  if (!atual) return true;
  return atual !== alvo;
}

/** Ordem do conserto: recusado primeiro, depois o que nao e portugues. Pura. */
function prioridade(produto) {
  const p = produto || {};
  const status = String(p.status || '').toUpperCase();
  let nota = 0;
  if (status === 'NOT_APPROVED') nota += 1000;
  if (status === 'CHANGES_PENDING_ON_PRODUCT') nota += 500;
  if (!String(p.language || '').toLowerCase().startsWith('pt')) nota += 100;
  return nota;
}

/** Linha de log da correcao, sem quebra vinda de fora. Pura. */
function resumoIdioma(id, de, para, titulo) {
  const limpo = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
  return limpo(id, 20) + ': ' + (limpo(de, 10) || '(vazio)') + ' -> ' + limpo(para, 10) + ' | "' + limpo(titulo, 40) + '"';
}

module.exports = { localeHotmart, precisaCorrigirIdioma, prioridade, resumoIdioma, LOCALE_POR_BASE };
