'use strict';
/**
 * painel-lojas: o bloco "Livros por loja" do painel. O que importa provar:
 * loja ativa aparece até zerada (0 é sinal), loja pausada só com livro e com
 * tarja, coluna ausente NÃO vira 0 (não medi ≠ tem zero), e a ordem põe o que
 * deveria vender no topo. O % é sobre o total de livros.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { resumoLojas, LOJAS } = require('../src/painel-lojas.logic');

const por = (linhas, loja) => linhas.find(l => l.loja === loja);

test('conta as TRÊS ativas, inclusive kiwify e a zerada (0 é sinal)', () => {
  const r = resumoLojas({ hotmart: 10, cakto: 2000, kiwify: 0 }, 5000);
  assert.deepStrictEqual(r.map(l => l.loja), ['cakto', 'hotmart', 'kiwify']);
  assert.strictEqual(por(r, 'kiwify').n, 0);
  assert.strictEqual(por(r, 'kiwify').estado, 'ativa');
});

test('pausada com livro aparece com a tarja do motivo; zerada não aparece', () => {
  const r = resumoLojas({ cakto: 100, amazon: 7, gplay: 0 }, 100);
  assert.ok(por(r, 'amazon'), 'amazon com 7 deve aparecer');
  assert.strictEqual(por(r, 'amazon').estado, 'pausada');
  assert.strictEqual(por(r, 'amazon').motivo, 'conta/banco');
  assert.strictEqual(por(r, 'gplay'), undefined, 'gplay zerada não entra');
});

test('coluna AUSENTE (undefined) é omitida — não vira 0', () => {
  const r = resumoLojas({ hotmart: 5, cakto: 5 }, 10); // kiwify/amazon/gplay ausentes
  assert.strictEqual(por(r, 'kiwify'), undefined);
  assert.strictEqual(por(r, 'amazon'), undefined);
  assert.strictEqual(r.length, 2);
});

test('ativas vêm antes das pausadas, independente da contagem', () => {
  const r = resumoLojas({ hotmart: 1, amazon: 9999 }, 10000);
  assert.deepStrictEqual(r.map(l => l.loja), ['hotmart', 'amazon']);
});

test('dentro do mesmo estado, maior contagem primeiro', () => {
  const r = resumoLojas({ hotmart: 3, cakto: 300, kiwify: 30 }, 1000);
  assert.deepStrictEqual(r.map(l => l.loja), ['cakto', 'kiwify', 'hotmart']);
});

test('% é sobre o total e arredonda a 1 casa; sem total é null', () => {
  const r = resumoLojas({ cakto: 1 }, 3);
  assert.strictEqual(por(r, 'cakto').pct, 33.3);
  const semTotal = resumoLojas({ cakto: 5 });
  assert.strictEqual(por(semTotal, 'cakto').pct, null);
  const totalZero = resumoLojas({ cakto: 5 }, 0);
  assert.strictEqual(por(totalZero, 'cakto').pct, null);
});

test('sem contagem nenhuma devolve lista vazia, sem quebrar', () => {
  assert.deepStrictEqual(resumoLojas(), []);
  assert.deepStrictEqual(resumoLojas({}), []);
  assert.deepStrictEqual(resumoLojas(null, 10), []);
});

test('toda loja ativa de LOJAS tem rótulo; pausada tem motivo', () => {
  for (const [loja, meta] of Object.entries(LOJAS)) {
    assert.ok(meta.rotulo, loja + ' precisa de rótulo');
    if (meta.estado === 'pausada') assert.ok(meta.motivo, loja + ' pausada precisa de motivo');
  }
});
