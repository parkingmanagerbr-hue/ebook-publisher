'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planejar } = require('../scripts/entregaCakto');

const LINK = 'https://publisher.veloxisit.com.br/entrega/abc.def';

test('produto com link vazio recebe o link (o defeito real)', () => {
  assert.strictEqual(planejar({ emailAccessLink: null }, LINK), 'gravar');
  assert.strictEqual(planejar({ emailAccessLink: '' }, LINK), 'gravar');
  assert.strictEqual(planejar({}, LINK), 'gravar');
});

test('link ja certo nao gasta chamada', () => {
  assert.strictEqual(planejar({ emailAccessLink: LINK }, LINK), 'ok');
});

test('link nosso antigo e atualizado; link de terceiro nunca e sobrescrito (controle)', () => {
  assert.strictEqual(planejar({ emailAccessLink: 'https://publisher.veloxisit.com.br/entrega/velho.x' }, LINK), 'gravar');
  assert.strictEqual(planejar({ emailAccessLink: 'https://drive.google.com/arquivo' }, LINK), 'link-alheio');
});
