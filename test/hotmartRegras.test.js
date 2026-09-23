'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { getCategoryPT, digitosDoPreco, idProdutoDaUrl, norm } = require('../src/agents/hotmartRegras');

const TEC = 'Tecnologia e Programacao', SAUDE = 'Saude e Esportes', NEG = 'Negocios e Carreira', DP = 'Desenvolvimento Pessoal';

// ── Categoria ───────────────────────────────────────────────────────────────

test('palavra-chave curta dentro de outra palavra nao decide a categoria (o defeito real)', () => {
  // "aprenda" contem "renda", "relacoes" contem "acoes", "profundo" contem
  // "fundo", "acredito" contem "credito", "fundamental" contem "mental",
  // "expressao" contem "pressao". Todos iam para a categoria errada.
  for (const t of ['Aprenda a Desenhar Retratos', 'Relações Amorosas Saudáveis', 'O Poder do Pensamento Profundo', 'Eu Acredito em Mim']) {
    assert.strictEqual(getCategoryPT(t), DP, t);
  }
  assert.strictEqual(getCategoryPT('Meditações Guiadas'), DP, '"meditacoes" nao e "acoes"');
  assert.strictEqual(getCategoryPT('Guia Fundamental da Culinária'), DP);
  assert.strictEqual(getCategoryPT('Expressão Corporal no Palco'), DP);
});

test('sigla IA vale como palavra, inclusive no inicio e com pontuacao', () => {
  assert.strictEqual(getCategoryPT('IA para Iniciantes'), TEC);
  assert.strictEqual(getCategoryPT('Guia: IA, ChatGPT e voce'), TEC);
  assert.strictEqual(getCategoryPT('Receitas da Tia Maria'), DP, '"tia" nao e IA');
  assert.strictEqual(getCategoryPT('Estratégias de Estudo'), NEG, '"estrategias" casa estrategia, nao IA');
});

test('palavra-chave casa no inicio da palavra, com acento e plural (controle)', () => {
  assert.strictEqual(getCategoryPT('Renda Extra em Casa'), NEG);
  assert.strictEqual(getCategoryPT('Ações e Dividendos'), NEG);
  assert.strictEqual(getCategoryPT('Fundos Imobiliários'), NEG);
  assert.strictEqual(getCategoryPT('Saúde Mental no Trabalho'), SAUDE);
  assert.strictEqual(getCategoryPT('Pressão Alta sem Remédio'), SAUDE);
  assert.strictEqual(getCategoryPT('Inteligência Artificial no Dia a Dia'), TEC);
  assert.strictEqual(getCategoryPT('Finanças Pessoais'), NEG);
  assert.strictEqual(getCategoryPT('Clientes Fiéis'), NEG);
});

test('palavra-chave longa continua valendo dentro de palavra composta', () => {
  assert.strictEqual(getCategoryPT('Guia do Microempreendedor'), NEG);
  assert.strictEqual(getCategoryPT('Neuromarketing Aplicado'), NEG);
  assert.strictEqual(getCategoryPT('Superalimentação'), SAUDE);
});

test('ordem de prioridade: tecnologia, saude, financas, negocios; topico tambem conta', () => {
  assert.strictEqual(getCategoryPT('Python para Investimentos'), TEC);
  assert.strictEqual(getCategoryPT('Dieta e Dinheiro'), SAUDE);
  assert.strictEqual(getCategoryPT('Bitcoin para Empreendedores'), NEG);
  assert.strictEqual(getCategoryPT('Um livro', 'marketing digital'), TEC, '"digital" e tecnologia e vem antes');
  assert.strictEqual(getCategoryPT('Um livro', 'yoga'), SAUDE);
});

test('titulo vazio, ausente ou sem latim cai em Desenvolvimento Pessoal', () => {
  assert.strictEqual(getCategoryPT(''), DP);
  assert.strictEqual(getCategoryPT(undefined, undefined), DP);
  assert.strictEqual(getCategoryPT('睡眠の科学'), DP);
});

test('norm tira acento e caixa e tolera vazio', () => {
  assert.strictEqual(norm('ÁÇÃO Ñ'), 'acao n');
  assert.strictEqual(norm(null), '');
});

// ── Preco ───────────────────────────────────────────────────────────────────

test('preco sem centavos nao vira centavos na mascara da Hotmart', () => {
  // A mascara desloca da direita: digitar "5" da R$ 0,05.
  assert.strictEqual(digitosDoPreco('5'), '500');
  assert.strictEqual(digitosDoPreco('30'), '3000');
  assert.strictEqual(digitosDoPreco('29.9'), '2990');
  assert.strictEqual(digitosDoPreco('29,9'), '2990');
});

test('preco com centavos em qualquer formato (controle: producao usa "5,00")', () => {
  assert.strictEqual(digitosDoPreco('5,00'), '500');
  assert.strictEqual(digitosDoPreco('4,99'), '499');
  assert.strictEqual(digitosDoPreco('4.99'), '499');
  assert.strictEqual(digitosDoPreco('R$ 12,50'), '1250');
  assert.strictEqual(digitosDoPreco('1.299,90'), '129990');
  assert.strictEqual(digitosDoPreco('0,99'), '99');
  assert.strictEqual(digitosDoPreco(',99'), '99', 'preco escrito sem a parte inteira');
  assert.strictEqual(digitosDoPreco(5), '500', 'aceita numero, nao so texto');
});

test('preco ausente ou sem digito nao vira preco nenhum (nada e digitado)', () => {
  for (const v of ['', null, undefined, 'R$', ',', 'gratis']) assert.strictEqual(digitosDoPreco(v), '', JSON.stringify(v));
});

// ── Id do produto na URL ────────────────────────────────────────────────────

