'use strict';
/**
 * Ferramenta de livro: a resposta da IA so vira pagina se passar pela porta.
 * O comprador AGE com base nela — promessa de resultado, numero inventado ou
 * "gerado por IA" derrubam a ferramenta inteira.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { montarPedido, lerEspecificacao, extrairJson, areaSensivel, totalDeAcoes, LIMITES, AVISOS, limpar } =
  require('../src/ferramentas/especificacao');

const livro = { title: 'Fundo de Emergência em 12 Meses', subtitle: 'Guia prático', language: 'pt-BR' };
const cap = (t, n = 3) => ({ titulo: t, resumo: 'Resumo de ' + t, acoes: Array.from({ length: n }, (_, i) => 'Ação ' + (i + 1) + ' de ' + t) });
const boa = { capitulos: [cap('Diagnóstico'), cap('Metas'), cap('Rotina')], habitos: ['Revisar gastos no domingo'] };

test('resposta boa vira especificação completa, com aviso da área', () => {
  const r = lerEspecificacao(JSON.stringify(boa), livro);
  assert.strictEqual(r.ok, true, JSON.stringify(r.motivos));
  assert.strictEqual(r.especificacao.titulo, 'Fundo de Emergência em 12 Meses');
  assert.strictEqual(r.especificacao.capitulos.length, 3);
  assert.strictEqual(totalDeAcoes(r.especificacao), 9);
  assert.strictEqual(r.especificacao.aviso, AVISOS.financas, 'livro de dinheiro leva aviso');
  assert.deepStrictEqual(r.especificacao.habitos, ['Revisar gastos no domingo']);
});

test('o JSON é achado mesmo com cerca de código e texto em volta', () => {
  const r = lerEspecificacao('Aqui está:\n```json\n' + JSON.stringify(boa) + '\n```\nEspero ter ajudado', livro);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(extrairJson('sem json nenhum'), null);
  assert.strictEqual(extrairJson('{quebrado'), null);
  assert.strictEqual(extrairJson('{ "a": }'), null);
  assert.strictEqual(extrairJson(null), null);
});

test('PROMESSA DE RESULTADO derruba a ferramenta inteira', () => {
  for (const frase of [
    'Resultado garantido em 30 dias',
    'Fature R$ 5.000 no primeiro mês',
    'Garantimos que você sai das dívidas',
    'Método 100% eficaz',
  ]) {
    const ruim = { capitulos: [cap('Capítulo A'), cap('Capítulo B'), { titulo: 'Capítulo C', resumo: 'x', acoes: ['Passo um aqui', frase] }] };
    const r = lerEspecificacao(JSON.stringify(ruim), livro);
    assert.strictEqual(r.ok, false, frase);
    assert.match(r.motivos.join(' '), /conteúdo proibido/);
  }
});

test('falar de si como IA derruba (pedido do dono: nada de "feito com IA")', () => {
  const ruim = { capitulos: [cap('Capítulo A'), cap('Capítulo B'), cap('Capítulo C')], habitos: ['Como uma IA, recomendo revisar'] };
  assert.strictEqual(lerEspecificacao(JSON.stringify(ruim), livro).ok, false);
  const ruim2 = { capitulos: [cap('Capítulo A'), cap('Capítulo B'), { titulo: 'Plano gerado por IA', resumo: 'x', acoes: ['Um passo', 'Outro passo'] }] };
  assert.strictEqual(lerEspecificacao(JSON.stringify(ruim2), livro).ok, false);
});

test('tema de IA no livro NAO é proibido — só falar de si como IA', () => {
  const ok = { capitulos: [cap('Ferramentas de IA para freelancers'), cap('Capítulo B'), cap('Capítulo C')] };
  assert.strictEqual(lerEspecificacao(JSON.stringify(ok), { title: 'Ganhe tempo com IA' }).ok, true);
});

test('poucos capítulos ou capítulos sem ações suficientes: recusa', () => {
  const pouco = { capitulos: [cap('Capítulo A'), cap('Capítulo B')] };
  const r = lerEspecificacao(JSON.stringify(pouco), livro);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivos[0], /mínimo 3/);
  const ralo = { capitulos: [cap('Capítulo A'), cap('Capítulo B'), cap('Capítulo C', 1)] };
  assert.strictEqual(lerEspecificacao(JSON.stringify(ralo), livro).ok, false, 'capítulo com 1 ação não conta');
  assert.strictEqual(lerEspecificacao('{"capitulos":"não é lista"}', livro).ok, false);
  assert.strictEqual(lerEspecificacao('{}', livro).ok, false);
  assert.strictEqual(lerEspecificacao('', livro).ok, false);
});

test('lixo dentro das listas é ignorado sem derrubar o resto', () => {
  const misto = {
    capitulos: [null, 'texto', cap('Capítulo A'), cap('Capítulo B'), cap('Capítulo C'), { titulo: 'x', acoes: ['Um passo', 'Outro passo'] }],
    habitos: ['ok', null, 'Caminhar 20 minutos', 42],
  };
  const r = lerEspecificacao(JSON.stringify(misto), livro);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.especificacao.capitulos.length, 3, 'título curto demais fica de fora');
  assert.deepStrictEqual(r.especificacao.habitos, ['Caminhar 20 minutos']);
});

test('tetos: capítulos, ações e tamanhos respeitam os limites', () => {
  const muito = {
    capitulos: Array.from({ length: 20 }, (_, i) => cap('Capítulo ' + i, 9)),
    habitos: Array.from({ length: 15 }, (_, i) => 'Hábito número ' + i),
  };
  const r = lerEspecificacao(JSON.stringify(muito), livro);
  assert.strictEqual(r.especificacao.capitulos.length, LIMITES.capitulosMax);
  assert.strictEqual(r.especificacao.capitulos[0].acoes.length, LIMITES.acoesMax);
  assert.strictEqual(r.especificacao.habitos.length, LIMITES.habitosMax);
  assert.strictEqual(limpar('x'.repeat(500), 10).length, 10);
});

test('texto com quebra e caractere de controle vira uma linha limpa', () => {
  assert.strictEqual(limpar('linha\num\t\u0007dois  ', 50), 'linha um dois');
  assert.strictEqual(limpar(null, 5), '');
});

test('área sensível: saúde, finanças, direito — e livro comum sem aviso', () => {
  assert.strictEqual(areaSensivel({ title: 'Low-Carb para Quem Vive em Turnos' }), 'saude');
  assert.strictEqual(areaSensivel({ title: 'Reduza suas Dívidas' }), 'financas');
  assert.strictEqual(areaSensivel({ titulo: 'Guia de Documentos para Adoção Internacional' }), 'direito');
  assert.strictEqual(areaSensivel({ title: 'Estúdio Caseiro: Gravações' }), null);
  assert.strictEqual(areaSensivel(null), null);
  const r = lerEspecificacao(JSON.stringify(boa), { title: 'Estúdio Caseiro' });
  assert.strictEqual(r.especificacao.aviso, null, 'livro sem risco não ganha aviso de enfeite');
});

test('o pedido leva as regras, o título e o texto cortado', () => {
  const p = montarPedido(livro, 'palavra '.repeat(5000), { maxTexto: 100 });
  assert.match(p, /Não invente números/);
  assert.match(p, /CADA capítulo do sumário/);
  assert.match(p, /Não fale de você, de IA/);
  assert.match(p, /Fundo de Emergência em 12 Meses/);
  assert.ok(p.length < 1500, 'texto do livro foi cortado');
  assert.match(montarPedido(null, null), /Título do livro: /);
});

test('título de capítulo curto demais não vira capítulo', () => {
  const curtos = { capitulos: [cap('A'), cap('Bb'), cap('Capítulo válido'), cap('Outro válido'), cap('Mais um válido')] };
  const r = lerEspecificacao(JSON.stringify(curtos), livro);
  assert.strictEqual(r.especificacao.capitulos.length, 3, 'A e Bb ficam de fora');
});

test('livro sem título/subtítulo e com nomes em português ainda monta a página', () => {
  const r = lerEspecificacao(JSON.stringify(boa), null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.especificacao.titulo, '');
  assert.strictEqual(r.especificacao.idioma, 'pt-BR', 'sem idioma, português');
  const r2 = lerEspecificacao(JSON.stringify(boa), { titulo: 'Casa Sem Plástico', subtitulo: 'Estratégias', idioma: 'es-ES' });
  assert.strictEqual(r2.especificacao.titulo, 'Casa Sem Plástico');
  assert.strictEqual(r2.especificacao.subtitulo, 'Estratégias');
  assert.strictEqual(r2.especificacao.idioma, 'es-ES');
});

test('capítulo sem lista de ações não quebra, e contar ações tolera entrada torta', () => {
  const semAcoes = { capitulos: [{ titulo: 'Capítulo sem ações' }, cap('Capítulo 1'), cap('Capítulo 2'), cap('Capítulo 3')] };
  assert.strictEqual(lerEspecificacao(JSON.stringify(semAcoes), livro).especificacao.capitulos.length, 3);
  assert.strictEqual(totalDeAcoes(null), 0);
  assert.strictEqual(totalDeAcoes({ capitulos: [null, { acoes: null }, { acoes: ['a', 'b'] }] }), 2);
});

test('a amostra cobre o livro INTEIRO, não só o começo', () => {
  const { amostraDoLivro } = require('../src/ferramentas/especificacao');
  // 30/09/2026: mandando os primeiros 12 mil caracteres, o plano saiu com 3
  // capítulos de um livro de 7 — a IA só via o sumário e o começo.
  const livroLongo = Array.from({ length: 7 }, (_, i) => ('CAPITULO' + (i + 1) + ' ').repeat(2000)).join('');
  const a = amostraDoLivro(livroLongo, 24000);
  assert.ok(a.length <= 24000 + 8 * 6, 'cabe no orçamento');
  for (let i = 1; i <= 7; i++) assert.ok(a.includes('CAPITULO' + i), 'capítulo ' + i + ' presente');
  assert.ok(a.startsWith('CAPITULO1'), 'o começo (sumário) fica');
});

test('livro curto vai inteiro, e entrada vazia não quebra', () => {
  const { amostraDoLivro } = require('../src/ferramentas/especificacao');
  assert.strictEqual(amostraDoLivro('texto   curto\n\ncom quebras', 24000), 'texto curto com quebras');
  assert.strictEqual(amostraDoLivro(null), '');
  assert.ok(amostraDoLivro('x'.repeat(1000), 100, 0).length <= 120, 'zero janelas vira uma');
});
