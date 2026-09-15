'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { textos, mesAno, fontes, TEXTOS } = require('../src/agents/pdfIdioma');

test('livro estrangeiro nao recebe texto fixo em portugues (o defeito real)', () => {
  assert.strictEqual(textos('de').sumario, 'Inhalt');
  assert.strictEqual(textos('es-ES').introducao, 'Introducción');
  assert.strictEqual(textos('ja-JP').sumario, '目次');
  assert.strictEqual(textos('pt-BR').sumario, 'Sumário');
  assert.strictEqual(textos('sv').sumario, 'Contents', 'idioma sem traducao cai em ingles, nao em portugues');
  assert.strictEqual(textos(undefined).sumario, 'Sumário');
});

test('todos os idiomas tem todas as chaves (controle contra traducao pela metade)', () => {
  const chaves = Object.keys(TEXTOS.pt).sort();
  for (const [l, t] of Object.entries(TEXTOS)) assert.deepStrictEqual(Object.keys(t).sort(), chaves, l);
  for (const t of Object.values(TEXTOS)) for (const v of Object.values(t)) assert.ok(v.trim().length > 0);
});

test('mes e ano no idioma do livro', () => {
  const d = new Date(Date.UTC(2026, 8, 15, 12));
  assert.match(mesAno('pt-BR', d), /setembro de 2026/);
  assert.match(mesAno('de', d), /September 2026/);
  assert.match(mesAno('ja', d), /2026年9月/);
  assert.match(mesAno('xx-invalido-', d), /2026/);
});

const tudoExiste = () => true;
const nadaExiste = () => false;

test('japones, chines e coreano usam Noto CJK com a variante certa', () => {
  const ja = fontes('ja-JP', tudoExiste);
  assert.deepStrictEqual(ja.registrar.map(r => r[2]), ['NotoSansCJKjp-Regular', 'NotoSansCJKjp-Bold']);
  assert.strictEqual(fontes('zh-CN', tudoExiste).registrar[0][2], 'NotoSansCJKsc-Regular');
  assert.strictEqual(fontes('ko', tudoExiste).registrar[1][2], 'NotoSansCJKkr-Bold');
  assert.strictEqual(ja.bold, 'Negrito');
});

test('CJK sem fonte instalada recusa gerar em vez de sair ilegivel', () => {
  assert.throws(() => fontes('ja', nadaExiste), /ilegivel/);
});

test('latino usa Noto Sans quando existe (polones com ą ę ł); sem arquivos cai em Helvetica', () => {
  const pl = fontes('pl', tudoExiste);
  assert.deepStrictEqual([pl.regular, pl.bold, pl.italic], ['Corpo', 'Negrito', 'Italico']);
  assert.strictEqual(pl.registrar.length, 3);
  assert.deepStrictEqual(fontes('pt-BR', nadaExiste), { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', registrar: [] });
});
