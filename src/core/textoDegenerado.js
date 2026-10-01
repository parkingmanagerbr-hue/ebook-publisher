'use strict';
/**
 * textoDegenerado.js — a IA as vezes entra em laco e repete um caractere.
 *
 * 01/10/2026: o capitulo 3 de "Maquiagem Vegana para Pele Sensivel em Climas
 * Umidos" veio com UMA "palavra" de 145.059 hifens. O pdfkit tenta quebrar
 * palavra que nao cabe na linha caractere a caractere e o processo morre por
 * falta de memoria (heap). O QA aprovou (conta palavras, nao procura lixo), o
 * texto foi GUARDADO, e como a fila de regeracao tem ordem fixa, os mesmos
 * livros do topo derrubavam todas as rodadas: cinco horas sem um PDF, e sem
 * uma linha de erro, porque o processo morria antes de imprimir o resumo.
 *
 * Aqui: sanear (para o PDF sempre poder ser montado) e apontar o defeito (para
 * o QA e o log saberem que o texto veio estragado). Puro.
 */

// Mesmo caractere repetido alem disto e laco do modelo, nao texto.
const REPETICAO_MAXIMA = 12;
// Nenhuma palavra real passa disto; URL longa ainda cabe.
const PALAVRA_MAXIMA = 80;
// A partir daqui o defeito e grave o bastante para registrar.
const REPETICAO_DEFEITO = 40;
const PALAVRA_DEFEITO = 200;

const REPETIDO = /(\S)\1{12,}/g;
const PALAVRA_LONGA = /\S{81,}/g;

/** Texto pronto para o PDF: repeticao encurtada e palavra gigante quebrada. */
function sanearTexto(texto) {
  if (typeof texto !== 'string' || !texto) return texto;
  return texto
    .replace(REPETIDO, (m, c) => c.repeat(3))
    .replace(PALAVRA_LONGA, (p) => p.match(new RegExp('.{1,' + PALAVRA_MAXIMA + '}', 'g')).join(' '));
}

/** Motivo do defeito, ou null. */
function defeitoDoTexto(texto) {
  if (typeof texto !== 'string' || !texto) return null;
  let maiorRepeticao = 0;
  for (const m of texto.matchAll(REPETIDO)) maiorRepeticao = Math.max(maiorRepeticao, m[0].length);
  if (maiorRepeticao >= REPETICAO_DEFEITO) return 'caractere repetido ' + maiorRepeticao + ' vezes';
  let maiorPalavra = 0;
  for (const m of texto.matchAll(PALAVRA_LONGA)) maiorPalavra = Math.max(maiorPalavra, m[0].length);
  if (maiorPalavra >= PALAVRA_DEFEITO) return 'palavra de ' + maiorPalavra + ' caracteres';
  return null;
}

/**
 * Livro saneado (copia) e a lista do que estava estragado, por trecho.
 * Os titulos tambem passam: sao texto da IA igual ao resto.
 */
function sanearLivro(livro) {
  const defeitos = [];
  const trata = (onde, t) => {
    const d = defeitoDoTexto(t);
    if (d) defeitos.push(onde + ': ' + d);
    return sanearTexto(t);
  };
  if (!livro || typeof livro !== 'object') return { livro, defeitos };
  const saida = {
    ...livro,
    introduction: trata('introducao', livro.introduction),
    conclusion: trata('conclusao', livro.conclusion),
  };
  if (Array.isArray(livro.chapters)) {
    saida.chapters = livro.chapters.map((c, i) => (c && typeof c === 'object')
      ? { ...c, title: trata('capitulo ' + (i + 1) + ' titulo', c.title), content: trata('capitulo ' + (i + 1), c.content) }
      : c);
  }
  return { livro: saida, defeitos };
}

module.exports = { sanearTexto, defeitoDoTexto, sanearLivro, REPETICAO_MAXIMA, PALAVRA_MAXIMA };
