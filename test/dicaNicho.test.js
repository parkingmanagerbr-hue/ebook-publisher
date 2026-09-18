'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { frasesUteis, escolherLivro, montarLegenda, primeiroComentario, linhasDoCard } = require('../src/agents/dicaNicho');

test('frases uteis: so as praticas, no tamanho do card', () => {
  const texto = [
    'Sumário',
    'Separe um valor fixo todo mês assim que o dinheiro entra, antes de qualquer gasta variável do mês.',
    'Curto demais.',
    'Capítulo 3 — como começar do zero com o que você já tem hoje na sua conta corrente hoje mesmo.',
    'Ganhe 100% a mais garantido, basta usar a planilha e fazer o passo a passo sem esforço nenhum hoje.',
    'Todos os direitos reservados, use a Veloxis Editorial como referência para montar o seu material.',
    'Esta frase é longa o suficiente para o card mas não diz o que fazer, apenas descreve uma situação.',
  ].join('\n');
  const f = frasesUteis(texto);
  assert.strictEqual(f.length, 1);
  assert.ok(f[0].startsWith('Separe um valor fixo'));
  assert.deepStrictEqual(frasesUteis(null), []);
});

const L = (id, extra = {}) => ({ id, title: 'Fundo de Emergência para Autônomos', topic: 'financas', language: 'pt-BR', pdf: '/a.pdf', slug: 'fundo-' + id, ...extra });

test('escolhe livro do nicho, em portugues e com arquivo', () => {
  const livros = [
    L('a'),
    L('b', { language: 'en-US' }),
    L('c', { pdf: null }),
    L('d', { title: 'Receitas de bolo', topic: 'culinaria' }),
  ];
  assert.strictEqual(escolherLivro(livros).id, 'a');
  assert.strictEqual(escolherLivro([]), null);
  assert.strictEqual(escolherLivro(null), null);
});

test('rodizio: o usado ha mais tempo vem primeiro; venda desempata', () => {
  const agora = 1e12;
  const livros = [L('a'), L('b'), L('c', { vendas: 3 })];
  const usados = new Map([['a', agora - 1000], ['b', agora - 99999999]]);
  assert.strictEqual(escolherLivro(livros, usados, agora).id, 'c', 'nunca usado vem antes');
  const usados2 = new Map([['a', agora - 1000], ['b', agora - 99999999], ['c', agora - 500]]);
  assert.strictEqual(escolherLivro(livros, usados2, agora).id, 'b');
});

test('livro unico usado ha menos de 7 dias nao repete', () => {
  const agora = 1e12;
  assert.strictEqual(escolherLivro([L('a')], new Map([['a', agora - 86400000]]), agora), null);
  assert.strictEqual(escolherLivro([L('a')], new Map([['a', agora - 8 * 86400000]]), agora).id, 'a');
});

test('legenda tem a dica, o livro e o link; sem promessa', () => {
  const t = montarLegenda(L('a'), 'Separe 10% assim que receber.');
  assert.ok(t.startsWith('Separe 10% assim que receber.'));
  assert.ok(t.includes('https://veloxisit.com.br/livros/fundo-a/'));
  assert.ok(t.includes('Veloxis Editorial'));
  assert.ok(!/garantid|lucro certo/i.test(t));
  assert.ok(primeiroComentario(L('a')).includes('/livros/fundo-a/'));
});

test('card quebra em linhas curtas sem cortar palavra', () => {
  const linhas = linhasDoCard('Separe um valor fixo todo mes assim que o dinheiro entra', 20);
  assert.ok(linhas.every(l => l.length <= 20));
  assert.strictEqual(linhas.join(' '), 'Separe um valor fixo todo mes assim que o dinheiro entra');
  assert.deepStrictEqual(linhasDoCard(''), []);
  assert.deepStrictEqual(linhasDoCard('palavramuitolongaqueestourao', 5), ['palavramuitolongaqueestourao']);
});

