'use strict';
/**
 * tentativas: um lote de 18 livros perdeu 5 por queda de ssh/scp ao buscar o
 * arquivo no servidor — nenhuma perda foi da loja (24/09/2026).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { comTentativas, valeTentarDeNovo, esperaDaTentativa } = require('../src/core/tentativas');

const semDormir = { esperar: async () => {} };

test('espera cresce a cada tentativa, com teto', () => {
  assert.strictEqual(esperaDaTentativa(1), 2000);
  assert.strictEqual(esperaDaTentativa(2), 6000);
  assert.strictEqual(esperaDaTentativa(3), 18000);
  assert.strictEqual(esperaDaTentativa(9), 60000, 'tem teto');
  assert.strictEqual(esperaDaTentativa(0), 2000);
  assert.strictEqual(esperaDaTentativa('x'), 2000);
  assert.strictEqual(esperaDaTentativa(2, 1000, 3000), 3000);
});

test('queda de rede merece nova tentativa; arquivo inexistente nao', () => {
  assert.strictEqual(valeTentarDeNovo(new Error('Command failed: ssh vps docker cp ...')), true);
  assert.strictEqual(valeTentarDeNovo(new Error('scp: Connection closed')), true);
  assert.strictEqual(valeTentarDeNovo(new Error('connect ETIMEDOUT')), true);
  assert.strictEqual(valeTentarDeNovo(new Error('ECONNRESET')), true);
  assert.strictEqual(valeTentarDeNovo(new Error('docker cp: No such file or directory')), false, 'arquivo que nao existe nao aparece por insistencia');
  assert.strictEqual(valeTentarDeNovo(new Error('PDF nao veio do VPS')), false);
  assert.strictEqual(valeTentarDeNovo(null), false);
});

test('REGRESSAO: soluco de rede no meio do lote nao perde mais o livro', async () => {
  let vez = 0;
  const esperas = [];
  const r = await comTentativas(async () => {
    vez++;
    if (vez < 3) throw new Error('Command failed: ssh vps docker cp /app/data/pdfs/x.pdf');
    return 'arquivo baixado';
  }, { vezes: 3, esperar: async ms => { esperas.push(ms); } });
  assert.strictEqual(r, 'arquivo baixado');
  assert.strictEqual(vez, 3);
  assert.deepStrictEqual(esperas, [2000, 6000]);
});

test('falha que nao e de rede desiste na primeira', async () => {
  let vez = 0;
  await assert.rejects(() => comTentativas(async () => { vez++; throw new Error('capa nao veio do VPS'); }, { vezes: 3, ...semDormir }));
  assert.strictEqual(vez, 1, 'nao insiste no que nao melhora');
});

test('esgotadas as tentativas, o erro original sobe', async () => {
  let vez = 0;
  await assert.rejects(
    () => comTentativas(async () => { vez++; throw new Error('scp: ETIMEDOUT'); }, { vezes: 3, ...semDormir }),
    /ETIMEDOUT/);
  assert.strictEqual(vez, 3);
});

test('acerto de primeira nao espera nem repete', async () => {
  let vez = 0;
  const r = await comTentativas(async n => { vez = n; return 'ok'; }, semDormir);
  assert.deepStrictEqual([r, vez], ['ok', 1]);
});

test('quem chama pode registrar cada nova tentativa no log', async () => {
  const avisos = [];
  await comTentativas(async n => { if (n < 2) throw new Error('ssh: broken pipe'); return 'ok'; },
    { vezes: 2, esperar: async () => {}, aoFalhar: (e, n) => avisos.push(n + ':' + e.message.slice(0, 12)) });
  assert.deepStrictEqual(avisos, ['1:ssh: broken ']);
});

test('vezes invalido ainda executa uma vez', async () => {
  let vez = 0;
  await assert.rejects(() => comTentativas(async () => { vez++; throw new Error('ssh caiu'); }, { vezes: 0, ...semDormir }));
  assert.strictEqual(vez, 1);
});

test('sem relogio injetado, a espera real acontece (2s na primeira)', async () => {
  const t0 = Date.now();
  let vez = 0;
  const r = await comTentativas(async n => { vez = n; if (n < 2) throw new Error('ssh: ECONNRESET'); return 'ok'; }, { vezes: 2 });
  const gasto = Date.now() - t0;
  assert.strictEqual(r, 'ok');
  assert.strictEqual(vez, 2);
  assert.ok(gasto >= 1900, 'esperou de verdade: ' + gasto + 'ms');
});
