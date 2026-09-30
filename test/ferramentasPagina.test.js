'use strict';
/**
 * A pagina da ferramenta: texto do livro nunca entra cru no HTML, a pagina
 * fica fora dos buscadores, e o progresso de um livro nao se mistura com o de
 * outro.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { paginaDaFerramenta, esc } = require('../src/ferramentas/pagina');

const esp = {
  titulo: 'Fundo de Emergência em 12 Meses', subtitulo: 'Guia prático', idioma: 'pt-BR',
  capitulos: [
    { titulo: 'Diagnóstico', resumo: 'Saiba onde está.', acoes: ['Listar despesas fixas', 'Somar dívidas'] },
    { titulo: 'Metas', resumo: '', acoes: ['Definir valor da reserva', 'Escolher onde guardar'] },
  ],
  habitos: ['Revisar gastos'],
  aviso: 'Este plano não é recomendação individual.',
};

test('a página tem título, capítulos, ações, hábitos e aviso', () => {
  const h = paginaDaFerramenta(esp, { chave: 'abc123' });
  assert.match(h, /<h1>Fundo de Emergência em 12 Meses<\/h1>/);
  assert.match(h, /Listar despesas fixas/);
  assert.match(h, /data-id="a1_1"/, 'cada ação tem id próprio');
  assert.match(h, /data-id="h0_6"/, 'um hábito, sete dias');
  assert.match(h, /não é recomendação individual/);
  assert.match(h, /<p class="resumo">Saiba onde está\.<\/p>/);
  assert.ok(!/<p class="resumo"><\/p>/.test(h), 'resumo vazio não vira parágrafo vazio');
});

test('fica FORA dos buscadores (acesso é pela área de membros)', () => {
  assert.match(paginaDaFerramenta(esp), /<meta name="robots" content="noindex,nofollow">/);
});

test('texto do livro NUNCA entra cru no HTML', () => {
  const ruim = {
    titulo: '<script>alert(1)</script>',
    capitulos: [{ titulo: '"><img src=x onerror=alert(1)>', resumo: '<b>x</b>', acoes: ["it's <i>", 'a & b'] }],
    habitos: ['<svg onload=alert(1)>'],
    aviso: '<u>aviso</u>',
    idioma: '"><x',
  };
  const h = paginaDaFerramenta(ruim);
  assert.ok(!h.includes('<script>alert'), 'script do título escapado');
  assert.ok(!h.includes('<img src=x'), 'atributo escapado');
  assert.ok(!h.includes('<svg onload'), 'hábito escapado');
  assert.ok(!h.includes('<u>aviso'), 'aviso escapado');
  assert.match(h, /it&#39;s &lt;i&gt;/);
  assert.match(h, /a &amp; b/);
  assert.match(h, /lang="&quot;&gt;&lt;x"/);
});

test('a chave de progresso é por livro e não aceita caractere estranho', () => {
  const h = paginaDaFerramenta(esp, { chave: 'ab"c/../12' });
  assert.match(h, /data-chave="vx-ferramenta-abc12"/);
  assert.match(paginaDaFerramenta(esp, { chave: '' }), /data-chave="vx-ferramenta-livro"/, 'chave vazia tem padrão');
  assert.match(paginaDaFerramenta(esp), /data-chave="vx-ferramenta-livro"/);
  assert.notStrictEqual(
    paginaDaFerramenta(esp, { chave: 'livroA' }).match(/data-chave="([^"]+)"/)[1],
    paginaDaFerramenta(esp, { chave: 'livroB' }).match(/data-chave="([^"]+)"/)[1],
    'progresso de um livro não se mistura com o de outro');
});

test('sem aviso, sem hábitos e sem subtítulo a página continua válida', () => {
  const h = paginaDaFerramenta({ titulo: 'Estúdio Caseiro', capitulos: esp.capitulos });
  assert.ok(!/class="aviso"/.test(h), 'sem aviso não há caixa vazia');
  assert.match(h, /Este livro não traz hábitos semanais/);
  assert.ok(!/<header><h1>Estúdio Caseiro<\/h1><p>/.test(h), 'sem subtítulo não há parágrafo');
  assert.match(h, /lang="pt-BR"/, 'sem idioma, português');
});

test('entrada torta não quebra a página', () => {
  const h = paginaDaFerramenta(null);
  assert.match(h, /<!doctype html>/);
  const h2 = paginaDaFerramenta({ capitulos: [null, { titulo: 'Só título' }], habitos: 'não é lista' });
  assert.match(h2, /Só título/);
  assert.match(h2, /não traz hábitos/);
  assert.strictEqual(esc(null), '');
});

test('a página não fala de IA', () => {
  assert.ok(!/\bIA\b|intelig[eê]ncia artificial|gerad[oa] por/i.test(paginaDaFerramenta(esp)));
});
