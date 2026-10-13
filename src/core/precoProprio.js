'use strict';
/**
 * precoProprio.js — qual linha de `ebooks` sobe com o PROPRIO preco.
 *
 * Livro avulso sobe com o preco padrao de cada loja. Produto montado em cima
 * de um livro (combo com plano de acao, e-book + audiolivro) tem preco
 * decidido pelo dono, gravado em `price`. Antes esta regra era escrita
 * `e.combo_de ? ...` em cada publicador; o audiolivro teria subido a R$ 4,99 em
 * toda loja onde alguem esquecesse de acrescentar a segunda condicao. Uma
 * funcao so, usada por todos.
 *
 * Tudo puro.
 */

const preenchido = v => v != null && String(v).trim() !== '';

/** A linha tem preco proprio (nao o padrao da loja)? */
function temPrecoProprio(e) {
  const l = e || {};
  return preenchido(l.combo_de) || preenchido(l.audio_de);
}

/** O preco a mandar para a loja, ou undefined para "use o padrao da loja". */
function precoDaLoja(e) {
  return temPrecoProprio(e) && Number(e.price) > 0 ? Number(e.price) : undefined;
}

/**
 * Trecho de SQL que exclui produtos derivados (combo e audiolivro) — para as
 * lojas e geradores que so aceitam o livro avulso (KDP, ferramentas). Recebe a
 * lista de colunas existentes: coluna que ainda nao existe no banco nao tem
 * linha para excluir, e citar coluna inexistente derruba a consulta inteira.
 */
function sqlSoLivroAvulso(colunas, prefixo = '') {
  return ['combo_de', 'audio_de']
    .filter(c => (colunas || []).includes(c))
    .map(c => 'AND (' + prefixo + c + ' IS NULL OR ' + prefixo + c + " = '') ")
    .join('');
}

module.exports = { temPrecoProprio, precoDaLoja, sqlSoLivroAvulso };
