'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { contaLiberada } = require('../src/agents/kdpConta');

test('conta com acao necessaria nao libera, e diz o motivo', () => {
  const r = contaLiberada('Ação necessária. Sua conta não está completa.\nReceber pagamento\nAção necessária: você inseriu uma conta bancária que não pode receber pagamentos do KDP.');
  assert.strictEqual(r.liberada, false);
  assert.match(r.motivo, /conta bancária que não pode receber/);
});

test('conta sem pendencia libera', () => {
  assert.deepStrictEqual(contaLiberada('Detalhes da conta\nReceber pagamento\nBrasil *****968\nVerificando os dados bancários.'), { liberada: true, motivo: '' });
});

test('pagina que nao carregou nao conta como liberada', () => {
  assert.strictEqual(contaLiberada('').liberada, false);
  assert.strictEqual(contaLiberada('Faça login').liberada, false);
});
