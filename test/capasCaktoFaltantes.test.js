'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { semCapa } = require('../scripts/capasCaktoFaltantes');

function banco() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE ebooks (id TEXT, title TEXT, subtitle TEXT, topic TEXT, language TEXT, pdf_path TEXT, cover_path TEXT, cakto_product_id TEXT);" +
          "INSERT INTO ebooks VALUES " +
          "('a','A',null,'t','pt-BR','/pdf/a','/capa/a-sumiu','ck1')," +   // entrega, capa apagada -> entra
          "('b','B',null,'t','pt-BR','/pdf/b','/capa/b','ck2')," +        // tem capa -> fora
          "('c','C',null,'t','pt-BR','/pdf/c-sumiu',null,'ck3')," +        // nao entrega -> fora
          "('d','D',null,'t','pt-BR','/pdf/d',null,NULL)," +                // nao esta na Cakto -> fora
          "('e','E',null,'t','ja-JP','/pdf/e','','ck5');");                // capa vazia -> entra
  return db;
}
const existe = p => ['/pdf/a', '/pdf/b', '/capa/b', '/pdf/d', '/pdf/e'].includes(p);

test('so entra quem entrega na Cakto e perdeu a capa', () => {
  assert.deepStrictEqual(semCapa(banco(), 10, existe).map(e => e.id).sort(), ['a', 'e']);
});

test('respeita o limite e traz o idioma para a capa', () => {
  const r = semCapa(banco(), 1, existe);
  assert.strictEqual(r.length, 1);
  assert.ok(['pt-BR', 'ja-JP'].includes(r[0].language));
});
