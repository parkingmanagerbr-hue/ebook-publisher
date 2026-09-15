'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizarTitulo, reconciliar } = require('../scripts/reconciliarCakto');

test('normalizacao ignora caixa, acento e pontuacao, mas nao troca palavra', () => {
  assert.strictEqual(normalizarTitulo('Liderança Servidora: Inspire Equipes‑Remotas'), normalizarTitulo('LIDERANCA servidora inspire equipes remotas'));
  assert.notStrictEqual(normalizarTitulo('Ganhe Dinheiro com IA'), normalizarTitulo('Ganhe Dinheiro como Afiliado'));
  assert.strictEqual(normalizarTitulo('家計管理アプリ'), '家計管理アプリ');
});

test('caso real: 3 livros dividindo um checkout voltam cada um para o seu', () => {
  const ebooks = [
    { id: 'a', title: 'Guia A', cakto_product_id: 'xxx' },
    { id: 'b', title: 'Guia B', cakto_product_id: 'xxx' },
    { id: 'c', title: 'Guia C', cakto_product_id: 'xxx' },
  ];
  const ofertas = [{ id: 'ofC', name: 'Guia C' }, { id: 'xxx', name: 'Guia A' }, { id: 'ofB', name: 'Guia B' }];
  const { mudancas, resumo } = reconciliar(ebooks, ofertas);
  assert.deepStrictEqual(resumo, { ok: 1, corrigidos: 2, semOferta: 0, duplicadasNaCakto: 0 });
  assert.deepStrictEqual(mudancas.map(m => m.para).sort(), ['ofB', 'ofC']);
});

test('livro sem oferta de mesmo nome perde o link (controle: nao casa por palavra parecida)', () => {
  const { mudancas } = reconciliar(
    [{ id: 'a', title: 'Ganhe Dinheiro com IA', cakto_product_id: 'p1' }],
    [{ id: 'p1', name: 'Ganhe Dinheiro como Afiliado com IA' }]);
  assert.deepStrictEqual(mudancas, [{ id: 'a', de: 'p1', para: null }]);
});

test('livro sem link e sem oferta nao gera mudanca', () => {
  assert.deepStrictEqual(reconciliar([{ id: 'a', title: 'X', cakto_product_id: null }], []).mudancas, []);
});

test('oferta duplicada na Cakto: a mais antiga fica com o livro, a segunda com o gemeo', () => {
  // API lista da mais nova para a mais antiga.
  const ofertas = [{ id: 'nova', name: 'Mesmo Titulo' }, { id: 'antiga', name: 'Mesmo Titulo' }, { id: 'z', name: '' }];
  const ebooks = [{ id: '1', title: 'Mesmo Titulo', cakto_product_id: null }, { id: '2', title: 'Mesmo Titulo', cakto_product_id: null }];
  const { mudancas, resumo } = reconciliar(ebooks, ofertas);
  assert.deepStrictEqual(mudancas, [{ id: '1', de: null, para: 'antiga' }, { id: '2', de: null, para: 'nova' }]);
  assert.strictEqual(resumo.duplicadasNaCakto, 1);
});
