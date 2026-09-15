'use strict';
/**
 * learningAgent: score de topico, relatorio e sincronizacao legada de vendas
 * (Cakto e Hotmart). O que protege: a receita e a contagem de vendas que o
 * painel mostra e que o ML usa para escolher o proximo topico.
 *
 * Banco :memory: pelo database.js real; https.get e Math.random injetados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const { interceptar, recarregar, comAmbiente } = require('./apoio');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));
const SESS = path.join(DIR, 'sessions');
fs.mkdirSync(SESS);
process.env.METRICS_DB = ':memory:';
process.env.SESSIONS_DIR = SESS;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const bd = require('../src/core/database');
const la = require('../src/agents/learningAgent');
const db = bd.getDb();

function reiniciar() {
  db.exec('DELETE FROM sales_metrics; DELETE FROM ebooks;');
  db.prepare('UPDATE topics SET ml_score = 0, total_sales = 0').run();
}

let n = 0;
function ebook(extra) {
  const l = { id: 'e' + (++n), topic: 'Concursos públicos', title: 'Livro ' + n, status: 'published', sales_count: 0, revenue: 0, published_at: null, hotmart_product_id: null, ...extra };
  db.prepare('INSERT OR IGNORE INTO topics (topic) VALUES (?)').run(l.topic);
  db.prepare('INSERT INTO ebooks (id, topic, title, status, sales_count, revenue, published_at, hotmart_product_id) VALUES (@id, @topic, @title, @status, @sales_count, @revenue, @published_at, @hotmart_product_id)').run(l);
  return l.id;
}

const mlDe = topic => db.prepare('SELECT ml_score FROM topics WHERE topic = ?').get(topic).ml_score;

// ── runLearningCycle ────────────────────────────────────────────────────────

test('topico sem e-book recebe 80% da demanda; com e-book mas nada publicado, 50%', async t => {
  reiniciar();
  t.mock.method(Math, 'random', () => 0);
  ebook({ topic: 'Concursos públicos', status: 'ready' });
  await la.runLearningCycle();
  assert.strictEqual(mlDe('Investimentos para iniciantes'), 9.0 * 0.8);
  assert.strictEqual(mlDe('Concursos públicos'), 7.0 * 0.5);
});

test('score com vendas, receita, recencia e saturacao, limitado a 10 e nunca negativo', async t => {
  reiniciar();
  t.mock.method(Math, 'random', () => 0);
  const recente = new Date(Date.now() - 3 * 86400000).toISOString();
  const antigo = new Date(Date.now() - 40 * 86400000).toISOString();
  // Freelancer (demanda 7): 2 publicados, 4 vendas, R$ 20 -> 2*0,4 + 10*0,03 + 7*0,2 + bonus 2 = 4,5
  ebook({ topic: 'Freelancer e trabalho remoto', sales_count: 3, revenue: 15, published_at: recente });
  ebook({ topic: 'Freelancer e trabalho remoto', sales_count: 1, revenue: 5, published_at: antigo });
  // Biohacking (demanda 6,8): 8 publicados antigos sem venda -> 1,36 - 0,9 = 0,46
  for (let i = 0; i < 8; i++) ebook({ topic: 'Biohacking e longevidade', published_at: antigo });
  // Maternidade (demanda 7): 1 publicado com 40 vendas -> passa de 10 e trava em 10
  ebook({ topic: 'Maternidade e criação de filhos', sales_count: 40, published_at: recente });
  // Espiritualidade (8): 20 publicados sem venda nem data -> 1,6 - 4,5 < 0 -> 0
  for (let i = 0; i < 20; i++) ebook({ topic: 'Espiritualidade e devocional cristão', sales_count: null, revenue: null });
  await la.runLearningCycle();
  assert.ok(Math.abs(mlDe('Freelancer e trabalho remoto') - 4.5) < 1e-9, String(mlDe('Freelancer e trabalho remoto')));
  assert.ok(Math.abs(mlDe('Biohacking e longevidade') - 0.46) < 1e-9);
  assert.strictEqual(mlDe('Maternidade e criação de filhos'), 10);
  assert.strictEqual(mlDe('Espiritualidade e devocional cristão'), 0);
});

test('relatorio: sem venda pede calibragem e nao elege categoria', async () => {
  reiniciar();
  const r = await la.runLearningCycle();
  assert.match(r.insight, /Aguardando primeiras vendas/);
  assert.strictEqual(r.bestCategory, null);
  assert.strictEqual(r.topRecommendations.length, 5);
  assert.ok(r.topRecommendations[0].mlScore + r.topRecommendations[0].demandScore >= r.topRecommendations[4].mlScore + r.topRecommendations[4].demandScore);
});

test('relatorio: poucas vendas fala em aprendizado; acima de R$ 100 aponta o topico', async () => {
  reiniciar();
  ebook({ topic: 'Investimentos para iniciantes', sales_count: 2, revenue: 9.98 });
  let r = await la.runLearningCycle();
  assert.match(r.insight, /^Com 2 vendas acumuladas/);
  db.prepare('UPDATE ebooks SET revenue = 150').run();
  r = await la.runLearningCycle();
  assert.match(r.insight, /está convertendo melhor/);
});

test('melhor categoria por media de vendas entre publicados', async () => {
  reiniciar();
  ebook({ topic: 'Investimentos para iniciantes', sales_count: 1 });
  ebook({ topic: 'Emagrecimento e dietas low carb', sales_count: 6 });
  ebook({ topic: 'Marketing digital e tráfego pago', sales_count: 3 });
  ebook({ topic: 'Inteligência artificial na prática', sales_count: 0 });
  ebook({ topic: 'Emagrecimento e dietas low carb', sales_count: null, status: 'ready' });
  const r = await la.runLearningCycle();
  assert.deepStrictEqual(r.bestCategory, { category: 'saude', avgSales: 6, count: 1 });
});

test('REGRESSAO: "ia" dentro de outra palavra nao vira categoria tecnologia', async () => {
  // includes('ia') casava culinaria, estrategias, criacao, familia... Com o
  // relatorio dizendo "melhor categoria: tecnologia" para livro de receita.
  reiniciar();
  ebook({ topic: 'Receitas saudáveis e culinária fitness', sales_count: 9 });
  let r = await la.runLearningCycle();
  assert.strictEqual(r.bestCategory.category, 'geral');
  reiniciar();
  ebook({ topic: 'Estratégias de marketing', sales_count: 9 });
  r = await la.runLearningCycle();
  assert.strictEqual(r.bestCategory.category, 'negocios');
  reiniciar();
  ebook({ topic: 'IA para criadores de conteúdo', sales_count: 9 });
  r = await la.runLearningCycle();
  assert.strictEqual(r.bestCategory.category, 'tecnologia', 'a sigla IA continua valendo (controle)');
});

test('topico vazio no e-book cai em geral', async () => {
  reiniciar();
  db.prepare("INSERT OR IGNORE INTO topics (topic) VALUES ('')").run();
  ebook({ topic: '', sales_count: 4 });
  const r = await la.runLearningCycle();
  assert.strictEqual(r.bestCategory.category, 'geral');
});

test('estatistica sem receita calculada nao quebra o log', async t => {
  const real = require('../src/core/database');
  interceptar(t, { '../core/database': { ...real, getStats: () => ({ ...real.getStats(), totalRevenue: undefined }) } });
  const mod = recarregar('src/agents/learningAgent.js');
  t.after(() => recarregar('src/agents/learningAgent.js'));
  await assert.doesNotReject(() => mod.runLearningCycle());
});

// ── fetchers (https.get injetado) ───────────────────────────────────────────

function httpsFalso(t, roteiro) {
  const pedidos = [];
  t.mock.method(https, 'get', (url, opts, cb) => {
    const req = new EventEmitter();
    const passo = roteiro.shift();
    pedidos.push({ url, headers: opts.headers });
    req.destroy = () => { req.destruido = true; };
    req.setTimeout = (ms, fn) => { req.timeoutMs = ms; if (passo === 'timeout') setImmediate(fn); };
    setImmediate(() => {
      if (passo === 'erro') return req.emit('error', new Error('ECONNRESET'));
      if (passo === 'timeout') return;
      const res = new EventEmitter();
      cb(res);
      const corpo = typeof passo === 'string' ? passo : JSON.stringify(passo);
      res.emit('data', corpo.slice(0, 5));
      res.emit('data', corpo.slice(5));
      res.emit('end');
    });
    return req;
  });
  return pedidos;
}

test('fetchers: JSON em partes e montado; corpo invalido, erro de rede e timeout viram null', async t => {
  const pedidos = httpsFalso(t, [{ results: [] }, 'nao-json', 'erro', 'timeout', { items: [1] }, 'lixo', 'erro', 'timeout']);
  assert.deepStrictEqual(await la.fetchCaktoSales('a=1'), { results: [] });
  assert.strictEqual(await la.fetchCaktoSales('a=1'), null);
  assert.strictEqual(await la.fetchCaktoSales('a=1'), null);
  assert.strictEqual(await la.fetchCaktoSales('a=1'), null);
  assert.deepStrictEqual(await la.fetchHotmartSales('jwt'), { items: [1] });
  assert.strictEqual(await la.fetchHotmartSales('jwt'), null);
  assert.strictEqual(await la.fetchHotmartSales('jwt'), null);
  assert.strictEqual(await la.fetchHotmartSales('jwt'), null);
  assert.strictEqual(pedidos[0].headers.Cookie, 'a=1');
  assert.strictEqual(pedidos[4].headers.Authorization, 'Bearer jwt');
  assert.strictEqual(await la.fetchHotmartSales(''), null, 'sem token nem tenta');
  assert.strictEqual(pedidos.length, 8);
});

// ── syncSalesFromPlatforms ──────────────────────────────────────────────────

function sessao(nome, conteudo) {
  fs.writeFileSync(path.join(SESS, nome), typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
}
function limparSessoes() { for (const f of fs.readdirSync(SESS)) fs.unlinkSync(path.join(SESS, f)); }

test('sem arquivos de sessao nao chama rede e nao atualiza nada', async t => {
  reiniciar(); limparSessoes();
  const pedidos = httpsFalso(t, []);
  assert.deepStrictEqual(await la.syncSalesFromPlatforms(), { syncedCakto: 0, syncedHotmart: 0 });
  assert.strictEqual(pedidos.length, 0);
});

test('Cakto: soma aprovadas por produto, casa por titulo e so grava quando cresceu', async t => {
  reiniciar(); limparSessoes();
  const a = ebook({ title: 'Fundo de Emergencia em 12 Meses: guia pratico' });
  const b = ebook({ title: 'Dieta Low Carb', sales_count: 5 });
  ebook({ title: '' });
  const c = ebook({ title: 'Organizacao da Casa' });
  sessao('cakto.json', { cookies: [{ name: 'sessionid', value: 'abc' }, { name: 'csrftoken', value: 'x' }] });
  const pedidos = httpsFalso(t, [{ results: [
    { status: 'approved', product_name: 'Fundo de Emergencia em 12 Meses: guia pratico', producer_net: '3.99' },
    { status: 'complete', product_name: 'Fundo de Emergencia em 12 Meses: guia pratico', total_price: '4.99' },
    { status: 'refunded', product_name: 'Fundo de Emergencia em 12 Meses: guia pratico', producer_net: '3.99' },
    { status: 'approved', offer_name: 'Oferta: Dieta Low Carb completa', producer_net: '3.99' },
    { status: 'approved', product_name: 'Kit Organizacao da Casa + bonus' },
    { status: 'approved' },
    { status: 'approved', product_name: 'Produto que nao existe no banco', producer_net: '1' },
  ] }]);
  const r = await la.syncSalesFromPlatforms();
  assert.strictEqual(pedidos[0].headers.Cookie, 'sessionid=abc; csrftoken=x');
  const linha = id => db.prepare('SELECT sales_count, revenue FROM ebooks WHERE id = ?').get(id);
  assert.deepStrictEqual(linha(a), { sales_count: 2, revenue: 8.98 });
  assert.deepStrictEqual(linha(b), { sales_count: 5, revenue: 0 }, 'banco com mais vendas que a API nao regride');
  assert.deepStrictEqual(linha(c), { sales_count: 1, revenue: 0 }, 'venda sem valor conta com receita zero');
  assert.deepStrictEqual(r, { syncedCakto: 2, syncedHotmart: 0 });
});

test('Cakto: sessao sem cookies ainda consulta; resposta sem results nao grava', async t => {
  reiniciar(); limparSessoes();
  sessao('cakto.json', {});
  const pedidos = httpsFalso(t, [{ detail: 'Authentication credentials were not provided.' }]);
  assert.deepStrictEqual(await la.syncSalesFromPlatforms(), { syncedCakto: 0, syncedHotmart: 0 });
  assert.strictEqual(pedidos[0].headers.Cookie, '');
});

test('sessao corrompida em cada plataforma: avisa e segue para a proxima', async t => {
  reiniciar(); limparSessoes();
  sessao('cakto.json', '{ corrompido');
  sessao('hotmart.json', '{ corrompido');
  httpsFalso(t, []);
  assert.deepStrictEqual(await la.syncSalesFromPlatforms(), { syncedCakto: 0, syncedHotmart: 0 });
});

test('Hotmart: sem token no localStorage nao chama rede', async t => {
  reiniciar(); limparSessoes();
  sessao('hotmart.json', { localStorage: {} });
  const pedidos = httpsFalso(t, []);
  await la.syncSalesFromPlatforms();
  sessao('hotmart.json', {});
  await la.syncSalesFromPlatforms();
  assert.strictEqual(pedidos.length, 0);
});

test('Hotmart: aprovadas por nome, so produto publicado no Hotmart, items ou data', async t => {
  reiniciar(); limparSessoes();
  const a = ebook({ title: 'Investir em Acoes com R$100', hotmart_product_id: '8419956' });
  ebook({ title: 'Investir em Acoes com R$100 (copia fora do Hotmart)' });
  sessao('hotmart.json', { localStorage: { token: 'jwt' } });
  httpsFalso(t, [{ data: [
    { purchase: { status: 'APPROVED', price: { value: '4.99' } }, product: { name: 'Investir em Acoes com R$100' } },
    { purchase: { status: 'CANCELLED', price: { value: '4.99' } }, product: { name: 'Investir em Acoes com R$100' } },
    { purchase: { status: 'APPROVED' }, product: {} },
    { purchase: { status: 'APPROVED' }, product: { name: 'Sem banco' } },
    { purchase: { status: 'APPROVED' } },
    {},
  ] }]);
  const r = await la.syncSalesFromPlatforms();
  assert.deepStrictEqual(r, { syncedCakto: 0, syncedHotmart: 1 });
  assert.deepStrictEqual(db.prepare('SELECT sales_count, revenue FROM ebooks WHERE id = ?').get(a), { sales_count: 1, revenue: 4.99 });
});

test('REGRESSAO: Hotmart nao soma de novo a receita acumulada a cada sincronizacao', async t => {
  // A API devolve o TOTAL do produto; o UPDATE fazia revenue = revenue + total.
  // Com 1 venda e depois 2, a receita ia a 4,99 + 9,98 = 14,97 em vez de 9,98.
  reiniciar(); limparSessoes();
  const a = ebook({ title: 'Guia do Home Office', hotmart_product_id: '1' });
  sessao('hotmart.json', { localStorage: { token: 'jwt' } });
  const vendaHm = () => ({ purchase: { status: 'APPROVED', price: { value: 4.99 } }, product: { name: 'Guia do Home Office' } });
  httpsFalso(t, [{ items: [vendaHm()] }, { items: [vendaHm(), vendaHm()] }, { items: [] }, null]);
  await la.syncSalesFromPlatforms();
  await la.syncSalesFromPlatforms();
  assert.deepStrictEqual(db.prepare('SELECT sales_count, revenue FROM ebooks WHERE id = ?').get(a), { sales_count: 2, revenue: 9.98 });
  assert.deepStrictEqual(await la.syncSalesFromPlatforms(), { syncedCakto: 0, syncedHotmart: 0 }, 'lista vazia nao mexe');
  assert.deepStrictEqual(await la.syncSalesFromPlatforms(), { syncedCakto: 0, syncedHotmart: 0 }, 'resposta nula nao mexe');
});

test('diretorio de sessoes: /app/data no Docker, data/sessions fora dele', async t => {
  comAmbiente(t, { SESSIONS_DIR: undefined });
  const vistos = [];
  for (const docker of [true, false]) {
    const restaurar = t.mock.method(fs, 'existsSync', p => { vistos.push(p); return docker && p === '/app/data'; });
    await la.syncSalesFromPlatforms();
    restaurar.mock.restore();
  }
  assert.ok(vistos.includes(path.join('/app/data/sessions', 'cakto.json')));
  assert.ok(vistos.includes(path.join('/app/data/sessions', 'hotmart.json')));
  assert.ok(vistos.includes(path.join(__dirname, '..', 'data', 'sessions', 'cakto.json')));
  assert.ok(vistos.includes(path.join(__dirname, '..', 'data', 'sessions', 'hotmart.json')));
});
