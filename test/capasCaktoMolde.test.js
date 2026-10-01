'use strict';
/**
 * A capa so pode vir do livro certo: nome repetido no banco NAO liga a nenhum
 * (a capa de um livro iria para o produto de outro).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { livrosPorNome } = require('../scripts/capasCaktoMolde');

function banco() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, title TEXT, subtitle TEXT, language TEXT, cover_path TEXT, cakto_nome TEXT, cakto_product_id TEXT)');
  const e = db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?)');
  e.run('a', 'Livro Unico', 's', 'pt-BR', null, null, 'c1');
  e.run('b', 'Repetido', null, 'pt-BR', null, null, 'c2');
  e.run('c', 'Repetido', null, 'pt-BR', null, null, 'c3');
  e.run('d', 'Titulo Base', null, 'pt-BR', null, 'Titulo Base: Nome Composto na Loja', 'c4');
  e.run('e', 'Fora da Cakto', null, 'pt-BR', null, null, null);
  return db;
}

test('nome unico liga ao livro; o nome usado na loja (cakto_nome) vale mais que o titulo', () => {
  const m = livrosPorNome(banco());
  assert.strictEqual(m.get('livro unico').id, 'a');
  assert.strictEqual(m.get('titulo base: nome composto na loja').id, 'd');
  assert.strictEqual(m.has('titulo base'), false);
});

test('nome repetido nao liga a ninguem', () => {
  const m = livrosPorNome(banco());
  assert.strictEqual(m.has('repetido'), true);
  assert.strictEqual(m.get('repetido'), null);
});

test('livro fora da Cakto nao entra; espacos e caixa nao atrapalham', () => {
  const m = livrosPorNome(banco());
  assert.strictEqual(m.has('fora da cakto'), false);
  const db = banco();
  db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?)').run('f', '  Espaços   Demais ', null, 'pt', null, null, 'c9');
  assert.strictEqual(livrosPorNome(db).get('espaços demais').id, 'f');
});
