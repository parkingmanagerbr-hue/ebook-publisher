'use strict';
/**
 * PriorityScorer decide a ordem em que o lote publica. Relogio congelado com
 * mock.timers e arquivos reais em diretorio temporario (a regra de ativos olha
 * o disco de verdade).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PriorityScorer } = require('../src/application/ml/PriorityScorer');
const { Ebook } = require('../src/domain/entities/Ebook');

const AGORA = Date.parse('2026-09-15T12:00:00Z');
const DIA = 86400000;

function congelar(t) { t.mock.timers.enable({ apis: ['Date'], now: AGORA }); }

// Titulo neutro (sem categoria, <20 caracteres, sem numero nem pontuacao) e
// criado ha mais de 10 dias: so a categoria padrao pontua -> 60% de 40 = 24.
const base = extra => new Ebook({ topic: 'variedades', title: 'Um livro qualquer', createdAt: new Date(AGORA - 30 * DIA).toISOString(), ...extra });

test('sem nenhum sinal o score e so a categoria padrao (24)', t => {
  congelar(t);
  assert.strictEqual(PriorityScorer.score(base()), 24);
});

test('categoria usa o maior peso encontrado e ignora acento', t => {
  congelar(t);
  assert.strictEqual(PriorityScorer.score(base({ topic: 'Finanças pessoais' })), 38);         // 95 -> 38
  assert.strictEqual(PriorityScorer.score(base({ topic: 'sono e saúde' })), 36);              // saude 90 vence sono 82
  assert.strictEqual(PriorityScorer.score(base({ topic: 'idioma' })), 27);                    // 68 -> 27.2
  assert.strictEqual(PriorityScorer.score(base({ topic: 'culinaria' })), 24, 'fora da tabela = padrao');
  assert.strictEqual(PriorityScorer.score(base({ topic: undefined, title: undefined })), 24, 'sem texto nao quebra');
});

test('qualidade do titulo: faixa de tamanho, pontuacao e numero', t => {
  congelar(t);
  const pts = title => PriorityScorer.score(base({ title })) - 24;
  assert.strictEqual(pts('a'.repeat(19)), 0);
  assert.strictEqual(pts('a'.repeat(20)), 5, '20 caracteres entra na faixa curta');
  assert.strictEqual(pts('a'.repeat(29)), 5);
  assert.strictEqual(pts('a'.repeat(30)), 10, '30 caracteres entra na faixa ideal');
  assert.strictEqual(pts('a'.repeat(60)), 10);
  assert.strictEqual(pts('a'.repeat(61)), 0, 'titulo longo demais nao pontua');
  assert.strictEqual(pts('Guia: poupar'), 5);
  assert.strictEqual(pts('Guia — poupar'), 5);
  assert.strictEqual(pts('Guia - poupar'), 5);
  assert.strictEqual(pts('7 passos'), 5);
  assert.strictEqual(pts('Plano de 30 dias: guia completo'), 20, 'faixa ideal + dois-pontos + numero');
});

test('ativos so pontuam se o arquivo existe no disco', t => {
  congelar(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-'));
  try {
    const pdf = path.join(dir, 'a.pdf'); fs.writeFileSync(pdf, '%PDF');
    const capa = path.join(dir, 'a.png'); fs.writeFileSync(capa, 'x');
    assert.strictEqual(PriorityScorer.score(base({ pdfPath: pdf })), 34);
    assert.strictEqual(PriorityScorer.score(base({ pdfPath: pdf, coverPath: capa })), 44);
    assert.strictEqual(PriorityScorer.score(base({ pdfPath: path.join(dir, 'sumiu.pdf'), coverPath: path.join(dir, 'sumiu.png') })), 24,
      'caminho gravado no banco sem arquivo nao vale ponto');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recencia: 10 pontos no dia, decai 1 por dia, zera depois de 10 dias', t => {
  congelar(t);
  const idade = d => PriorityScorer.score(base({ createdAt: new Date(AGORA - d * DIA).toISOString() })) - 24;
  assert.strictEqual(idade(0), 10);
  assert.strictEqual(idade(4), 6);
  assert.strictEqual(idade(10), 0);
  assert.strictEqual(idade(11), 0);
  assert.strictEqual(PriorityScorer.score(new Ebook({ topic: 'x', title: 'Um livro qualquer', createdAt: '' })), 34,
    'sem data o Ebook assume agora');
  const cru = { topic: 'x', title: 'Um livro qualquer', publishedCount: () => 0 };
  assert.strictEqual(PriorityScorer.score(cru), 34, 'objeto cru sem createdAt tambem conta como novo');
});

test('REGRESSAO: data invalida nao vira NaN e data no futuro nao passa de 10 pontos', t => {
  // new Date('lixo') dava NaN, o NaN atravessava Math.max/min e o score saia
  // NaN — e o sort de scoreAll com NaN deixa a ordem do lote indefinida.
  congelar(t);
  const lixo = PriorityScorer.score(base({ createdAt: 'nao-e-data' }));
  assert.ok(Number.isFinite(lixo), 'veio ' + lixo);
  assert.strictEqual(lixo, 24, 'sem data confiavel, recencia nao pontua');
  assert.strictEqual(PriorityScorer.score(base({ createdAt: new Date(AGORA + 5 * DIA).toISOString() })), 34,
    'relogio adiantado do gerador nao pode dar 15 pontos de recencia');
});

test('bonus so para quem esta em exatamente uma loja (conteudo provado, ainda falta loja)', t => {
  congelar(t);
  assert.strictEqual(PriorityScorer.score(base({ hotmartProductId: 'H' })), 29);
  assert.strictEqual(PriorityScorer.score(base({ hotmartProductId: 'H', caktoProductId: 'C' })), 24);
});

test('e-book com todos os sinais chega ao maximo real da formula (93)', t => {
  congelar(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-'));
  try {
    const f = path.join(dir, 'a'); fs.writeFileSync(f, 'x');
    const topo = new Ebook({ topic: 'financas', title: 'Investimento: 10 passos para sair das dividas',
      pdfPath: f, coverPath: f, createdAt: new Date(AGORA).toISOString(), hotmartProductId: 'H' });
    // categoria 38 + titulo 20 + ativos 20 + recencia 10 + bonus 5
    assert.strictEqual(PriorityScorer.score(topo), 93);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scoreAll devolve do maior para o menor', t => {
  congelar(t);
  const r = PriorityScorer.scoreAll([base({ id: 'baixo' }), base({ id: 'alto', topic: 'financas' }), base({ id: 'meio', topic: 'tecnologia' })]);
  assert.deepStrictEqual(r.map(x => x.ebook.id), ['alto', 'meio', 'baixo']);
  assert.deepStrictEqual(r.map(x => x.score), [38, 32, 24]);
});

test('getCategory cobre cada rotulo e cai em outros', () => {
  const cat = topic => PriorityScorer.getCategory({ topic, title: '' });
  assert.strictEqual(cat('Bolsa de valores'), 'financas');
  assert.strictEqual(cat('Ansiedade'), 'saude');
  assert.strictEqual(cat('Carreira'), 'negocios');
  assert.strictEqual(cat('Python'), 'tecnologia');
  assert.strictEqual(cat('Comunicação'), 'relacionamento');
  assert.strictEqual(cat('Culinária'), 'outros');
  assert.strictEqual(PriorityScorer.getCategory({}), 'outros');
});
