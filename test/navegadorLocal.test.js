'use strict';
/**
 * navegadorLocal: sem achar o Chrome certo, nenhuma loja publica. O defeito de
 * 22/09/2026 (porta 9223 fixa, Chrome reaberto na 9222) tem teste aqui.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { LOJAS, portasCandidatas, escolherPorta, estaDeslogado, pendenciasDeLogin, argumentosDoChrome } = require('../src/core/navegadorLocal');

test('procura primeiro a porta do ambiente, depois as conhecidas', () => {
  assert.deepStrictEqual(portasCandidatas({}), [9222, 9223]);
  assert.deepStrictEqual(portasCandidatas({ CHROME_CDP_PORT: '9333' }), [9333, 9222, 9223]);
  assert.deepStrictEqual(portasCandidatas({ HOTMART_CDP_PORT: 'http://127.0.0.1:9224' }), [9224, 9222, 9223]);
  assert.deepStrictEqual(portasCandidatas({ CHROME_CDP_PORT: '9223' }), [9223, 9222], 'sem repetir a mesma porta');
  assert.deepStrictEqual(portasCandidatas({ CHROME_CDP_PORT: 'abc' }), [9222, 9223]);
});

test('REGRESSAO: Chrome reaberto em outra porta nao derruba mais o lote', async () => {
  const vistas = [];
  const porta = await escolherPorta(async p => { vistas.push(p); return p === 9222; }, [9223, 9222]);
  assert.strictEqual(porta, 9222);
  assert.deepStrictEqual(vistas, [9223, 9222], 'tenta na ordem ate achar');
});

test('nenhuma porta de pe devolve null (o vigia abre o Chrome)', async () => {
  assert.strictEqual(await escolherPorta(async () => false, [9222, 9223]), null);
  assert.strictEqual(await escolherPorta(() => { throw new Error('conexao recusada'); }, [9222]), null);
  assert.strictEqual(await escolherPorta(async () => true, []), null);
});

test('a URL final diz se a loja pediu login', () => {
  assert.strictEqual(estaDeslogado('kiwify', 'https://dashboard.kiwify.com/login?redirect=%2Fproducts%2F'), true);
  assert.strictEqual(estaDeslogado('kiwify', 'https://dashboard.kiwify.com/products/'), false);
  assert.strictEqual(estaDeslogado('hotmart', 'https://sso.hotmart.com/login?service=x'), true);
  assert.strictEqual(estaDeslogado('hotmart', 'https://app.hotmart.com/'), false);
  assert.strictEqual(estaDeslogado('cakto', 'https://sso.cakto.com.br/accounts/login/?next=x'), true);
  assert.strictEqual(estaDeslogado('cakto', 'https://app.cakto.com.br/dashboard/products?tab=products'), false);
  assert.strictEqual(estaDeslogado('kdp', 'https://www.amazon.com/ap/signin?openid=x'), true);
  assert.strictEqual(estaDeslogado('kdp', 'https://kdp.amazon.com/pt_BR/bookshelf'), false);
  assert.strictEqual(estaDeslogado('loja-que-nao-existe', 'https://x/login'), false);
  assert.strictEqual(estaDeslogado('kdp', null), false);
});

test('pendencia de login sai pronta para o log, em ordem', () => {
  const p = pendenciasDeLogin({ kiwify: 'deslogado', hotmart: 'deslogado', cakto: 'deslogado', kdp: 'logado' });
  assert.deepStrictEqual(p.faltando, ['cakto', 'hotmart', 'kiwify']);
  assert.match(p.mensagem, /login humano necessario em: cakto, hotmart, kiwify/);
  assert.match(p.mensagem, /nao digita senha/);
  const nenhuma = pendenciasDeLogin({ kdp: 'logado' });
  assert.deepStrictEqual(nenhuma.faltando, []);
  assert.strictEqual(nenhuma.mensagem, 'todas as lojas logadas');
  assert.deepStrictEqual(pendenciasDeLogin(null).faltando, []);
});

test('o Chrome do vigia abre em perfil proprio, sem mexer no do dia a dia', () => {
  const a = argumentosDoChrome(9223, 'C:/chrome-automacao', ['https://app.hotmart.com/']);
  assert.ok(a.includes('--remote-debugging-port=9223'));
  assert.ok(a.includes('--user-data-dir=C:/chrome-automacao'));
  assert.ok(a.includes('--no-first-run'));
  assert.ok(a.includes('--restore-last-session'), 'volta com as abas da sessao anterior');
  assert.strictEqual(a[a.length - 1], 'https://app.hotmart.com/');
  assert.strictEqual(argumentosDoChrome('9223', 'x').length, 5, 'sem url, so as opcoes');
});

test('toda loja do mapa tem pagina e regra de deslogado', () => {
  for (const [nome, l] of Object.entries(LOJAS)) {
    assert.match(l.url, /^https:\/\//, nome);
    assert.ok(l.deslogado instanceof RegExp, nome);
  }
});
