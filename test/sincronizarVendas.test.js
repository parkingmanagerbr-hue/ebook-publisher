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

test('rajada de teste de cartao (padrao real de 15/09) sai do aprendizado; venda isolada fica', () => {
  const { marcarSuspeitas } = require('../src/agents/sincronizarVendas');
  const t0 = Date.UTC(2026, 8, 15, 5, 48, 37);
  const v = (id, s) => ({ transacao: 't' + id + s, produtoId: String(id), quando: t0 + s * 1000, comissao: 3 });
  const r = marcarSuspeitas([
    v(8451777, 0), v(8451665, 7), v(8451942, 19), v(8444361, 357),   // 4 produtos em 6 min
    v(9000001, 40000),                                                // 11 h depois, sozinha
    v(9000002, 90000), v(9000002, 90300),                             // mesmo produto 2x: nao e rajada
  ]);
  assert.deepStrictEqual(r.map(x => x.suspeita), [true, true, true, true, false, false, false]);
});

test('rajada: dois produtos distintos nao bastam e intervalo acima da janela separa os grupos (controle)', () => {
  const { marcarSuspeitas } = require('../src/agents/sincronizarVendas');
  const m = 60000;
  const base = [{ produtoId: 'a', quando: 0 }, { produtoId: 'b', quando: 5 * m }];
  assert.deepStrictEqual(marcarSuspeitas(base).map(x => x.suspeita), [false, false]);
  const separados = [{ produtoId: 'a', quando: 0 }, { produtoId: 'b', quando: 16 * m }, { produtoId: 'c', quando: 32 * m }];
  assert.deepStrictEqual(marcarSuspeitas(separados).map(x => x.suspeita), [false, false, false]);
  assert.deepStrictEqual(marcarSuspeitas([null, { produtoId: 'z', quando: 1 }]).length, 1);
  const entrada = [{ produtoId: 'a', quando: 2 }, { produtoId: 'b', quando: 1 }];
  marcarSuspeitas(entrada);
  assert.strictEqual(entrada[0].suspeita, undefined, 'nao altera a entrada');
});
