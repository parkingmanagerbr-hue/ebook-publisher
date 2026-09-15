'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { precoCakto, descricaoCakto, codigoDoPayUrl, lerRespostaCakto, paraNumero } = require('../src/agents/caktoRegras');

// ── Preco ───────────────────────────────────────────────────────────────────

test('preco do livro manda, respeitado o minimo de R$ 5,00 da Cakto', () => {
  assert.strictEqual(precoCakto(29.9, 4.99), '29,90');
  assert.strictEqual(precoCakto(5, 4.99), '5,00');
  assert.strictEqual(precoCakto(3.5, 4.99), '5,00', 'abaixo do minimo sobe para o minimo');
  assert.strictEqual(precoCakto(4.999, 4.99), '5,00');
});

test('sem preco no livro vale o padrao; sem os dois, o minimo', () => {
  assert.strictEqual(precoCakto(undefined, 9.9), '9,90');
  assert.strictEqual(precoCakto(null, 9.9), '9,90');
  assert.strictEqual(precoCakto(0, 9.9), '9,90');
  assert.strictEqual(precoCakto(undefined, undefined), '5,00');
  assert.strictEqual(precoCakto(undefined, NaN), '5,00');
});

test('preco escrito em texto brasileiro nao vira "NaN" no checkout', () => {
  // Math.max(5, "9,90") dava NaN e o campo do checkout recebia a palavra NaN.
  assert.strictEqual(precoCakto('9,90', 4.99), '9,90');
  assert.strictEqual(precoCakto('R$ 12,50', 4.99), '12,50');
  assert.strictEqual(precoCakto('7.5', 4.99), '7,50');
  assert.strictEqual(precoCakto('1.299,90', 4.99), '1299,90');
  assert.strictEqual(precoCakto('gratis', 8), '8,00', 'texto sem numero cai no padrao');
  assert.strictEqual(precoCakto('gratis', 'R$ 8,00'), '8,00');
});

test('paraNumero: numero, texto e lixo', () => {
  assert.strictEqual(paraNumero(12.3), 12.3);
  assert.strictEqual(paraNumero('30'), 30);
  assert.strictEqual(paraNumero('0,05'), 0.05);
  assert.strictEqual(paraNumero(',5'), 0.5);
  assert.ok(Number.isNaN(paraNumero('')));
  assert.ok(Number.isNaN(paraNumero(null)));
  assert.ok(Number.isNaN(paraNumero('R$')));
});

// ── Descricao ───────────────────────────────────────────────────────────────

const conta = s => [...s].length;

test('descricao curta ou ausente e completada acima do minimo da Cakto', () => {
  const semNada = descricaoCakto({ title: 'Sono Profundo' });
  assert.ok(semNada.length >= 110, 'veio ' + semNada.length);
  assert.match(semNada, /^Guia completo e prático sobre Sono Profundo\. Aprenda/);
  const comTopico = descricaoCakto({ title: 'T', topic: 'meditação guiada' });
  assert.match(comTopico, /sobre meditação guiada/);
  const curta = descricaoCakto({ description: 'Um resumo curto.' });
  assert.ok(curta.startsWith('Um resumo curto. '));
  assert.ok(curta.length >= 110);
  assert.strictEqual(descricaoCakto({ subtitle: 'Subtitulo curto' }).startsWith('Subtitulo curto '), true);
  assert.ok(descricaoCakto({}).length >= 110, 'e-book sem nenhum texto ainda gera descricao valida');
});

test('descricao no limite: 109 caracteres e completada, 110 fica como esta', () => {
  const c109 = 'a'.repeat(109), c110 = 'a'.repeat(110);
  assert.notStrictEqual(descricaoCakto({ description: c109 }), c109);
  assert.strictEqual(descricaoCakto({ description: c110 }), c110);
});

test('descricao longa e cortada em 500 sem partir caractere no meio', () => {
  const longa = 'á'.repeat(600);
  assert.strictEqual(descricaoCakto({ description: longa }).length, 500);
  // Emoji ocupa duas posicoes: cortar no meio deixa metade de um caractere.
  const comEmoji = 'x'.repeat(499) + '🚀' + 'y'.repeat(50);
  const r = descricaoCakto({ description: comEmoji });
  assert.strictEqual(r.length, 499, 'emoji inteiro nao cabe: fica de fora');
  assert.strictEqual(r, [...r].join(''), 'nenhum caractere partido ao meio');
  assert.ok(!/[\uD800-\uDBFF]$/.test(r), 'nao pode terminar em meio emoji');
});

// ── Link de pagamento e resposta da API ─────────────────────────────────────

test('codigo do checkout sai da URL; URL sem codigo devolve null', () => {
  assert.strictEqual(codigoDoPayUrl('https://pay.cakto.com.br/35vb4nn'), '35vb4nn');
  assert.strictEqual(codigoDoPayUrl('https://pay.cakto.com.br/abcde'), 'abcde');
  assert.strictEqual(codigoDoPayUrl('https://pay.cakto.com.br/abcd'), null, 'codigo de 4 nao e aceito');
  assert.strictEqual(codigoDoPayUrl('https://pay.cakto.com.br/35vb4nn?src=email'), null);
  for (const u of ['', null, undefined, 'https://app.cakto.com.br/dashboard']) assert.strictEqual(codigoDoPayUrl(u), null);
});

test('resposta da API: link de pagamento vence o identificador solto', () => {
  const r = lerRespostaCakto('{"checkout_url":"abcd1234","url":"https://pay.cakto.com.br/9xk2ppz"}');
  assert.deepStrictEqual([r.payUrl, r.id], ['https://pay.cakto.com.br/9xk2ppz', '9xk2ppz']);
});

test('resposta so com identificador devolve o campo; data ISO nao e identificador', () => {
  assert.strictEqual(lerRespostaCakto('{"shortcode":"35vb4nn"}').id, '35vb4nn');
  assert.strictEqual(lerRespostaCakto('{"uuid":"7f3e9a21-aa"}').id, '7f3e9a21-aa');
  assert.strictEqual(lerRespostaCakto('{"id":"2026-09-15T10:00"}'), null, 'data nao e id de produto');
  assert.strictEqual(lerRespostaCakto('{"id":"2026-09-15"}'), null);
});

test('resposta sem nada util devolve null', () => {
  for (const t of ['', null, undefined, '<html>erro</html>', '{"ok":true}', '{"id":"curto"}', '{"count":3}']) {
    assert.strictEqual(lerRespostaCakto(t), null, JSON.stringify(t));
  }
});
