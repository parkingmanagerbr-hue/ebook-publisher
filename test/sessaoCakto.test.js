'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ehSemSessao, cookiesDaCakto, renovarDoChrome } = require('../src/core/sessaoCakto');

const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sessao-cakto-'));
const ck = (domain, name, value = 'v') => ({ domain, name, value, path: '/' });

test('401 e sessao recusada; 403, 429 e 502 nao', () => {
  assert.strictEqual(ehSemSessao('POST products/: HTTP 401 {"detail":"..."}'), true);
  assert.strictEqual(ehSemSessao('POST products/: HTTP 403 {}'), false);
  assert.strictEqual(ehSemSessao('Cakto devolveu HTML (HTTP 429)'), false);
  assert.strictEqual(ehSemSessao('HTTP 4010'), false);
  assert.strictEqual(ehSemSessao(undefined), false);
});

test('so cookies do dominio da Cakto entram', () => {
  const nomes = cookiesDaCakto([
    ck('.cakto.com.br', 'sessionid'), ck('app.cakto.com.br', '__cf_bm'), ck('cakto.com.br', 'a'),
    ck('.google.com', 'SID'), ck('naocakto.com.br', 'x'), ck('cakto.com.br.evil.com', 'y'),
  ]).map(c => c.name);
  assert.deepStrictEqual(nomes, ['sessionid', '__cf_bm', 'a']);
});

test('com sessionid no Chrome: grava os cookies, guarda backup e preserva o resto do arquivo', async () => {
  const dir = pasta();
  const arq = path.join(dir, 'cakto.json');
  fs.writeFileSync(arq, JSON.stringify({ platform: 'cakto', localStorage: { k: 1 }, cookies: [ck('.cakto.com.br', 'sessionid', 'velho')] }));
  const r = await renovarDoChrome({
    arquivo: arq,
    lerCookies: async () => [ck('.cakto.com.br', 'sessionid', 'novo'), ck('.google.com', 'SID')],
    agora: () => new Date('2026-11-25T20:00:00Z'),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.n, 1);
  const gravado = JSON.parse(fs.readFileSync(arq, 'utf8'));
  assert.strictEqual(gravado.cookies[0].value, 'novo');
  assert.strictEqual(gravado.cookies.length, 1);
  assert.strictEqual(gravado.localStorage.k, 1);
  assert.strictEqual(gravado.lastRenewed, '2026-11-25T20:00:00.000Z');
  assert.strictEqual(JSON.parse(fs.readFileSync(arq + '.bak', 'utf8')).cookies[0].value, 'velho');
});

test('sem sessionid no Chrome (ninguem logou): o arquivo NAO e tocado', async () => {
  const dir = pasta();
  const arq = path.join(dir, 'cakto.json');
  const original = JSON.stringify({ cookies: [ck('.cakto.com.br', 'sessionid', 'velho')] });
  fs.writeFileSync(arq, original);
  const r = await renovarDoChrome({ arquivo: arq, lerCookies: async () => [ck('.cakto.com.br', '__cf_bm')] });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /sessionid/);
  assert.strictEqual(fs.readFileSync(arq, 'utf8'), original);
  assert.strictEqual(fs.existsSync(arq + '.bak'), false);
});

test('Chrome fora do ar: devolve o motivo sem lancar e sem tocar o arquivo', async () => {
  const dir = pasta();
  const arq = path.join(dir, 'cakto.json');
  fs.writeFileSync(arq, '{"cookies":[]}');
  const r = await renovarDoChrome({ arquivo: arq, lerCookies: async () => { throw new Error('ECONNREFUSED'); } });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /Chrome nao respondeu/);
  assert.strictEqual(fs.readFileSync(arq, 'utf8'), '{"cookies":[]}');
});
