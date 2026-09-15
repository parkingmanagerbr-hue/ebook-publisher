'use strict';
/**
 * Pecas pequenas do nucleo: formato do log, caminho da sessao das lojas e o
 * nome do arquivo entregue ao comprador.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createLogger } = require('../src/core/logger');
const { resolveSessionFile } = require('../src/core/sessionPath');
const { nomeArquivo } = require('../src/core/entrega');

const MENSAGEM = Symbol.for('message');

// ── logger ──────────────────────────────────────────────────────────────────

test('log do arquivo: [data] [NIVEL] [modulo] mensagem, com meta em JSON so quando existe', t => {
  const log = createLogger('publicador');
  t.after(() => log.close());
  const semMeta = log.format.transform({ level: 'info', message: 'lote iniciado', module: 'publicador' });
  assert.match(semMeta[MENSAGEM], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO\] \[publicador\] lote iniciado$/);

  const comMeta = log.format.transform({ level: 'error', message: 'falhou', module: 'publicador', ebookId: 'abc', tentativa: 2 });
  assert.ok(comMeta[MENSAGEM].endsWith('[ERROR] [publicador] falhou {"ebookId":"abc","tentativa":2}'));
});

test('log do console usa o nivel colorido e o mesmo tratamento de meta', t => {
  const log = createLogger('mod');
  t.after(() => log.close());
  const console_ = log.transports.find(tr => tr.name === 'console');
  const f = info => console_.format.transform({ timestamp: '2026-09-15 10:00:00', module: 'mod', [Symbol.for('level')]: info.level, ...info })[MENSAGEM];
  assert.match(f({ level: 'warn', message: 'x' }), /^\[2026-09-15 10:00:00\] .*warn.* \[mod\] x$/);
  assert.match(f({ level: 'info', message: 'y', id: 7 }), / \[mod\] y \{"id":7\}$/);
  assert.strictEqual(log.transports.filter(tr => tr.name === 'dailyRotateFile').length, 2, 'combinado + so erros');
});

// ── sessionPath ─────────────────────────────────────────────────────────────

function comAmbiente(t, vars) {
  const antes = {};
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('sessao: variavel especifica da loja vence tudo', t => {
  comAmbiente(t, { HOTMART_SESSION_FILE: '/segredos/hm.json', DATA_DIR: '/dados' });
  assert.strictEqual(resolveSessionFile('hotmart', 'HOTMART_SESSION_FILE'), '/segredos/hm.json');
});

test('sessao: variavel especifica vazia ou nao informada cai para DATA_DIR', t => {
  comAmbiente(t, { HOTMART_SESSION_FILE: '', DATA_DIR: '/dados' });
  assert.strictEqual(resolveSessionFile('hotmart', 'HOTMART_SESSION_FILE'), path.join('/dados', 'sessions', 'hotmart.json'));
  assert.strictEqual(resolveSessionFile('cakto'), path.join('/dados', 'sessions', 'cakto.json'));
});

test('sessao: sem variaveis, dentro do Docker usa /app/data', t => {
  comAmbiente(t, { DATA_DIR: undefined });
  t.mock.method(fs, 'existsSync', p => p === '/app/data');
  assert.strictEqual(resolveSessionFile('amazon', 'AMAZON_SESSION_FILE_INEXISTENTE'), '/app/data/sessions/amazon.json');
});

test('sessao: fora do Docker usa data/sessions na raiz do projeto', t => {
  comAmbiente(t, { DATA_DIR: undefined });
  t.mock.method(fs, 'existsSync', () => false);
  assert.strictEqual(resolveSessionFile('cakto'), path.join(__dirname, '..', 'data', 'sessions', 'cakto.json'));
});

// ── entrega: nome do arquivo ────────────────────────────────────────────────

test('titulo feito so de caracteres proibidos vira ebook.pdf, nunca ".pdf"', () => {
  assert.strictEqual(nomeArquivo('???'), 'ebook.pdf');
  assert.strictEqual(nomeArquivo('<>:|*'), 'ebook.pdf');
  assert.strictEqual(nomeArquivo('   '), 'ebook.pdf');
  assert.strictEqual(nomeArquivo('Finanças: guia'), 'Finanças guia.pdf', 'acento fica, dois-pontos sai');
  assert.strictEqual(nomeArquivo('a'.repeat(200)).length, 94, '90 caracteres + .pdf');
});
