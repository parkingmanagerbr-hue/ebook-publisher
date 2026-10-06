'use strict';
/**
 * kiwifyCapa: 06/10/2026 os 921 produtos da Kiwify estavam sem imagem. A capa
 * certa e a do livro LIGADO ao produto; numa captura manual subi a capa de um
 * livro no produto vizinho — a fila nunca pode depender de ordem.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { filaDeCapas, categoriaPrecisaTrocar } = require('../src/agents/kiwifyCapa');
const { mapaDeLivros } = require('../scripts/capas_kiwify');
const { CATEGORIAS: C } = require('../src/agents/kiwifyRegras');

const livros = new Map([
  ['p1', { title: 'Guia de finanças', topic: 'finanças pessoais', cover_path: '/c/1.png' }],
  ['p2', { title: 'Sono', topic: 'sono profundo', cover_path: '/c/2.png' }],
  ['p4', { title: 'Sem capa', topic: 'x', cover_path: '' }],
]);

test('entra so quem nao tem imagem e tem livro ligado com capa', () => {
  const produtos = [
    { id: 'p1', name: 'A', product_img: null },
    { id: 'p2', name: 'B', product_img: 'https://img' },
    { id: 'p3', name: 'C', product_img: null },
    { id: 'p4', name: 'D', product_img: null },
  ];
  const fila = filaDeCapas(produtos, livros);
  assert.deepStrictEqual(fila.map(i => [i.id, i.capa, i.trocar]), [['p1', '/c/1.png', false]]);
  assert.strictEqual(fila[0].categoria, C.financas);
});

test('forcar troca a capa errada; feitos e limite sao respeitados', () => {
  const produtos = [{ id: 'p2', name: 'B', product_img: 'https://errada' }, { id: 'p1', name: 'A', product_img: null }];
  assert.deepStrictEqual(filaDeCapas(produtos, livros, { forcar: new Set(['p2']) }).map(i => [i.id, i.trocar]), [['p2', true], ['p1', false]]);
  assert.deepStrictEqual(filaDeCapas(produtos, livros, { forcar: new Set(['p2']), limite: 1 }).map(i => i.id), ['p2']);
  assert.deepStrictEqual(filaDeCapas(produtos, livros, { feitos: new Set(['p1']) }).map(i => i.id), []);
});

test('categoria so troca quando esta vazia ou em Outros, e nunca para Outros', () => {
  assert.strictEqual(categoriaPrecisaTrocar('999', C.saude), true);
  assert.strictEqual(categoriaPrecisaTrocar(String(C.outros), C.saude), true);
  assert.strictEqual(categoriaPrecisaTrocar(null, C.saude), true);
  assert.strictEqual(categoriaPrecisaTrocar(String(C.ti), C.saude), false);
  assert.strictEqual(categoriaPrecisaTrocar('999', C.outros), false);
});

test('livro do produto: pelo id gravado; sem id, so por nome UNICO', () => {
  const linhas = [
    { pid: 'k1', title: 'Livro Um', cover_path: '/1' },
    { pid: null, title: 'Livro Dois', cover_path: '/2' },
    { pid: null, title: 'Repetido', cover_path: '/3' },
    { pid: null, title: 'Repetido', cover_path: '/4' },
  ];
  const m = mapaDeLivros(linhas, [{ id: 'k1', name: 'outro nome' }, { id: 'k2', name: 'livro  dois' }, { id: 'k3', name: 'Repetido' }]);
  assert.strictEqual(m.get('k1').cover_path, '/1');
  assert.strictEqual(m.get('k2').cover_path, '/2');
  assert.strictEqual(m.has('k3'), false);
});

test('preco abaixo do minimo da moeda e reconhecido', () => {
  const { precoAbaixoDoMinimo } = require('../src/agents/kiwifyCapa');
  assert.strictEqual(precoAbaixoDoMinimo({ currency: 'JPY', price: 500 }), true);
  assert.strictEqual(precoAbaixoDoMinimo({ currency: 'JPY', price: 100000 }), false);
  assert.strictEqual(precoAbaixoDoMinimo({ currency: 'BRL', price: 500 }), false);
});

test('produto em iene abaixo do minimo entra na fila PARA virar US$ 5 (decisao do dono)', () => {
  const { MOEDA_SUBSTITUTA } = require('../src/agents/kiwifyCapa');
  const fila = filaDeCapas([{ id: 'p1', name: 'A', product_img: null, currency: 'JPY', price: 500 }], livros, { converterMoeda: true });
  assert.strictEqual(fila.length, 1);
  assert.deepStrictEqual(fila[0].moeda, { de: 'JPY', moeda: 'USD', centavos: 500 });
  assert.deepStrictEqual(MOEDA_SUBSTITUTA, { moeda: 'USD', centavos: 500 });
  // com imagem tambem entra, so pela moeda
  assert.strictEqual(filaDeCapas([{ id: 'p1', name: 'A', product_img: 'x', currency: 'JPY', price: 500 }], livros, { converterMoeda: true }).length, 1);
  // sem a opcao, produto abaixo do minimo fica fora (troca de preco so acompanhada)
  assert.strictEqual(filaDeCapas([{ id: 'p1', name: 'A', product_img: null, currency: 'JPY', price: 500 }], livros).length, 0);
  // em reais, nada de moeda
  assert.strictEqual(filaDeCapas([{ id: 'p1', name: 'A', product_img: null, currency: 'BRL', price: 500 }], livros)[0].moeda, undefined);
});
