'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { montarPaginaAfiliados, linkAfiliacao, ganhoAfiliado } = require('../scripts/paginaAfiliados');
const { esc, precoBR } = require('../scripts/vitrineLivros');

const F = { esc, precoBR };

test('link de afiliacao usa o produtor e o ucode do produto', () => {
  assert.strictEqual(
    linkAfiliacao('u-1', 'p-1'),
    'https://app.hotmart.com/market/details?producerUcode=p-1&productUcode=u-1');
  assert.strictEqual(linkAfiliacao(null), null);
  assert.ok(linkAfiliacao('u-1').includes('producerUcode=ff801bff'));
});

test('ganho e preco vezes comissao', () => {
  assert.strictEqual(ganhoAfiliado(9.9, 70), 6.93);
  assert.strictEqual(ganhoAfiliado(null, null), 0);
});

test('tabela traz comissao, ganho e link; escapa o titulo', () => {
  const html = montarPaginaAfiliados([{ titulo: 'Livro <b>', slug: 'livro-1', preco: 9.9, comissao: 70, ucode: 'u-1' }], F, new Date('2026-09-18T00:00:00Z'));
  assert.ok(html.includes('Livro &lt;b&gt;'));
  assert.ok(html.includes('<a href="../livro-1/">'));
  assert.ok(html.includes('R$ 6,93'));
  assert.ok(html.includes('productUcode=u-1'));
  assert.ok(html.includes('atualizado em 2026-09-18'));
  assert.ok(!/aggregateRating|mais vendido|garantid[oa] que|\d+ vendas/i.test(html), 'sem numero ou superlativo inventado');
});

test('livro sem ucode nao inventa link, e lista vazia nao quebra', () => {
  const html = montarPaginaAfiliados([{ titulo: 'X', slug: 'x-1', preco: 5, comissao: 50 }], F);
  assert.ok(html.includes('pelo Mercado da Hotmart'));
  assert.ok(!html.includes('productUcode='));
  assert.ok(montarPaginaAfiliados(null, F).includes('Programa de afiliados'));
});
