'use strict';
/**
 * logger: o log de acesso HTTP nao pode virar vazamento nem ser forjado.
 * Regra do playbook: valor que vem do usuario e sanitizado; nada de token,
 * e-mail ou IP inteiro no log.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createLogger, httpLoggerMiddleware, linhaDeAcesso, caminhoSeguro, ipMascarado } = require('../src/core/logger');

test('query string fica de fora (carrega token de download e e-mail)', () => {
  assert.strictEqual(caminhoSeguro('/download?token=abc123&email=joao@x.com'), '/download?…');
  assert.strictEqual(caminhoSeguro('/livros/fundo-de-emergencia/'), '/livros/fundo-de-emergencia/');
  assert.strictEqual(caminhoSeguro(''), '/');
  assert.strictEqual(caminhoSeguro(null), '/');
  assert.strictEqual(caminhoSeguro('/a'.repeat(300)).length, 200);
});

test('quebra de linha na URL nao forja outra linha de log', () => {
  const linha = linhaDeAcesso({ method: 'GET', url: '/x\n[2026-09-22] info: pagamento aprovado', status: 200, ms: 3 });
  assert.ok(!/[\r\n]/.test(linha), linha);
  assert.ok(linha.startsWith('GET /x [2026-09-22]'));
});

test('IP perde o ultimo octeto (LGPD) e aceita lista do proxy', () => {
  assert.strictEqual(ipMascarado('189.45.12.200'), '189.45.12.0');
  assert.strictEqual(ipMascarado('189.45.12.200, 10.0.0.1'), '189.45.12.0');
  assert.strictEqual(ipMascarado('2804:14d:baa::9f'), '2804:14d:baa::');
  assert.strictEqual(ipMascarado(''), '-');
  assert.strictEqual(ipMascarado(null), '-');
  assert.strictEqual(ipMascarado('nao-e-ip'), '-', 'letra fora de hexadecimal sai');
});

test('metodo vem do usuario: so letras, em caixa alta', () => {
  assert.ok(linhaDeAcesso({ method: 'get', url: '/', status: 200, ms: 1 }).startsWith('GET /'));
  assert.ok(linhaDeAcesso({ method: 'GET /admin HTTP/1.1\nPOST', url: '/', status: 200, ms: 1 }).startsWith('GETADMINHT '));
  assert.strictEqual(linhaDeAcesso({ url: '/', status: 'x', ms: null }), '- / 0 0ms ip=-');
});

test('middleware so loga quando a resposta termina, e avisa nos erros', t => {
  const escritas = [];
  const escrever = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (m, ...r) => { escritas.push(String(m)); return escrever(m, ...r); });

  const ouvintes = [];
  const res = { statusCode: 200, on: (ev, fn) => ouvintes.push([ev, fn]) };
  let seguiu = false;
  httpLoggerMiddleware({ method: 'GET', originalUrl: '/livros/?q=1', ip: '189.45.12.200', headers: {} }, res, () => { seguiu = true; });
  assert.strictEqual(seguiu, true, 'a requisicao segue o fluxo');
  assert.deepStrictEqual(ouvintes.map(o => o[0]), ['finish']);
  ouvintes[0][1]();

  const res2 = { statusCode: 500, on: (ev, fn) => ouvintes.push([ev, fn]) };
  httpLoggerMiddleware({ method: 'POST', originalUrl: '/api/x', headers: { 'x-forwarded-for': '10.1.2.3' } }, res2, () => {});
  ouvintes[1][1]();
  const aviso = escritas.find(l => l.includes('/api/x'));
  assert.ok(aviso, 'erro 5xx tambem vai para o log principal');
  assert.ok(aviso.includes('ip=10.1.2.0'), aviso);
});

test('createLogger devolve logger com nivel do ambiente', () => {
  const l = createLogger('teste');
  assert.strictEqual(typeof l.info, 'function');
  assert.strictEqual(l.level, process.env.LOG_LEVEL || 'info');
});

test('disco sem permissao para criar logs/ nao derruba o processo', t => {
  const { interceptar, recarregar } = require('./apoio');
  const fsReal = require('fs');
  interceptar(t, {
    fs: { ...fsReal, mkdirSync: () => { throw new Error('EACCES: logs/ somente leitura'); } },
  });
  const mod = recarregar('src/core/logger.js');
  assert.strictEqual(typeof mod.createLogger('x').info, 'function');
  t.after(() => recarregar('src/core/logger.js'));
});
