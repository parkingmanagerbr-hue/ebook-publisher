'use strict';
/**
 * ofertaViral: os quatro elementos do metodo publico de produto viral de baixo
 * ticket (Hotmart Cast #229), aplicados ao nosso catalogo de R$ 5.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { pontuarOferta, porNotaDeOferta, resumoDaNota } = require('../src/agents/ofertaViral');

test('oferta forte: resultado claro, facil e rapido', () => {
  const p = pontuarOferta({
    titulo: 'Pare de Perder Dinheiro: Guia Definitivo para Organizar suas Contas em 7 Dias',
    descricao: 'Passo a passo simples, do zero, sem experiencia. Resultado em 7 dias.',
  });
  assert.ok(p.desejo >= 7, 'desejo ' + p.desejo);
  assert.ok(p.capacidade >= 7, 'capacidade ' + p.capacidade);
  assert.ok(p.esforco <= 3, 'esforco baixo e bom: ' + p.esforco);
  assert.ok(p.tempo <= 3, 'prazo curto: ' + p.tempo);
  assert.ok(p.nota >= 8, 'nota ' + p.nota);
  assert.deepStrictEqual(p.sugestoes, []);
});

test('oferta fraca: titulo vago, sem prazo e cheirando a trabalho', () => {
  const p = pontuarOferta({
    titulo: 'Reflexoes sobre Financas Pessoais',
    descricao: 'Um estudo aprofundado que exige disciplina e dedicacao ao longo do ano.',
  });
  assert.ok(p.nota <= 5, 'nota ' + p.nota);
  assert.ok(p.esforco >= 6, 'o texto promete trabalho: ' + p.esforco);
  assert.ok(p.tempo >= 6, 'sem prazo curto: ' + p.tempo);
  assert.ok(p.sugestoes.length >= 2, JSON.stringify(p.sugestoes));
  assert.ok(p.sugestoes.some(s => s.startsWith('esforco')));
});

test('o titulo pesa mais que a descricao (e o que aparece na vitrine)', () => {
  const soNaDescricao = pontuarOferta({ titulo: 'Financas em Ordem', descricao: 'Guia definitivo, passo a passo, descubra como economizar.' });
  const noTitulo = pontuarOferta({ titulo: 'Guia Definitivo: Descubra Como Economizar Passo a Passo', descricao: 'Financas em ordem.' });
  assert.ok(noTitulo.desejo > soNaDescricao.desejo, noTitulo.desejo + ' vs ' + soNaDescricao.desejo);
});

test('prazo em meses nao e prazo curto', () => {
  const curto = pontuarOferta({ titulo: 'Emagreca em 30 dias' });
  const longo = pontuarOferta({ titulo: 'Emagreca em 6 meses' });
  assert.ok(curto.tempo < longo.tempo);
  assert.ok(curto.nota > longo.nota);
});

test('acento e caixa nao mudam a nota', () => {
  const a = pontuarOferta({ titulo: 'GUIA DEFINITIVO: Organize suas Contas em 7 Dias' });
  const b = pontuarOferta({ titulo: 'guia definitivo: organize suas contas em 7 dias' });
  assert.deepStrictEqual(a, b);
});

test('entrada vazia nao quebra e cai na nota baixa', () => {
  const p = pontuarOferta({});
  assert.ok(p.nota >= 1 && p.nota <= 10);
  assert.deepStrictEqual(pontuarOferta(), pontuarOferta({ titulo: '', descricao: '' }));
  assert.ok(pontuarOferta(null).sugestoes.length >= 2);
});

test('a fila sai com a melhor oferta na frente', () => {
  const livros = [
    { id: 'fraco', titulo: 'Reflexoes sobre habitos', descricao: 'Estudo aprofundado que exige disciplina.' },
    { id: 'forte', titulo: 'Pare de Procrastinar: Metodo Simples em 7 Dias', descricao: 'Passo a passo do zero.' },
    { id: 'medio', titulo: 'Organize sua Rotina', descricao: 'Guia pratico.' },
  ];
  const ordem = porNotaDeOferta(livros).map(x => x.livro.id);
  assert.strictEqual(ordem[0], 'forte');
  assert.strictEqual(ordem[2], 'fraco');
  assert.deepStrictEqual(porNotaDeOferta([]), []);
  assert.deepStrictEqual(porNotaDeOferta(null), []);
  assert.strictEqual(porNotaDeOferta([null, livros[0]]).length, 1, 'item nulo e ignorado');
});

test('ordenar nao mexe na lista original', () => {
  const livros = [{ titulo: 'a' }, { titulo: 'Guia Definitivo em 7 dias' }];
  const copia = [...livros];
  porNotaDeOferta(livros);
  assert.deepStrictEqual(livros, copia);
});

test('log de uma linha, sem quebra vinda do titulo', () => {
  const p = pontuarOferta({ titulo: 'Guia Definitivo em 7 Dias' });
  const linha = resumoDaNota('Guia\nDefinitivo', p);
  assert.ok(!/[\r\n]/.test(linha));
  assert.match(linha, /nota=\d+ \(desejo \d+, capacidade \d+, esforco \d+, tempo \d+\)/);
  assert.match(resumoDaNota(null, null), /nota=undefined/);
});

test('titulo em outro idioma nao recebe nota (os padroes sao em portugues)', () => {
  const alemao = pontuarOferta({ titulo: 'Zapier für Performance-Marketing-Agenturen', language: 'de' });
  assert.strictEqual(alemao.aplicavel, false);
  assert.strictEqual(alemao.nota, null);
  assert.deepStrictEqual(alemao.sugestoes, [], 'nao sugere ajuste no que nao sabe medir');
  const chines = pontuarOferta({ titulo: '电竞选手视力保护指南', idioma: 'zh-CN' });
  assert.strictEqual(chines.aplicavel, false);
  const portugues = pontuarOferta({ titulo: 'Guia Definitivo em 7 Dias', language: 'pt-BR' });
  assert.strictEqual(portugues.aplicavel, true);
  assert.ok(portugues.nota >= 7);
  assert.strictEqual(pontuarOferta({ titulo: 'Guia Definitivo em 7 Dias' }).aplicavel, true, 'sem idioma, assume portugues');
});

test('livro de outro idioma nao e jogado para o fim da fila', () => {
  const lista = [
    { id: 'fraco-pt', titulo: 'Reflexoes sobre habitos', language: 'pt-BR' },
    { id: 'alemao', titulo: 'Zapier für Agenturen', language: 'de' },
    { id: 'forte-pt', titulo: 'Pare de Procrastinar: Guia Simples em 7 Dias', language: 'pt-BR' },
  ];
  const ordem = porNotaDeOferta(lista).map(x => x.livro.id);
  assert.strictEqual(ordem[0], 'forte-pt');
  assert.strictEqual(ordem[1], 'alemao', 'sem nota, fica no meio — nao penalizado');
  assert.strictEqual(ordem[2], 'fraco-pt');
});
