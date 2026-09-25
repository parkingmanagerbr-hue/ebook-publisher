'use strict';
/**
 * ofertaViral.js — nota da oferta de um livro, para escolher o que publicar
 * primeiro e o que reescrever.
 *
 * Destilado do conteudo PUBLICO de Fernanda Carbosa (Hotmart Cast #229, "Como
 * vender todos os dias com produtos virais de baixo ticket") em 25/09/2026. O
 * treinamento pago dela (MPV) nao foi comprado nem e necessario: o arcabouco
 * que interessa esta no proprio episodio.
 *
 * Triade: oferta clara e especifica, execucao facil, preco acessivel.
 * Quatro elementos, de 1 a 10:
 *   1. Desejo ardente — bate o olho e pensa "preciso disso"  (quanto MAIOR, melhor)
 *   2. Sensacao de capacidade — "eu consigo fazer isso"      (quanto MAIOR, melhor)
 *   3. Esforco e sacrificio — ninguem quer trabalho           (quanto MENOR, melhor)
 *   4. Tempo ate o resultado                                  (quanto MENOR, melhor)
 *
 * Serve ao nosso caso: catalogo de baixo ticket (R$ 5) que depende de decisao
 * de impulso no marketplace. Tudo aqui e puro e mede TEXTO — nao inventa
 * metrica de venda nem promete resultado.
 */

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Resultado que a pessoa quer, dito na cara: ganhar, parar de, sem, livrar-se.
const DESEJO = [
  /\bsem\s+(gastar|sair|estresse|dor|culpa|complica|segredo|erro)/, /\bpare de\b/, /\bacabe com\b/,
  /\bdobre\b|\btriplique\b|\baumente\b|\breduza\b|\beconomize\b/, /\bganhe\b|\blucre\b|\brenda\b/,
  /\bdefinitivo\b|\bcompleto\b|\bdefinitiva\b/, /\bguia\b|\bmanual\b|\bplano\b|\bmetodo\b|\breceitas?\b/,
  /\bdomine\b|\bdescubra\b|\btransforme\b|\bconquiste\b/,
];
// "eu consigo": passo a passo, para iniciantes, simples, com o que ja tenho.
const CAPACIDADE = [
  /passo a passo/, /\bpara iniciantes\b/, /\bdo zero\b/, /\bsimples\b|\bfacil\b|\bdescomplicad/,
  /\bpratico\b|\bpratica\b/, /\bsem experiencia\b|\bsem conhecimento\b/, /\bcom o que voce ja tem\b/,
  /\bem casa\b|\bsozinho\b|\bsozinha\b/,
];
// Palavras que lembram trabalho duro derrubam a nota (ela e explicita nisso).
const ESFORCO = [
  /\besforco\b|\bsacrificio\b|\bdisciplina\b|\bdedicacao\b/, /\btrabalho duro\b|\bsuor\b/,
  /\bavancado\b|aprofundad|\bprofundo\b/, /\brotina rigorosa\b|\brigor\b/,
  /\bmaratona\b|\bintensivo\b/, /\bexige\b|\brequer\b|\bdemanda\b/,
];
// Prazo curto e explicito: "em 7 dias", "em 30 minutos", "hoje".
const TEMPO_CURTO = /\bem\s+(\d{1,3})\s*(min|minutos|horas?|dias?|semanas?)\b|\bhoje\b|\bem um fim de semana\b|\bexpress\b|\brapido\b|\brapidas?\b/;
const TEMPO_LONGO = /\bem\s+(\d{1,2})\s*(meses|anos)\b|\blongo prazo\b|\bdurante o ano\b/;

function conta(texto, regras) {
  let n = 0;
  for (const r of regras) if (r.test(texto)) n++;
  return n;
}

/**
 * Nota de 1 a 10 a partir de quantos sinais apareceram.
 * O passo e 1.8 para a nota nao saturar em 10 com dois ou tres sinais — senao
 * titulo bom e titulo otimo empatam e a fila perde a ordem. Pura.
 */
