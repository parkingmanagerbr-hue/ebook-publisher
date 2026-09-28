'use strict';
/**
 * tituloUnico.js — nao gerar duas vezes o mesmo livro.
 *
 * Medido em 27/09/2026: 924 e-books pendentes tinham apenas 20 titulos
 * distintos — 663 cópias de "Ganhe Dinheiro com IA em 2026", 101 de "Earn
 * Money with AI in 2026", 73 da versao em espanhol. O grosso e de agosto
 * (quando a rotacao de topicos travou), mas o defeito NAO acabou: nos 7 dias
 * anteriores, 84 dos 1.865 titulos gerados eram repetidos.
 *
 * Duplicata custa caro em todas as pontas: gera PDF e capa a toa, enche o
 * catalogo de produtos identicos (que o comprador nao sabe escolher) e, em
 * marketplace, nao se desfaz sozinha.
 *
 * A verificacao acontece LOGO DEPOIS de gerar o texto e ANTES da capa e do
 * PDF, que sao as etapas caras.
 *
 * Tudo aqui e puro.
 */

/** Mesma normalizacao usada pelos publicadores. */
function chave(titulo) {
  return String(titulo == null ? '' : titulo)
    .normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Decide o que fazer com o titulo recem-gerado. Devolve
 * { acao: 'usar' | 'variar' | 'descartar', titulo, motivo }.
 *
 * - inedito            -> 'usar'
 * - repetido, mas o subtitulo distingue -> 'variar' com "Titulo: Subtitulo"
 * - repetido sem nada que distinga      -> 'descartar' (nao gasta PDF nem capa)
 *
 * `usados` e o conjunto de titulos que ja existem (Set ou lista). Pura.
 */
function decidirTitulo(livro, usados, { maximo = 255 } = {}) {
  const jaUsados = usados instanceof Set
    ? usados
    : new Set((usados || []).map(chave).filter(Boolean));
  const l = livro || {};
  const titulo = String(l.title || l.titulo || '').replace(/\s+/g, ' ').trim().slice(0, maximo);
  if (!titulo) return { acao: 'descartar', titulo: null, motivo: 'livro sem titulo' };
  if (!jaUsados.has(chave(titulo))) return { acao: 'usar', titulo, motivo: 'titulo inedito' };

  const sub = String(l.subtitle || l.subtitulo || '').replace(/\s+/g, ' ').trim();
  if (sub.length >= 4 && chave(sub) !== chave(titulo)) {
    const composto = (titulo + ': ' + sub).slice(0, maximo);
    if (!jaUsados.has(chave(composto))) {
      return { acao: 'variar', titulo: composto, motivo: 'titulo repetido; o subtitulo distingue' };
    }
  }
  // Nunca "Titulo 2": numero nao informa nada a quem le a vitrine, e o livro
  // continuaria sendo o mesmo conteudo com outro rotulo.
  return { acao: 'descartar', titulo: null, motivo: 'titulo repetido e nada distingue' };
}

/** Uma linha de log, sem quebra vinda do titulo gerado. Pura. */
function resumoDoTitulo(decisao, original) {
  const d = decisao || {};
  const limpo = s => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
  return 'titulo ' + (d.acao || '?') + ': "' + limpo(original) + '"' +
    (d.titulo && limpo(d.titulo) !== limpo(original) ? ' -> "' + limpo(d.titulo) + '"' : '') +
    ' (' + limpo(d.motivo) + ')';
}

module.exports = { decidirTitulo, resumoDoTitulo, chave };
