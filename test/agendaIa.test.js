'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { proximaTentativaIa } = require('../src/core/aiClient');
const { ehFalhaDeCota, esperaPorCota, MIN_MS, MAX_MS } = require('../src/core/agendaIa');

const T = 1_000_000_000;
const MIN = 60_000;

test('proxima tentativa: a primeira marca que vence ou fica sondavel', () => {
  const deg = {
    a: { until: T + 90 * MIN, since_ms: T - 5 * MIN },          // sondagem em T+15
    b: { until: T + 8 * MIN, since_ms: T },                      // vence em T+8
    c: { until: T + 60 * MIN, lastProbe: T - 30 * MIN },         // sondagem ja liberada
    d: null, e: {},
  };
  assert.strictEqual(proximaTentativaIa(deg, T, 20 * MIN), T, 'sondagem vencida = agora');
  delete deg.c;
  assert.strictEqual(proximaTentativaIa(deg, T, 20 * MIN), T + 8 * MIN);
  assert.strictEqual(proximaTentativaIa({ x: { until: T + 60 * MIN } }, T, 20 * MIN), T, 'sem since conta como sondavel');
  assert.strictEqual(proximaTentativaIa({}, T), null);
  assert.strictEqual(proximaTentativaIa(undefined), null);
});

test('falha de cota reconhecida; outras nao', () => {
  assert.ok(ehFalhaDeCota('Todos os providers de AI falharam. Providers tentados: .'));
  assert.ok(ehFalhaDeCota('groq(quota/rate-limit)'));
  assert.ok(!ehFalhaDeCota('PDF sem paginas'));
  assert.ok(!ehFalhaDeCota(undefined));
});

test('espera: limitada entre 1 e 30 min; null fora de cota', () => {
  const msg = 'Todos os providers de AI falharam';
  assert.strictEqual(esperaPorCota('erro de disco', {}, T), null);
  assert.strictEqual(esperaPorCota(msg, { a: { until: T + 12 * MIN, since_ms: T } }, T), 12 * MIN);
  assert.strictEqual(esperaPorCota(msg, { a: { until: T + 5 * 60 * MIN, since_ms: T + 90 * MIN } }, T), MAX_MS);
  assert.strictEqual(esperaPorCota(msg, { a: { until: T + 60 * MIN, lastProbe: T - 60 * MIN } }, T), MIN_MS);
  assert.strictEqual(esperaPorCota(msg, {}, T), MAX_MS, 'cota sem marca: espera o maximo');
  assert.strictEqual(esperaPorCota(msg, {}, T, { minMs: 1, maxMs: 2 }), 2);
  assert.ok(esperaPorCota(msg, {}) >= MIN_MS);
});
