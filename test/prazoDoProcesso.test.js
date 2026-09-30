'use strict';
/**
 * Um script que fala com o Chrome nao pode viver para sempre: em 30/09/2026
 * dois ficaram pendurados quase uma hora e pararam a publicacao sem erro.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { armarPrazoDoProcesso, CODIGO_PRAZO } = require('../src/core/prazoDoProcesso');

const esperar = ms => new Promise(r => setTimeout(r, ms));

test('estourou o prazo: registra o motivo e sai com o codigo proprio', async () => {
  const saidas = [];
  const erros = [];
  armarPrazoDoProcesso({ ms: 20, oQue: 'sessaoHotmart\nlinha forjada', log: { error: m => erros.push(m) }, sair: c => saidas.push(c) });
  await esperar(60);
  assert.deepStrictEqual(saidas, [CODIGO_PRAZO]);
  assert.strictEqual(CODIGO_PRAZO, 3, 'diferente de 2 (precisa de gente) e de 1 (erro comum)');
  assert.match(erros[0], /PRAZO DO PROCESSO: sessaoHotmart linha forjada passou de/);
  assert.ok(!/[\r\n]/.test(erros[0]), 'uma linha so');
});

test('processo que termina a tempo nao e derrubado', async () => {
  const saidas = [];
  const t = armarPrazoDoProcesso({ ms: 40, log: { error() {} }, sair: c => saidas.push(c) });
  clearTimeout(t);
  await esperar(70);
  assert.deepStrictEqual(saidas, []);
});

test('log que estoura nao impede de sair', async () => {
  const saidas = [];
  armarPrazoDoProcesso({ ms: 10, log: { error() { throw new Error('disco cheio'); } }, sair: c => saidas.push(c) });
  await esperar(40);
  assert.deepStrictEqual(saidas, [CODIGO_PRAZO]);
});

test('prazo invalido nao arma nada (nunca derruba por engano)', () => {
  assert.strictEqual(armarPrazoDoProcesso({ ms: 0 }), null);
  assert.strictEqual(armarPrazoDoProcesso({ ms: -5 }), null);
  assert.strictEqual(armarPrazoDoProcesso({ ms: 'abc' }), null);
  assert.strictEqual(armarPrazoDoProcesso(), null);
});

test('o temporizador nao segura o processo vivo (unref)', () => {
  const t = armarPrazoDoProcesso({ ms: 60000, log: { error() {} }, sair() {} });
  assert.strictEqual(t.hasRef(), false);
  clearTimeout(t);
});
