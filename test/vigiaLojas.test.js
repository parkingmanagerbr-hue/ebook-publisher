'use strict';
/**
 * vigiaLojas: a regra que decide o que vira alerta das lojas. O caso que mais
 * importa é o SILÊNCIO — tudo saudável NÃO pode gerar linha (aviso que aparece
 * sempre ensina a não ler aviso) — e loja pausada de propósito (amazon/gplay)
 * nunca alarma. Os limiares e o estado real medido em 15/10/2026 estão cobertos.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { detectarProblemas, LOJAS_ATIVAS } = require('../src/vigia-lojas.logic');

// fatos de uma operação SAUDÁVEL (tudo abaixo do limiar).
const saudavel = () => ({
  ready: { total: 10, diasMaisAntigo: 1 },
  token: { hotmartExpiraMin: 120, hotmartTemHmSsoExp: true },
  lojas: { hotmart: { horasSemPublicar: 1 }, cakto: { horasSemPublicar: 0 }, kiwify: { horasSemPublicar: 2 } },
  falhas24h: { kiwifySemEntrega: 0, caktoWizard: 0 },
});
const itens = probs => probs.map(p => p.item).sort();

test('saudável não gera NENHUM alerta (silêncio é o certo)', () => {
  assert.deepStrictEqual(detectarProblemas(saudavel()), []);
});

test('loja ativa com horasSemPublicar=null não alarma (nunca publicou medição)', () => {
  const f = saudavel(); f.lojas.hotmart.horasSemPublicar = null;
  assert.deepStrictEqual(detectarProblemas(f), []);
});

test('sem fatos nenhum: token ausente é o problema, sem quebrar', () => {
  assert.deepStrictEqual(itens(detectarProblemas()), ['hotmart-token']);
  assert.deepStrictEqual(itens(detectarProblemas({})), ['hotmart-token']);
  assert.match(detectarProblemas({})[0].texto, /ausente/);
});

test('token EXPIRADO sem hmSsoExp diz que não dá para auto-renovar', () => {
  const f = saudavel(); f.token = { hotmartExpiraMin: -30, hotmartTemHmSsoExp: false };
  const p = detectarProblemas(f).find(x => x.item === 'hotmart-token');
  assert.match(p.texto, /EXPIRADO há 30 min/);
  assert.match(p.texto, /sem hmSsoExp/);
  assert.match(p.acao, /renovar/);
});

test('token EXPIRADO com hmSsoExp NÃO cita o hmSsoExp', () => {
  const f = saudavel(); f.token = { hotmartExpiraMin: -5, hotmartTemHmSsoExp: true };
  const p = detectarProblemas(f).find(x => x.item === 'hotmart-token');
  assert.match(p.texto, /EXPIRADO/);
  assert.doesNotMatch(p.texto, /sem hmSsoExp/);
});

test('token com minutos de sobra não vira problema', () => {
  const f = saudavel(); f.token = { hotmartExpiraMin: 1, hotmartTemHmSsoExp: true };
  assert.strictEqual(detectarProblemas(f).some(x => x.item === 'hotmart-token'), false);
});

test('backlog por VOLUME e por IDADE são dois problemas distintos', () => {
  const f = saudavel(); f.ready = { total: 885, diasMaisAntigo: 18 };
  const i = itens(detectarProblemas(f));
  assert.ok(i.includes('ready-volume'));
  assert.ok(i.includes('ready-idade'));
});

test('backlog no limite exato NÃO alarma (> e não >=)', () => {
  const f = saudavel(); f.ready = { total: 500, diasMaisAntigo: 7 };
  assert.deepStrictEqual(detectarProblemas(f), []);
});

test('loja ATIVA parada além do limite alarma, com nome capitalizado', () => {
  const f = saudavel(); f.lojas.cakto.horasSemPublicar = 20;
  const p = detectarProblemas(f).find(x => x.item === 'loja-parada-cakto');
  assert.ok(p, 'devia flagar cakto parada');
  assert.match(p.texto, /^Cakto:/);
});

test('loja PAUSADA de propósito (amazon/gplay) nunca alarma, mesmo parada há muito', () => {
  const f = saudavel();
  f.lojas.amazon = { horasSemPublicar: 99999 };
  f.lojas.gplay = { horasSemPublicar: 99999 };
  const i = itens(detectarProblemas(f));
  assert.ok(!i.some(x => x.includes('amazon') || x.includes('gplay')));
  // e só as ativas podem aparecer como loja-parada
  for (const x of i) if (x.startsWith('loja-parada-')) assert.ok(LOJAS_ATIVAS.includes(x.replace('loja-parada-', '')));
});

test('Kiwify sem-entrega: alarma no limiar (>=3), não abaixo', () => {
  const f3 = saudavel(); f3.falhas24h.kiwifySemEntrega = 3;
  assert.ok(detectarProblemas(f3).some(x => x.item === 'kiwify-entrega'));
  const f2 = saudavel(); f2.falhas24h.kiwifySemEntrega = 2;
  assert.ok(!detectarProblemas(f2).some(x => x.item === 'kiwify-entrega'));
});

test('Cakto wizard: alarma quando o form mudou (falhas repetidas)', () => {
  const f = saudavel(); f.falhas24h.caktoWizard = 4;
  const p = detectarProblemas(f).find(x => x.item === 'cakto-wizard');
  assert.match(p.texto, /form da Cakto mudou/);
});

test('Hotmart DESLIGADA (conta encerrada) não alarma token nem loja-parada', () => {
  const f = {
    ready: { total: 10, diasMaisAntigo: 1 },
    token: { hotmartExpiraMin: null, hotmartTemHmSsoExp: false }, // morto, mas off
    lojas: { hotmart: { horasSemPublicar: 999 }, cakto: { horasSemPublicar: 0 }, kiwify: { horasSemPublicar: 1 } },
    falhas24h: { kiwifySemEntrega: 0, caktoWizard: 0 },
  };
  const i = itens(detectarProblemas(f, { lojasAtivas: ['cakto', 'kiwify'] }));
  assert.ok(!i.includes('hotmart-token'), 'Hotmart off não checa token');
  assert.ok(!i.includes('loja-parada-hotmart'), 'Hotmart off não alarma parada');
  assert.deepStrictEqual(i, []);
});

test('loja desligada não alarma as PRÓPRIAS falhas (kiwify/cakto off)', () => {
  const f = saudavel();
  f.falhas24h = { kiwifySemEntrega: 50, caktoWizard: 5000 };
  // só hotmart ativa (hipótese): nem kiwify-entrega nem cakto-wizard saem
  const i = itens(detectarProblemas(f, { lojasAtivas: ['hotmart'] }));
  assert.ok(!i.includes('kiwify-entrega'));
  assert.ok(!i.includes('cakto-wizard'));
});

test('ESTADO REAL 15/10: flaga token, backlog(volume+idade) e kiwify — e cada um traz AÇÃO', () => {
  const real = {
    ready: { total: 885, diasMaisAntigo: 18 },
    token: { hotmartExpiraMin: null, hotmartTemHmSsoExp: false },
    lojas: { hotmart: { horasSemPublicar: 2 }, cakto: { horasSemPublicar: 0 }, kiwify: { horasSemPublicar: 20 } },
    falhas24h: { kiwifySemEntrega: 5, caktoWizard: 0 },
  };
  const probs = detectarProblemas(real);
  const i = itens(probs);
  assert.ok(i.includes('hotmart-token'));
  assert.ok(i.includes('ready-volume'));
  assert.ok(i.includes('ready-idade'));
  assert.ok(i.includes('kiwify-entrega'));
  assert.ok(i.includes('loja-parada-kiwify'));
  for (const p of probs) assert.ok(p.acao && p.acao.length > 5, 'todo problema traz ação: ' + p.item);
});
