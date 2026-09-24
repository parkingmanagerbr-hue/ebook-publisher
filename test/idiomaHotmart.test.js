'use strict';
/**
 * idiomaHotmart: o unico produto recusado da conta era um livro em japones
 * declarado como PT_BR (24/09/2026).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { localeHotmart, precisaCorrigirIdioma, prioridade, resumoIdioma } = require('../src/agents/idiomaHotmart');

test('idioma do banco vira o codigo da Hotmart', () => {
  assert.strictEqual(localeHotmart('pt-BR'), 'PT_BR');
  assert.strictEqual(localeHotmart('pt'), 'PT_BR');
  assert.strictEqual(localeHotmart('ja'), 'JA');
  assert.strictEqual(localeHotmart('ja-JP'), 'JA');
  assert.strictEqual(localeHotmart('zh-CN'), 'ZH');
  assert.strictEqual(localeHotmart('EN_us'), 'EN');
  assert.strictEqual(localeHotmart('  fr  '), 'FR');
  assert.strictEqual(localeHotmart('sv'), null, 'idioma fora da lista nao vira palpite');
  assert.strictEqual(localeHotmart(''), null);
  assert.strictEqual(localeHotmart(null), null);
});

test('REGRESSAO: livro japones marcado como PT_BR precisa de correcao', () => {
  assert.strictEqual(precisaCorrigirIdioma('ja', 'PT_BR'), true);
  assert.strictEqual(precisaCorrigirIdioma('ja-JP', 'JA'), false, 'ja esta certo');
  assert.strictEqual(precisaCorrigirIdioma('pt-BR', 'PT_BR'), false);
  assert.strictEqual(precisaCorrigirIdioma('fr', ''), true, 'sem idioma na loja, grava o do banco');
  assert.strictEqual(precisaCorrigirIdioma('fr', null), true);
  assert.strictEqual(precisaCorrigirIdioma('fr', 'fr'), false, 'caixa nao importa');
});

test('idioma desconhecido no banco nao vira palpite na loja', () => {
  assert.strictEqual(precisaCorrigirIdioma('sv-SE', 'PT_BR'), false);
  assert.strictEqual(precisaCorrigirIdioma(null, 'PT_BR'), false);
  assert.strictEqual(precisaCorrigirIdioma('', ''), false);
});

test('recusado vem antes; depois o estrangeiro', () => {
  const recusado = { status: 'NOT_APPROVED', language: 'ja' };
  const pendente = { status: 'CHANGES_PENDING_ON_PRODUCT', language: 'pt-BR' };
  const estrangeiro = { status: 'ACTIVE', language: 'fr' };
  const comum = { status: 'ACTIVE', language: 'pt-BR' };
  const ordem = [comum, estrangeiro, pendente, recusado].sort((a, b) => prioridade(b) - prioridade(a));
  assert.deepStrictEqual(ordem.map(p => p.status), ['NOT_APPROVED', 'CHANGES_PENDING_ON_PRODUCT', 'ACTIVE', 'ACTIVE']);
  assert.strictEqual(prioridade(recusado) > prioridade(pendente), true);
  assert.strictEqual(prioridade(estrangeiro) > prioridade(comum), true);
  // sem idioma conhecido conta como estrangeiro: entra na fila de conferencia
  assert.strictEqual(prioridade(null), 100);
  assert.strictEqual(prioridade({}), 100);
});

test('log de uma linha, sem quebra vinda do titulo', () => {
  assert.strictEqual(resumoIdioma('8588806', 'PT_BR', 'JA', 'VR\nトレーニング'), '8588806: PT_BR -> JA | "VR トレーニング"');
  assert.strictEqual(resumoIdioma('1', '', 'FR', 'x'), '1: (vazio) -> FR | "x"');
  assert.strictEqual(resumoIdioma(null, null, 'EN', null), ': (vazio) -> EN | ""');
});
