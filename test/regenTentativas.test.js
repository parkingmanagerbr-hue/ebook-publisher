'use strict';
/**
 * O passe de capas precisa TERMINAR.
 *
 * Antes, a busca ordenava so por rowid: o livro sem gancho nao era marcado e
 * voltava no ciclo seguinte, entao os 40 do topo se repetiam para sempre e o
 * resto do catalogo so era alcancado quando sobrava cota. Um livro que nunca
 * ganha gancho travava a janela.
 */
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buscarTodas, contarTentativa, garantirTabelas, MAX_TENTATIVAS_GANCHO } = require('../src/agents/regenCovers');

function banco(n) {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE ebooks (id TEXT, title TEXT, subtitle TEXT, topic TEXT, language TEXT, hotmart_product_id TEXT, cover_path TEXT)').run();
  const ins = db.prepare('INSERT INTO ebooks VALUES (?,?,?,?,?,?,?)');
  for (let i = 1; i <= n; i++) ins.run('e' + i, 'Livro ' + i, '', 'tema ' + i, 'pt-BR', String(1000 + i), null);
  garantirTabelas(db);
  return db;
}

test('livro ja tentado cede a vez a quem nunca foi tentado', () => {
  const db = banco(5);
  // Os mais recentes (rowid alto) sao os que a ordem antiga repetia sempre.
  contarTentativa(db, 'e5');
  contarTentativa(db, 'e4');
  const ids = buscarTodas(db, 3).map(r => r.id);
  assert.deepStrictEqual(ids, ['e3', 'e2', 'e1'], 'deveria pegar primeiro os nunca tentados');
});

test('contagem de tentativas acumula por livro', () => {
  const db = banco(2);
  contarTentativa(db, 'e1');
  contarTentativa(db, 'e1');
  contarTentativa(db, 'e1');
  const r = buscarTodas(db, 5).find(x => x.id === 'e1');
  assert.strictEqual(r.tentativas, 3);
});

test('livro concluido nao volta para a fila', () => {
  const db = banco(3);
  db.prepare('INSERT INTO cover_viral_v2 (ebook_id, quando) VALUES (?, ?)').run('e3', Date.now());
  const ids = buscarTodas(db, 10).map(r => r.id);
  assert.ok(!ids.includes('e3'));
  assert.strictEqual(ids.length, 2);
});

test('a janela avanca mesmo que os mesmos livros falhem sempre', () => {
  // Simula ciclos em que NENHUM livro ganha gancho: cada um so conta tentativa.
  // Com a ordem antiga, os mesmos 2 seriam pegos para sempre.
  const db = banco(6);
  const vistos = new Set();
  for (let ciclo = 0; ciclo < 3; ciclo++) {
    for (const r of buscarTodas(db, 2)) { vistos.add(r.id); contarTentativa(db, r.id); }
  }
  assert.strictEqual(vistos.size, 6, 'em 3 ciclos de 2, os 6 livros devem ter tido a vez');
});

test('o teto de tentativas e finito e sensato', () => {
  assert.ok(MAX_TENTATIVAS_GANCHO >= 3 && MAX_TENTATIVAS_GANCHO <= 50);
});
