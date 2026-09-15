'use strict';
/**
 * src/core/database.js — banco de metricas do pipeline (topicos, e-books, vendas).
 *
 * O modulo abre o banco no require. METRICS_DB=':memory:' e definido ANTES do
 * require para nunca tocar data/metrics.db. Cada arquivo de teste roda em
 * processo proprio, entao o singleton nao vaza para outros testes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

process.env.METRICS_DB = ':memory:';
const ALVO = require.resolve('../src/core/database');
const bd = require(ALVO);
const db = bd.getDb();

function limparEbooks() {
  db.exec('DELETE FROM sales_metrics; DELETE FROM ebooks;');
}

test('getDb devolve sempre a mesma conexao, ja com schema e 20 topicos semeados', () => {
  assert.strictEqual(bd.getDb(), db);
  assert.strictEqual(db.name, ':memory:', 'o teste nunca pode abrir o banco real');
  assert.strictEqual(bd.getAllTopics().length, 20);
  assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);
});

test('banco existente com topicos nao e ressemeado ao reiniciar; tabela legada sem FK continua aceitando venda', () => {
  // Reinicio real: arquivo ja tem topicos (inclusive editados a mao). Semear de
  // novo sobrescreveria nada (INSERT OR IGNORE), mas o retorno antecipado evita
  // reinserir topico que o operador APAGOU de proposito.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  const arquivo = path.join(dir, 'metrics.db');
  const legado = new Database(arquivo);
  legado.exec(`CREATE TABLE topics (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT UNIQUE NOT NULL, category TEXT,
      demand_score REAL DEFAULT 5.0, ml_score REAL DEFAULT 0.0, times_used INTEGER DEFAULT 0, total_sales INTEGER DEFAULT 0,
      total_revenue REAL DEFAULT 0.0, avg_rating REAL DEFAULT 0.0, last_used TEXT, created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO topics (topic, category) VALUES ('So este', 'x');
    CREATE TABLE sales_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, ebook_id TEXT NOT NULL, platform TEXT NOT NULL,
      sales INTEGER DEFAULT 0, revenue REAL DEFAULT 0.0, date TEXT DEFAULT (date('now')));`);
  legado.close();

  const antes = process.env.METRICS_DB;
  process.env.METRICS_DB = arquivo;
  delete require.cache[ALVO];
  const outro = require(ALVO);
  try {
    assert.deepStrictEqual(outro.getAllTopics().map(t => t.topic), ['So este'], 'nao ressemeou');
    // sales_metrics legada nao tem FK: venda de e-book inexistente grava a
    // metrica e simplesmente nao mexe em topico.
    assert.doesNotThrow(() => outro.recordSale('sumiu', 'hotmart', 1, 3.99));
    assert.strictEqual(outro.getAllTopics()[0].total_sales, 0);
  } finally {
    outro.getDb().close();
    delete require.cache[ALVO];
    process.env.METRICS_DB = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sem METRICS_DB o modulo abre data/metrics.db do projeto (caminho de producao)', () => {
  // better-sqlite3 interceptado: registra o caminho e entrega um banco em
  // memoria, para nunca abrir o arquivo real.
  const Module = require('module');
  const carregar = Module._load;
  let caminho = null;
  Module._load = function (pedido, pai, ...resto) {
    if (pedido === 'better-sqlite3' && pai && pai.filename === ALVO) {
      return function BancoFalso(p) { caminho = p; return new Database(':memory:'); };
    }
    return carregar.call(this, pedido, pai, ...resto);
  };
  const antes = process.env.METRICS_DB;
  delete process.env.METRICS_DB;
  delete require.cache[ALVO];
  try {
    const isolado = require(ALVO);
    assert.strictEqual(caminho, path.join(__dirname, '..', 'data', 'metrics.db'));
    isolado.getDb().close();
  } finally {
    Module._load = carregar;
    process.env.METRICS_DB = antes;
    delete require.cache[ALVO];
  }
});

test('getNextTopic prefere o de maior score fora da janela de 48h', () => {
  const t = bd.getNextTopic();
  assert.strictEqual(t.topic, 'Educação financeira e saída das dívidas', 'maior demand_score semeado');
  assert.strictEqual(t.reciclado, undefined);
  bd.markTopicUsed(t.topic);
  const depois = bd.getNextTopic();
  assert.notStrictEqual(depois.topic, t.topic, 'usado agora sai da preferencia');
  const usado = bd.getAllTopics().find(x => x.topic === t.topic);
  assert.strictEqual(usado.times_used, 1);
  assert.ok(usado.last_used);
});

test('REGRESSAO 21/08: com todos usados nas ultimas 48h recicla o mais antigo e sinaliza', () => {
  const ordem = bd.getAllTopics().map(t => t.topic);
  db.prepare("UPDATE topics SET last_used = datetime('now', '-1 hour')").run();
  db.prepare("UPDATE topics SET last_used = datetime('now', '-40 hours') WHERE topic = ?").run(ordem[7]);
  const r = bd.getNextTopic();
  assert.strictEqual(r.topic, ordem[7], 'o menos recente, nao um topico fixo');
  assert.strictEqual(r.reciclado, true, 'o chamador precisa saber para reabastecer');
  db.prepare('UPDATE topics SET last_used = NULL').run();
});

test('getNextTopic sem nenhum topico devolve vazio (e nao inventa um)', () => {
  const copia = db.prepare('SELECT * FROM topics').all();
  db.exec('DELETE FROM topics');
  try {
    assert.strictEqual(bd.getNextTopic(), undefined);
  } finally {
    const ins = db.prepare('INSERT INTO topics (id, topic, category, demand_score, ml_score, times_used, total_sales, total_revenue, avg_rating, last_used, created_at) VALUES (@id, @topic, @category, @demand_score, @ml_score, @times_used, @total_sales, @total_revenue, @avg_rating, @last_used, @created_at)');
    copia.forEach(r => ins.run(r));
  }
});

test('updateTopicScore: ml_score tem teto 10 e demanda so sobe acima de 5 vendas', () => {
  const alvo = 'Concursos públicos';
  const antes = bd.getAllTopics().find(t => t.topic === alvo);
  bd.updateTopicScore(alvo, 5, 10);          // 2.5 + 1 = 3.5, sem bonus
  let t = bd.getAllTopics().find(x => x.topic === alvo);
  assert.deepStrictEqual([t.ml_score, t.demand_score, t.total_sales, t.total_revenue], [3.5, antes.demand_score, 5, 10]);
  bd.updateTopicScore(alvo, 6, 100);         // 3 + 10 -> teto 10, bonus 0.5
  t = bd.getAllTopics().find(x => x.topic === alvo);
  assert.deepStrictEqual([t.ml_score, t.demand_score, t.total_sales], [10, antes.demand_score + 0.5, 11]);
  assert.strictEqual(bd.getAllTopics()[0].topic, alvo, 'getAllTopics ordena por ml_score');
  for (let i = 0; i < 10; i++) bd.updateTopicScore(alvo, 6, 0);
  assert.strictEqual(bd.getAllTopics().find(x => x.topic === alvo).demand_score, 10, 'demanda tambem tem teto 10');
});

test('saveEbook cria o topico que falta, grava idioma e aplica padroes', () => {
  limparEbooks();
  bd.saveEbook({ id: 'e1', topic: 'Topico manual novo', title: 'T1', aiProvider: 'groq' });
  const row = db.prepare("SELECT * FROM ebooks WHERE id='e1'").get();
  assert.deepStrictEqual([row.status, row.price, row.language, row.ai_provider], ['pending', 4.99, 'pt-BR', 'groq']);
  assert.strictEqual(db.prepare("SELECT category FROM topics WHERE topic='Topico manual novo'").get().category, 'geral');

  // REGRESSAO: idioma escolhido no ciclo morria aqui e 8.050 linhas ficaram pt-BR.
  bd.saveEbook({ id: 'e2', topic: 'Outro', category: 'financas', title: 'T2', status: 'ready', price: 9.9, language: 'ja' });
  const r2 = db.prepare("SELECT * FROM ebooks WHERE id='e2'").get();
  assert.deepStrictEqual([r2.status, r2.price, r2.language], ['ready', 9.9, 'ja']);
  assert.strictEqual(db.prepare("SELECT category FROM topics WHERE topic='Outro'").get().category, 'financas');
});

test('saveEbook sem topico e recusado pelo banco (topic e obrigatorio)', () => {
  assert.throws(() => bd.saveEbook({ id: 'e3', title: 'Sem topico' }), /NOT NULL/);
});

test('updateEbookStatus grava so os campos informados e data ao publicar', () => {
  limparEbooks();
  bd.saveEbook({ id: 'u1', topic: 'Outro', title: 'T' });
  bd.updateEbookStatus('u1', 'ready');
  let r = db.prepare("SELECT * FROM ebooks WHERE id='u1'").get();
  assert.deepStrictEqual([r.status, r.published_at, r.hotmart_product_id], ['ready', null, null]);

  bd.updateEbookStatus('u1', 'published', { caktoUrl: 'cu', hotmartUrl: 'hu', hotmartProductId: 'H', caktoProductId: 'C', amazonAsin: 'B0', amazonUrl: 'au' });
  r = db.prepare("SELECT * FROM ebooks WHERE id='u1'").get();
  assert.deepStrictEqual([r.status, r.cakto_url, r.hotmart_url, r.hotmart_product_id, r.cakto_product_id, r.amazon_asin, r.amazon_url],
    ['published', 'cu', 'hu', 'H', 'C', 'B0', 'au']);
  assert.ok(r.published_at);

  bd.updateEbookStatus('u1', 'error', { hotmartProductId: '' });
  r = db.prepare("SELECT * FROM ebooks WHERE id='u1'").get();
  assert.strictEqual(r.hotmart_product_id, 'H', 'valor vazio nao apaga id de loja');
});

test('getEbooks filtra por status e ordena do mais novo', () => {
  limparEbooks();
  bd.saveEbook({ id: 'velho', topic: 'Outro', title: 'V', status: 'ready' });
  bd.saveEbook({ id: 'novo', topic: 'Outro', title: 'N' });
  db.prepare("UPDATE ebooks SET created_at = '2020-01-01' WHERE id = 'velho'").run();
  assert.deepStrictEqual(bd.getEbooks().map(e => e.id), ['novo', 'velho']);
  assert.deepStrictEqual(bd.getEbooks('ready').map(e => e.id), ['velho']);
});

test('recordSale soma no e-book e no topico; venda de e-book inexistente e barrada pela FK', () => {
  limparEbooks();
  bd.saveEbook({ id: 'v1', topic: 'Afiliados e monetização de conteúdo', title: 'V' });
  const antes = bd.getAllTopics().find(t => t.topic === 'Afiliados e monetização de conteúdo').total_sales;
  bd.recordSale('v1', 'hotmart', 2, 7.98);
  const e = db.prepare("SELECT sales_count, revenue FROM ebooks WHERE id='v1'").get();
  assert.deepStrictEqual(e, { sales_count: 2, revenue: 7.98 });
  assert.strictEqual(bd.getAllTopics().find(t => t.topic === 'Afiliados e monetização de conteúdo').total_sales, antes + 2);
  assert.throws(() => bd.recordSale('nao-existe', 'hotmart', 1, 1), /FOREIGN KEY/);
});

test('getStats em banco sem e-book devolve zeros e com vendas soma', () => {
  limparEbooks();
  let s = bd.getStats();
  assert.deepStrictEqual([s.totalEbooks, s.published, s.totalSales, s.totalRevenue], [0, 0, 0, 0]);
  bd.saveEbook({ id: 's1', topic: 'Outro', title: 'S' });
  bd.updateEbookStatus('s1', 'published');
  bd.recordSale('s1', 'cakto', 3, 14.97);
  s = bd.getStats();
  assert.deepStrictEqual([s.totalEbooks, s.published, s.totalSales, s.totalRevenue], [1, 1, 3, 14.97]);
  assert.ok(s.topTopic && typeof s.topTopic.topic === 'string');
});
