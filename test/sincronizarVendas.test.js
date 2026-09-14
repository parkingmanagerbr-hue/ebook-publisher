'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extrairVenda, agregarPorProduto } = require('../src/agents/sincronizarVendas');

// Formato real devolvido por /rest/v2/sales/history (dados pessoais ficticios).
const vendaApi = (transacao, produtoId, comissao) => ({
  product: { id: produtoId, name: 'Produto ' + produtoId, ucode: 'u-' + produtoId },
  buyer: { name: 'Fulana de Tal', email: 'fulana@exemplo.com', documents: ['123'], id: 999 },
  purchase: { transaction: transacao, orderDate: 1789411004000, status: 'APPROVED', buyerId: 999 },
  offer: { price: { value: 4.99 } },
  commission: { value: comissao },
});

test('extrairVenda nao carrega NENHUM dado do comprador', () => {
  const v = extrairVenda(vendaApi('HP1', 8483097, 3.99));
  const serializado = JSON.stringify(v);
  for (const pessoal of ['Fulana', 'fulana@exemplo.com', '"123"', 'buyer'])
    assert.ok(!serializado.includes(pessoal), 'vazou dado pessoal: ' + pessoal);
  assert.deepStrictEqual(Object.keys(v).sort(),
    ['comissao', 'preco', 'produto', 'produtoId', 'quando', 'status', 'transacao']);
});

test('extrairVenda descarta registro sem transacao ou sem produto', () => {
  assert.strictEqual(extrairVenda({ product: { id: 1 }, purchase: {} }), null);
  assert.strictEqual(extrairVenda({ purchase: { transaction: 'X' } }), null);
  assert.strictEqual(extrairVenda(null), null);
});

test('agregarPorProduto soma vendas e receita pela comissao', () => {
  const agg = agregarPorProduto([
    extrairVenda(vendaApi('A', 1, 3.99)),
    extrairVenda(vendaApi('B', 1, 3.99)),
    extrairVenda(vendaApi('C', 2, 3.99)),
  ]);
  assert.strictEqual(agg.get('1').vendas, 2);
  assert.strictEqual(agg.get('1').receita, 7.98);
  assert.strictEqual(agg.get('2').vendas, 1);
});

test('receita nao acumula erro de ponto flutuante', () => {
  const lista = Array.from({ length: 10 }, (_, i) => extrairVenda(vendaApi('T' + i, 5, 0.1)));
  assert.strictEqual(agregarPorProduto(lista).get('5').receita, 1);
});
