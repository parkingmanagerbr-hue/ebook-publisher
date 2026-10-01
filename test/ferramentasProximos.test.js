'use strict';
/**
 * Depois do piloto, os proximos combos saem por demanda do tema (01/10/2026).
 * Cada caso de fora tem UM defeito so, para provar a regra que o exclui.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { proximosCandidatos } = require('../scripts/gerarFerramentas');

function banco() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ebooks (id TEXT, title TEXT, subtitle TEXT, topic TEXT, language TEXT, pdf_path TEXT,
      hotmart_product_id TEXT, cakto_product_id TEXT, combo_de TEXT);
    CREATE TABLE topics (topic TEXT, demand_score REAL);
    CREATE TABLE ferramentas (ebook_id TEXT);
  `);
  const t = db.prepare('INSERT INTO topics VALUES (?, ?)');
  t.run('baixa', 5); t.run('media', 7); t.run('alta', 9.8);
  const e = db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?,?,?)');
  // Bons, inseridos de modo que o desempate (rowid DESC) daria a ordem INVERSA:
  // so a demanda do tema produz alta, media, baixa.
  e.run('b-alta', 'A', null, 'alta', 'pt', '/p/a.pdf', '3', 'c3', '');
  e.run('b-media', 'M', null, 'media', 'pt-BR', '/p/m.pdf', '2', 'c2', null);
  e.run('b-baixa', 'B', null, 'baixa', 'pt-BR', '/p/b.pdf', '1', 'c1', null);
  // Um defeito cada.
  e.run('x-ingles', 'X', null, 'alta', 'en-US', '/p/x.pdf', '4', 'c4', null);
  e.run('x-sem-hotmart', 'X', null, 'alta', 'pt-BR', '/p/x.pdf', null, 'c5', null);
  e.run('x-sem-cakto', 'X', null, 'alta', 'pt-BR', '/p/x.pdf', '6', '', null);
  e.run('x-combo', 'X', null, 'alta', 'pt-BR', '/p/x.pdf', '7', 'c7', 'b-alta');
  e.run('x-ja-tem', 'X', null, 'tema-proprio', 'pt-BR', '/p/x.pdf', '8', 'c8', null);
  e.run('x-pdf-sumiu', 'X', null, 'alta', 'pt-BR', '/p/sumiu.pdf', '9', 'c9', null);
  e.run('x-sem-pdf', 'X', null, 'alta', 'pt-BR', null, '10', 'c10', null);
  db.prepare('INSERT INTO ferramentas VALUES (?)').run('x-ja-tem');
  return db;
}

const existe = (p) => p !== '/p/sumiu.pdf';

test('ordena pela demanda do tema e exclui cada caso que nao pode virar combo', () => {
  const r = proximosCandidatos(banco(), 10, existe).map((l) => l.id);
  assert.deepStrictEqual(r, ['b-alta', 'b-media', 'b-baixa']);
});

test('respeita o limite, ficando com os de maior demanda', () => {
  assert.deepStrictEqual(proximosCandidatos(banco(), 2, existe).map((l) => l.id), ['b-alta', 'b-media']);
});

test('o PDF tem de existir no disco, nao basta o campo preenchido', () => {
  const nenhum = proximosCandidatos(banco(), 10, () => false);
  assert.deepStrictEqual(nenhum, []);
});

test('um livro por tema, e tema que ja tem ferramenta fica de fora', () => {
  const db = banco();
  const e = db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?,?,?)');
  db.prepare('INSERT INTO topics VALUES (?, ?)').run('repetido', 9.9);
  // Mesmo tema tres vezes (como o "Devocional Diario" do catalogo real).
  e.run('r1', 'R', null, 'repetido', 'pt-BR', '/p/r1.pdf', '20', 'c20', null);
  e.run('r2', 'R', null, 'Repetido ', 'pt-BR', '/p/r2.pdf', '21', 'c21', null);
  e.run('r3', 'R', null, 'repetido', 'pt-BR', '/p/r3.pdf', '22', 'c22', null);
  // Tema "alta" ja ganhou ferramenta por outro livro dele.
  e.run('alta-feita', 'F', null, 'alta', 'pt-BR', '/p/f.pdf', '23', 'c23', null);
  db.prepare('INSERT INTO ferramentas VALUES (?)').run('alta-feita');
  const r = proximosCandidatos(db, 10, existe).map((l) => l.id);
  assert.deepStrictEqual(r, ['r3', 'b-media', 'b-baixa']);
});

test('livro sem PDF nao gasta o tema: o proximo do mesmo tema ainda entra', () => {
  const db = banco();
  const e = db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?,?,?)');
  db.prepare('INSERT INTO topics VALUES (?, ?)').run('dupla', 9.9);
  e.run('d-com-pdf', 'D', null, 'dupla', 'pt-BR', '/p/d.pdf', '30', 'c30', null);
  e.run('d-sem-pdf', 'D', null, 'dupla', 'pt-BR', '/p/sumiu.pdf', '31', 'c31', null);
  assert.strictEqual(proximosCandidatos(db, 1, existe)[0].id, 'd-com-pdf');
});

test('traz os campos que a geracao usa', () => {
  const [l] = proximosCandidatos(banco(), 1, existe);
  assert.deepStrictEqual(Object.keys(l).sort(), ['id', 'language', 'pdf_path', 'subtitle', 'title', 'topic']);
});
