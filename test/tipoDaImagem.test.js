'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { tipoDaImagem } = require('../scripts/capas_em_lote');

test('tipo da capa vem dos bytes: JPEG vira image/jpeg, PNG e o resto image/png', () => {
  assert.deepStrictEqual(tipoDaImagem(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])), { nome: 'capa.jpg', tipo: 'image/jpeg' });
  assert.deepStrictEqual(tipoDaImagem(Buffer.from([0x89, 0x50, 0x4E, 0x47])), { nome: 'capa.png', tipo: 'image/png' });
  assert.deepStrictEqual(tipoDaImagem(null), { nome: 'capa.png', tipo: 'image/png' });
});
