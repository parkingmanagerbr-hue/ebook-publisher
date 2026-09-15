'use strict';
/**
 * Dois processos no mesmo ai_state.json. O ultimo a gravar ressuscitava marcas
 * ja liberadas (caso real: 6 chaves do HF presas com a marca das 20:13, liberadas
 * duas vezes). Testa a regra de mescla.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mesclarDegradados } = require('../src/core/aiClient');

const marca = (since_ms) => ({ until: since_ms + 1800000, since_ms, hours: 0.5 });
const LIDO = 1000;

test('marca liberada por outro processo nao volta (o bug)', () => {
  const memoria = { 'huggingface:a': marca(500) };   // lida antes de liberarem
  const disco = {};                                   // outro processo liberou
  assert.deepStrictEqual(mesclarDegradados(memoria, disco, LIDO), {});
});

test('marca nova de outro processo e preservada', () => {
  const disco = { 'groq:x': marca(1500) };
  assert.ok(mesclarDegradados({}, disco, LIDO)['groq:x']);
});

test('este processo liberou a marca antiga: some do disco', () => {
  const disco = { 'gemini:k': marca(400) };
  assert.deepStrictEqual(mesclarDegradados({}, disco, LIDO), {});
});

test('marca criada por este processo depois da leitura e gravada', () => {
  assert.ok(mesclarDegradados({ 'hf:b': marca(2000) }, {}, LIDO)['hf:b']);
});

test('nos dois lados vale a mais recente', () => {
  const r = mesclarDegradados({ k: marca(900) }, { k: marca(1900) }, LIDO);
  assert.strictEqual(r.k.since_ms, 1900);
});