test('id do produto sai das quatro formas de URL, na ordem de confianca', () => {
  assert.strictEqual(idProdutoDaUrl('https://app.hotmart.com/products/manage/8419962/info'), '8419962');
  assert.strictEqual(idProdutoDaUrl('https://app.hotmart.com/products/add/4/pricing/123'), '123');
  assert.strictEqual(idProdutoDaUrl('https://app.hotmart.com/x?tab=1&productId=77'), '77');
  assert.strictEqual(idProdutoDaUrl('https://app.hotmart.com/club/8483671?x=1'), '8483671');
  assert.strictEqual(idProdutoDaUrl('https://app.hotmart.com/a/1234567/b'), '1234567');
  assert.strictEqual(idProdutoDaUrl('https://app.hotmart.com/products/manage/1/x?productId=2'), '1', 'manage vem antes');
});

test('URL sem id (login, wizard no inicio, numero curto) devolve null', () => {
  for (const u of ['https://sso.hotmart.com/login', 'https://app.hotmart.com/products/add', 'https://app.hotmart.com/p/123456', '']) {
    assert.strictEqual(idProdutoDaUrl(u), null, u);
  }
});

// ── Produto certo antes de mandar o arquivo (22/09/2026) ────────────────────
const { mesmoProduto, motivoProdutoErrado, umaLinha, ehAvisoDeTermos, ehBotaoDeAviso } = require('../src/agents/hotmartRegras');

test('produto de nome diferente nao recebe o arquivo (caso 8452258)', () => {
  assert.strictEqual(mesmoProduto('Orçamento de Viagem de Luxo Gastando Pouco', 'Fundo de Emergência para Autônomos'), false);
  assert.strictEqual(mesmoProduto('Fundo de Emergência para Autônomos', 'Fundo de Emergência para Autônomos'), true);
});

test('acento, caixa e espaco a mais nao reprovam o mesmo produto', () => {
  assert.strictEqual(mesmoProduto('  FUNDO  de Emergência ', 'Fundo de Emergência'), true);
  assert.strictEqual(mesmoProduto('Fundo de Emergencia', 'Fundo de Emergência'), false, 'sem acento e outro titulo');
});

test('sem resposta da API o envio segue (consulta que falhou nao bloqueia)', () => {
  for (const vazio of [null, undefined, '', '   ']) assert.strictEqual(mesmoProduto(vazio, 'Qualquer Livro'), true);
  assert.strictEqual(mesmoProduto('Algum Livro', null), false, 'titulo vazio com nome no ar = produto errado');
});

test('motivo do bloqueio cabe em uma linha de log e nao forja outra', () => {
  const m = motivoProdutoErrado('8452258', 'Orçamento de Viagem\nINFO: tudo certo', 'Fundo de Emergência');
  assert.ok(m.startsWith('PRODUTO_ERRADO: id 8452258'));
  assert.ok(!m.includes('\n'), 'quebra de linha vinda do nome forjaria uma linha de log');
  assert.ok(m.includes('Fundo de Emergência'));
  assert.strictEqual(umaLinha('a\r\nb\tc', 60), 'a b c');
  assert.strictEqual(umaLinha(null), '');
  assert.strictEqual(umaLinha('abcdef', 3), 'abc');
});

// ── Aviso de termos por cima do wizard ──────────────────────────────────────
test('aviso de termos so conta com o texto E o botao', () => {
  assert.strictEqual(ehAvisoDeTermos('Nossos Termos foram atualizados. Leia. OK, Entendi'), true);
  assert.strictEqual(ehAvisoDeTermos('Termo de Uso Ético da Hotmart. Concordo'), true);
  assert.strictEqual(ehAvisoDeTermos('Nossos Termos foram atualizados. Leia mais.'), false, 'sem botao nao e o aviso');
  assert.strictEqual(ehAvisoDeTermos('Cadastrar eBook. Aceitar'), false, 'so o botao nao e o aviso');
  assert.strictEqual(ehAvisoDeTermos(null), false);
});

test('botao do aviso: so o que fecha, nao "Aceitar pagamento"', () => {
  for (const t of ['OK, Entendi', 'ok entendi', 'Entendi', 'Aceitar', 'Concordo']) assert.strictEqual(ehBotaoDeAviso(t), true, t);
  for (const t of ['Aceitar pagamento por Pix', 'Cadastrar eBook', 'Não concordo com nada', '', null]) assert.strictEqual(ehBotaoDeAviso(t), false, String(t));
});

// ── Rotulo do resultado da publicacao ───────────────────────────────────────
const { rotuloDoResultado, detalheDoResultado } = require('../src/agents/hotmartRegras');

test('rascunho nao e falha: o produto existe e so falta finalizar', () => {
  assert.strictEqual(rotuloDoResultado({ url: 'https://hotmart.com/product/1', hotmartProductId: '1' }), 'OK');
  assert.strictEqual(rotuloDoResultado({ hotmartProductId: '8419962' }), 'RASCUNHO');
  assert.strictEqual(rotuloDoResultado({ error: 'Pricing save timeout' }), 'FALHA');
  assert.strictEqual(rotuloDoResultado(null), 'FALHA');
  assert.strictEqual(rotuloDoResultado({}), 'FALHA');
});

test('o detalhe explica o que aconteceu, em uma linha', () => {
  assert.strictEqual(detalheDoResultado({ url: 'https://hotmart.com/product/1' }), 'https://hotmart.com/product/1');
  assert.strictEqual(detalheDoResultado({ hotmartProductId: '8419962' }), 'produto 8419962 criado, aguardando finalizacao');
  assert.strictEqual(detalheDoResultado({ error: 'wizard\nnot rendered' }), 'wizard not rendered', 'sem quebra de linha no log');
  assert.strictEqual(detalheDoResultado(null), 'sem url');
});
