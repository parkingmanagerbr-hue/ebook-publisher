'use strict';
/**
 * dicaNicho.js — escolhe a dica do dia a partir dos livros que ja vendemos.
 *
 * Por que (18/09/2026): as contas sociais somam 41 seguidores no Instagram, 4
 * no Facebook e 36 inscritos no YouTube, e os anuncios tiveram de 0 a 5
 * visualizacoes. Anuncio em conta sem audiencia nao vende. A saida escolhida
 * pelo dono e uma conta de nicho publicando conteudo util todo dia — e o
 * conteudo sai dos nossos proprios livros, que sao nossos.
 *
 * Nicho por dado, nao por palpite: as vendas reais de 16/09/2026 foram
 * "Fundo de Emergência para Autônomos" e "Do Marketing à Data Science".
 *
 * Aqui so a decisao (pura): qual livro, qual trecho e qual texto. Quem
 * desenha o video e publica e o script que chama.
 */
const NICHO = /financ|dinheiro|renda|divida|d[ií]vida|or[çc]amento|invest|aut[oô]nomo|freelanc|carreira|produtivid/i;

/** Frases que servem de dica: praticas, do tamanho de um card. Pura. */
function frasesUteis(texto, { min = 60, max = 180 } = {}) {
  return String(texto || '')
    // quebra de linha do PDF tambem separa: o titulo do capitulo grudava na
    // primeira frase e derrubava a dica inteira no filtro.
    .split(/\r?\n+/)
    .flatMap(l => l.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/))
    // tira marcador de lista e marcacao de markdown que sobra do PDF (`=SOMASE`)
    .map(f => f.trim().replace(/^[•\-–—*\d.)\s]+/, '').replace(/[`*_]+/g, '').trim())
    // Frase inteira: o PDF quebra linha no meio e saia "... ou caderno) e"
    // ou comecava no meio ("detalhado dos custos e priorize...").
    .filter(f => /[.!?]$/.test(f))
    .filter(f => /^[A-ZÀÁÂÃÄÉÊËÍÎÓÔÕÖÚÛÜÇ“"]/.test(f))
    // Fecha o que nao abriu = sobra de frase anterior ("Terreno Ideal”) e faca...").
    .filter(f => (f.match(/\)/g) || []).length <= (f.match(/\(/g) || []).length)
    .filter(f => (f.match(/”/g) || []).length <= (f.match(/“/g) || []).length)
    .filter(f => f.length >= min && f.length <= max)
    // fora: sumario, cabecalho, aviso de direitos e promessa
    .filter(f => !/sum[áa]rio|cap[íi]tulo\s+\d|todos os direitos|veloxis|https?:|@|\bp[áa]gina\b/i.test(f))
    // Fora do livro, "ao final de cada secao" nao quer dizer nada para quem le o post.
    .filter(f => !/\b(se[çc][ãa]o|cap[íi]tulo|neste livro|deste livro|a seguir|acima|abaixo|tabela|figura|anexo)\b/i.test(f))
    .filter(f => !/garantid|ganhe \d|lucro certo|sem esfor[çc]o|100%/i.test(f))
    // dica de verdade costuma ter verbo de acao
    .filter(f => /\b(use|fa[çc]a|anote|separe|defina|comece|evite|reserve|revise|calcule|negocie|organize|registre|escolha|monte|guarde|priorize)\b/i.test(f));
}

/** O livro da vez: do nicho, em portugues, com arquivo, e o que ha mais tempo nao usamos. Pura. */
function escolherLivro(livros, usados = new Map(), agora = Date.now()) {
  const candidatos = (livros || []).filter(l =>
    l && l.pdf &&
    String(l.language || '').toLowerCase().startsWith('pt') &&
    NICHO.test(String(l.title || '') + ' ' + String(l.topic || '')));
  if (!candidatos.length) return null;
  const quando = l => usados.get(String(l.id)) || 0;
  const ordenado = [...candidatos].sort((a, b) => quando(a) - quando(b) || (b.vendas || 0) - (a.vendas || 0));
  const escolhido = ordenado[0];
  // Um mesmo livro nao volta antes de 7 dias, se houver outro disponivel.
  if (quando(escolhido) > agora - 7 * 86400000 && ordenado.length === 1) return null;
  return escolhido;
}

/** Texto do post. Sem promessa, com o link da pagina do livro. Pura. */
function montarLegenda(livro, dica, base = 'https://veloxisit.com.br/livros/') {
  const url = base + livro.slug + '/';
  return [
    dica,
    '',
    'Do e-book "' + livro.title + '", da Veloxis Editorial.',
    'Leitura completa em PDF: ' + url,
    '',
    '#financaspessoais #autonomo #organizacaofinanceira #produtividade #ebook',
  ].join('\n');
}

/** Primeiro comentario: so o link, como manda o costume das redes. Pura. */
function primeiroComentario(livro, base = 'https://veloxisit.com.br/livros/') {
  return '👉 ' + livro.title + ': ' + base + livro.slug + '/';
}

/** Quebra a dica em linhas que cabem no card. Pura. */
function linhasDoCard(dica, largura = 26) {
  const palavras = String(dica || '').split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if ((atual + ' ' + p).trim().length > largura) { if (atual) linhas.push(atual.trim()); atual = p; }
    else atual = (atual + ' ' + p).trim();
  }
  if (atual) linhas.push(atual.trim());
  return linhas;
}

module.exports = { frasesUteis, escolherLivro, montarLegenda, primeiroComentario, linhasDoCard, NICHO };
