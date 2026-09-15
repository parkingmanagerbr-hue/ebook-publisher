'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { arquivosProtegidos, escolherExcedente } = require('../src/core/retencao');

function banco() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, pdf_path TEXT, cover_path TEXT, cakto_url TEXT, hotmart_url TEXT, hotmart_product_id TEXT)');
  const ins = db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?)');
  ins.run('cakto', '/d/pdfs/a.pdf', '/d/covers/a.png', 'https://pay.cakto.com.br/x', null, null);
  ins.run('hotmart', '/d/pdfs/b.pdf', null, '', null, '123');
  ins.run('rascunho', '/d/pdfs/c.pdf', '/d/covers/c.png', null, '', '');
  return db;
}

test('protege PDF e capa de livro a venda na Cakto ou Hotmart, nao de rascunho', () => {
  const p = arquivosProtegidos(banco());
  assert.ok(p.has(require('path').resolve('/d/pdfs/a.pdf')));
  assert.ok(p.has(require('path').resolve('/d/covers/a.png')));
  assert.ok(p.has(require('path').resolve('/d/pdfs/b.pdf')));
  assert.ok(!p.has(require('path').resolve('/d/pdfs/c.pdf')), 'rascunho nao e protegido');
});

test('caso real: PDF antigo de produto Cakto sobrevive mesmo fora do teto', () => {
  const p = arquivosProtegidos(banco());
  const arquivos = [
    { full: '/d/pdfs/a.pdf', mtime: 1 },     // o mais velho, a venda
    { full: '/d/pdfs/c.pdf', mtime: 2 },     // rascunho velho
    { full: '/d/pdfs/novo.pdf', mtime: 3 },
  ];
  const apagar = escolherExcedente(arquivos, 1, p).map(a => a.full);
  assert.deepStrictEqual(apagar, ['/d/pdfs/c.pdf']);
});

test('controle: sem protecao, o teto apaga os mais velhos como antes', () => {
  const arquivos = [{ full: '/x/1', mtime: 1 }, { full: '/x/2', mtime: 2 }, { full: '/x/3', mtime: 3 }];
  assert.deepStrictEqual(escolherExcedente(arquivos, 2, new Set()).map(a => a.full), ['/x/1']);
});
