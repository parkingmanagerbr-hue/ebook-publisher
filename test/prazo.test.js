'use strict';
/**
 * prazo: em 26/09/2026 um livro travado na tela de preco prendeu o lote por
 * DOZE HORAS (14:16 -> 02:20), com um unico livro publicado. O teste protege a
 * regra: tarefa que nao termina no prazo lanca, e a fila segue.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { comPrazo, prazoPorItem, PrazoEstourado } = require('../src/core/prazo');

/** Relogio falso: o teste nao espera de verdade. */
function relogio() {
  const pendentes = new Map();
  let id = 0;
  return {
    agendar: (fn, ms) => { pendentes.set(++id, { fn, ms }); return id; },
    cancelar: x => pendentes.delete(x),
    /** dispara o que estava agendado, como se o tempo tivesse passado */
    avancar: () => { for (const [k, v] of [...pendentes]) { pendentes.delete(k); v.fn(); } },
    quantos: () => pendentes.size,
  };
}

test('tarefa que termina no prazo devolve o resultado', async () => {
  const r = relogio();
  const saida = await comPrazo(() => Promise.resolve('publicado'), 60000, { agendar: r.agendar, cancelar: r.cancelar });
  assert.strictEqual(saida, 'publicado');
  assert.strictEqual(r.quantos(), 0, 'o relogio e desarmado no fim (senao o processo nao encerra)');
});

test('tarefa que NUNCA termina estoura o prazo em vez de prender a fila', async () => {
  const r = relogio();
  const presa = comPrazo(() => new Promise(() => {}), 720000, { oQue: 'livro "Casa Segura"', agendar: r.agendar, cancelar: r.cancelar });
  r.avancar();
  await assert.rejects(presa, e => {
    assert.ok(e instanceof PrazoEstourado);
    assert.strictEqual(e.prazo, true, 'quem chama precisa distinguir prazo de falha da loja');
    assert.match(e.message, /livro "Casa Segura" passou de 720s/);
    return true;
  });
});

test('erro da propria tarefa passa como esta (nao vira erro de prazo)', async () => {
  const r = relogio();
  await assert.rejects(
    comPrazo(() => Promise.reject(new Error('a loja recusou')), 60000, { agendar: r.agendar, cancelar: r.cancelar }),
    e => { assert.strictEqual(e.message, 'a loja recusou'); assert.ok(!e.prazo); return true; },
  );
  assert.strictEqual(r.quantos(), 0);
});

test('tarefa que lanca na hora (nem promessa devolve) tambem e capturada', async () => {
  const r = relogio();
  await assert.rejects(
    comPrazo(() => { throw new Error('quebrou antes de comecar'); }, 60000, { agendar: r.agendar, cancelar: r.cancelar }),
    /quebrou antes de comecar/,
  );
});

test('a limpeza roda ANTES de lancar (a aba travada precisa ser fechada)', async () => {
  const r = relogio();
  const ordem = [];
  const presa = comPrazo(() => new Promise(() => {}), 1000, {
    aoEstourar: () => ordem.push('limpou'), agendar: r.agendar, cancelar: r.cancelar,
  });
  r.avancar();
  await presa.catch(() => ordem.push('lancou'));
  assert.deepStrictEqual(ordem, ['limpou', 'lancou']);
});

test('limpeza que quebra nao troca o motivo do erro', async () => {
  const r = relogio();
  const presa = comPrazo(() => new Promise(() => {}), 1000, {
    aoEstourar: () => { throw new Error('a aba ja tinha morrido'); }, agendar: r.agendar, cancelar: r.cancelar,
  });
  r.avancar();
  await assert.rejects(presa, e => { assert.ok(e.prazo, 'o prazo continua sendo o motivo'); return true; });
});

test('prazo zero ou negativo desliga a trava (nao vira "estoura na hora")', async () => {
  assert.strictEqual(await comPrazo(() => 'ok', 0), 'ok');
  assert.strictEqual(await comPrazo(() => 'ok', -1), 'ok');
  assert.strictEqual(await comPrazo(() => 'ok'), 'ok');
});

test('prazo por item: folga para a loja lenta, sem chegar a horas', () => {
  assert.strictEqual(prazoPorItem(3), 9 * 60000, 'tres vezes o tempo tipico');
  assert.strictEqual(prazoPorItem(1), 6 * 60000, 'piso de 6 min: item rapido nao ganha prazo curto demais');
  assert.strictEqual(prazoPorItem(60), 25 * 60000, 'teto de 25 min: 12 h nunca mais');
  assert.strictEqual(prazoPorItem(0), 9 * 60000, 'sem medida, assume 3 min');
  assert.strictEqual(prazoPorItem(null), 9 * 60000);
  assert.strictEqual(prazoPorItem('4'), 12 * 60000, 'numero em texto tambem serve');
  assert.ok(prazoPorItem(3) < 30 * 60000, 'o prazo por item cabe dentro de um lote');
});
