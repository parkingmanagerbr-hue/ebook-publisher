'use strict';
/**
 * scoreCoverHooks fecha o ciclo do bandit das capas: casa cada capa com as
 * vendas do e-book e alimenta o placar de tecnicas.
 *
 * Duas coisas decidem se isto presta: o ponto tem de CHEGAR ao placar (e ficar
 * la), e tem de ser do e-book certo. Banco real em arquivo temporario (o modulo
 * abre somente-leitura, o que :memory: nao permite); memoria em tmp.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const { interceptar, recarregar, comAmbiente } = require('./apoio');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'score-'));
const MEM = path.join(DIR, 'mem.json');
const BANCO = path.join(DIR, 'metrics.db');
process.env.COVER_PACKAGING_MEMORY = MEM;
process.env.METRICS_DB = BANCO;
process.env.COVER_SCORE_MIN_DAYS = '7';
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const sch = require('../src/agents/scoreCoverHooks');

const VELHO = new Date(Date.now() - 30 * 86400000).toISOString();
const NOVO = new Date(Date.now() - 2 * 86400000).toISOString();

function banco(linhas) {
  try { fs.unlinkSync(BANCO); } catch { /* primeira vez */ }
  const db = new Database(BANCO);
  db.exec('CREATE TABLE ebooks (id TEXT, topic TEXT, title TEXT, sales_count INTEGER, revenue REAL, published_at TEXT, created_at TEXT)');
  const ins = db.prepare('INSERT INTO ebooks (id, topic, title, sales_count, revenue) VALUES (?, ?, ?, ?, ?)');
  for (const l of linhas) ins.run(...l);
  db.close();
}

function memoria(log, hooks = {}) { fs.writeFileSync(MEM, JSON.stringify({ hooks, log })); }
const lerMem = () => JSON.parse(fs.readFileSync(MEM, 'utf8'));

test('sem arquivo de memoria nada e pontuado', () => {
  try { fs.unlinkSync(MEM); } catch { /* ok */ }
  assert.deepStrictEqual(sch.pontuarCapas(), { pontuados: 0, semVenda: 0, imaturos: 0, semMatch: 0 });
});

test('memoria sem registro novo (sem log, ja pontuado ou sem tecnica) nao abre o banco', t => {
  interceptar(t, { 'better-sqlite3': new Error('nao devia abrir o banco') });
  for (const m of [{ hooks: {} }, { hooks: {}, log: [null, { hookId: 'dor', pontuado: true }, { topico: 'x' }] }]) {
    fs.writeFileSync(MEM, JSON.stringify(m));
    assert.deepStrictEqual(sch.pontuarCapas(), { pontuados: 0, semVenda: 0, imaturos: 0, semMatch: 0 });
  }
});

test('REGRESSAO: o ponto chega ao placar e continua la depois que o passe grava a memoria', () => {
  // pontuarHook grava o placar no arquivo; no fim o passe regravava a copia da
  // memoria lida no INICIO (hooks vazios) e apagava os pontos. O registro ja
  // saia marcado como pontuado, entao a venda nunca mais era contada: o bandit
  // nunca recebeu recompensa.
  banco([['e1', 'Investimentos para iniciantes', 'Livro', 3, 12.5]]);
  memoria([{ hookId: 'numero', quando: VELHO, topico: 'Investimentos para iniciantes' }], { numero: { usos: 1, scoreSum: 0 } });
  const r = sch.pontuarCapas();
  assert.strictEqual(r.pontuados, 1);
  const m = lerMem();
  assert.strictEqual(m.hooks.numero.scoreSum, 3.0125, 'vendas + receita/1000 no placar gravado');
  assert.deepStrictEqual(r.placar, [{ id: 'numero', usos: 1, media: 3.013 }]);
  assert.deepStrictEqual([m.log[0].pontuado, m.log[0].score, m.log[0].ebookId], [true, 3.0125, 'e1']);
});

test('rodar de novo nao conta a mesma venda duas vezes', () => {
  banco([['e1', 'Tema A', 'L', 2, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: 'Tema A' }], { dor: { usos: 1, scoreSum: 0 } });
  sch.pontuarCapas();
  sch.pontuarCapas();
  assert.strictEqual(lerMem().hooks.dor.scoreSum, 2);
});

test('capa nova demais (dentro da maturacao) espera; sem data conta como madura', () => {
  banco([['e1', 'Tema A', 'L', 0, null]]);
  memoria([{ hookId: 'dor', quando: NOVO, topico: 'Tema A' }, { hookId: 'pergunta', topico: 'Tema A' }]);
  const r = sch.pontuarCapas();
  assert.deepStrictEqual([r.pontuados, r.imaturos, r.semVenda], [1, 1, 1]);
  const log = lerMem().log;
  assert.strictEqual(log[0].pontuado, undefined, 'a imatura continua esperando');
  assert.strictEqual(log[1].score, 0, 'receita nula vale zero');
});

