'use strict';
/**
 * cdpLocal: achar o Chrome de automacao de verdade (com servidor HTTP real),
 * porque foi exatamente isso que quebrou publicacao, capas e token em 22/09/2026.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { responde, urlCdpAuto, urlCdpObrigatoria } = require('../src/core/cdpLocal');

/** Sobe um servidor que finge ser o Chrome; devolve a porta e como desligar. */
function servidorFalso(t, { status = 200, demorar = 0 } = {}) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const responder = () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"Browser":"Chrome/153"}'); };
      if (demorar) setTimeout(responder, demorar); else responder();
    });
    s.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(r => s.close(r)));
      resolve(s.address().port);
    });
  });
}

test('porta com Chrome responde; porta vazia nao', async t => {
  const porta = await servidorFalso(t);
  assert.strictEqual(await responde(porta), true);
  assert.strictEqual(await responde(1), false, 'porta reservada, ninguem escuta');
});

test('servidor que responde errado nao passa por Chrome', async t => {
  const porta = await servidorFalso(t, { status: 404 });
  assert.strictEqual(await responde(porta), false);
});

test('servidor lento estoura o tempo e nao trava o robo', async t => {
  const porta = await servidorFalso(t, { demorar: 300 });
  assert.strictEqual(await responde(porta, { timeout: 30 }), false);
});

test('pedido que explode na hora vira "nao responde"', async () => {
  const quebrado = () => { throw new Error('socket hang up'); };
  assert.strictEqual(await responde(9222, { pedir: quebrado }), false);
});

test('a URL sai com a porta que realmente atende', async () => {
  const url = await urlCdpAuto({ CHROME_CDP_PORT: '9333' }, async p => p === 9222);
  assert.strictEqual(url, 'http://127.0.0.1:9222', 'a do ambiente nao atendeu, caiu na conhecida');
  assert.strictEqual(await urlCdpAuto({}, async () => false), null);
});

test('quando nao ha navegador, a mensagem diz o que fazer', async () => {
  await assert.rejects(() => urlCdpObrigatoria({}, async () => false), e => {
    assert.match(e.message, /CHROME_FORA_DO_AR/);
    assert.match(e.message, /vigia_navegador/);
    return true;
  });
  assert.strictEqual(await urlCdpObrigatoria({}, async p => p === 9223), 'http://127.0.0.1:9223');
});
