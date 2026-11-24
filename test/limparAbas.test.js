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

test('marcador de login: sem prazo, e so a valvula de seguranca limpa', () => {
  assert.strictEqual(loginEmAndamento(null, 5), false);                    // sem marcador: limpa
  assert.strictEqual(loginEmAndamento(1, 5), true);                        // marcador: mantem
  assert.strictEqual(loginEmAndamento(1, 20), true);                       // no limite ainda mantem
  assert.strictEqual(loginEmAndamento(1, 21), false);                      // abas demais: limpa mesmo assim
  assert.strictEqual(loginEmAndamento(0, 3), true);                        // mtime 0 e um marcador valido
});
