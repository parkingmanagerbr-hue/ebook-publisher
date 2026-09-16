'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { descricaoHotmart, MIN, MAX } = require('../src/agents/hotmartDescricao');

test('japones curto chega ao minimo sem espacos entre frases (caso de 16/09/2026)', () => {
  const d = descricaoHotmart('本書は、デジタル格差が拡大する中で起業家へ全プロセスを示します。', '高校向けIT支援', '教育IT', 'ja-JP');
  assert.ok(d.length >= MIN && d.length <= MAX, 'tamanho ' + d.length);
  assert.ok(d.startsWith('本書は、デジタル格差'));
  assert.ok(d.includes('テーマ：教育IT。'));
  assert.ok(!/。 /.test(d));
});

test('descricao longa e mantida e cortada em fim de frase', () => {
  const frase = 'Uma frase completa sobre o assunto do livro. ';
  const d = descricaoHotmart(frase.repeat(20), 'T', 'x', 'pt-BR');
  assert.ok(d.length <= MAX && d.length >= MIN);
  assert.ok(d.endsWith('.'));
  assert.ok(!d.includes('Hotmart'));
});

test('portugues curto recebe complemento no proprio idioma', () => {
  const d = descricaoHotmart('Guia curto.', 'Titulo', 'finanças', 'pt');
  assert.ok(d.length >= MIN);
  assert.ok(d.includes('Tema: finanças.'));
  assert.ok(d.includes('Guia curto. E-book digital'));
});

test('idioma desconhecido cai em ingles e sem descricao usa o titulo', () => {
  const d = descricaoHotmart('', 'My Book', '', 'xx');
  assert.ok(d.startsWith('My Book Digital e-book'));
  assert.ok(!d.includes('{t}'));
  assert.ok(d.includes('Topic: My Book.'), 'sem tema, o assunto e o titulo');
  assert.ok(d.length >= MIN);
  assert.strictEqual(descricaoHotmart(null, null, null, 'constructor').startsWith('Digital e-book'), true);
});

test('ainda curto depois do complemento: acrescenta o titulo', () => {
  // coreano tem 4 frases; forcamos titulo e tema curtos e descricao vazia
  const d = descricaoHotmart('', '', 'a', 'ko');
  assert.ok(d.length >= 150);
  const semTitulo = descricaoHotmart('x', 'Titulo Extra', '', 'zh');
  assert.ok(semTitulo.includes('每一章'));
  assert.ok(semTitulo.length >= MIN);
});

test('corte sem pontuacao: usa espaco ou corta seco', () => {
  const comEspaco = descricaoHotmart('palavra '.repeat(80), 't', 't', 'pt');
  assert.ok(comEspaco.length <= MAX && !comEspaco.endsWith(' '));
  const semEspaco = descricaoHotmart('字'.repeat(600), 't', 't', 'ja');
  assert.strictEqual(semEspaco.length, MAX);
});

test('ultimo recurso do titulo e idioma ausente', () => {
  const comTitulo = descricaoHotmart('a', 'Qq', 'z', 'pl');
  assert.ok(comTitulo.endsWith(' Qq'));
  const jaTem = descricaoHotmart('', 'Qq', '', 'pl');
  assert.ok(!jaTem.endsWith(' Qq'));
  assert.ok(descricaoHotmart('Curto.', 't', 't').includes('E-book digital em PDF'));
});
