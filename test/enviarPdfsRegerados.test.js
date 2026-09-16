'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extrairJson } = require('../scripts/enviarPdfsRegerados');

test('le o JSON mesmo com log do container antes e depois', () => {
  const saida = '[2026-09-15 23:00:00] info [database] Schema inicializado\n[{"produto":"111","pdf_path":"/app/data/pdfs/a.pdf"}]\n';
  assert.deepStrictEqual(extrairJson(saida), [{ produto: '111', pdf_path: '/app/data/pdfs/a.pdf' }]);
  assert.deepStrictEqual(extrairJson('ruido {"removidos":2} fim'), { removidos: 2 });
});

test('sem JSON na saida, falha dizendo o que veio (controle)', () => {
  assert.throws(() => extrairJson('erro: container parado'), /VPS nao devolveu JSON/);
  assert.throws(() => extrairJson(''), /VPS nao devolveu JSON/);
});
