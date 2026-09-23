'use strict';
/**
 * conteudoEbook: o texto do livro tem de sobreviver ao PDF. Foi a perda dos
 * PDFs que pausou 5.795 produtos da Cakto em 23/09/2026.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { salvarConteudo, carregarConteudo, quantosGuardados, contarPalavras, vale } = require('../src/core/conteudoEbook');

const texto = n => Array.from({ length: n }, (_, i) => 'palavra' + i).join(' ');
const LIVRO = { subtitle: 'Guia pratico', sections: [{ title: 'Capitulo 1', content: texto(400) }] };

const banco = t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  return db;
};

test('texto guardado volta igual', t => {
  const db = banco(t);
  assert.strictEqual(salvarConteudo(db, 'livro-1', LIVRO), true);
  assert.deepStrictEqual(carregarConteudo(db, 'livro-1'), LIVRO);
  assert.strictEqual(quantosGuardados(db), 1);
});

test('conteudo curto demais nao e guardado (nao vale regerar PDF de um esqueleto)', t => {
  const db = banco(t);
  assert.strictEqual(salvarConteudo(db, 'livro-2', { sections: [{ title: 'x', content: 'tres palavras aqui' }] }), false);
  assert.strictEqual(carregarConteudo(db, 'livro-2'), null);
  assert.strictEqual(quantosGuardados(db), 0);
});

test('id ausente ou conteudo invalido nao grava', t => {
  const db = banco(t);
  assert.strictEqual(salvarConteudo(db, '', LIVRO), false);
  assert.strictEqual(salvarConteudo(db, null, LIVRO), false);
  assert.strictEqual(salvarConteudo(db, 'x', null), false);
  assert.strictEqual(salvarConteudo(db, 'x', 'texto solto'), false);
  assert.strictEqual(quantosGuardados(db), 0);
});

test('regravar o mesmo livro substitui, nao duplica', t => {
  const db = banco(t);
  salvarConteudo(db, 'livro-3', LIVRO);
  const novo = { sections: [{ title: 'Capitulo 1', content: texto(500) }] };
  salvarConteudo(db, 'livro-3', novo);
  assert.strictEqual(quantosGuardados(db), 1);
  assert.deepStrictEqual(carregarConteudo(db, 'livro-3'), novo);
});

test('contagem de palavras entra em qualquer profundidade', () => {
  assert.strictEqual(contarPalavras({ a: 'uma duas', b: { c: ['tres quatro', 'cinco'] } }), 5);
  assert.strictEqual(contarPalavras('   '), 0);
  assert.strictEqual(contarPalavras(null), 0);
  assert.strictEqual(contarPalavras({ n: 42, ok: true }), 0, 'numero e booleano nao sao texto');
  assert.strictEqual(vale({ t: texto(300) }), true);
  assert.strictEqual(vale({ t: texto(299) }), false);
  assert.strictEqual(vale(null), false);
});

test('linha corrompida no banco nao derruba quem le', t => {
  const db = banco(t);
  salvarConteudo(db, 'livro-4', LIVRO);
  db.prepare('UPDATE ebook_conteudo SET conteudo = ? WHERE ebook_id = ?').run('{isso nao e json', 'livro-4');
  assert.strictEqual(carregarConteudo(db, 'livro-4'), null, 'quem chama gera de novo, em vez de quebrar');
});

test('banco indisponivel: leitura devolve null e contagem zero', () => {
  const quebrado = { prepare: () => { throw new Error('database is locked'); } };
  assert.strictEqual(carregarConteudo(quebrado, 'x'), null);
  assert.strictEqual(quantosGuardados(quebrado), 0);
});

test('livro que nunca foi guardado devolve null', t => {
  assert.strictEqual(carregarConteudo(banco(t), 'nao-existe'), null);
});

test('linha sem texto (coluna vazia) tambem devolve null', t => {
  const db = banco(t);
  salvarConteudo(db, 'livro-5', LIVRO);
  db.prepare("UPDATE ebook_conteudo SET conteudo = '' WHERE ebook_id = ?").run('livro-5');
  assert.strictEqual(carregarConteudo(db, 'livro-5'), null);
  // e um JSON valido mas curto demais tambem nao serve
  db.prepare("UPDATE ebook_conteudo SET conteudo = ? WHERE ebook_id = ?").run(JSON.stringify({ t: 'curto' }), 'livro-5');
  assert.strictEqual(carregarConteudo(db, 'livro-5'), null);
});
