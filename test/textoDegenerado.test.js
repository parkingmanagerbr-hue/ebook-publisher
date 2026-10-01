'use strict';
/**
 * O livro que derrubou a regeracao por 5 horas tinha uma "palavra" de 145.059
 * hifens (01/10/2026). Estes testes usam o mesmo formato de defeito.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { sanearTexto, defeitoDoTexto, sanearLivro } = require('../src/core/textoDegenerado');

const HIFENS = '-'.repeat(145059);

test('repeticao gigante vira tres caracteres; texto normal fica igual', () => {
  assert.strictEqual(sanearTexto('antes ' + HIFENS + ' depois'), 'antes --- depois');
  const normal = 'Separe a pele em tres zonas -- testa, bochechas e queixo. Nota 10/10!!';
  assert.strictEqual(sanearTexto(normal), normal);
});

test('o limite e 12 repeticoes: 13 encurta, 12 fica', () => {
  assert.strictEqual(sanearTexto('a' + '='.repeat(13) + 'b'), 'a===b');
  assert.strictEqual(sanearTexto('='.repeat(12)), '='.repeat(12));
});

test('palavra longa sem repeticao e quebrada em pedacos de ate 80', () => {
  const longa = Array.from({ length: 200 }, (_, i) => 'abcdefghij'[i % 10]).join('');
  const r = sanearTexto(longa);
  assert.ok(r.split(' ').every((p) => p.length <= 80));
  assert.strictEqual(r.replace(/ /g, ''), longa, 'nada se perde, so ganha espaco');
  const url = 'https://www.exemplo.com.br/receitas/maquiagem-vegana?utm_source=livro';
  assert.strictEqual(sanearTexto(url), url, 'URL de tamanho normal fica inteira');
});

test('entrada que nao e texto volta igual', () => {
  for (const v of [undefined, null, '', 5]) assert.strictEqual(sanearTexto(v), v);
});

test('defeito: repeticao de 40+ e palavra de 200+; texto bom e null', () => {
  assert.strictEqual(defeitoDoTexto('x ' + HIFENS), 'caractere repetido 145059 vezes');
  assert.strictEqual(defeitoDoTexto('-'.repeat(39)), null);
  assert.strictEqual(defeitoDoTexto('-'.repeat(40)), 'caractere repetido 40 vezes');
  const palavra = Array.from({ length: 250 }, (_, i) => 'abcdefghij'[i % 10]).join('');
  assert.strictEqual(defeitoDoTexto(palavra), 'palavra de 250 caracteres');
  assert.strictEqual(defeitoDoTexto(palavra.slice(0, 199)), null);
  assert.strictEqual(defeitoDoTexto('texto comum de livro'), null);
  assert.strictEqual(defeitoDoTexto(null), null);
});

test('sanearLivro limpa todos os trechos, aponta onde e nao altera o original', () => {
  const original = {
    title: 'Maquiagem Vegana', introduction: 'intro ok',
    conclusion: 'fim ' + '*'.repeat(60),
    chapters: [{ title: 'Um', content: 'bom' }, { title: 'Tres', content: 'antes ' + HIFENS }, null],
  };
  const { livro, defeitos } = sanearLivro(original);
  assert.strictEqual(livro.chapters[1].content, 'antes ---');
  assert.strictEqual(livro.conclusion, 'fim ***');
  assert.strictEqual(livro.chapters[2], null);
  assert.strictEqual(livro.title, 'Maquiagem Vegana');
  assert.deepStrictEqual(defeitos, ['conclusao: caractere repetido 60 vezes', 'capitulo 2: caractere repetido 145059 vezes']);
  assert.strictEqual(original.chapters[1].content.length, 6 + 145059, 'o original nao e mexido');
});

test('livro sem capitulos ou invalido nao quebra', () => {
  assert.deepStrictEqual(sanearLivro(null), { livro: null, defeitos: [] });
  const { livro, defeitos } = sanearLivro({ introduction: 'a' });
  assert.strictEqual(livro.chapters, undefined);
  assert.deepStrictEqual(defeitos, []);
});
