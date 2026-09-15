'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planejar, alvo, camposAlterados, PRODUTOR } = require('../scripts/entregaCakto');

const LINK = 'https://publisher.veloxisit.com.br/entrega/abc.def';
const COM_NOME = { producerName: 'Veloxis Editorial' };

test('produto com link vazio recebe o link (o defeito real)', () => {
  for (const p of [{ emailAccessLink: null }, { emailAccessLink: '' }, {}]) {
    assert.strictEqual(planejar({ ...COM_NOME, ...p }, LINK), 'gravar');
    assert.deepStrictEqual(alvo({ ...COM_NOME, ...p }, LINK), { emailAccessLink: LINK });
  }
});

test('produto sem nome de vendedor recebe o nome, mesmo com link certo', () => {
  assert.deepStrictEqual(alvo({ emailAccessLink: LINK, producerName: null }, LINK), { producerName: PRODUTOR });
  assert.strictEqual(planejar({ emailAccessLink: LINK }, LINK), 'gravar');
});

test('tudo certo nao gasta chamada; nome ja preenchido nao e trocado (controle)', () => {
  assert.strictEqual(planejar({ emailAccessLink: LINK, producerName: 'Outro Nome' }, LINK), 'ok');
  assert.deepStrictEqual(alvo({ emailAccessLink: LINK, producerName: 'Outro Nome' }, LINK), {});
});

test('link nosso antigo e atualizado; link de terceiro nunca e sobrescrito (controle)', () => {
  assert.strictEqual(planejar({ ...COM_NOME, emailAccessLink: 'https://publisher.veloxisit.com.br/entrega/velho.x' }, LINK), 'gravar');
  assert.strictEqual(planejar({ ...COM_NOME, emailAccessLink: 'https://drive.google.com/arquivo' }, LINK), 'link-alheio');
  assert.deepStrictEqual(alvo({ emailAccessLink: 'https://drive.google.com/arquivo' }, LINK), { producerName: PRODUTOR });
});

test('imagem so e enviada para produto sem imagem e com capa em disco', () => {
  const { precisaImagem } = require('../scripts/entregaCakto');
  assert.strictEqual(precisaImagem({ image: null }, true), true);
  assert.strictEqual(precisaImagem({ image: null }, false), false);
  assert.strictEqual(precisaImagem({ image: 'https://cdn/x.jpg' }, true), false);
});

test('camposAlterados aponta so o que mudou', () => {
  assert.deepStrictEqual(camposAlterados({ a: 1, b: [1], c: 'x' }, { a: 1, b: [2], d: true }), ['b', 'c', 'd']);
  assert.deepStrictEqual(camposAlterados(null, {}), []);
});
