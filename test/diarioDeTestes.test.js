'use strict';
/**
 * diarioDeTestes: em 27/09/2026 a suite morreu por DISCO CHEIO e o portao so
 * disse "test failed". A regra que importa aqui: suite que nao termina NUNCA
 * pode ser lida como "0 falhas".
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { lerPlacar, testesQueFalharam, lerCobertura, linhaDoDiario, resumoDoDiario } = require('../src/core/diarioDeTestes');

const TAP_VERDE = [
  'TAP version 13',
  'ok 1 - regra que funciona',
  '1..1',
  '# tests 1',
  '# pass 12',
  '# fail 0',
  '# skipped 0',
  '# todo 0',
].join('\n');

const TAP_VERMELHO = [
  'not ok 3 - produto sem entrega nao fica ativo',
  'not ok 7 - o link do checkout leva o id',
  '# pass 10',
  '# fail 2',
].join('\n');

test('placar verde e lido do rodape', () => {
  const p = lerPlacar(TAP_VERDE);
  assert.strictEqual(p.completou, true);
  assert.strictEqual(p.passou, 12);
  assert.strictEqual(p.falhou, 0);
  assert.strictEqual(p.total, 12);
});

test('SUITE QUE MORREU NO MEIO nao pode virar "0 falhas"', () => {
  // Foi o caso do disco cheio: saida truncada, sem rodape.
  const p = lerPlacar('TAP version 13\nok 1 - comecou\n');
  assert.strictEqual(p.completou, false, 'sem rodape, a suite nao terminou');
  const linha = linhaDoDiario({ saida: 'TAP version 13\nok 1 - comecou\n', coberturaOk: true });
  assert.strictEqual(linha.ok, false, 'rodada incompleta NUNCA e verde');
  assert.match(resumoDoDiario([linha]), /NAO TERMINOU/);
});

test('entrada vazia ou nula nao vira rodada verde', () => {
  assert.strictEqual(lerPlacar('').completou, false);
  assert.strictEqual(lerPlacar(null).completou, false);
  assert.strictEqual(linhaDoDiario({ saida: null }).ok, false);
  assert.strictEqual(linhaDoDiario().ok, false);
});

test('os nomes dos testes vermelhos entram no diario', () => {
  const nomes = testesQueFalharam(TAP_VERMELHO);
  assert.deepStrictEqual(nomes, ['produto sem entrega nao fica ativo', 'o link do checkout leva o id']);
  assert.deepStrictEqual(testesQueFalharam(TAP_VERDE), []);
  assert.deepStrictEqual(testesQueFalharam(null), []);
  const linha = linhaDoDiario({ saida: TAP_VERMELHO, coberturaOk: true });
  assert.strictEqual(linha.ok, false);
  assert.strictEqual(linha.falhou, 2);
  assert.strictEqual(linha.falharam.length, 2);
});

test('cobertura reprovada derruba a rodada mesmo com todos os testes passando', () => {
  const linha = linhaDoDiario({ saida: TAP_VERDE, coberturaOk: false });
  assert.strictEqual(linha.ok, false, 'portao de cobertura tambem conta');
  assert.strictEqual(linha.falhou, 0);
  assert.strictEqual(linhaDoDiario({ saida: TAP_VERDE, coberturaOk: true }).ok, true);
});

test('a cobertura global e lida da tabela', () => {
  assert.strictEqual(lerCobertura('all files    |  82.27 |  98.85 |'), 82.27);
  assert.strictEqual(lerCobertura('ℹ all files                        |  100.00 |'), 100);
  assert.strictEqual(lerCobertura('sem tabela'), null);
  assert.strictEqual(lerCobertura(null), null);
  assert.strictEqual(linhaDoDiario({ saida: TAP_VERDE }).cobertura, null);
});

test('a linha do diario tem data, e uma so linha por rodada', () => {
  const linha = linhaDoDiario({ saida: TAP_VERDE, coberturaOk: true, segundos: 91.6, agora: Date.UTC(2026, 8, 27, 12, 0, 0) });
  assert.strictEqual(linha.quando, '2026-09-27T12:00:00.000Z');
  assert.strictEqual(linha.segundos, 92, 'arredonda');
  assert.strictEqual(linha.rotulo, 'suite');
  assert.ok(!JSON.stringify(linha).includes('\n'), 'cabe em uma linha de JSON Lines');
});

test('rotulo com quebra de linha nao forja uma linha do diario', () => {
  const linha = linhaDoDiario({ saida: TAP_VERDE, rotulo: 'noturno\n{"ok":true}' });
  assert.ok(!/[\r\n]/.test(linha.rotulo));
});

test('o resumo diz ha quantas rodadas esta vermelho', () => {
  const vermelha = linhaDoDiario({ saida: TAP_VERMELHO, coberturaOk: true });
  const verde = linhaDoDiario({ saida: TAP_VERDE, coberturaOk: true });
  assert.match(resumoDoDiario([vermelha, vermelha, vermelha, verde]), /vermelho ha 3 rodadas/);
  assert.match(resumoDoDiario([verde, vermelha]), /VERDE/);
  assert.match(resumoDoDiario([vermelha]), /falhando: produto sem entrega/);
  assert.match(resumoDoDiario([]), /diario vazio/);
  assert.match(resumoDoDiario(null), /diario vazio/);
  assert.match(resumoDoDiario([vermelha, vermelha]), /vermelho ha 2 rodadas/, 'tudo vermelho conta todas');
});

test('segundos ausentes ou absurdos nao inventam numero', () => {
  assert.strictEqual(linhaDoDiario({ saida: TAP_VERDE }).segundos, null);
  assert.strictEqual(linhaDoDiario({ saida: TAP_VERDE, segundos: -5 }).segundos, null);
  assert.strictEqual(linhaDoDiario({ saida: TAP_VERDE, segundos: 'abc' }).segundos, null);
});

test('o resumo mostra a cobertura e o tempo quando existem', () => {
  const comTudo = linhaDoDiario({
    saida: TAP_VERDE + '\nall files    |  100.00 |  100.00 |',
    coberturaOk: true, segundos: 120,
  });
  const linha = resumoDoDiario([comTudo]);
  assert.match(linha, /cobertura 100%/);
  assert.match(linha, /em 120s/);
  const semTempo = resumoDoDiario([linhaDoDiario({ saida: TAP_VERDE, coberturaOk: true })]);
  assert.match(semTempo, /sem medida de cobertura/);
  assert.match(semTempo, /em \?s/);
});

test('le tambem o formato do relatorio padrao do node --test (nao so TAP)', () => {
  // A suite VERDE de 776 testes era registrada como "nao terminou" porque o
  // leitor so conhecia "# pass". O relatorio padrao usa "ℹ pass" (27/09/2026).
  const I = String.fromCharCode(8505);
  const relatorio = [
    I + ' tests 776',
    I + ' suites 0',
    I + ' pass 776',
    I + ' fail 0',
    I + ' cancelled 0',
    I + ' skipped 0',
    I + ' todo 0',
  ].join('\n');
  const p = lerPlacar(relatorio);
  assert.strictEqual(p.completou, true);
  assert.strictEqual(p.passou, 776);
  assert.strictEqual(p.falhou, 0);
  assert.strictEqual(linhaDoDiario({ saida: relatorio, coberturaOk: true }).ok, true);
  // com recuo, que e como o gate imprime
  assert.strictEqual(lerPlacar('   ' + I + ' pass 5\n   ' + I + ' fail 1').passou, 5);
});
