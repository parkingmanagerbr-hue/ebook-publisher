'use strict';
/**
 * As copias de capa que o Chrome da VPS le sao apagadas depois do bloco.
 * 11/10/2026: nunca eram, e somavam 2,3 GB com o disco a 91%.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('apaga cada copia do mapa; copia ja ausente nao derruba; o original fica', () => {
  const { apagarCopias } = require('../scripts/capas_kiwify');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copias-'));
  const original = path.join(dir, 'original.jpg');
  const copia = path.join(dir, 'p1.jpg');
  fs.writeFileSync(original, 'x'); fs.writeFileSync(copia, 'x');
  const mapa = new Map([['p1', copia], ['p2', path.join(dir, 'sumiu.jpg')]]);
  assert.strictEqual(apagarCopias(mapa), 1);
  assert.ok(!fs.existsSync(copia));
  assert.ok(fs.existsSync(original));
  assert.strictEqual(apagarCopias(undefined), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('produto com 3 erros SEGUIDOS sai da fila; ok no meio zera; sem-capa nao conta como erro', () => {
  const { desistidos } = require('../scripts/capas_kiwify');
  const L = (id, resultado) => JSON.stringify({ id, resultado });
  const linhas = [
    L('a', 'erro'), L('a', 'erro'), L('a', 'erro'),
    L('b', 'erro'), L('b', 'erro'), L('b', 'ok'), L('b', 'erro'),
    L('c', 'erro'), L('c', 'erro'),
    L('d', 'erro'), L('d', 'sem-capa'), L('d', 'erro'), L('d', 'erro'),
    '', '{cortada', JSON.stringify({ resultado: 'erro' }),
  ];
  assert.deepStrictEqual([...desistidos(linhas)], ['a']);
  assert.deepStrictEqual([...desistidos(linhas, 2)].sort(), ['a', 'c', 'd']);
  assert.deepStrictEqual([...desistidos(undefined)], []);
});
