'use strict';
/**
 * gerarPackaging e revisar: o texto que vai para a capa PUBLICA.
 *
 * Regra de conteudo publico (CDC/CONAR): nada de alegacao de cura/causa em
 * saude, nada de promessa sem lastro. A IA e interceptada: cada teste define a
 * resposta dela e confere o que sai para a capa (ou que nada sai).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { interceptar, recarregar, comAmbiente } = require('./apoio');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
const MEM = path.join(DIR, 'mem.json');
process.env.COVER_PACKAGING_MEMORY = MEM;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const cp = require('../src/agents/coverPackaging');

const limpar = () => { try { fs.unlinkSync(MEM); } catch { /* ja limpo */ } };
const json = o => 'Claro! Aqui esta:\n```json\n' + JSON.stringify(o) + '\n```';
const BOM = { kicker: 'sem tempo para cozinhar', titulo: 'Jantar em 15 Minutos', subtitulo: 'Receitas de uma panela para a semana toda', badge: 'Passo a passo' };

/** IA falsa: devolve em ordem as respostas (1a = geracao, 2a = revisao). */
function ia(t, respostas) {
  const pedidos = [];
  interceptar(t, { '../core/aiClient': { generate: async (prompt, sys, opts) => {
    pedidos.push({ prompt, sys, opts });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return r;
  } } });
  return pedidos;
}

test('caminho feliz: prompt leva tema, idioma e tecnica; saida normalizada e uso registrado', async t => {
  limpar();
  t.mock.method(Math, 'random', () => 0.99);   // sem exploracao; desempate estavel
  const pedidos = ia(t, [json(BOM), { text: json({ ...BOM, titulo: 'Jantar em 15 Minutos!' }) }]);
  const r = await cp.gerarPackaging({ topico: 'culinaria pratica', categoria: 'culinaria', idioma: 'es' });
  assert.deepStrictEqual(r, { kicker: 'SEM TEMPO PARA COZINHAR', titulo: 'Jantar em 15 Minutos!', subtitulo: BOM.subtitulo, badge: '', hookId: r.hookId });
  assert.ok(cp.HOOKS.some(h => h.id === r.hookId));
  assert.match(pedidos[0].prompt, /Tema do e-book: "culinaria pratica" \(categoria: culinaria\)/);
  assert.match(pedidos[0].prompt, /Idioma da capa: es\./);
  assert.strictEqual(pedidos[0].opts.maxTokens, 1200);
  assert.match(pedidos[1].prompt, /no idioma es\./, 'revisao no idioma da capa');
  assert.strictEqual(pedidos[1].opts.maxTokens, 600);
  const mem = JSON.parse(fs.readFileSync(MEM, 'utf8'));
  assert.deepStrictEqual(mem.log.map(l => [l.hookId, l.topico, l.titulo]), [[r.hookId, 'culinaria pratica', 'Jantar em 15 Minutos!']]);
});

test('o selo NUNCA vem da IA, mesmo quando ela manda um inofensivo', async t => {
  limpar();
  ia(t, [json({ ...BOM, badge: 'Guia 2026' }), json({ ...BOM, badge: 'Guia 2026' })]);
  assert.strictEqual((await cp.gerarPackaging({ titulo: 'Jantar' })).badge, '');
});

test('sem opcoes: usa titulo ausente, categoria geral e pt-BR, e ainda assim gera', async t => {
  limpar();
  const pedidos = ia(t, [json(BOM), 'revisor sem json']);
  const r = await cp.gerarPackaging();
  assert.ok(r, 'embalagem valida nao depende do tema');
  assert.match(pedidos[0].prompt, /\(categoria: geral\)/);
  assert.match(pedidos[0].prompt, /Idioma da capa: pt-BR\./);
  assert.strictEqual(JSON.parse(fs.readFileSync(MEM, 'utf8')).log[0].topico, '');
});

