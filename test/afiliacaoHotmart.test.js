'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nota, selecionarDestaques, planejar, texto, COMISSAO_PADRAO, COMISSAO_DESTAQUE } = require('../scripts/afiliacaoHotmart');

const neg = { categoria: 'Negocios e Carreira', saude: false };

test('venda real pesa mais que capa e categoria', () => {
  const comVenda = nota({ language: 'pt-BR', vendas_reais: 1 }, { categoria: 'Desenvolvimento Pessoal', saude: false });
  const semVenda = nota({ language: 'pt-BR', vendas_reais: 0, capa_viral: 1 }, neg);
  assert.ok(comVenda > semVenda);
});

test('saude e idioma estrangeiro nunca viram destaque (controle)', () => {
  assert.strictEqual(nota({ language: 'pt-BR', vendas_reais: 9 }, { categoria: 'Saude e Esportes', saude: false }), -Infinity);
  assert.strictEqual(nota({ language: 'pt-BR', vendas_reais: 9 }, { categoria: 'Negocios e Carreira', saude: true }), -Infinity);
  assert.strictEqual(nota({ language: 'ja-JP', vendas_reais: 9 }, neg), -Infinity);
  assert.strictEqual(nota({ language: undefined }, neg), -Infinity);
});

test('seleciona os N melhores, desempatando pelo mais recente', () => {
  const livros = [
    { produto: 'a', language: 'pt-BR', ordem: 1 },
    { produto: 'b', language: 'pt-BR', ordem: 2 },
    { produto: 'c', language: 'pt-BR', ordem: 3, vendas_reais: 1 },
    { produto: 'd', language: 'en-US', ordem: 4, vendas_reais: 5 },
  ];
  assert.deepStrictEqual(selecionarDestaques(livros, () => neg, 2), ['c', 'b']);
  assert.deepStrictEqual(selecionarDestaques(livros, () => neg).length, 3, 'estrangeiro fica de fora mesmo com vaga');
});

test('planejar: destaque 70%, resto 50%, e nada a fazer quando ja esta assim', () => {
  assert.deepStrictEqual(planejar({ affiliationType: 'NO_ONE', commission: 0 }, false), { affiliationType: 'ANYONE', commission: COMISSAO_PADRAO });
  assert.deepStrictEqual(planejar({ affiliationType: 'ANYONE', commission: 50 }, true), { affiliationType: 'ANYONE', commission: COMISSAO_DESTAQUE });
  assert.strictEqual(planejar({ affiliationType: 'ANYONE', commission: 50 }, false), null);
  assert.strictEqual(planejar({ affiliationType: 'ANYONE', commission: '70' }, true), null);
  assert.deepStrictEqual(planejar(null, false), { affiliationType: 'ANYONE', commission: 50 });
});

test('texto do programa cita a comissao certa e nao promete resultado', () => {
  assert.match(texto(70), /Comissão de 70%/);
  assert.doesNotMatch(texto(50), /garantid[oa] (de|seu)|ganhe R\$|\d+ vendas/i);
  assert.ok(texto(50).length < 2000, 'limite do campo no painel');
});

test('filtro extra de saude pega o caso real e nao acusa financas (controle)', () => {
  const { SAUDE_EXTRA } = require('../scripts/afiliacaoHotmart');
  assert.ok(SAUDE_EXTRA.test('Guia Definitivo de Cuidados com a Pele para Adolescentes'));
  assert.ok(SAUDE_EXTRA.test('Adeus Ansiedade: Técnicas Naturais'));
  assert.ok(!SAUDE_EXTRA.test('Fundo de Emergência em 12 Meses'));
  assert.ok(!SAUDE_EXTRA.test('Marca Pessoal no LinkedIn'));
});