function nota(sinais, porSinal = 1.8, base = 2) {
  return Math.max(1, Math.min(10, Math.round(base + sinais * porSinal)));
}

/**
 * Pontua a oferta. Devolve as quatro notas, a nota final e o que melhorar.
 * `desejo` e `capacidade`: quanto maior, melhor. `esforco` e `tempo`: quanto
 * menor, melhor (a nota final ja inverte os dois). Pura.
 */
function pontuarOferta(oferta) {
  // `null` explicito tambem precisa passar: a fila vem do banco e campo vazio
  // acontece.
  const { titulo, descricao, language, idioma } = oferta || {};
  // Os padroes sao em portugues. Medir um titulo em alemao com eles daria nota
  // baixa por causa do IDIOMA, nao da oferta — e isso viraria prioridade errada
  // na fila. Enquanto nao houver padrao por idioma, o honesto e dizer que nao
  // se aplica (medido em 25/09/2026: titulos em zh e de caiam todos em 5).
  const lang = String(language || idioma || 'pt').toLowerCase();
  if (lang && !lang.startsWith('pt')) {
    return { aplicavel: false, nota: null, desejo: null, capacidade: null, esforco: null, tempo: null, sugestoes: [] };
  }
  const t = norm(titulo);
  const d = norm(descricao);
  const tudo = (t + ' ' + d).trim();

  // O titulo pesa mais: e o que a pessoa ve na vitrine.
  const desejo = nota(conta(t, DESEJO) * 2 + conta(d, DESEJO));
  const capacidade = nota(conta(t, CAPACIDADE) * 2 + conta(d, CAPACIDADE));
  const esforco = nota(conta(tudo, ESFORCO), 3, 1);
  const temCurto = TEMPO_CURTO.test(tudo);
  const temLongo = TEMPO_LONGO.test(tudo);
  const tempo = temCurto ? 2 : (temLongo ? 9 : 6);

  const final = Math.max(1, Math.min(10, Math.round((desejo + capacidade + (11 - esforco) + (11 - tempo)) / 4)));

  const sugestoes = [];
  if (desejo <= 4) sugestoes.push('desejo: diga o resultado na cara (o que a pessoa ganha ou para de sofrer)');
  if (capacidade <= 4) sugestoes.push('capacidade: mostre que da para fazer ("passo a passo", "do zero", "sem experiencia")');
  if (esforco >= 6) sugestoes.push('esforco: tire as palavras de trabalho duro (esforco, disciplina, avancado)');
  if (tempo >= 6) sugestoes.push('tempo: prometa um prazo curto e concreto ("em 7 dias", "em 30 minutos")');

  return { aplicavel: true, desejo, capacidade, esforco, tempo, nota: final, sugestoes };
}

/** Ordena livros pela nota da oferta (melhor primeiro). Pura, nao muda a lista. */
function porNotaDeOferta(livros) {
  return [...(livros || [])].filter(Boolean)
    .map(l => ({ livro: l, ...pontuarOferta(l) }))
    // Quem nao tem nota (outro idioma) nao vai para o fim da fila por isso:
    // fica no meio, com a nota neutra de 6.
    .sort((a, b) => (b.aplicavel ? b.nota : 6) - (a.aplicavel ? a.nota : 6));
}

/** Uma linha de log com a nota e o que falta. Pura. */
function resumoDaNota(titulo, p) {
  const limpo = String(titulo == null ? '' : titulo).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 45);
  const s = p || {};
  return '"' + limpo + '" nota=' + s.nota + ' (desejo ' + s.desejo + ', capacidade ' + s.capacidade +
    ', esforco ' + s.esforco + ', tempo ' + s.tempo + ')' +
    (s.sugestoes && s.sugestoes.length ? ' | ' + s.sugestoes.length + ' ajuste(s)' : '');
}

module.exports = { pontuarOferta, porNotaDeOferta, resumoDaNota };
