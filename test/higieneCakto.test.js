'use strict';
/**
 * higieneCakto: o checkout de 8.000 produtos mostrava o e-mail pessoal do dono
 * e nenhum tinha afiliacao. Cada regra daqui nasceu de um numero medido.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { alvoHigiene, precisaSubirCapa, paginaDeVendasRuim, resumoDaCorrecao, DESCRICAO_AFILIADO } = require('../src/agents/higieneCakto');
const { PRODUTOR, COMISSAO_AFILIADO } = require('../scripts/entregaCakto');

const CHECKOUT = 'https://pay.cakto.com.br/abc123';

test('produto cru recebe nome de vendedor, pagina e afiliacao', () => {
  const m = alvoHigiene({}, { checkout: CHECKOUT });
  assert.strictEqual(m.producerName, PRODUTOR);
  assert.strictEqual(m.salesPage, CHECKOUT);
  assert.strictEqual(m.affiliate, true);
  assert.strictEqual(m.affiliateMarketplace, true);
  assert.strictEqual(m.affiliateRequest, false);
  assert.strictEqual(m.affiliateCommission, COMISSAO_AFILIADO);
  assert.strictEqual(m.affiliateDescription, DESCRICAO_AFILIADO);
  assert.ok(!('status' in m), 'higiene nunca ativa produto sem arquivo');
});

test('o que ja esta certo nao e tocado', () => {
  const pronto = {
    producerName: 'Veloxis Editorial', salesPage: CHECKOUT, affiliate: true,
    affiliateCommission: 70, affiliateDescription: 'texto do dono',
  };
  assert.deepStrictEqual(alvoHigiene(pronto, { checkout: CHECKOUT }), {});
});

test('nome dado por uma pessoa e respeitado', () => {
  const m = alvoHigiene({ producerName: 'Editora do Ze' }, { checkout: CHECKOUT });
  assert.ok(!('producerName' in m));
});

test('comissao fora da faixa da Cakto (1 a 95) e corrigida', () => {
  assert.strictEqual(alvoHigiene({ affiliateCommission: '0.00' }, {}).affiliateCommission, COMISSAO_AFILIADO);
  assert.strictEqual(alvoHigiene({ affiliateCommission: 99 }, {}).affiliateCommission, COMISSAO_AFILIADO);
  assert.strictEqual(alvoHigiene({ affiliateCommission: 70 }, {}).affiliateCommission, undefined, 'dentro da faixa fica');
});

test('pagina de vendas: vazia ou apontando para a Hotmart e trocada', () => {
  assert.strictEqual(paginaDeVendasRuim(''), true);
  assert.strictEqual(paginaDeVendasRuim(null), true);
  assert.strictEqual(paginaDeVendasRuim('https://hotmart.com'), true, 'mandava o comprador para outra plataforma');
  assert.strictEqual(paginaDeVendasRuim('https://www.hotmart.com/'), true);
  assert.strictEqual(paginaDeVendasRuim('https://veloxisit.com.br/livros/x/'), false);
  assert.strictEqual(alvoHigiene({ salesPage: 'https://veloxisit.com.br/livros/x/' }, { checkout: CHECKOUT }).salesPage, undefined);
  assert.strictEqual(alvoHigiene({ salesPage: '' }, {}).salesPage, undefined, 'sem checkout conhecido, nao inventa');
});

test('capa so sobe quando falta no produto e existe em disco', () => {
  assert.strictEqual(precisaSubirCapa({ image: null }, true), true);
  assert.strictEqual(precisaSubirCapa({ image: 'https://cdn/x.jpg' }, true), false, 'nao troca capa existente');
  assert.strictEqual(precisaSubirCapa({ image: null }, false), false, 'sem arquivo local nao ha o que enviar');
  assert.strictEqual(precisaSubirCapa(null, true), true);
});

test('resumo do log e uma linha, sem quebra vinda de fora', () => {
  assert.strictEqual(resumoDaCorrecao('abc', {}, false), 'abc: nada a corrigir');
  assert.strictEqual(resumoDaCorrecao('abc', { producerName: 'x' }, true), 'abc: capa, producerName');
  assert.strictEqual(resumoDaCorrecao('a\nb', { salesPage: 'x' }, false), 'a b: salesPage');
  assert.strictEqual(resumoDaCorrecao(null, null, false), ': nada a corrigir');
});

test('produto nulo nao quebra o passe', () => {
  const m = alvoHigiene(null, { checkout: CHECKOUT });
  assert.strictEqual(m.producerName, PRODUTOR);
});

// ── Metodos de pagamento (a API devolve o que ela mesma recusa) ─────────────
const { metodosDePagamentoValidos } = require('../src/agents/higieneCakto');
const DO_PRODUTO = ['pix', 'pix_auto', 'credit_card', 'threeDs', 'picpay', 'googlepay', 'applepay', 'oxxo', 'spei'];

test('BRL sem assinatura: sai spei, oxxo e pix automatico', () => {
  const m = metodosDePagamentoValidos(DO_PRODUTO, { moeda: 'BRL', tipo: 'unique' });
  assert.deepStrictEqual(m, ['pix', 'credit_card', 'threeDs', 'picpay', 'googlepay', 'applepay']);
});

test('assinatura mantem o Pix Automatico', () => {
  const m = metodosDePagamentoValidos(['pix', 'pix_auto'], { moeda: 'BRL', tipo: 'subscription' });
  assert.deepStrictEqual(m, ['pix', 'pix_auto']);
});

test('fora do BRL, os metodos mexicanos continuam valendo', () => {
  const m = metodosDePagamentoValidos(['oxxo', 'spei', 'credit_card'], { moeda: 'MXN', tipo: 'unique' });
  assert.deepStrictEqual(m, ['oxxo', 'spei', 'credit_card']);
});

test('lista ausente, vazia ou com lixo nao quebra', () => {
  assert.deepStrictEqual(metodosDePagamentoValidos(null), []);
  assert.deepStrictEqual(metodosDePagamentoValidos('pix'), []);
  assert.deepStrictEqual(metodosDePagamentoValidos([null, '', 'pix']), ['pix']);
  assert.deepStrictEqual(metodosDePagamentoValidos(['PIX', 'OXXO'], { moeda: 'brl' }), ['PIX'], 'caixa nao engana');
  assert.deepStrictEqual(metodosDePagamentoValidos(['pix']), ['pix'], 'padrao e BRL e pagamento unico');
});

test('a higiene corrige os metodos junto com o resto (era 400 em 60 de 60)', () => {
  const m = alvoHigiene({ paymentMethods: DO_PRODUTO, currency: 'BRL', type: 'unique' }, { checkout: CHECKOUT });
  assert.deepStrictEqual(m.paymentMethods, ['pix', 'credit_card', 'threeDs', 'picpay', 'googlepay', 'applepay']);
  const jaLimpo = alvoHigiene({ paymentMethods: ['pix'], currency: 'BRL', type: 'unique', producerName: 'Veloxis Editorial', salesPage: CHECKOUT, affiliate: true, affiliateCommission: 50, affiliateDescription: 'x' }, { checkout: CHECKOUT });
  assert.ok(!('paymentMethods' in jaLimpo), 'lista ja valida nao e reescrita');
});
