'use strict';
/**
 * kiwifyRegras: o que decide preco, moeda e categoria antes de falar com a API.
 * Preco errado ou moeda errada e dinheiro — cada regra aqui e exercitada.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  CATEGORIAS, categoriaKiwify, precoCentavos, moedaPorIdioma, descricaoKiwify,
  descritorFatura, corpoDeCriacao, mesmoProdutoKiwify,
} = require('../src/agents/kiwifyRegras');

test('preco vai em centavos e nunca abaixo do minimo da plataforma', () => {
  assert.strictEqual(precoCentavos(5), 500);
  assert.strictEqual(precoCentavos('9,90'), 990);
  assert.strictEqual(precoCentavos(19.9), 1990);
  assert.strictEqual(precoCentavos(3.99), 500, 'abaixo do minimo sobe para o minimo');
  assert.strictEqual(precoCentavos(0), 500);
  assert.strictEqual(precoCentavos(-7), 500);
  assert.strictEqual(precoCentavos(null), 500);
  assert.strictEqual(precoCentavos('nao e numero'), 500);
  assert.strictEqual(precoCentavos(2, 100), 200, 'minimo configuravel');
});

test('moeda segue o idioma do livro (catalogo mundial)', () => {
  assert.strictEqual(moedaPorIdioma('pt-BR'), 'BRL');
  assert.strictEqual(moedaPorIdioma('en-US'), 'USD');
  assert.strictEqual(moedaPorIdioma('fr'), 'EUR');
  assert.strictEqual(moedaPorIdioma('ja-JP'), 'JPY');
  assert.strictEqual(moedaPorIdioma('hi-IN'), 'USD', 'idioma sem moeda propria vende em dolar');
  assert.strictEqual(moedaPorIdioma(null), 'USD');
  assert.strictEqual(moedaPorIdioma('ja', ['BRL', 'USD']), 'BRL', 'moeda fora da lista da loja cai para BRL');
});

test('categoria pelo assunto, com "Outros" quando nada casa', () => {
  assert.strictEqual(categoriaKiwify('Fundo de Emergência para Autônomos', 'financas'), CATEGORIAS.financas);
  assert.strictEqual(categoriaKiwify('Mindfulness e Produtividade Remota', 'foco no trabalho remoto'), CATEGORIAS.saude);
  assert.strictEqual(categoriaKiwify('Cardápio Plant-Based nas Escolas', 'alimentação escolar'), CATEGORIAS.saude);
  assert.strictEqual(categoriaKiwify('Docker na prática', 'devops'), CATEGORIAS.ti);
  assert.strictEqual(categoriaKiwify('Como criar hábitos', 'rotina e disciplina'), CATEGORIAS.desenvolvimento);
  assert.strictEqual(categoriaKiwify('Tricô para iniciantes', 'artesanato manual'), CATEGORIAS.outros);
  assert.strictEqual(categoriaKiwify(null, null), CATEGORIAS.outros);
});

test('descricao cabe no campo de 500 sem cortar palavra', () => {
  const longa = 'palavra '.repeat(200);
  const d = descricaoKiwify(longa);
  assert.ok(d.length <= 501, d.length);
  assert.ok(d.endsWith('.'));
  assert.ok(!/palavr\.$/.test(d), 'nao corta no meio da palavra');
  assert.strictEqual(descricaoKiwify('  texto   curto  '), 'texto curto');
  assert.strictEqual(descricaoKiwify(null), '');
  assert.strictEqual(descricaoKiwify('abcdefghij', 5), 'abcde.', 'sem espaco util, corta no limite');
});

test('descritor de fatura: 10 caracteres, sem acento nem simbolo', () => {
  assert.strictEqual(descritorFatura('Orçamento de Viagem'), 'Orcamentod');
  assert.strictEqual(descritorFatura('R$ #@!'), 'Rxx', 'sobra curta ainda preenche o minimo');
  assert.strictEqual(descritorFatura(null), 'Ebook');
});

test('corpo da criacao e exatamente o que a API aceita', () => {
  const c = corpoDeCriacao({
    title: 'Mindfulness e Produtividade Remota',
    description: 'Guia prático em PDF.',
    language: 'pt-BR',
    preco: 5,
    paginaDeVendas: 'https://veloxisit.com.br/livros/mindfulness/',
  });
  assert.deepStrictEqual(c, {
    name: 'Mindfulness e Produtividade Remota',
    price: 500,
    payment_type: 'charge',
    sales_page_url: 'https://veloxisit.com.br/livros/mindfulness/',
    type: 'club',
    description: 'Guia prático em PDF.',
    currency: 'BRL',
    club_id: null,
  });
  const semNada = corpoDeCriacao({});
  assert.strictEqual(semNada.name, '');
  assert.strictEqual(semNada.price, 500);
  assert.strictEqual(semNada.sales_page_url, '');
  assert.strictEqual(semNada.currency, 'USD');
});

test('titulo enorme nao estoura o campo de nome', () => {
  const c = corpoDeCriacao({ title: 'A'.repeat(300), language: 'en' });
  assert.strictEqual(c.name.length, 100);
  assert.strictEqual(c.currency, 'USD');
});

test('produto de outro nome nao recebe arquivo nem preco (mesma trava da Hotmart)', () => {
  assert.strictEqual(mesmoProdutoKiwify('Mindfulness e Produtividade Remota', 'Mindfulness e Produtividade Remota'), true);
  assert.strictEqual(mesmoProdutoKiwify(' MINDFULNESS  e Produtividade Remota ', 'Mindfulness e Produtividade Remota'), true);
  assert.strictEqual(mesmoProdutoKiwify('Outro Livro', 'Mindfulness e Produtividade Remota'), false);
  assert.strictEqual(mesmoProdutoKiwify('', 'Qualquer'), true, 'sem resposta da API o fluxo segue');
  assert.strictEqual(mesmoProdutoKiwify(null, 'Qualquer'), true);
});

test('PUT so leva campo permitido — o objeto do GET inteiro da 400', () => {
  const { corpoDeAtualizacao } = require('../src/agents/kiwifyRegras');
  const doGet = {
    id: 'p1', created_at: '2026-09-23', type: 'club', club: { id: 'c1' }, gateway_type: 'x',
    soft_ban: false, has_sales_recovery_agent: false, subscriptions_bulk_cancel_allowed: true,
    moneyback_guarantee: 15, payment_methods: 1, checkout_color: '#000000', pixels: [{ id: 1 }],
    cpf_required: false, instagram_required: true, support_email: 'a@b.c',
  };
  const c = corpoDeAtualizacao(doGet, { title: 'Docker na prática', description: 'd', language: 'pt-BR', preco: 5, topic: 'devops' }, 21);
  for (const proibido of ['id', 'created_at', 'type', 'club', 'gateway_type', 'soft_ban', 'has_sales_recovery_agent', 'subscriptions_bulk_cancel_allowed']) {
    assert.ok(!(proibido in c), proibido + ' nao pode ir no PUT');
  }
  assert.strictEqual(c.category, 21);
  assert.strictEqual(c.moneyback_guarantee, 15, 'respeita o que ja estava');
  assert.strictEqual(c.cpf_required, false);
  assert.strictEqual(c.instagram_required, true);
  assert.deepStrictEqual(c.pixels, [{ id: 1 }]);
  assert.strictEqual(c.soft_descriptor, 'Dockernapr');
});

test('PUT sem objeto anterior usa os padroes do painel', () => {
  const { corpoDeAtualizacao } = require('../src/agents/kiwifyRegras');
  const c = corpoDeAtualizacao(null, { title: 'Receitas de pão', description: 'd', language: 'en-US', preco: 9.9 });
  assert.strictEqual(c.moneyback_guarantee, 7);
  assert.strictEqual(c.payment_methods, 3);
  assert.strictEqual(c.days_expiration, 2);
  assert.strictEqual(c.checkout_color, '#2353ff');
  assert.strictEqual(c.checkout_logo, null);
  assert.strictEqual(c.support_email, null);
  assert.strictEqual(c.approved_url, '');
  assert.strictEqual(c.boleto_url, '');
  assert.deepStrictEqual(c.pixels, []);
  assert.strictEqual(c.cpf_required, true);
  assert.strictEqual(c.instagram_required, false);
  assert.strictEqual(c.currency, 'USD');
  assert.strictEqual(c.price, 990);
  assert.strictEqual(c.category, 7, 'categoria vem do titulo quando nao e informada');
  const semArray = corpoDeAtualizacao({ pixels: 'nao e lista', days_expiration: 5, mobile_required: false, email_confirmation_required: false }, { title: 'x' }, 3);
  assert.deepStrictEqual(semArray.pixels, []);
  assert.strictEqual(semArray.days_expiration, 5);
  assert.strictEqual(semArray.mobile_required, false);
  assert.strictEqual(semArray.email_confirmation_required, false);
});
