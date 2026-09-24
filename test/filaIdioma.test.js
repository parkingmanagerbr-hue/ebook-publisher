'use strict';
/**
 * filaIdioma: 3.641 livros estrangeiros estavam parados atras da fila em
 * portugues. A regra reserva parte das vagas para eles, em rodizio.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { filaDaRodada, resumoDaFila, ehPortugues, base } = require('../src/core/filaIdioma');

const L = (id, language) => ({ id, language });
const CATALOGO = [
  L('p1', 'pt-BR'), L('p2', 'pt-BR'), L('p3', 'pt'), L('p4', 'PT_BR'), L('p5', 'pt-BR'), L('p6', 'pt-BR'),
  L('e1', 'en-US'), L('e2', 'en-US'), L('e3', 'en'),
  L('s1', 'es'), L('s2', 'es-MX'),
  L('j1', 'ja-JP'),
];

test('idioma normaliza variante e regiao', () => {
  assert.strictEqual(base('pt-BR'), 'pt');
  assert.strictEqual(base('PT_br'), 'pt');
  assert.strictEqual(base('  en-US '), 'en');
  assert.strictEqual(base(null), '');
  assert.strictEqual(ehPortugues('pt-BR'), true);
  assert.strictEqual(ehPortugues('ptBR'), false, 'sem separador nao e o nosso formato');
  assert.strictEqual(ehPortugues('es'), false);
});

test('portugues fica com a maioria, mas estrangeiro sempre entra', () => {
  const fila = filaDaRodada(CATALOGO, 10, { fatiaEstrangeira: 0.4 });
  assert.strictEqual(fila.length, 10);
  const fora = fila.filter(l => !ehPortugues(l.language));
  assert.strictEqual(fora.length, 4, '40% das vagas');
  assert.strictEqual(fila.filter(l => ehPortugues(l.language)).length, 6);
});

test('rodizio: idiomas diferentes em rodadas diferentes', () => {
  const r0 = filaDaRodada(CATALOGO, 5, { fatiaEstrangeira: 0.4, rodada: 0 }).filter(l => !ehPortugues(l.language));
  const r1 = filaDaRodada(CATALOGO, 5, { fatiaEstrangeira: 0.4, rodada: 1 }).filter(l => !ehPortugues(l.language));
  // idiomas em ordem: en, es, ja — a rodada gira por onde o rodizio comeca
  assert.deepStrictEqual(r0.map(l => l.id), ['e1', 's1'], 'rodada 0 comeca em en');
  assert.deepStrictEqual(r1.map(l => l.id), ['s1', 'j1'], 'rodada 1 comeca em es');
  const r2 = filaDaRodada(CATALOGO, 5, { fatiaEstrangeira: 0.4, rodada: 2 }).filter(l => !ehPortugues(l.language));
  assert.deepStrictEqual(r2.map(l => l.id), ['j1', 'e1'], 'rodada 2 comeca em ja e volta para en');
});

test('um idioma nao leva todas as vagas estrangeiras', () => {
  const fila = filaDaRodada(CATALOGO, 10, { fatiaEstrangeira: 0.6 });
  const idiomas = new Set(fila.filter(l => !ehPortugues(l.language)).map(l => base(l.language)));
  assert.ok(idiomas.size >= 3, 'en, es e ja aparecem: ' + [...idiomas].join(','));
});

test('sem estrangeiro no catalogo, portugues leva tudo', () => {
  const so = [L('p1', 'pt-BR'), L('p2', 'pt-BR')];
  assert.deepStrictEqual(filaDaRodada(so, 5).map(l => l.id), ['p1', 'p2']);
});

test('so estrangeiro: as vagas de portugues nao ficam vazias', () => {
  const so = [L('e1', 'en'), L('e2', 'en'), L('s1', 'es')];
  const fila = filaDaRodada(so, 3, { fatiaEstrangeira: 0.4 });
  assert.strictEqual(fila.length, 1, 'so a fatia estrangeira e usada quando nao ha pt');
  assert.deepStrictEqual(filaDaRodada(so, 3, { fatiaEstrangeira: 1 }).map(l => l.id).sort(), ['e1', 'e2', 's1']);
});

test('limites bobos nao quebram', () => {
  assert.deepStrictEqual(filaDaRodada(CATALOGO, 0), []);
  assert.deepStrictEqual(filaDaRodada(CATALOGO, -3), []);
  assert.deepStrictEqual(filaDaRodada(CATALOGO, 'x'), []);
  assert.deepStrictEqual(filaDaRodada([], 5), []);
  assert.deepStrictEqual(filaDaRodada(null, 5), []);
  assert.strictEqual(filaDaRodada(CATALOGO, 4, { fatiaEstrangeira: -1 }).every(l => ehPortugues(l.language)), true);
  assert.strictEqual(filaDaRodada(CATALOGO, 4, { fatiaEstrangeira: 5 }).every(l => !ehPortugues(l.language)), true);
  assert.strictEqual(filaDaRodada(CATALOGO, 4, { rodada: -7 }).length, 4, 'rodada negativa nao quebra o rodizio');
  assert.strictEqual(filaDaRodada(CATALOGO, 4, { fatiaEstrangeira: 'abc' }).every(l => ehPortugues(l.language)), true, 'fatia invalida = so portugues');
  assert.strictEqual(filaDaRodada([null, L('p1', 'pt')], 2).length, 1, 'item nulo e ignorado');
});

test('livro sem idioma conta como estrangeiro, e aparece no resumo', () => {
  const fila = filaDaRodada([L('x', null), L('p1', 'pt')], 2, { fatiaEstrangeira: 0.5 });
  assert.strictEqual(fila.length, 2);
  assert.strictEqual(resumoDaFila(fila), '?? =1 pt=1'.replace('?? ', '??'));
  assert.strictEqual(resumoDaFila([]), '');
  assert.strictEqual(resumoDaFila(null), '');
});

test('fatia estrangeira maior que o catalogo nao entra em laco infinito', () => {
  // vagasFora pediria mais do que existe: o laco precisa parar quando acabam os livros
  const so = [L('e1', 'en'), L('s1', 'es')];
  const fila = filaDaRodada(so, 100, { fatiaEstrangeira: 1 });
  assert.deepStrictEqual(fila.map(l => l.id).sort(), ['e1', 's1']);
  assert.strictEqual(filaDaRodada([L('p1', 'pt')], 100, { fatiaEstrangeira: 0.5 }).length, 1);
});

test('catalogo que nao e lista tambem devolve fila vazia', () => {
  assert.deepStrictEqual(filaDaRodada('nao e lista', 5), []);
  assert.deepStrictEqual(filaDaRodada({ 0: L('p', 'pt') }, 5), []);
});

test('REGRESSAO: titulo repetido no lote virava produto duplicado na loja', () => {
  const { semTitulosRepetidos } = require('../src/core/filaIdioma');
  const lote = [
    { id: 'a', title: 'Alimentação Anti-inflamatória', language: 'pt-BR' },
    { id: 'b', title: 'alimentação anti-inflamatória ', language: 'pt-BR' },
    { id: 'c', title: 'Outro Livro', language: 'pt-BR' },
  ];
  assert.deepStrictEqual(semTitulosRepetidos(lote).map(l => l.id), ['a', 'c']);
  // e a fila da rodada ja entrega sem repetidos
  const fila = filaDaRodada(lote.concat([{ id: 'd', title: 'Alimentação Anti-inflamatória', language: 'en' }]), 4, { fatiaEstrangeira: 0.5 });
  const titulos = fila.map(l => String(l.title).toLowerCase().trim());
  assert.strictEqual(new Set(titulos).size, titulos.length, 'nenhum titulo repetido: ' + titulos.join(' | '));
});

test('livro sem titulo nao e descartado por engano', () => {
  const { semTitulosRepetidos } = require('../src/core/filaIdioma');
  const r = semTitulosRepetidos([{ id: 'x' }, { id: 'y' }, null, { id: 'z', title: '' }]);
  assert.deepStrictEqual(r.map(l => l.id), ['x', 'y', 'z']);
  assert.deepStrictEqual(semTitulosRepetidos(null), []);
});