test('limites configuraveis e campos ausentes nao quebram', () => {
  assert.strictEqual(frasesUteis('Use isto.', { min: 5, max: 50 }).length, 1);
  const semTitulo = { id: 'x', topic: 'financas pessoais', language: 'pt-BR', pdf: '/a.pdf', slug: 's' };
  assert.strictEqual(escolherLivro([semTitulo]).id, 'x');
  const semTopico = { id: 'y', title: 'Dívidas no controle', language: 'pt-BR', pdf: '/a.pdf', slug: 's' };
  assert.strictEqual(escolherLivro([semTopico, null]).id, 'y');
  assert.strictEqual(montarLegenda({ title: 't', slug: 's' }, 'd', 'https://x/').includes('https://x/s/'), true);
  assert.ok(primeiroComentario({ title: 't', slug: 's' }, 'https://x/').includes('https://x/s/'));
});

test('sem idioma fica de fora e venda desempata nos dois sentidos', () => {
  const semIdioma = { id: 'z', title: 'Dívidas', pdf: '/a.pdf', slug: 's' };
  assert.strictEqual(escolherLivro([semIdioma]), null);
  const comVenda = { id: 'v', title: 'Dívidas', language: 'pt', pdf: '/a.pdf', slug: 'v', vendas: 2 };
  const semVenda = { id: 'w', title: 'Dívidas', language: 'pt', pdf: '/a.pdf', slug: 'w' };
  assert.strictEqual(escolherLivro([semVenda, comVenda], new Map(), 1e12).id, 'v');
  assert.strictEqual(escolherLivro([comVenda, semVenda], new Map(), 1e12).id, 'v');
});

test('frase cortada no meio nao vira dica (caso do PDF real, 18/09/2026)', () => {
  const cortada = '• Aplicação imediata: escolha uma das ferramentas de controle (planilha, app ou caderno) e';
  assert.deepStrictEqual(frasesUteis(cortada), []);
  const inteira = '• Aplicação imediata: escolha uma das ferramentas de controle e registre o gasto no mesmo dia.';
  const f = frasesUteis(inteira);
  assert.strictEqual(f.length, 1);
  assert.ok(f[0].startsWith('Aplicação imediata'), 'marcador removido');
});

test('frase que so faz sentido dentro do livro fica de fora', () => {
  const fora = 'Faça as pausas de ação: ao final de cada seção há um checklist ou exercício prático para você.';
  assert.deepStrictEqual(frasesUteis(fora), []);
  const ok = 'Separe dez por cento do que entra assim que o pagamento cair na sua conta corrente.';
  assert.strictEqual(frasesUteis(ok).length, 1);
});

test('frase que comeca no meio (quebra do PDF) fica de fora', () => {
  assert.deepStrictEqual(frasesUteis('detalhado dos custos e priorize o que trará retorno imediato no seu caixa.'), []);
  assert.strictEqual(frasesUteis('Priorize o que trará retorno imediato e registre o gasto no mesmo dia da compra.').length, 1);
  assert.strictEqual(frasesUteis('“Anote tudo”: registre o gasto no mesmo dia em que ele acontece, sem exceção.').length, 1);
});

test('sobra de frase anterior (fecha o que nao abriu) fica de fora', () => {
  assert.deepStrictEqual(frasesUteis('Terreno Ideal”) e faça um mapa mental com as prioridades da sua semana inteira.'), []);
  assert.deepStrictEqual(frasesUteis('Ideal) e faça um mapa mental com as prioridades da sua semana de trabalho.'), []);
  assert.strictEqual(frasesUteis('Monte um mapa mental (bem simples) com as prioridades da sua semana inteira.').length, 1);
});

test('marcacao de markdown do PDF sai do texto', () => {
  const f = frasesUteis('Use funções como `=SOMASE` para totalizar as categorias do mês automaticamente.');
  assert.strictEqual(f.length, 1);
  assert.ok(!f[0].includes('`'));
});

test('tema de investimento regulado fica fora do rodizio', () => {
  const cripto = { id: 'k', title: 'Diversificando com Cripto para Conservadores', topic: 'investimentos', language: 'pt-BR', pdf: '/a.pdf', slug: 'k' };
  assert.strictEqual(escolherLivro([cripto]), null);
  const ok = { id: 'o', title: 'Reduza suas dívidas', topic: 'financas', language: 'pt-BR', pdf: '/a.pdf', slug: 'o' };
  assert.strictEqual(escolherLivro([cripto, ok]).id, 'o');
});
