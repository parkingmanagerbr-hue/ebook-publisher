'use strict';
/**
 * tituloUnico: 924 e-books pendentes tinham 20 titulos distintos (663 copias
 * de um so). Nos 7 dias anteriores a 27/09/2026, 84 de 1.865 titulos gerados
 * ainda eram repetidos.
 *
 * A regra que nao pode ser afrouxada: titulo repetido sem nada que o distinga
 * NAO vira livro — e nunca ganha um numero no fim.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { decidirTitulo, resumoDoTitulo, chave } = require('../src/core/tituloUnico');

test('titulo inedito passa direto', () => {
  const d = decidirTitulo({ title: 'Horta em Apartamento' }, ['Outro Livro']);
  assert.strictEqual(d.acao, 'usar');
  assert.strictEqual(d.titulo, 'Horta em Apartamento');
});

test('titulo repetido COM subtitulo que distingue vira nome composto', () => {
  const d = decidirTitulo(
    { title: 'Ganhe Dinheiro com IA em 2026', subtitle: 'Guia de automação para consultorias' },
    ['Ganhe Dinheiro com IA em 2026'],
  );
  assert.strictEqual(d.acao, 'variar');
  assert.strictEqual(d.titulo, 'Ganhe Dinheiro com IA em 2026: Guia de automação para consultorias');
});

test('titulo repetido SEM nada que distinga e descartado — nunca "Titulo 2"', () => {
  const usados = ['Ganhe Dinheiro com IA em 2026'];
  const semSub = decidirTitulo({ title: 'Ganhe Dinheiro com IA em 2026' }, usados);
  assert.strictEqual(semSub.acao, 'descartar');
  assert.strictEqual(semSub.titulo, null, 'descartado nao devolve titulo para usar assim mesmo');
  assert.ok(!/\d\s*$/.test(String(semSub.titulo)), 'nunca numero no fim');

  const subCurto = decidirTitulo({ title: 'Ganhe Dinheiro com IA em 2026', subtitle: 'IA' }, usados);
  assert.strictEqual(subCurto.acao, 'descartar');

  const subIgual = decidirTitulo({ title: 'Ganhe Dinheiro com IA em 2026', subtitle: 'ganhe  dinheiro COM ia em 2026' }, usados);
  assert.strictEqual(subIgual.acao, 'descartar', 'subtitulo que repete o titulo nao distingue');

  const compostoUsado = decidirTitulo(
    { title: 'Ganhe Dinheiro com IA em 2026', subtitle: 'Guia pratico' },
    ['Ganhe Dinheiro com IA em 2026', 'Ganhe Dinheiro com IA em 2026: Guia pratico'],
  );
  assert.strictEqual(compostoUsado.acao, 'descartar', 'o composto tambem ja existe');
});

test('a comparacao ignora caixa, acento composto e espaco duplo', () => {
  assert.strictEqual(decidirTitulo({ title: 'Horta  em   APARTAMENTO' }, ['horta em apartamento']).acao, 'descartar');
  assert.strictEqual(chave('  Guia\tDefinitivo '), 'guia definitivo');
  assert.strictEqual(chave(null), '');
});

test('livro sem titulo nunca vira e-book', () => {
  assert.strictEqual(decidirTitulo({}, []).acao, 'descartar');
  assert.strictEqual(decidirTitulo({ title: '   ' }, []).acao, 'descartar');
  assert.strictEqual(decidirTitulo(null, []).acao, 'descartar');
});

test('entrada torta nao quebra a decisao', () => {
  assert.strictEqual(decidirTitulo({ title: 'Novo' }, null).acao, 'usar');
  assert.strictEqual(decidirTitulo({ title: 'Novo' }, new Set(['novo'])).acao, 'descartar', 'aceita Set');
  assert.strictEqual(decidirTitulo({ titulo: 'Em portugues', subtitulo: 'Com subtitulo proprio' }, ['em portugues']).acao, 'variar');
  assert.strictEqual(decidirTitulo({ title: 'Novo' }, [null, '', 'outro']).acao, 'usar');
});

test('o titulo respeita o limite pedido', () => {
  const d = decidirTitulo({ title: 'T'.repeat(400) }, []);
  assert.strictEqual(d.titulo.length, 255);
  const c = decidirTitulo({ title: 'T'.repeat(200), subtitle: 'S'.repeat(200) }, ['t'.repeat(200)], { maximo: 120 });
  assert.strictEqual(c.titulo.length, 120);
});

test('log de uma linha, sem quebra vinda do titulo gerado', () => {
  const d = decidirTitulo({ title: 'Guia', subtitle: 'Do zero ao primeiro cliente' }, ['Guia']);
  const linha = resumoDoTitulo(d, 'Guia\ncom quebra');
  assert.ok(!/[\r\n]/.test(linha));
  assert.match(linha, /titulo variar/);
  assert.match(resumoDoTitulo(null, null), /titulo \?/);
});
