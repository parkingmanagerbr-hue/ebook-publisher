'use strict';
/**
 * 01/10/2026: com 20 combos feitos, a consulta pegava as 20 ferramentas mais
 * antigas (justamente as ja feitas) e as novas nunca viravam combo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ferramentasSemCombo } = require('../scripts/criarCombos');

function banco(feitas, novas) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ferramentas (ebook_id TEXT, token TEXT, especificacao TEXT, criado_em INTEGER);' +
    'CREATE TABLE ebooks (id TEXT, combo_de TEXT);');
  const f = db.prepare('INSERT INTO ferramentas VALUES (?,?,?,?)');
  const e = db.prepare('INSERT INTO ebooks VALUES (?,?)');
  // As antigas ja tem combo; as novas nao.
  for (let i = 0; i < feitas; i++) { f.run('velho' + i, 't', '{}', i); e.run('combo' + i, 'velho' + i); }
  for (let i = 0; i < novas; i++) f.run('novo' + i, 't', '{}', 1000 + i);
  return db;
}

test('com o piloto inteiro feito, devolve as ferramentas NOVAS (o defeito devolvia as 20 antigas)', () => {
  const r = ferramentasSemCombo(banco(20, 4), 20).map((x) => x.ebook_id);
  assert.deepStrictEqual(r, ['novo0', 'novo1', 'novo2', 'novo3']);
});

test('respeita o limite pela ordem de criacao', () => {
  assert.deepStrictEqual(ferramentasSemCombo(banco(3, 5), 2).map((x) => x.ebook_id), ['novo0', 'novo1']);
});

test('tudo feito: lista vazia', () => {
  assert.deepStrictEqual(ferramentasSemCombo(banco(5, 0), 20), []);
});