test('IA sem JSON, com JSON quebrado, vazia ou fora do ar: nenhuma capa sai, nada e registrado', async t => {
  for (const resposta of ['nao sei fazer isso', '{ kicker: sem aspas }', null, { text: null }, new Error('Todos os providers de AI falharam')]) {
    limpar();
    const restaurar = interceptar(null, { '../core/aiClient': { generate: async () => { if (resposta instanceof Error) throw resposta; return resposta; } } });
    try {
      assert.strictEqual(await cp.gerarPackaging({ titulo: 'x' }), null, String(resposta));
    } finally { restaurar(); }
    assert.ok(!fs.existsSync(MEM), 'falha nao registra uso de tecnica');
  }
});

test('revisao que apaga campo, quebra ou lanca e ignorada: fica o texto original', async t => {
  for (const revisao of [json({ kicker: 'SO KICKER' }), '{ quebrado }', new Error('429'), null]) {
    limpar();
    const restaurar = interceptar(null, { '../core/aiClient': { generate: (() => { const f = [json(BOM), revisao]; return async () => { const r = f.shift(); if (r instanceof Error) throw r; return r; }; })() } });
    try {
      const r = await cp.gerarPackaging({ titulo: 'Jantar' });
      assert.strictEqual(r.titulo, BOM.titulo, 'revisao ' + String(revisao).slice(0, 20));
    } finally { restaurar(); }
  }
});

test('revisao sem selo mantem o selo original (e o selo continua fora da capa)', async t => {
  limpar();
  ia(t, [json(BOM), json({ kicker: 'k', titulo: 'Titulo revisado', subtitulo: 'Sub revisado' })]);
  const r = await cp.gerarPackaging({ titulo: 'Jantar' });
  assert.deepStrictEqual([r.kicker, r.titulo, r.subtitulo, r.badge], ['K', 'Titulo revisado', 'Sub revisado', '']);
});

test('largura cheia vira normal ANTES dos filtros: promessa de 10% em japones e barrada', async t => {
  limpar();
  const jp = { kicker: '毎月の支出', titulo: '家計を立て直す', subtitulo: '毎月の支出を１０％削減', badge: '' };
  ia(t, [json(jp), json(jp)]);
  assert.strictEqual(await cp.gerarPackaging({ topico: '家計管理', idioma: 'ja' }), null);
});

test('campo que nao e texto passa pela normalizacao sem quebrar', async t => {
  limpar();
  ia(t, [json({ ...BOM, badge: 2026 }), json({ ...BOM, badge: 2026 })]);
  assert.ok(await cp.gerarPackaging({ titulo: 'Jantar' }));
});

test('SAUDE: alegacao de causa ou cura derruba a embalagem inteira', async t => {
  limpar();
  const alegacao = { ...BOM, kicker: 'suas dores vem da industria', titulo: 'Dieta Anti Dor' };
  ia(t, [json(alegacao), json(alegacao)]);
  assert.strictEqual(await cp.gerarPackaging({ topico: 'dieta anti-inflamatoria', categoria: 'saude' }), null);
});

test('SAUDE sem alegacao passa; a mesma frase fora de saude tambem passa (controle)', async t => {
  limpar();
  const neutro = { kicker: 'sem tempo para treinar', titulo: 'Treino de 20 Minutos', subtitulo: 'Rotina curta para fazer em casa', badge: '' };
  ia(t, [json(neutro), json(neutro), json({ ...BOM, kicker: 'a culpa nao e sua' }), json({ ...BOM, kicker: 'a culpa nao e sua' })]);
  assert.ok(await cp.gerarPackaging({ topico: 'saude e treino', categoria: 'saude' }));
  assert.ok(await cp.gerarPackaging({ topico: 'organizacao financeira', categoria: 'financas' }), '"culpa" so e vedada em saude');
});

test('promessa sem lastro: no selo so zera; no corpo derruba', async t => {
  limpar();
  ia(t, [json({ ...BOM, badge: 'CERTIFICADO' }), json({ ...BOM, badge: 'CERTIFICADO' }),
         json({ ...BOM, subtitulo: 'Resultados em 30 dias garantidos' }), json({ ...BOM, subtitulo: 'Resultados em 30 dias garantidos' })]);
  const comSelo = await cp.gerarPackaging({ titulo: 'Jantar' });
  assert.ok(comSelo, 'selo com promessa nao derruba a capa');
  assert.strictEqual(comSelo.badge, '');
  assert.strictEqual(await cp.gerarPackaging({ titulo: 'Jantar' }), null);
});

