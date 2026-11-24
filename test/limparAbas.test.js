'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { abasParaFechar, loginEmAndamento } = require('../scripts/limparAbas');

test('fica uma aba por site; as repetidas fecham', () => {
  const urls = ['https://app.hotmart.com/a', 'https://dashboard.kiwify.com/x', 'https://app.hotmart.com/b', 'https://app.hotmart.com/c', 'https://dashboard.kiwify.com/y', 'https://kdp.amazon.com/z'];
  assert.deepStrictEqual(abasParaFechar(urls), [2, 3, 4]);
});

test('about:blank fecha, menos quando e a unica aba', () => {
  assert.deepStrictEqual(abasParaFechar(['https://a.com/', 'about:blank', 'about:blank']), [1, 2]);
  assert.deepStrictEqual(abasParaFechar(['about:blank']), []);
});

test('marcador de login: vale por 2 h, some sozinho e ausente limpa', () => {
  const agora = 10 * 3600 * 1000;
  assert.strictEqual(loginEmAndamento(null, agora), false);
  assert.strictEqual(loginEmAndamento(agora - 30 * 60 * 1000, agora), true);
  assert.strictEqual(loginEmAndamento(agora - 3 * 3600 * 1000, agora), false);
  assert.strictEqual(loginEmAndamento(agora + 60 * 1000, agora), false);   // relogio no futuro: nao confia
});
