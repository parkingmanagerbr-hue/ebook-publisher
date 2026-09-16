'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { paraLocaleHotmart } = require('../scripts/capas_em_lote');

test('codigo curto do livro novo vira o locale certo (caso real: frances subia como PT_BR)', () => {
  assert.strictEqual(paraLocaleHotmart('fr'), 'FR');
  assert.strictEqual(paraLocaleHotmart('ja'), 'JA');
  assert.strictEqual(paraLocaleHotmart('pt'), 'PT_BR');
  assert.strictEqual(paraLocaleHotmart('en_GB'), 'EN');
});

test('codigo completo continua como antes e desconhecido nao arrisca (controle)', () => {
  assert.strictEqual(paraLocaleHotmart('pt-BR'), 'PT_BR');
  assert.strictEqual(paraLocaleHotmart('en-US'), 'EN');
  assert.strictEqual(paraLocaleHotmart('sv'), null);
  assert.strictEqual(paraLocaleHotmart('constructor'), null);
  assert.strictEqual(paraLocaleHotmart(''), null);
  assert.strictEqual(paraLocaleHotmart(undefined), null);
});
