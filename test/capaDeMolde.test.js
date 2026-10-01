'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { htmlDaCapa, separarTitulo, fonteDoTitulo, escapar, indice, PALETAS } = require('../src/agents/capaDeMolde');

test('a capa traz titulo, subtitulo e editora, com o tamanho certo', () => {
  const h = htmlDaCapa({ titulo: 'Marca Pessoal no LinkedIn', subtitulo: 'Seu passo a passo', idioma: 'pt-BR' });
  assert.match(h, /<h1>Marca Pessoal no LinkedIn<\/h1>/);
  assert.match(h, /<h2>Seu passo a passo<\/h2>/);
  assert.match(h, /Veloxis Editorial/);
  assert.match(h, /width:1600px;height:2560px/);
  assert.match(h, /lang="pt-BR"/);
});

test('sem subtitulo nao ha h2 vazio; titulo vazio e recusado', () => {
  assert.doesNotMatch(htmlDaCapa({ titulo: 'Só título' }), /<h2>/);
  assert.throws(() => htmlDaCapa({ titulo: '  ' }), /sem titulo/);
  assert.throws(() => htmlDaCapa(), /sem titulo/);
});

test('texto vindo de fora e escapado (nome de produto com <script> nao vira codigo)', () => {
  const h = htmlDaCapa({ titulo: '<script>alert(1)</script>', subtitulo: '"x" & \'y\'', idioma: '"><b>' });
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /&quot;x&quot; &amp; &#39;y&#39;/);
  assert.doesNotMatch(h, /lang=""><b>/);
  assert.strictEqual(escapar(null), '');
});

test('o mesmo titulo da sempre a mesma paleta, e titulos diferentes variam', () => {
  assert.strictEqual(htmlDaCapa({ titulo: 'A' }), htmlDaCapa({ titulo: 'A' }));
  const usadas = new Set(['Livro 1', 'Livro 2', 'Livro 3', 'Livro 4', 'Livro 5', 'Livro 6'].map((t) => indice(t, PALETAS.length)));
  assert.ok(usadas.size > 1);
  assert.strictEqual(indice('', 8), 0);
});

test('titulo longo encolhe a fonte; subtitulo gigante e cortado', () => {
  assert.deepStrictEqual([10, 30, 50, 70, 120].map((n) => fonteDoTitulo('x'.repeat(n))), [150, 128, 108, 92, 78]);
  assert.strictEqual(fonteDoTitulo(undefined), 150);
  const h = htmlDaCapa({ titulo: 'T', subtitulo: 'y'.repeat(400) });
  assert.match(h, new RegExp('<h2>' + 'y'.repeat(180) + '</h2>'));
});

test('separarTitulo divide o nome composto da loja', () => {
  assert.deepStrictEqual(separarTitulo('Rotina Matinal: Energia o dia todo'), { titulo: 'Rotina Matinal', subtitulo: 'Energia o dia todo' });
  assert.deepStrictEqual(separarTitulo('Sem dois pontos'), { titulo: 'Sem dois pontos', subtitulo: '' });
  assert.deepStrictEqual(separarTitulo('IA: x'), { titulo: 'IA: x', subtitulo: '' });
  assert.deepStrictEqual(separarTitulo(null), { titulo: '', subtitulo: '' });
});

test('idioma ausente vira pt-BR', () => {
  assert.match(htmlDaCapa({ titulo: 'T', idioma: null }), /lang="pt-BR"/);
});
