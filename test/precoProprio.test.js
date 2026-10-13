'use strict';
/**
 * O preco proprio era `e.combo_de ? ...` repetido em cada publicador. O
 * audiolivro (audio_de) teria subido ao preco padrao de R$ 4,99 em toda loja
 * onde alguem esquecesse a segunda condicao.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { temPrecoProprio, precoDaLoja, sqlSoLivroAvulso } = require('../src/core/precoProprio');

test('combo e audiolivro tem preco proprio; livro avulso nao', () => {
  assert.strictEqual(temPrecoProprio({ combo_de: 'abc' }), true);
  assert.strictEqual(temPrecoProprio({ audio_de: 'abc' }), true, 'o audiolivro tambem');
  assert.strictEqual(temPrecoProprio({ combo_de: '', audio_de: null }), false);
  assert.strictEqual(temPrecoProprio({ combo_de: '  ' }), false, 'so espaco nao e vinculo');
  assert.strictEqual(temPrecoProprio({}), false);
  assert.strictEqual(temPrecoProprio(null), false);
});

test('o preco que vai para a loja: o proprio, ou undefined (padrao da loja)', () => {
  assert.strictEqual(precoDaLoja({ audio_de: 'x', price: 9.9 }), 9.9);
  assert.strictEqual(precoDaLoja({ combo_de: 'x', price: '19.9' }), 19.9);
  assert.strictEqual(precoDaLoja({ price: 9.9 }), undefined, 'livro avulso usa o padrao mesmo com price gravado');
  assert.strictEqual(precoDaLoja({ audio_de: 'x', price: null }), undefined, 'preco nulo nunca sobe (null vira 0 na loja)');
  assert.strictEqual(precoDaLoja({ audio_de: 'x', price: 0 }), undefined);
});

test('o filtro de livro avulso cita so coluna que existe e exclui os dois derivados', () => {
  assert.strictEqual(sqlSoLivroAvulso([]), '', 'sem coluna, nada a excluir');
  assert.strictEqual(sqlSoLivroAvulso(null), '');
  assert.strictEqual(sqlSoLivroAvulso(['combo_de']), "AND (combo_de IS NULL OR combo_de = '') ");
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, combo_de TEXT, audio_de TEXT)');
  const ins = db.prepare('INSERT INTO ebooks VALUES (?,?,?)');
  ins.run('avulso', null, null); ins.run('avulso2', '', ''); ins.run('combo', 'o', null); ins.run('audio', null, 'o');
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  const ids = db.prepare('SELECT e.id FROM ebooks e WHERE 1 ' + sqlSoLivroAvulso(cols, 'e.') + 'ORDER BY id').all().map(r => r.id);
  assert.deepStrictEqual(ids, ['avulso', 'avulso2']);
});
