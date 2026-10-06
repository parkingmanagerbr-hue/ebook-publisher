'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { idsPorNome, categoriaDoProduto } = require('../scripts/categoriasCakto');

const produtos = [
  { category: { id: 'uuid-saude', name: 'Saúde e Esportes' } },
  { category: { id: 'uuid-fin', name: 'Finanças e Investimentos' } },
  { category: null },
];

test('o id da categoria da Cakto vem dos produtos que ja a usam, pelo nome', () => {
  const ids = idsPorNome(produtos);
  assert.strictEqual(ids.get('saúde e esportes'), 'uuid-saude');
  assert.strictEqual(ids.size, 2);
});

test('tema do livro decide; sem livro, o nome do produto; Outros nao vira categoria', () => {
  const ids = idsPorNome(produtos);
  assert.strictEqual(categoriaDoProduto({ name: 'Livro X' }, { title: 'Livro X', topic: 'finanças pessoais' }, ids), 'uuid-fin');
  assert.strictEqual(categoriaDoProduto({ name: 'Dieta e sono' }, null, ids), 'uuid-saude');
  assert.strictEqual(categoriaDoProduto({ name: 'Xyzzy' }, null, ids), null);
  // categoria conhecida pela regra mas que a Cakto ainda nao tem em nenhum produto
  assert.strictEqual(categoriaDoProduto({ name: 'Docker na prática' }, null, ids), null);
});