test('embalagem incompleta (campo vazio depois de limpar aspas) e recusada', async t => {
  limpar();
  const vazio = { ...BOM, subtitulo: '""' };
  ia(t, [json(vazio), json({ kicker: 'k' })]);
  assert.strictEqual(await cp.gerarPackaging({ titulo: 'Jantar' }), null);
});

test('texto longo e cortado no limite do layout sem cortar palavra', async t => {
  limpar();
  const longo = { kicker: 'voce trabalha o mes inteiro e ainda falta dinheiro no fim', titulo: 'Sobra Dinheiro Todo Mes Sem Aperto', subtitulo: 'Um plano simples para organizar as contas da casa e voltar a respirar tranquilo', badge: '' };
  ia(t, [json(longo), json(longo)]);
  const r = await cp.gerarPackaging({ titulo: 'Financas' });
  assert.ok(r.kicker.length <= 40 && r.titulo.length <= 28 && r.subtitulo.length <= 60);
  // Antes terminava em "...Mes Sem" (frase aberta); agora corta antes da preposicao.
  assert.strictEqual(r.titulo, 'Sobra Dinheiro Todo Mes');
  assert.strictEqual(r.subtitulo, 'Um plano simples para organizar as contas da casa');
});

// ── bandit: fronteiras ──────────────────────────────────────────────────────

test('exploracao (sorteio abaixo de epsilon) ignora o placar', t => {
  limpar();
  cp.registrarUso('dor');
  cp.pontuarHook('dor', 100);
  const seq = [0.01, 0.99];
  t.mock.method(Math, 'random', () => seq.shift() ?? 0.5);
  assert.strictEqual(cp.escolherHook(undefined, 'financas', 'x').id, cp.HOOKS[cp.HOOKS.length - 1].id);
});

test('placar tolera tecnica sem scoreSum e pontuacao nula', () => {
  fs.writeFileSync(MEM, JSON.stringify({ hooks: { numero: { usos: 2 } }, log: [] }));
  assert.strictEqual(cp.placar().find(h => h.id === 'numero').media, 0);
  const h = cp.pontuarHook('numero', undefined);
  assert.strictEqual(h.scoreSum, 0);
  assert.deepStrictEqual(cp.pontuarHook('novo', 3), { usos: 0, scoreSum: 3 });
});

test('memoria em caminho impossivel: avisa e segue sem lancar', t => {
  const arquivoNoCaminho = path.join(DIR, 'sou-arquivo');
  fs.writeFileSync(arquivoNoCaminho, 'x');
  comAmbiente(t, { COVER_PACKAGING_MEMORY: path.join(arquivoNoCaminho, 'sub', 'mem.json') });
  const mod = recarregar('src/agents/coverPackaging.js');
  t.after(() => recarregar('src/agents/coverPackaging.js'));
  assert.doesNotThrow(() => mod.registrarUso('dor', { topico: 't' }));
  assert.deepStrictEqual(mod.placar(), []);
});

test('carga: sem logger usa console; epsilon e caminho padrao vem da env ou do padrao', t => {
  interceptar(t, { '../core/logger': new Error('winston ausente') });
  comAmbiente(t, { COVER_PACKAGING_MEMORY: undefined, COVER_HOOK_EPSILON: '1' });
  const mod = recarregar('src/agents/coverPackaging.js');
  t.after(() => recarregar('src/agents/coverPackaging.js'));
  // epsilon 1: sempre explora; o ultimo sorteio escolhe a posicao
  const seq = [0.5, 0];
  t.mock.method(Math, 'random', () => seq.shift() ?? 0);
  assert.strictEqual(mod.escolherHook({ hooks: {} }, 'x', 'y').id, mod.HOOKS[0].id);
});
