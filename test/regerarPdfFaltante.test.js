'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { pendentes } = require('../scripts/regerarPdfFaltante');

function banco() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE ebooks (id TEXT, title TEXT, topic TEXT, language TEXT, subtitle TEXT, cover_path TEXT, pdf_path TEXT);" +
          "INSERT INTO ebooks VALUES ('e1','A','ta','pt-BR','s',NULL,NULL),('e2','B','tb','ja-JP','s',NULL,NULL);");
  return db;
}

test('lista os produtos sem arquivo, do mais antigo para o mais novo, respeitando o limite', () => {
  const db = banco();
  db.prepare('CREATE TABLE IF NOT EXISTS hotmart_sem_arquivo (produto TEXT PRIMARY KEY, ebook_id TEXT, quando INTEGER)').run();
  db.prepare('INSERT INTO hotmart_sem_arquivo VALUES (?,?,?)').run('222', 'e2', 200);
  db.prepare('INSERT INTO hotmart_sem_arquivo VALUES (?,?,?)').run('111', 'e1', 100);
  assert.deepStrictEqual(pendentes(db, 5).map(p => p.produto), ['111', '222']);
  assert.deepStrictEqual(pendentes(db, 1).map(p => p.produto), ['111']);
  assert.strictEqual(pendentes(db, 1)[0].language, 'pt-BR');
});

test('cria a tabela quando nao existe e devolve vazio (primeira execucao)', () => {
  assert.deepStrictEqual(pendentes(banco(), 3), []);
});

test('produto cujo e-book nao esta mais no banco nao entra na fila (controle)', () => {
  const db = banco();
  db.prepare('CREATE TABLE IF NOT EXISTS hotmart_sem_arquivo (produto TEXT PRIMARY KEY, ebook_id TEXT, quando INTEGER)').run();
  db.prepare('INSERT INTO hotmart_sem_arquivo VALUES (?,?,?)').run('999', 'sumiu', 1);
  assert.deepStrictEqual(pendentes(db, 5), []);
});

test('e-book que ja voltou a ter PDF em disco sai da fila', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
  const arq = path.join(dir, 'x.pdf');
  fs.writeFileSync(arq, '%PDF-');
  const db = banco();
  db.prepare('UPDATE ebooks SET pdf_path = ? WHERE id = ?').run(arq, 'e1');
  db.prepare('CREATE TABLE IF NOT EXISTS hotmart_sem_arquivo (produto TEXT PRIMARY KEY, ebook_id TEXT, quando INTEGER)').run();
  db.prepare('INSERT INTO hotmart_sem_arquivo VALUES (?,?,?)').run('111', 'e1', 1);
  assert.deepStrictEqual(pendentes(db, 5).map(p => p.produto), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
