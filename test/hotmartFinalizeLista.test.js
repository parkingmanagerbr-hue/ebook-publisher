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
