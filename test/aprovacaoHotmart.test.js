'use strict';
/**
 * aprovacaoHotmart: medido em 26/09/2026, os 3 produtos NOT_APPROVED da conta
 * eram exatamente os 3 sem capa. O teste protege a regra que importa: nao
 * reenviar para analise produto sem capa.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { decidirAprovacao, filaDeAprovacao, temCapa, resumoDaDecisao } = require('../src/agents/aprovacaoHotmart');

const capaReal = { id: 10510306, name: 'capa.png', webPath: 'https://hotmart.s3.amazonaws.com/x.png' };

test('recusado SEM capa: sobe a capa antes, nao reenvia', () => {
  const d = decidirAprovacao({ id: 8597189, status: 'NOT_APPROVED', coverPhoto: {} });
  assert.strictEqual(d.acao, 'capa');
  assert.match(d.motivo, /sem capa/);
});

test('recusado COM capa: volta para a analise', () => {
  const d = decidirAprovacao({ id: 1, status: 'NOT_APPROVED', coverPhoto: capaReal });
  assert.strictEqual(d.acao, 'reenviar');
});

test('mudanca pendente conta como acao nossa; em analise e ativo nao', () => {
  assert.strictEqual(decidirAprovacao({ status: 'CHANGES_PENDING_ON_PRODUCT', coverPhoto: capaReal }).acao, 'reenviar');
  assert.strictEqual(decidirAprovacao({ status: 'IN_REVIEW', coverPhoto: capaReal }).acao, 'nada', 'analise em andamento nao se empurra');
  assert.strictEqual(decidirAprovacao({ status: 'ACTIVE', coverPhoto: capaReal }).acao, 'nada');
  assert.strictEqual(decidirAprovacao({ status: 'PAUSED', coverPhoto: capaReal }).acao, 'nada');
  assert.strictEqual(decidirAprovacao({ status: 'not_approved', coverPhoto: capaReal }).acao, 'reenviar', 'caixa baixa tambem conta');
});

test('coverPhoto vazio, nulo ou com tipo errado nao e capa', () => {
  assert.strictEqual(temCapa({ coverPhoto: {} }), false);
  assert.strictEqual(temCapa({ coverPhoto: null }), false);
  assert.strictEqual(temCapa({ coverPhoto: 'https://x/capa.png' }), false, 'string nao e o formato da API');
  assert.strictEqual(temCapa({}), false);
  assert.strictEqual(temCapa(null), false);
  assert.strictEqual(temCapa({ coverPhoto: capaReal }), true);
  assert.strictEqual(temCapa({ coverPhoto: { url: 'https://x/c.png' } }), true);
  assert.strictEqual(temCapa({ coverPhoto: { fileName: 'c.png' } }), true);
});

test('produto sem status nenhum nao vira acao', () => {
  assert.strictEqual(decidirAprovacao({}).acao, 'nada');
  assert.strictEqual(decidirAprovacao(null).acao, 'nada');
});

test('fila: capa primeiro, reenvio depois, o resto fica de fora', () => {
  const fila = filaDeAprovacao([
    { id: 'reenvia', status: 'NOT_APPROVED', coverPhoto: capaReal },
    { id: 'ativo', status: 'ACTIVE', coverPhoto: capaReal },
    null,
    { id: 'capa', status: 'NOT_APPROVED', coverPhoto: {} },
  ]);
  assert.deepStrictEqual(fila.map(x => x.produto.id), ['capa', 'reenvia']);
  assert.deepStrictEqual(filaDeAprovacao([]), []);
  assert.deepStrictEqual(filaDeAprovacao(null), []);
});

test('log de uma linha, sem quebra vinda do nome', () => {
  const linha = resumoDaDecisao({ id: 1, status: 'NOT_APPROVED', name: 'Casa\nSegura' }, { acao: 'capa', motivo: 'sem capa' });
  assert.ok(!/[\r\n]/.test(linha));
  assert.match(linha, /1 \[NOT_APPROVED\] capa: sem capa \| "Casa Segura"/);
  assert.match(resumoDaDecisao(null, null), /\? \[\?\] \?/);
});
