'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pendentes, nota } = require('../scripts/regerarPdfCakto');

const existe = c => c === '/capa.jpg' || c === '/tem.pdf';

function bancoFalso(linhas, { quebra = false } = {}) {
  return {
    prepare() {
      if (quebra) throw new Error('no such table: cakto_entrega');
      return { all: () => linhas, run: () => {} };
    },
  };
}

const L = (id, extra = {}) => ({ id, title: 't' + id, topic: null, language: 'en-US', cover_path: null, pdf_path: null, ordem: 1, produto: 'p' + id, ...extra });

test('nota: capa vale mais que idioma, e idioma mais que ordem', () => {
  assert.ok(nota(L('a', { cover_path: '/capa.jpg' }), existe) > nota(L('b', { language: 'pt-BR', ordem: 9e8 }), existe));
  assert.ok(nota(L('b', { language: 'pt-BR' }), existe) > nota(L('c', { ordem: 9e8 }), existe));
  assert.ok(nota(L('d', { ordem: 10 }), existe) > nota(L('e', { ordem: 1 }), existe));
  assert.strictEqual(nota({}, existe), 0);
});

test('fila: so quem esta sem PDF, na ordem da nota e respeitando o limite', () => {
  const linhas = [
    L('semTudo'),
    L('comCapa', { cover_path: '/capa.jpg' }),
    L('jaTemPdf', { pdf_path: '/tem.pdf', cover_path: '/capa.jpg' }),
    L('portugues', { language: 'pt-BR' }),
  ];
  const fila = pendentes(bancoFalso(linhas), 10, existe);
  assert.deepStrictEqual(fila.map(e => e.id), ['comCapa', 'portugues', 'semTudo']);
  assert.deepStrictEqual(pendentes(bancoFalso(linhas), 1, existe).map(e => e.id), ['comCapa']);
});

test('sem a tabela (banco novo) devolve fila vazia', () => {
  assert.deepStrictEqual(pendentes(bancoFalso([], { quebra: true }), 5, existe), []);
});

test('usa fs.existsSync por padrao', () => {
  assert.deepStrictEqual(pendentes(bancoFalso([L('x', { pdf_path: '/nao/existe.pdf' })]), 5).map(e => e.id), ['x']);
  assert.strictEqual(nota({ cover_path: '/nao/existe.jpg', language: 'pt' }), 100);
});

test('PDF refeito: sai da fila de regerar e CONTINUA marcado como pausado por nos (senao nunca volta a vender)', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, title TEXT, subtitle TEXT, topic TEXT, language TEXT, cover_path TEXT, pdf_path TEXT)');
  db.exec('CREATE TABLE cakto_entrega (ebook_id TEXT PRIMARY KEY, produto TEXT, resultado TEXT, quando INTEGER)');
  db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?)').run('L1', 'Livro', null, 't', 'pt-BR', null, null);
  db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?)').run('L2', 'Outro', null, 't', 'pt-BR', null, null);
  db.prepare('INSERT INTO cakto_entrega VALUES (?,?,?,?)').run('L1', 'p1', 'pausado-sem-pdf', 1);
  db.prepare('INSERT INTO cakto_entrega VALUES (?,?,?,?)').run('L2', 'p2', 'gravado-v4', 1);
  const { reabrir, pendentes } = require('../scripts/regerarPdfCakto');
  const { pausadosPorNos } = require('../scripts/entregaCakto');
  assert.deepStrictEqual(pendentes(db, 5, () => false).map(e => e.id), ['L1']);
  assert.strictEqual(reabrir(db, 'L1'), 1);
  assert.strictEqual(reabrir(db, 'L2'), 0, 'registro que nao era pausa nossa nao vira pausa nossa');
  assert.deepStrictEqual(pendentes(db, 5, () => false), [], 'saiu da fila de regerar');
  assert.deepStrictEqual([...pausadosPorNos(db)], ['L1'], 'a entrega ainda sabe que foi ela que pausou');
});
