'use strict';
/**
 * sessaoHotmart: em 26/09/2026 oito lotes publicaram zero porque o vigia dizia
 * "deslogado" — e o painel estava logado, so a aba do app tinha morrido.
 *
 * A regra que NAO pode ser afrouxada: tela que pede senha ou codigo e trabalho
 * de gente. O robo nunca digita credencial de loja.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { diagnosticarTela, pedeSegredo, botaoDeSessaoSalva, ehPainel, resumoDaSessao } = require('../src/agents/sessaoHotmart');

const painel = { url: 'https://app.hotmart.com/products', campos: [], botoes: ['Home', 'Produtos'] };

test('painel aberto: e so renovar o token, ninguem precisa ser acordado', () => {
  const d = diagnosticarTela(painel);
  assert.strictEqual(d.estado, 'logado');
  assert.strictEqual(d.botao, null);
});

test('tela que pede SENHA e trabalho de gente — nunca do robo', () => {
  const d = diagnosticarTela({
    url: 'https://sso.hotmart.com/login',
    campos: [{ tipo: 'email', nome: 'username', visivel: true }, { tipo: 'password', nome: 'password', visivel: true }],
    botoes: ['Entrar'],
  });
  assert.strictEqual(d.estado, 'precisa-humano', 'ter botao "Entrar" nao autoriza preencher senha');
  assert.match(d.motivo, /senha ou codigo/);
  assert.strictEqual(d.botao, null);
});

test('tela que pede CODIGO de verificacao tambem para o robo', () => {
  for (const campo of [
    { tipo: 'text', nome: 'codigo', visivel: true },
    { tipo: 'text', nome: 'otp', visivel: true },
    { tipo: 'tel', ph: 'Código de verificação', visivel: true },
    { tipo: 'text', nome: 'token2fa', visivel: true },
  ]) {
    const d = diagnosticarTela({ url: 'https://sso.hotmart.com/2fa', campos: [campo], botoes: ['Continuar'] });
    assert.strictEqual(d.estado, 'precisa-humano', JSON.stringify(campo));
  }
});

test('campo de senha ESCONDIDO nao conta (formulario que o site deixa no DOM)', () => {
  assert.strictEqual(pedeSegredo([{ tipo: 'password', nome: 'password', visivel: false }]), false);
  assert.strictEqual(pedeSegredo([]), false);
  assert.strictEqual(pedeSegredo(null), false);
  assert.strictEqual(pedeSegredo([null]), false);
});

test('continuar com a conta ja guardada: o robo pode clicar (nao ha segredo digitado)', () => {
  const d = diagnosticarTela({
    url: 'https://sso.hotmart.com/continuar',
    campos: [],
    botoes: ['Continuar como Rovariz', 'Usar outra conta'],
  });
  assert.strictEqual(d.estado, 'sessao-salva');
  assert.strictEqual(d.botao, 'Continuar como Rovariz');
});

test('o botao de continuar e reconhecido nas formas que a Hotmart usa', () => {
  assert.strictEqual(botaoDeSessaoSalva(['Acessar']), 'Acessar');
  assert.strictEqual(botaoDeSessaoSalva(['Sim, sou eu']), 'Sim, sou eu');
  assert.strictEqual(botaoDeSessaoSalva(['  Continuar  ']), 'Continuar');
  assert.strictEqual(botaoDeSessaoSalva(['Criar conta', 'Esqueci minha senha']), null, 'nao clica no que nao e continuar');
  assert.strictEqual(botaoDeSessaoSalva([]), null);
  assert.strictEqual(botaoDeSessaoSalva(null), null);
  assert.strictEqual(botaoDeSessaoSalva([null, '', 'Entrar']), 'Entrar');
});

test('tela desconhecida nao vira clique no escuro', () => {
  const d = diagnosticarTela({ url: 'https://sso.hotmart.com/seja-la-o-que-for', campos: [], botoes: ['Ajuda', 'Voltar'] });
  assert.strictEqual(d.estado, 'precisa-humano');
  assert.match(d.motivo, /tela desconhecida/);
});

test('so app.hotmart.com conta como painel (nao se confia em url parecida)', () => {
  assert.strictEqual(ehPainel('https://app.hotmart.com/products', []), true);
  assert.strictEqual(ehPainel('https://app.hotmart.com.invasor.com/products', []), false);
  assert.strictEqual(ehPainel('http://app.hotmart.com/products', []), false, 'sem https nao vale');
  assert.strictEqual(ehPainel('https://sso.hotmart.com/login', []), false);
  assert.strictEqual(ehPainel(null, []), false);
  assert.strictEqual(ehPainel('https://app.hotmart.com/x', [{ tipo: 'password', visivel: true }]), false,
    'url de painel com campo de senha e tela de entrada disfarcada');
});

test('entrada vazia nao quebra e nao autoriza nada', () => {
  assert.strictEqual(diagnosticarTela().estado, 'precisa-humano');
  assert.strictEqual(diagnosticarTela(null).estado, 'precisa-humano');
  assert.strictEqual(diagnosticarTela({}).estado, 'precisa-humano');
});

test('log de uma linha, sem query (que carrega token) e sem quebra', () => {
  const linha = resumoDaSessao({ estado: 'logado', motivo: 'o painel\nabriu' }, 'https://app.hotmart.com/x?access_token=abc123');
  assert.ok(!/[\r\n]/.test(linha));
  assert.ok(!linha.includes('abc123'), linha);
  assert.match(linha, /sessao Hotmart: logado/);
  assert.match(resumoDaSessao(null, null), /sessao Hotmart: \?/);
});

test('campo sem tipo nem nome nao e confundido com campo de segredo', () => {
  assert.strictEqual(pedeSegredo([{ visivel: true }]), false);
  assert.strictEqual(pedeSegredo([{ tipo: 'text', visivel: true }]), false, 'campo de texto comum passa');
  assert.strictEqual(pedeSegredo([{ tipo: 'PASSWORD', visivel: true }]), true, 'caixa alta tambem conta');
});
