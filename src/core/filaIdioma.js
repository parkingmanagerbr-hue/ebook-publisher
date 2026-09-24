'use strict';
/**
 * filaIdioma.js — quem entra na proxima rodada de publicacao.
 *
 * Ate 23/09/2026 a fila era "portugues primeiro, sempre": as 5 vendas reais
 * foram todas em pt-BR, entao fazia sentido. O efeito colateral medido: dos
 * 10.209 livros, 3.641 estao em outros idiomas e ficaram parados atras de
 * 6.568 em portugues — na Kiwify, nenhum estrangeiro tinha sido publicado.
 *
 * Regra nova: a maioria das vagas continua com portugues (e o que vende), mas
 * uma parte fixa vai para os outros idiomas, em rodizio entre eles, para o
 * catalogo mundial sair do lugar. Sem sorteio: rodizio e reproduzivel e da para
 * testar.
 */

/** pt-BR, PT, pt_br → 'pt'; vazio → ''. Pura. */
function base(idioma) {
  return String(idioma || '').toLowerCase().replace(/[_-].*$/, '').trim();
}

/** É português? Pura. */
function ehPortugues(idioma) {
  return base(idioma) === 'pt';
}

/**
 * Monta a fila da rodada.
 * @param {{language?:string}[]} livros candidatos, ja na ordem de preferencia
 * @param {number} limite vagas da rodada
 * @param {{fatiaEstrangeira?:number, rodada?:number}} opcoes
 *   fatiaEstrangeira: 0 a 1 (0.4 = 40% das vagas para outros idiomas)
 *   rodada: numero que gira o rodizio entre os idiomas estrangeiros
 * Pura.
 */
function filaDaRodada(livros, limite, { fatiaEstrangeira = 0.4, rodada = 0 } = {}) {
  const vagas = Math.max(0, Math.floor(Number(limite) || 0));
  if (!vagas || !Array.isArray(livros) || !livros.length) return [];
  const fatia = Math.min(1, Math.max(0, Number(fatiaEstrangeira) || 0));

  const pt = livros.filter(l => l && ehPortugues(l.language));
  const outros = livros.filter(l => l && !ehPortugues(l.language));
  const vagasFora = Math.min(outros.length, Math.round(vagas * fatia));

  // Rodizio entre idiomas: um de cada vez, comecando por um idioma diferente a
  // cada rodada — senao o primeiro idioma da lista levaria todas as vagas.
  const porIdioma = new Map();
  for (const l of outros) {
    const k = base(l.language) || '??';
    if (!porIdioma.has(k)) porIdioma.set(k, []);
    porIdioma.get(k).push(l);
  }
  const idiomas = [...porIdioma.keys()].sort();
  const giro = idiomas.length ? Math.abs(Math.floor(Number(rodada) || 0)) % idiomas.length : 0;
  const ordem = idiomas.slice(giro).concat(idiomas.slice(0, giro));

  // vagasFora nunca passa de outros.length, entao o rodizio sempre acha item:
  // basta girar pelas posicoes ate completar as vagas.
  const escolhidosFora = [];
  const maiorLista = Math.max(...ordem.map(k => porIdioma.get(k).length), 0);
  for (let volta = 0; volta < maiorLista && escolhidosFora.length < vagasFora; volta++) {
    for (const k of ordem) {
      const lista = porIdioma.get(k);
      if (volta < lista.length) {
        escolhidosFora.push(lista[volta]);
        if (escolhidosFora.length >= vagasFora) break;
      }
    }
  }

  const restantes = vagas - escolhidosFora.length;
  // Titulo repetido no mesmo lote vira produto duplicado na loja.
  return semTitulosRepetidos(pt.slice(0, restantes).concat(escolhidosFora));
}

/**
 * Tira do lote titulos repetidos.
 *
 * 24/09/2026: 39 titulos ficaram com DUAS copias ativas na Hotmart, sempre com
 * ids consecutivos — o mesmo titulo estava duas vezes na fila e o catalogo,
 * lido no inicio do lote, ainda nao conhecia a copia criada minutos antes.
 * Produto duplicado em marketplace nao se desfaz sozinho. Pura.
 */
function semTitulosRepetidos(livros) {
  const vistos = new Set();
  const saida = [];
  for (const l of livros || []) {
    if (!l) continue;
    const chave = String(l.title || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (chave && vistos.has(chave)) continue;
    if (chave) vistos.add(chave);
    saida.push(l);
  }
  return saida;
}

/** Quantos de cada idioma saíram — para o log da rodada. Pura. */
function resumoDaFila(fila) {
  const conta = {};
  for (const l of fila || []) {
    const k = base(l && l.language) || '??';
    conta[k] = (conta[k] || 0) + 1;
  }
  return Object.keys(conta).sort().map(k => k + '=' + conta[k]).join(' ');
}

module.exports = { filaDaRodada, resumoDaFila, semTitulosRepetidos, ehPortugues, base };
