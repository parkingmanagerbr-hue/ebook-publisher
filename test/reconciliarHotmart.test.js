'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reconciliar } = require('../scripts/reconciliarHotmart');

const ebook = (id, title, pid = null) => ({ id, title, hotmart_product_id: pid });

test('produto que vendeu e nao esta no banco e ligado ao e-book de mesmo titulo', () => {
  const r = reconciliar(
    [{ produtoId: '8483671', produto: 'Guia Prático de Documentos para Adoção Internacional' }],
    [ebook('a', 'Guia Pratico de Documentos para Adocao Internacional'), ebook('b', 'Outro livro')]);
  assert.deepStrictEqual(r.ligar, [{ ebookId: 'a', produtoId: '8483671', titulo: 'Guia Prático de Documentos para Adoção Internacional' }]);
  assert.deepStrictEqual([r.ambiguos, r.semTitulo], [[], []]);
});

test('produto ja ligado nao e mexido; e-book que ja tem produto nao e candidato (controle)', () => {
  const r = reconciliar(
    [{ produtoId: '111', produto: 'Livro X' }, { produtoId: '222', produto: 'Livro X' }],
    [ebook('a', 'Livro X', '111')]);
  assert.deepStrictEqual(r.ligar, [], 'o unico e-book com esse titulo ja tem produto');
  assert.deepStrictEqual(r.semTitulo, [{ produtoId: '222', titulo: 'Livro X' }]);
});

test('dois e-books livres com o mesmo titulo: ambiguo, nao liga nenhum', () => {
  const r = reconciliar([{ produtoId: '999', produto: 'Titulo Repetido' }],
    [ebook('a', 'Titulo Repetido'), ebook('b', 'Título Repetido')]);
  assert.deepStrictEqual(r.ligar, []);
  assert.deepStrictEqual(r.ambiguos, [{ produtoId: '999', titulo: 'Titulo Repetido', candidatos: 2 }]);
});

test('duas copias do mesmo livro na Hotmart: a primeira liga, a segunda fica orfa', () => {
  const r = reconciliar([{ produtoId: '1', produto: 'Japones' }, { produtoId: '2', produto: 'Japones' }],
    [ebook('a', 'Japones')]);
  assert.deepStrictEqual(r.ligar.map(l => l.produtoId), ['1']);
  assert.deepStrictEqual(r.semTitulo.map(s => s.produtoId), ['2']);
});

test('titulo vazio nunca casa', () => {
  const r = reconciliar([{ produtoId: '5', produto: '' }], [ebook('a', ''), ebook('b', '   ')]);
  assert.deepStrictEqual([r.ligar, r.ambiguos], [[], []]);
  assert.strictEqual(r.semTitulo.length, 1);
});
