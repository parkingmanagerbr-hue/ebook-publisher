'use strict';
/**
 * O finalize lista so os RASCUNHOS (status=DRAFT) e so para na pagina vazia.
 * 07/10/2026: a listagem inteira deu 500 e ele via "0 rascunhos"; e, antes, parava
 * em 3.000 produtos de um catalogo de 6.500.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

test('listProducts pede status=DRAFT e atravessa pagina do meio menor', async () => {
  const urls = [];
  const paginas = { 1: [{ id: 1, status: 'DRAFT' }, { id: 2, status: 'DRAFT' }], 2: [{ id: 3, status: 'DRAFT' }], 3: [{ id: 4, status: 'DRAFT' }] };
  // axios falso no cache de modulos, antes de carregar o agente
  const caminhoAxios = require.resolve('axios');
  require.cache[caminhoAxios] = { id: caminhoAxios, filename: caminhoAxios, loaded: true, exports: {
    get: async (url) => { urls.push(url); const p = Number(url.match(/page=(\d+)/)[1]); return { data: { data: paginas[p] || [] } }; },
    post: async () => ({ data: {} }),
  } };
  const corpo = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
  process.env.HOTMART_ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + corpo + '.' + 'x'.repeat(80);
  process.env.HOTMART_TOKEN_FILE = path.join(__dirname, 'nao-existe.txt');
  const { listProducts } = require('../src/agents/hotmartFinalizeAgent');
  const lista = await listProducts();
  assert.deepStrictEqual(lista.map(p => p.id), [1, 2, 3, 4]);
  assert.ok(urls.every(u => /status=DRAFT/.test(u)), 'toda pagina pede so rascunho');
  assert.strictEqual(urls.length, 4, 'para na primeira pagina vazia');
});

test('rascunhos do banco: produto criado (id) e sem URL de venda; o resto fica de fora', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (title TEXT, hotmart_product_id TEXT, hotmart_url TEXT)');
  const i = db.prepare('INSERT INTO ebooks VALUES (?,?,?)');
  i.run('Rascunho', '8680746', null);
  i.run('Rascunho vazio', '8680801', '');
  i.run('Publicado', '8664721', 'https://hotmart.com/product/8664721');
  i.run('Nunca criado', null, null);
  i.run('Id torto', 'abc', null);
  const { rascunhosDoBanco } = require('../src/agents/hotmartFinalizeAgent');
  assert.deepStrictEqual(rascunhosDoBanco(db).map(r => r.id), [8680746, 8680801]);
});

test('listagem que falha NAO vira "zero rascunhos": lanca LISTAGEM_FALHOU', async () => {
  const caminhoAxios = require.resolve('axios');
  const antes = require.cache[caminhoAxios].exports.get;
  require.cache[caminhoAxios].exports.get = async () => { const e = new Error('Request failed with status code 500'); e.response = { status: 500 }; throw e; };
  const { listProducts } = require('../src/agents/hotmartFinalizeAgent');
  await assert.rejects(listProducts(), /LISTAGEM_FALHOU/);
  require.cache[caminhoAxios].exports.get = antes;
});
