'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { estatisticasPorIdioma, escolherIdioma } = require('../src/agents/idiomaPorVenda');

// Gerador deterministico: o teste nao pode depender da sorte.
function semente(s) { return () => { s = (s * 1664525 + 1013904223) % 4294967296; return (s + 0.5) / 4294967296; }; }

function frequencia(idiomas, est, n = 4000) {
  const rnd = semente(42), f = {};
  for (let i = 0; i < n; i++) { const l = escolherIdioma(idiomas, est, rnd); f[l] = (f[l] || 0) + 1; }
  return f;
}

test('cenario real de 14/09: japones converte mais e passa a ser o mais sorteado', () => {
  const est = { pt: { produtos: 717, vendas: 2 }, ja: { produtos: 19, vendas: 2 }, en: { produtos: 110, vendas: 0 } };
  const f = frequencia(['pt-BR', 'ja', 'en'], est);
  assert.ok(f.ja > f['pt-BR'] && f.ja > (f.en || 0), JSON.stringify(f));
});

test('sem venda nenhuma, todos continuam sendo explorados (controle)', () => {
  const est = { pt: { produtos: 700, vendas: 0 }, ja: { produtos: 19, vendas: 0 }, en: { produtos: 110, vendas: 0 } };
  const f = frequencia(['pt-BR', 'ja', 'en'], est);
  for (const l of ['pt-BR', 'ja', 'en']) assert.ok((f[l] || 0) > 200, l + ' pouco explorado: ' + JSON.stringify(f));
});

test('venda de produto duplicado fora do banco e atribuida pelo titulo', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE ebooks (id TEXT, title TEXT, language TEXT, hotmart_product_id TEXT);" +
          "CREATE TABLE vendas_hotmart (transacao TEXT, produto_id TEXT, produto TEXT);" +
          "INSERT INTO ebooks VALUES ('a','家計管理','ja-JP','111'),('b','Guia','pt-BR','222');" +
          "INSERT INTO vendas_hotmart VALUES ('t1','999','家計管理'),('t2','222','Guia'),('t3','888','Sem Dono');");
  const est = estatisticasPorIdioma(db);
  assert.deepStrictEqual(est.ja, { produtos: 1, vendas: 1 });
  assert.deepStrictEqual(est.pt, { produtos: 1, vendas: 1 });
});
