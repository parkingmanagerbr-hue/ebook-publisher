'use strict';
/**
 * Complementa idiomaPorVenda.test.js: fronteiras da estatistica por idioma e o
 * amostrador Beta/Gamma que decide o idioma do proximo e-book. Se o amostrador
 * enviesa, o gerador passa a produzir no idioma errado sem nenhum erro visivel.
 */
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const { comAmbiente, recarregar, semente, sequencia } = require('./apoio');
const { estatisticasPorIdioma, escolherIdioma, base, gamma, beta } = require('../src/agents/idiomaPorVenda');

function banco(sql) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, title TEXT, language TEXT, hotmart_product_id TEXT);' + (sql || ''));
  return db;
}

test('sem tabela de vendas ainda: conta so produtos, sem quebrar', () => {
  const db = banco("INSERT INTO ebooks VALUES ('a','A','pt-BR','1'),('b','B','pt-BR','2'),('c','C','en','3'),('d','D','ja',''),('e','E','ja',NULL);");
  assert.deepStrictEqual(estatisticasPorIdioma(db), { pt: { produtos: 2, vendas: 0 }, en: { produtos: 1, vendas: 0 } },
    'e-book sem produto no Hotmart nao conta como produto');
});

test('produto sem idioma gravado cai na chave vazia, nao some', () => {
  const db = banco("INSERT INTO ebooks VALUES ('a','A',NULL,'1');");
  assert.deepStrictEqual(estatisticasPorIdioma(db), { '': { produtos: 1, vendas: 0 } });
});

test('venda atribuida por titulo a e-book sem produto no Hotmart cria o idioma so com venda', () => {
  const db = banco("INSERT INTO ebooks VALUES ('a','Livro DE','de-DE',NULL);" +
    'CREATE TABLE vendas_hotmart (transacao TEXT, produto_id TEXT, produto TEXT);' +
    "INSERT INTO vendas_hotmart VALUES ('t1','777','Livro DE');");
  assert.deepStrictEqual(estatisticasPorIdioma(db), { de: { produtos: 0, vendas: 1 } });
});

test('base normaliza regiao e caixa; nulo vira vazio', () => {
  assert.deepStrictEqual([base('ja-JP'), base('PT-br'), base('en'), base(null)], ['ja', 'pt', 'en', '']);
});

test('fatia de exploracao sorteia uniforme, ignorando as vendas', () => {
  // primeiro rnd < 0,35 -> explora; segundo rnd escolhe a posicao
  const est = { pt: { produtos: 10, vendas: 9 } };
  assert.strictEqual(escolherIdioma(['pt-BR', 'ja', 'en'], est, sequencia([0.1, 0.5])), 'ja');
  assert.strictEqual(escolherIdioma(['pt-BR', 'ja', 'en'], est, sequencia([0.34, 0.999999])), 'en');
});

test('idioma sem nenhuma estatistica entra no sorteio com o prior (nao e descartado)', () => {
  const f = {};
  const rnd = semente(3);
  for (let i = 0; i < 3000; i++) { const l = escolherIdioma(['pt-BR', 'ko'], { pt: { produtos: 800, vendas: 1 } }, rnd); f[l] = (f[l] || 0) + 1; }
  assert.ok(f.ko > 900, 'idioma novo tem de ser explorado: ' + JSON.stringify(f));
});

test('mais vendas que produtos (venda duplicada) nao gera falha negativa', () => {
  const r = escolherIdioma(['ja'], { ja: { produtos: 1, vendas: 5 } }, sequencia([0.9]));
  assert.strictEqual(r, 'ja');
});

test('sem gerador injetado usa Math.random e devolve um dos candidatos', () => {
  for (let i = 0; i < 20; i++) assert.ok(['pt-BR', 'en'].includes(escolherIdioma(['pt-BR', 'en'], {})));
});

test('IDIOMA_EXPLORACAO=0 desliga a fatia uniforme: so as vendas decidem', t => {
  comAmbiente(t, { IDIOMA_EXPLORACAO: '0' });
  const mod = recarregar('src/agents/idiomaPorVenda.js');
  t.after(() => recarregar('src/agents/idiomaPorVenda.js'));
  const est = { pt: { produtos: 700, vendas: 0 }, ja: { produtos: 20, vendas: 10 } };
  const rnd = semente(11);
  let ja = 0;
  for (let i = 0; i < 500; i++) if (mod.escolherIdioma(['pt-BR', 'ja'], est, rnd) === 'ja') ja++;
  assert.ok(ja > 490, 'com 50% de conversao contra 0%, o japones tem de dominar: ' + ja);
});

// ── amostrador ──────────────────────────────────────────────────────────────

function momentos(f, n) {
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const x = f(); s += x; s2 += x * x; }
  const media = s / n;
  return { media, variancia: s2 / n - media * media };
}

test('REGRESSAO: Gamma(k) tem media k e variancia k (o amostrador estava enviesado)', () => {
  // Medido antes da correcao, com 400 mil amostras de Math.random: Gamma(1)
  // media 0,837 e variancia 0,642; Gamma(0,5) media 0,437. Um amostrador
  // enviesado muda quem o Thompson escolhe sem erro nenhum aparecer.
  const rnd = semente(20260915);
  for (const k of [0.5, 1, 2, 5, 151]) {
    const { media, variancia } = momentos(() => gamma(k, rnd), 40000);
    assert.ok(Math.abs(media - k) / k < 0.03, `Gamma(${k}) media ${media.toFixed(3)}`);
    assert.ok(Math.abs(variancia - k) / k < 0.08, `Gamma(${k}) variancia ${variancia.toFixed(3)}`);
  }
});

test('Beta(a,b) tem media a/(a+b) — o prior de 1 em 150 fica perto de 0,66%', () => {
  const rnd = semente(99);
  const m1 = momentos(() => beta(1, 150, rnd), 40000).media;
  assert.ok(Math.abs(m1 - 1 / 151) / (1 / 151) < 0.03, 'Beta(1,150) media ' + m1);
  const m2 = momentos(() => beta(3, 5, rnd), 40000).media;
  assert.ok(Math.abs(m2 - 3 / 8) < 0.01, 'Beta(3,5) media ' + m2);
});

test('gerador que devolve 0 exato nao produz infinito nem NaN', () => {
  // Math.random pode devolver 0; log(0) = -Infinity.
  const v = gamma(2, sequencia([0, 0.3, 0]));
  assert.ok(Number.isFinite(v) && v > 0, 'veio ' + v);
});

test('proposta invalida (v <= 0) e rejeitada e sorteada de novo', () => {
  // u1 pequeno com cos = -1 empurra x para muito negativo -> v <= 0
  const chamadas = [];
  const base_ = sequencia([0.001, 0.5], semente(1));
  const rnd = () => { const x = base_(); chamadas.push(x); return x; };
  const v = gamma(1, rnd);
  assert.ok(v > 0);
  assert.ok(chamadas.length > 3, 'a primeira proposta tinha de ser descartada');
});

test('proposta recusada no teste de aceitacao gera nova tentativa', () => {
  // x = 4 (u1 = e^-8, cos = 1) e u = 0,9: log(u) acima do limite -> recusa
  const chamadas = [];
  const base_ = sequencia([Math.exp(-8), 0, 0.9], semente(2));
  const rnd = () => { const x = base_(); chamadas.push(x); return x; };
  assert.ok(gamma(1, rnd) > 0);
  assert.ok(chamadas.length > 3, 'tinha de recusar a primeira proposta');
});
