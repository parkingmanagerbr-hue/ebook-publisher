'use strict';
/**
 * kdpRegras: a Amazon trocou "Adicionar categoria" por "Editar categorias" e o
 * publish passou a morrer em "Adicione uma categoria para seu livro" (23/09/2026).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { ehBotaoDeCategoria, melhorBotaoDeCategoria, errosQueImportam } = require('../src/agents/kdpRegras');

test('REGRESSAO: o botao novo ("Editar categorias") e reconhecido', () => {
  assert.strictEqual(ehBotaoDeCategoria({ tag: 'BUTTON', id: 'categories-modal-button', texto: 'Editar categorias' }), true);
  assert.strictEqual(ehBotaoDeCategoria({ tag: 'SPAN', texto: 'Editar categorias' }), true);
  assert.strictEqual(ehBotaoDeCategoria({ tag: 'SPAN', texto: 'Adicionar categoria' }), true, 'o texto antigo continua valendo');
  assert.strictEqual(ehBotaoDeCategoria({ texto: 'Escolha as categorias' }), true);
  assert.strictEqual(ehBotaoDeCategoria({ texto: 'Edit categories' }), true);
  assert.strictEqual(ehBotaoDeCategoria({ texto: 'Add a category' }), true);
});

test('rotulo e ajuda nao sao o botao', () => {
  assert.strictEqual(ehBotaoDeCategoria({ texto: 'O que são categorias?' }), false);
  assert.strictEqual(ehBotaoDeCategoria({ texto: 'As categorias atuais do seu livro' }), false);
  assert.strictEqual(ehBotaoDeCategoria({ texto: 'Adicione uma categoria para seu livro.' }), false, 'mensagem de erro nao e botao');
  assert.strictEqual(ehBotaoDeCategoria({ texto: '' }), false);
  assert.strictEqual(ehBotaoDeCategoria(null), false);
  assert.strictEqual(ehBotaoDeCategoria({ texto: 'x'.repeat(61) }), false);
});

test('entre os candidatos, vence o que tem id conhecido', () => {
  const candidatos = [
    { tag: 'SPAN', cls: 'a-button', texto: 'Editar categorias' },
    { tag: 'SPAN', cls: 'a-button-inner', texto: 'Editar categorias' },
    { tag: 'BUTTON', cls: 'a-button-text', texto: 'Editar categorias', id: 'categories-modal-button' },
    { tag: 'SPAN', texto: 'O que são categorias?' },
  ];
  assert.strictEqual(melhorBotaoDeCategoria(candidatos).id, 'categories-modal-button');
});

test('sem id, o BUTTON vale mais que o SPAN que o embrulha', () => {
  const r = melhorBotaoDeCategoria([
    { tag: 'SPAN', texto: 'Editar categorias' },
    { tag: 'BUTTON', texto: 'Editar categorias' },
  ]);
  assert.strictEqual(r.tag, 'BUTTON');
  assert.strictEqual(melhorBotaoDeCategoria([{ tag: 'SPAN', texto: 'Editar categorias' }]).tag, 'SPAN');
  assert.strictEqual(melhorBotaoDeCategoria([{ texto: 'nada a ver' }]), null);
  assert.strictEqual(melhorBotaoDeCategoria([]), null);
  assert.strictEqual(melhorBotaoDeCategoria(null), null);
});

test('o erro que importa nao se perde no meio dos avisos de tela', () => {
  const doKdp = [
    'Adicione uma categoria para seu livro.',
    'Você pode atualizar o manuscrito e as configurações do seu livro até 3 dias antes da ativação da pré-venda. Saiba mais',
    'Em andamento...',
    'Não iniciada...',
    'No momento, o chinês (tradicional) está em beta no KDP. Somente conteúdo horizontal é permitido.',
    'Este é seu primeiro adiamento.',
    'A pré-venda de livros em domínio público não é permitida. Saiba mais',
  ];
  // O aviso do chines aparece em qualquer livro (e da tela, nao do livro):
  // sobra so o que de fato impede publicar.
  assert.deepStrictEqual(errosQueImportam(doKdp), ['Adicione uma categoria para seu livro.']);
  assert.deepStrictEqual(errosQueImportam([]), []);
  assert.deepStrictEqual(errosQueImportam(null), []);
  assert.deepStrictEqual(errosQueImportam(['   ', null, 'O tamanho combinado do título e do subtítulo não pode exceder 200 caracteres.']),
    ['O tamanho combinado do título e do subtítulo não pode exceder 200 caracteres.']);
});

test('candidato sem tag definida ainda serve de ultimo recurso', () => {
  const r = melhorBotaoDeCategoria([{ texto: 'Editar categorias' }]);
  assert.deepStrictEqual(r, { texto: 'Editar categorias' });
});

// ── Preco por mercado (o publish travava em "Use um formato de preco de 0,00") ──
const { mercadoDoCampo, precoDoMercado, royaltyPara } = require('../src/agents/kdpRegras');

test('o mercado sai do name do campo (o id vem vazio, por isso preenchia 0 de 13)', () => {
  assert.strictEqual(mercadoDoCampo('data[digital][channels][amazon][US][price_vat_inclusive]'), 'US');
  assert.strictEqual(mercadoDoCampo('data[digital][channels][amazon][IN][price_vat_inclusive]'), 'IN');
  assert.strictEqual(mercadoDoCampo('data[title]'), null);
  assert.strictEqual(mercadoDoCampo(null), null);
});

test('India e Japao sem centavos; o resto com virgula', () => {
  assert.strictEqual(precoDoMercado('US', 2.99), '2,99');
  assert.strictEqual(precoDoMercado('IN', 2.99), '249', 'multiplo de 1 INR, como o KDP exige');
  assert.strictEqual(precoDoMercado('JP', 2.99), '443');
  assert.strictEqual(precoDoMercado('DE', 2.99), '4,49');
  assert.strictEqual(precoDoMercado('BR', 2.99), '14,95');
  assert.ok(!precoDoMercado('UK', 2.99).includes('.'), 'ponto decimal e recusado pelo KDP');
});

test('mercado desconhecido e preco invalido nao inventam valor', () => {
  assert.strictEqual(precoDoMercado('ZZ', 2.99), null);
  assert.strictEqual(precoDoMercado('', 2.99), null);
  assert.strictEqual(precoDoMercado('US', 0), '2,99', 'preco zero cai no padrao');
  assert.strictEqual(precoDoMercado('US', 'abc'), '2,99');
  assert.strictEqual(precoDoMercado('us', 9.99), '9,99', 'caixa do mercado nao importa');
});

test('royalty: 70% so vale na faixa que a Amazon permite', () => {
  assert.strictEqual(royaltyPara(2.99), '70_PERCENT');
  assert.strictEqual(royaltyPara(9.99), '70_PERCENT');
  assert.strictEqual(royaltyPara(0.99), '35_PERCENT');
  assert.strictEqual(royaltyPara(10), '35_PERCENT');
  assert.strictEqual(royaltyPara('x'), '35_PERCENT');
  assert.strictEqual(royaltyPara(), '70_PERCENT', 'o padrao do projeto e 2,99');
});

test('SALVAR nao e PUBLICAR: o botao de rascunho nunca conta como publicacao', () => {
  const { ehBotaoDePublicar } = require('../src/agents/kdpRegras');
  // 29/09/2026: "Salvar e continuar" estava na lista de botoes de publicar. O
  // robo clicava nele, o rascunho era salvo e o log dizia buttonClicked=true —
  // livros completos parados como Rascunho e a Amazon sem catalogo.
  assert.strictEqual(ehBotaoDePublicar('Salvar e continuar'), false);
  assert.strictEqual(ehBotaoDePublicar('Save and continue'), false);
  assert.strictEqual(ehBotaoDePublicar('Salvar como rascunho'), false);
  assert.strictEqual(ehBotaoDePublicar('Save as draft'), false);
});

test('o rotulo real do KDP em portugues e reconhecido', () => {
  const { ehBotaoDePublicar } = require('../src/agents/kdpRegras');
  assert.strictEqual(ehBotaoDePublicar('Publicar seu eBooks Kindle'), true, 'e este o botao da tela');
  assert.strictEqual(ehBotaoDePublicar('Publicar e-book Kindle'), true);
  assert.strictEqual(ehBotaoDePublicar('Publish Your Kindle eBook'), true);
  assert.strictEqual(ehBotaoDePublicar('  PUBLICAR  '), true, 'caixa e espaco nao importam');
  assert.strictEqual(ehBotaoDePublicar('Voltar para o conteudo'), false);
  assert.strictEqual(ehBotaoDePublicar(''), false);
  assert.strictEqual(ehBotaoDePublicar(null), false);
});

test('conta incompleta vem PRIMEIRO na causa, e texto de ajuda de preco nao e causa', () => {
  const { errosQueImportam, ehBloqueioDeConta } = require('../src/agents/kdpRegras');
  // 30/09/2026: o log dizia "causa: Concluida | O tamanho do arquivo... | Use um
  // formato de preco... | Defina um preco sugerido..." — todos textos de AJUDA,
  // sempre presentes — e o bloqueio real (conta incompleta) nem aparecia. Custou
  // duas rodadas perseguindo preco.
  const tela = [
    'Concluída',
    'O tamanho do arquivo do seu livro após a conversão é de 0.04 MB.',
    'Use um formato de preço de 0,00',
    'Defina um preço sugerido entre $2,99-$12,99',
    'O preço sugerido deve ser em múltiplos de 1 INR',
    'Corrija o(s) erro(s) destacado(s) para continuar.',
    'Informações de conta incompletas Você deve preencher as informações de sua conta para publicar itens.',
  ];
  const r = errosQueImportam(tela);
  assert.match(r[0], /conta incompletas/, 'o bloqueio de conta e a causa');
  assert.ok(!r.some(t => /Defina um pre|formato de pre|tamanho do arquivo|^Conclu/.test(t)), JSON.stringify(r));
  assert.ok(r.includes('Corrija o(s) erro(s) destacado(s) para continuar.'), 'erro generico continua, depois');
  assert.strictEqual(ehBloqueioDeConta('Account information is incomplete'), true);
  assert.strictEqual(ehBloqueioDeConta('Adicione uma categoria'), false);
  assert.strictEqual(ehBloqueioDeConta(null), false);
});

test('o robo NAO faz login sozinho no KDP, salvo com a chave escrita de proposito', () => {
  const { podeLogarSozinhoNoKdp } = require('../src/agents/kdpRegras');
  // 30/09/2026: com o .env ainda guardando a conta ANTIGA, o login automatico
  // via tela de entrada com a conta nova, achava "conta errada", clicava em
  // "Trocar contas" e entrava na antiga digitando a senha.
  assert.strictEqual(podeLogarSozinhoNoKdp({}), false, 'padrao: desligado');
  assert.strictEqual(podeLogarSozinhoNoKdp(null), false);
  assert.strictEqual(podeLogarSozinhoNoKdp({ KDP_EMAIL: 'x@y.com', KDP_PASSWORD: 'z' }), false,
    'ter senha no .env NAO liga o login');
  assert.strictEqual(podeLogarSozinhoNoKdp({ KDP_LOGIN_AUTOMATICO: 'true' }), false, 'so o 1 literal liga');
  assert.strictEqual(podeLogarSozinhoNoKdp({ KDP_LOGIN_AUTOMATICO: '0' }), false);
  assert.strictEqual(podeLogarSozinhoNoKdp({ KDP_LOGIN_AUTOMATICO: ' 1 ' }), true);
});
