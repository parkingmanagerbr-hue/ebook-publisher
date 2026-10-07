'use strict';
/**
 * capasFaltantes: so recria capa de livro cujo arquivo SUMIU — nunca sobrescreve
 * capa que existe — e os que estao a venda vem primeiro.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { filaDeCapas, caminhoDaCapa } = require('../scripts/capasFaltantes');

const existentes = new Set(['/c/existe.png']);
const existe = c => existentes.has(c);

test('so entra livro com titulo e arquivo de capa ausente', () => {
  const fila = filaDeCapas([
    { id: 'a', title: 'Tem capa', cover_path: '/c/existe.png' },
    { id: 'b', title: 'Sumiu', cover_path: '/c/sumiu.png' },
    { id: 'c', title: 'Sem campo', cover_path: null },
    { id: 'd', title: '   ', cover_path: '/c/sumiu2.png' },
  ], existe);
  assert.deepStrictEqual(fila.map(l => l.id), ['b', 'c']);
});

test('ordem: Kiwify (que pula sem capa), depois Hotmart, Cakto, resto', () => {
  const fila = filaDeCapas([
    { id: 'resto', title: 'x', cover_path: '/c/1' },
    { id: 'cakto', title: 'x', cover_path: '/c/2', cakto_product_id: 'c' },
    { id: 'hotmart', title: 'x', cover_path: '/c/3', hotmart_product_id: 'h' },
    { id: 'kiwify', title: 'x', cover_path: '/c/4', kiwify_product_id: 'k' },
  ], existe);
  assert.deepStrictEqual(fila.map(l => l.id), ['kiwify', 'hotmart', 'cakto', 'resto']);
});

test('caminho da capa nova vem do id (estavel) e nao aceita caractere de caminho', () => {
  assert.strictEqual(caminhoDaCapa('ab-12', '/c'), path.join('/c', 'cover_molde_livro_ab-12.jpg'));
  assert.strictEqual(caminhoDaCapa('../x/y', '/c'), path.join('/c', 'cover_molde_livro_xy.jpg'));
});