test('casamento tolerante: topico truncado em 80 chars e com acento acha o e-book', () => {
  const longo = 'Educação financeira e saída das dívidas para famílias que vivem de salário mínimo e querem juntar dinheiro';
  banco([['e9', longo, 'L', 5, 0], ['outro', 'Receitas saudáveis', 'L', 50, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: longo.slice(0, 80).toUpperCase() }]);
  const r = sch.pontuarCapas();
  assert.strictEqual(r.pontuados, 1);
  assert.strictEqual(lerMem().log[0].ebookId, 'e9');
});

test('sem e-book correspondente nao pontua', () => {
  banco([['e1', 'Receitas', 'L', 9, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: 'Marketing para dentistas' }]);
  const r = sch.pontuarCapas();
  assert.deepStrictEqual([r.pontuados, r.semMatch], [0, 1]);
  assert.deepStrictEqual(r.placar, []);
});

test('REGRESSAO: registro sem topico NAO pega as vendas de um e-book qualquer', () => {
  // normalizar(undefined) = '' e ''.startsWith('') e verdadeiro: o casamento
  // tolerante devolvia o primeiro e-book do banco. Medido: capa sem topico
  // recebeu 42,17 pontos de um e-book sem relacao nenhuma.
  banco([['campeao', 'Investimentos para iniciantes', 'X', 42, 170]]);
  memoria([{ hookId: 'dor', quando: VELHO }, { hookId: 'pergunta', quando: VELHO, topico: '!!!' }]);
  const r = sch.pontuarCapas();
  assert.deepStrictEqual([r.pontuados, r.semMatch], [0, 2]);
  assert.strictEqual(lerMem().hooks.dor, undefined);
});

test('dry-run conta mas nao pontua nem grava', () => {
  banco([['e1', 'Tema A', 'L', 4, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: 'Tema A' }]);
  const antes = fs.readFileSync(MEM, 'utf8');
  const r = sch.pontuarCapas({ dryRun: true });
  assert.strictEqual(r.pontuados, 1);
  assert.strictEqual(fs.readFileSync(MEM, 'utf8'), antes);
});

test('banco travado no meio da busca: o registro fica sem match e o passe segue', t => {
  // Leitor somente-leitura pode receber SQLITE_BUSY enquanto o pipeline grava.
  const Real = Database;
  interceptar(t, { 'better-sqlite3': function Travado(p, o) {
    const db = new Real(p, o);
    return { close: () => db.close(), prepare: sql => { if (/LIMIT (1|800)$/.test(sql.trim())) return { get() { throw new Error('SQLITE_BUSY'); }, all() { throw new Error('SQLITE_BUSY'); } }; return db.prepare(sql); } };
  } });
  banco([['e1', 'Tema A', 'L', 4, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: 'Tema A' }]);
  const r = sch.pontuarCapas();
  assert.deepStrictEqual([r.pontuados, r.semMatch], [0, 1]);
});

test('falha ao gravar a memoria avisa e devolve o resultado mesmo assim', t => {
  banco([['e1', 'Tema A', 'L', 1, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: 'Tema A' }]);
  const escrever = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (p, ...r) => { if (p === MEM && String(r[0]).includes('"pontuado"')) throw new Error('disco cheio'); return escrever(p, ...r); });
  const r = sch.pontuarCapas();
  assert.strictEqual(r.pontuados, 1);
});

test('carga: sem logger usa console; maturacao e caminhos padrao sem env', t => {
  interceptar(t, { '../core/logger': new Error('winston ausente') });
  comAmbiente(t, { COVER_PACKAGING_MEMORY: undefined, COVER_SCORE_MIN_DAYS: undefined, METRICS_DB: undefined });
  const mod = recarregar('src/agents/scoreCoverHooks.js');
  t.after(() => recarregar('src/agents/scoreCoverHooks.js'));
  assert.strictEqual(typeof mod.pontuarCapas, 'function');
});

test('sem METRICS_DB abre data/metrics.db do projeto em somente-leitura', t => {
  const Real = Database;
  const abertos = [];
  interceptar(t, { 'better-sqlite3': function Espiao(p, o) { abertos.push([p, o]); return new Real(BANCO, o); } });
  comAmbiente(t, { METRICS_DB: undefined });
  banco([['e1', 'Tema A', 'L', 0, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: 'Tema A' }]);
  sch.pontuarCapas({ dryRun: true });
  assert.deepStrictEqual(abertos, [[path.join(__dirname, '..', 'data', 'metrics.db'), { readonly: true }]]);
});

test('executavel imprime o resultado em JSON', () => {
  banco([['e1', 'Tema A', 'L', 1, 0]]);
  memoria([{ hookId: 'dor', quando: VELHO, topico: 'Tema A' }]);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'agents', 'scoreCoverHooks.js'), '--dry-run'], { encoding: 'utf8', env: process.env });
  assert.strictEqual(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('\n{') + 1));
  assert.strictEqual(json.pontuados, 1);
});
