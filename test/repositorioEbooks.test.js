'use strict';
/**
 * Repositorio SQLite e migracoes do painel de publicacao (src/server.js).
 *
 * A pergunta de negocio e "quem ainda falta publicar nesta loja". Se o
 * repositorio devolve e-book que ja esta a venda, a fila gasta a vaga com ele
 * (o limite do lote enche de itens ja publicados) e o que realmente falta nunca
 * entra. Banco sempre :memory:.
 */
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const { runMigrations } = require('../src/infrastructure/db/schema');
const { EbookRepository } = require('../src/infrastructure/db/EbookRepository');
const { Ebook } = require('../src/domain/entities/Ebook');

// Tabela como era ANTES das migracoes v2 (sem colunas da Amazon, idioma etc.).
// As migracoes e que tem de trazer o resto — e isso tambem fica testado.
function bancoLegado() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ebooks (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT,
    cover_path TEXT, pdf_path TEXT, status TEXT DEFAULT 'pending', cakto_url TEXT, cakto_product_id TEXT,
    hotmart_url TEXT, hotmart_product_id TEXT, price REAL DEFAULT 4.99, sales_count INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0.0, created_at TEXT DEFAULT (datetime('now')), published_at TEXT)`);
  return db;
}

function bancoMigrado() {
  const db = bancoLegado();
  runMigrations(db);
  return db;
}

const colunas = (db, t) => db.pragma(`table_info(${t})`).map(c => c.name);

function inserir(db, linha) {
  const l = { status: 'ready', pdf_path: '/data/pdfs/x.pdf', created_at: '2026-09-01 10:00:00', ...linha };
  const cols = Object.keys(l);
  db.prepare(`INSERT INTO ebooks (topic, title, ${cols.join(',')}) VALUES ('t', 'Titulo', ${cols.map(c => '@' + c).join(',')})`).run(l);
}

// ── schema.js ───────────────────────────────────────────────────────────────

test('migracao traz as colunas novas num banco antigo e cria as tabelas auxiliares', () => {
  const db = bancoMigrado();
  const c = colunas(db, 'ebooks');
  for (const nova of ['amazon_product_id', 'amazon_url', 'amazon_asin', 'ml_score', 'ai_provider', 'language', 'word_count'])
    assert.ok(c.includes(nova), 'faltou ' + nova);
  for (const t of ['publishing_queue', 'affiliate_products', 'affiliate_clicks'])
    assert.ok(colunas(db, t).length > 0, 'faltou tabela ' + t);
  assert.ok(colunas(db, 'affiliate_products').includes('click_count'));
  db.prepare("INSERT INTO ebooks (id, topic, title) VALUES ('d', 't', 'T')").run();
  assert.deepStrictEqual(db.prepare("SELECT language, word_count, ml_score FROM ebooks WHERE id='d'").get(),
    { language: 'pt-BR', word_count: 0, ml_score: 0 }, 'defaults das colunas novas');
});

test('migracao e idempotente: roda a cada boot sem erro e sem duplicar coluna', () => {
  const db = bancoMigrado();
  const antes = colunas(db, 'ebooks').length;
  assert.doesNotThrow(() => runMigrations(db));
  assert.strictEqual(colunas(db, 'ebooks').length, antes);
});

test('affiliate_products antiga (sem click_count) ganha a coluna', () => {
  const db = bancoLegado();
  db.exec('CREATE TABLE affiliate_products (id INTEGER PRIMARY KEY, platform TEXT NOT NULL, product_id TEXT, product_name TEXT NOT NULL, landing_page_url TEXT)');
  runMigrations(db);
  assert.ok(colunas(db, 'affiliate_products').includes('click_count'));
});

test('falha na migracao de click_count nao derruba o boot', () => {
  const real = bancoLegado();
  // Proxy que delega ao banco real mas falha so na leitura de affiliate_products.
  const db = {
    pragma: q => { if (q.includes('affiliate_products')) throw new Error('disco cheio'); return real.pragma(q); },
    exec: s => real.exec(s),
  };
  assert.doesNotThrow(() => runMigrations(db));
  assert.ok(colunas(real, 'affiliate_clicks').length > 0, 'o resto da migracao continua depois da falha');
});

// ── EbookRepository ─────────────────────────────────────────────────────────

test('findById devolve entidade ou null', async () => {
  const db = bancoMigrado();
  inserir(db, { id: 'a', hotmart_product_id: '8419956' });
  const repo = new EbookRepository(db);
  const e = await repo.findById('a');
  assert.ok(e instanceof Ebook);
  assert.strictEqual(e.hotmartProductId, '8419956');
  assert.strictEqual(await repo.findById('nao-existe'), null);
});

test('findAll ordena do mais novo e filtra por status', async () => {
  const db = bancoMigrado();
  inserir(db, { id: 'velho', created_at: '2026-01-01 00:00:00', status: 'error' });
  inserir(db, { id: 'novo', created_at: '2026-09-01 00:00:00' });
  const repo = new EbookRepository(db);
  assert.deepStrictEqual((await repo.findAll()).map(e => e.id), ['novo', 'velho']);
  assert.deepStrictEqual((await repo.findAll('error')).map(e => e.id), ['velho']);
});

test('pendentes por loja: exige PDF, exclui ja publicado, erro e em publicacao, respeita limite', async () => {
  const db = bancoMigrado();
  inserir(db, { id: 'ok1', created_at: '2026-09-02 00:00:00' });
  inserir(db, { id: 'ok2', created_at: '2026-09-01 00:00:00', hotmart_product_id: '' });
  inserir(db, { id: 'semPdf', pdf_path: null });
  inserir(db, { id: 'pdfVazio', pdf_path: '' });
  inserir(db, { id: 'jaHotmart', hotmart_product_id: '8419956' });
  inserir(db, { id: 'erro', status: 'error' });
  inserir(db, { id: 'publicando', status: 'publishing' });
  const repo = new EbookRepository(db);
  assert.deepStrictEqual((await repo.findPendingForPlatform('hotmart')).map(e => e.id), ['ok1', 'ok2']);
  assert.deepStrictEqual((await repo.findPendingForPlatform('hotmart', 1)).map(e => e.id), ['ok1']);
  assert.strictEqual((await repo.findPendingForPlatform('cakto')).length, 3, 'jaHotmart ainda falta no Cakto');
});

test('loja desconhecida nao vira SQL (o nome da loja entra na consulta)', async () => {
  const repo = new EbookRepository(bancoMigrado());
  assert.deepStrictEqual(await repo.findPendingForPlatform('hotmart_product_id IS NULL; --'), []);
});

test('REGRESSAO: e-book marcado como publicado na Amazon NAO volta como pendente da Amazon', async () => {
  // markPublished('amazon') grava em amazon_asin, mas a consulta de pendentes
  // olhava amazon_product_id — que so o script antigo de KDP preenchia. Todo
  // e-book publicado pelo painel voltava para a fila da Amazon e ocupava a vaga
  // do lote.
  const db = bancoMigrado();
  inserir(db, { id: 'publicado' });
  inserir(db, { id: 'legado', amazon_product_id: 'B0LEGADO' });
  inserir(db, { id: 'falta' });
  const repo = new EbookRepository(db);
  await repo.markPublished('publicado', 'amazon', 'B0NOVO123', 'https://amazon.com.br/dp/B0NOVO123');
  assert.deepStrictEqual((await repo.findPendingForPlatform('amazon')).map(e => e.id), ['falta']);
});

test('markPublished grava id e url da loja, status publicado e preserva a primeira data', async () => {
  const db = bancoMigrado();
  inserir(db, { id: 'a' });
  const repo = new EbookRepository(db);
  await repo.markPublished('a', 'cakto', 'C1', 'https://pay.cakto.com.br/c1');
  let row = db.prepare("SELECT * FROM ebooks WHERE id='a'").get();
  assert.deepStrictEqual([row.cakto_product_id, row.cakto_url, row.status], ['C1', 'https://pay.cakto.com.br/c1', 'published']);
  assert.ok(row.published_at);
  db.prepare("UPDATE ebooks SET published_at='2020-01-01 00:00:00' WHERE id='a'").run();
  await repo.markPublished('a', 'hotmart', 'H1', 'https://h');
  row = db.prepare("SELECT * FROM ebooks WHERE id='a'").get();
  assert.strictEqual(row.published_at, '2020-01-01 00:00:00');
  assert.strictEqual(row.hotmart_product_id, 'H1');
});

test('save insere e atualiza pelo id', async () => {
  const db = bancoMigrado();
  const repo = new EbookRepository(db);
  const e = new Ebook({ id: 's', topic: 't', title: 'Primeiro', pdfPath: '/p.pdf', price: 9.9 });
  await repo.save(e);
  e.title = 'Segundo';
  await repo.save(e);
  const lidos = await repo.findAll();
  assert.strictEqual(lidos.length, 1);
  assert.strictEqual(lidos[0].title, 'Segundo');
  assert.strictEqual(lidos[0].price, 9.9);
});

test('REGRESSAO: save nao apaga ASIN, idioma e contagem de palavras que ele nao conhece', async () => {
  // INSERT OR REPLACE apaga a linha e insere outra: toda coluna fora da lista
  // voltava ao default — ASIN sumia (e-book "despublicado" da Amazon) e o
  // idioma voltava para pt-BR.
  const db = bancoMigrado();
  inserir(db, { id: 'j', language: 'ja', word_count: 12000 });
  const repo = new EbookRepository(db);
  await repo.markPublished('j', 'amazon', 'B0JA', 'https://amazon.co.jp/dp/B0JA');
  const e = await repo.findById('j');
  e.title = 'Titulo revisado';
  await repo.save(e);
  const row = db.prepare("SELECT * FROM ebooks WHERE id='j'").get();
  assert.deepStrictEqual([row.title, row.amazon_asin, row.amazon_url, row.language, row.word_count],
    ['Titulo revisado', 'B0JA', 'https://amazon.co.jp/dp/B0JA', 'ja', 12000]);
});

test('getStats conta por loja, pendentes, erros e soma receita', async () => {
  const db = bancoMigrado();
  inserir(db, { id: 'h', status: 'published', hotmart_product_id: 'H', revenue: 3.99, sales_count: 1 });
  inserir(db, { id: 'c', status: 'published', cakto_product_id: 'C', revenue: 7.98, sales_count: 2 });
  inserir(db, { id: 'a', status: 'published', amazon_asin: 'B0' });
  inserir(db, { id: 'u', status: 'published', amazon_url: 'https://amazon' });
  inserir(db, { id: 'vazio', hotmart_product_id: '', cakto_product_id: '', amazon_asin: '', amazon_url: '' });
  inserir(db, { id: 'p', status: 'pending' });
  inserir(db, { id: 'semPdf', status: 'pending', pdf_path: null });
  inserir(db, { id: 'e', status: 'error' });
  const s = await new EbookRepository(db).getStats();
  assert.deepStrictEqual(s, { total: 8, published: 4, hotmart: 1, cakto: 1, amazon: 2, pending: 2, errors: 1, revenue: 11.97, sales: 3 });
});

test('getStats em banco vazio devolve zeros, nao null', async () => {
  const s = await new EbookRepository(bancoMigrado()).getStats();
  assert.strictEqual(s.revenue, 0);
  assert.strictEqual(s.sales, 0);
  assert.strictEqual(s.total, 0);
});
