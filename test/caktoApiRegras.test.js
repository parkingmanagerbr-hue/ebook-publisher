'use strict';
/**
 * caktoApiRegras: publicacao na Cakto pela API (o wizard do navegador quebrou
 * em 26/09/2026). O que precisa ficar vermelho se alguem quebrar a regra:
 * produto sem entrega NAO pode nascer ativo, e ajuste nunca vai para o produto
 * errado.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  corpoDeCriacao, corpoDeAjuste, nomeDeProduto, descricaoDeProduto, shortcodeDaOferta,
  linkDeCheckout, mesmoProdutoCakto, motivoDefinitivo, resumoDaPublicacao, PRODUTOR, COMISSAO_AFILIADO,
} = require('../src/agents/caktoApiRegras');

const novo = extra => Object.assign({
  name: 'Guia de Mobiliario', status: 'active', type: 'unique', currency: 'BRL',
  paymentMethods: ['pix', 'credit_card'], offers: [{ id: 'abc1234', default: true }],
}, extra);

test('criacao manda so nome e descricao (e o que a API exige)', () => {
  const c = corpoDeCriacao({ title: 'Pare de Procrastinar em 7 Dias', description: 'Metodo simples, passo a passo, para sair da procrastinacao em uma semana.' });
  assert.deepStrictEqual(Object.keys(c).sort(), ['description', 'name']);
  assert.strictEqual(c.name, 'Pare de Procrastinar em 7 Dias');
  assert.match(c.description, /passo a passo/);
});

test('nome de produto: uma linha, no maximo 120', () => {
  assert.strictEqual(nomeDeProduto('Guia\nDefinitivo\tde Financas'), 'Guia Definitivo de Financas');
  assert.strictEqual(nomeDeProduto('x'.repeat(200)).length, 120);
  assert.strictEqual(nomeDeProduto(null), '');
  assert.strictEqual(nomeDeProduto('  espacos  '), 'espacos');
});

test('descricao curta demais vira texto padrao com o titulo', () => {
  const d = descricaoDeProduto({ title: 'Financas em Ordem', description: 'curta' });
  assert.match(d, /Financas em Ordem/);
  assert.match(d, /Entrega imediata/);
  assert.ok(descricaoDeProduto({}).length >= 40, 'livro vazio ainda gera descricao valida');
  assert.ok(descricaoDeProduto({ description: 'a'.repeat(900) }).length <= 500);
  assert.ok(!/[\r\n]/.test(descricaoDeProduto({ description: 'linha um\nlinha dois que continua por bastante tempo aqui' })));
});

test('o checkout sai da oferta padrao, nao da primeira qualquer', () => {
  const p = novo({ offers: [{ id: 'secundaria' }, { id: 'principal', default: true }] });
  assert.strictEqual(shortcodeDaOferta(p), 'principal');
  assert.strictEqual(shortcodeDaOferta({ offers: [] }), null);
  assert.strictEqual(shortcodeDaOferta(null), null);
  assert.strictEqual(linkDeCheckout('principal'), 'https://pay.cakto.com.br/principal');
  assert.strictEqual(linkDeCheckout(null), null);
});

test('SEM entrega o produto NAO fica ativo (vender sem ter o que entregar e pior que nao vender)', () => {
  const a = corpoDeAjuste(novo({ status: 'active', emailAccessLink: null }), {});
  assert.strictEqual(a.status, 'waiting_config');
  assert.ok(!('emailAccessLink' in a), 'nao inventa link de entrega');
});

test('COM entrega o produto fica ativo e com o link gravado', () => {
  const link = 'https://publisher.veloxisit.com.br/entrega/abc.token';
  const a = corpoDeAjuste(novo({ status: 'waiting_config' }), { entrega: link });
  assert.strictEqual(a.status, 'active');
  assert.strictEqual(a.emailAccessLink, link);
  assert.deepStrictEqual(a.contentDeliveries, ['external']);
});

test('produto que ja tem link de entrega continua ativo mesmo sem link novo', () => {
  const a = corpoDeAjuste(novo({ status: 'waiting_config', emailAccessLink: 'https://x/entrega/t' }), {});
  assert.strictEqual(a.status, 'active');
});

test('nada muda quando ja esta tudo certo', () => {
  const pronto = novo({
    status: 'active', emailAccessLink: 'https://x/entrega/t', producerName: PRODUTOR,
    supportEmail: 'suporte@exemplo.com', salesPage: 'https://pay.cakto.com.br/abc1234',
    affiliate: true, affiliateCommission: '50.00',
  });
  assert.deepStrictEqual(corpoDeAjuste(pronto, {}), {});
});

test('afiliacao entra completa e com a comissao da casa', () => {
  const a = corpoDeAjuste(novo(), { entrega: 'https://x/e/t' });
  assert.strictEqual(a.affiliate, true);
  assert.strictEqual(a.affiliateMarketplace, true);
  assert.strictEqual(a.affiliateRequest, false, 'afiliacao automatica: pedido manual trava o afiliado');
  assert.strictEqual(a.affiliateCommission, COMISSAO_AFILIADO);
  assert.ok(a.affiliateCommission >= 1 && a.affiliateCommission <= 95, 'a Cakto recusa fora de 1..95');
  assert.match(a.affiliateDescription, /Comissão de 50%/);
});

test('metodo de pagamento que a Cakto recusa e retirado antes do PUT', () => {
  const a = corpoDeAjuste(novo({ paymentMethods: ['pix', 'spei', 'oxxo', 'pix_auto', 'credit_card'] }), { entrega: 'https://x/e/t' });
  assert.deepStrictEqual(a.paymentMethods, ['pix', 'credit_card']);
});

test('producerName evita o e-mail do dono no checkout', () => {
  assert.strictEqual(corpoDeAjuste(novo(), {}).producerName, PRODUTOR);
  assert.ok(!('producerName' in corpoDeAjuste(novo({ producerName: 'Outro' }), {})), 'nome ja definido nao e trocado');
});

test('nunca grava ajuste no produto errado', () => {
  assert.strictEqual(mesmoProdutoCakto('Guia de Financas', 'guia  de   financas'), true);
  assert.strictEqual(mesmoProdutoCakto('Guia de Financas', 'Outro Livro'), false);
  assert.strictEqual(mesmoProdutoCakto('', 'Guia'), false);
  assert.strictEqual(mesmoProdutoCakto('Guia', ''), false);
  assert.strictEqual(mesmoProdutoCakto(null, null), false);
  assert.strictEqual(mesmoProdutoCakto('x'.repeat(120), 'x'.repeat(200)), true, 'compara depois do corte de 120');
});

test('recusa definitiva nao volta para a fila; erro passageiro volta', () => {
  assert.strictEqual(motivoDefinitivo(402, '{}'), 'limite de plano');
  assert.strictEqual(motivoDefinitivo(400, 'limite de produtos do plano'), 'limite de plano');
  assert.strictEqual(motivoDefinitivo(403, 'sem permissao'), 'conta sem permissao');
  assert.strictEqual(motivoDefinitivo(403, 'CSRF cookie not set'), null, 'CSRF se resolve pegando token novo');
  assert.strictEqual(motivoDefinitivo(400, 'conteúdo não permitido'), 'conteudo recusado');
  assert.strictEqual(motivoDefinitivo(500, 'erro'), null);
  assert.strictEqual(motivoDefinitivo(201, ''), null);
});

test('log de uma linha, sem quebra vinda do titulo', () => {
  const linha = resumoDaPublicacao('Guia\nDefinitivo', 'abc1234', { status: 'active', emailAccessLink: 'x' });
  assert.ok(!/[\r\n]/.test(linha));
  assert.match(linha, /checkout=abc1234/);
  assert.match(linha, /ajustes=emailAccessLink,status/);
  assert.match(resumoDaPublicacao('x', 'y', {}), /sem ajuste/);
  assert.match(resumoDaPublicacao(null, null, null), /sem ajuste/);
});

test('aceita o livro nos dois nomes de campo (title/titulo, description/descricao)', () => {
  const c = corpoDeCriacao({ titulo: 'Horta em Apartamento', descricao: 'Guia completo para cultivar temperos na varanda, do vaso a colheita.' });
  assert.strictEqual(c.name, 'Horta em Apartamento');
  assert.match(c.description, /varanda/);
  assert.match(descricaoDeProduto({ titulo: 'So o titulo' }), /So o titulo/);
});

test('entrada faltando nao quebra nenhuma das regras', () => {
  assert.deepStrictEqual(corpoDeCriacao(), corpoDeCriacao({}));
  assert.strictEqual(corpoDeCriacao().name, '');
  assert.strictEqual(descricaoDeProduto(null).length > 40, true);
  assert.deepStrictEqual(Object.keys(corpoDeAjuste(null)).sort(), ['affiliate', 'affiliateCommission', 'affiliateDescription', 'affiliateMarketplace', 'affiliateRequest', 'producerName', 'status', 'supportEmail']);
  assert.strictEqual(corpoDeAjuste(null).status, 'waiting_config', 'produto desconhecido nao vai para o ar');
  assert.strictEqual(shortcodeDaOferta({ offers: [{ default: true }] }), null, 'oferta sem id nao vira checkout');
  assert.strictEqual(shortcodeDaOferta({}), null);
  assert.strictEqual(motivoDefinitivo(400, null), null);
  assert.strictEqual(motivoDefinitivo(null, ''), null);
});

test('checkout informado por quem chama tem preferencia sobre o derivado da oferta', () => {
  const a = corpoDeAjuste(novo({ salesPage: null }), { checkout: 'https://pay.cakto.com.br/forcado', entrega: 'https://x/e/t' });
  assert.strictEqual(a.salesPage, 'https://pay.cakto.com.br/forcado');
  const b = corpoDeAjuste(novo({ salesPage: null, offers: [] }), { entrega: 'https://x/e/t' });
  assert.ok(!('salesPage' in b), 'sem oferta e sem checkout informado, nao inventa pagina de vendas');
});

test('paymentMethods ausente nao vira lista vazia gravada', () => {
  const a = corpoDeAjuste(novo({ paymentMethods: undefined }), { entrega: 'https://x/e/t' });
  assert.ok(!('paymentMethods' in a));
});
