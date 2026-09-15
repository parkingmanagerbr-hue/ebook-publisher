'use strict';
/**
 * Passes de capa: backfillCovers (reenvia capa que existe em disco) e
 * regenCovers (regera capa que sumiu, ou troca todas pela viral).
 *
 * O que protege: produto no ar sem capa vende menos, e um passe que nunca
 * termina ou reenvia o mesmo item gasta cota e tempo. Navegador e gerador de
 * imagem sao falsos (interceptados); banco :memory: pelo database.js real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { interceptar, recarregar, comAmbiente } = require('./apoio');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'capas-'));
process.env.METRICS_DB = ':memory:';
process.env.COVERS_DIR = path.join(DIR, 'covers');
process.env.REGEN_PAUSA_MS = '1';
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { getDb } = require('../src/core/database');
const backfillMod = require('../src/agents/backfillCovers');
const regen = require('../src/agents/regenCovers');

function arquivo(nome) { const p = path.join(DIR, nome); fs.writeFileSync(p, 'png'); return p; }

function reiniciarBanco() {
  const db = getDb();
  db.exec('DELETE FROM ebooks; DROP TABLE IF EXISTS cover_backfill; DROP TABLE IF EXISTS cover_viral_v2; DROP TABLE IF EXISTS cover_viral_tentativas;');
  db.prepare("INSERT OR IGNORE INTO topics (topic) VALUES ('tema')").run();
  return db;
}

function ebook(db, id, extra = {}) {
  const l = { id, topic: 'tema', title: 'Livro ' + id, hotmart_product_id: null, cover_path: null, language: 'pt-BR', subtitle: null, ...extra };
  db.prepare('INSERT INTO ebooks (id, topic, title, subtitle, hotmart_product_id, cover_path, language) VALUES (@id, @topic, @title, @subtitle, @hotmart_product_id, @cover_path, @language)').run(l);
}

// ── backfillCovers.backfill ─────────────────────────────────────────────────

test('backfill sem pendente nao abre navegador', async t => {
  reiniciarBanco();
  interceptar(t, { './publisherHotmart': new Error('nao devia carregar o navegador') });
  assert.deepStrictEqual(await backfillMod.backfill(), { total: 0, ok: 0 });
});

test('backfill dry-run lista e nao envia; ignora capa ja apagada do disco', async t => {
  const db = reiniciarBanco();
  ebook(db, 'a', { hotmart_product_id: '101', cover_path: arquivo('a.png') });
  ebook(db, 'b', { hotmart_product_id: '102', cover_path: path.join(DIR, 'apagada.png') });
  interceptar(t, { './publisherHotmart': new Error('dry-run nao envia') });
  const r = await backfillMod.backfill({ limite: '5', dryRun: true });
  assert.deepStrictEqual(r, { total: 1, ok: 0, dryRun: true });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cover_backfill').get().n, 0, 'dry-run nao marca nada');
});

test('backfill registra CADA item assim que termina (lote morto no meio nao perde o feito)', async t => {
  const db = reiniciarBanco();
  ebook(db, 'a', { hotmart_product_id: '201', cover_path: arquivo('b1.png') });
  ebook(db, 'b', { hotmart_product_id: '202', cover_path: arquivo('b2.png') });
  const vistosNoMeio = [];
  interceptar(t, { './publisherHotmart': {
    backfillCapas: async (itens, aoTerminar) => {
      aoTerminar(itens[0], true);
      vistosNoMeio.push(db.prepare('SELECT produto, ok FROM cover_backfill').all());
      throw new Error('SIGTERM no meio do lote');
    },
  } });
  await assert.rejects(() => backfillMod.backfill({ limite: 10 }), /SIGTERM/);
  assert.deepStrictEqual(vistosNoMeio[0], [{ produto: '202', ok: 1 }], 'o primeiro ja estava gravado antes da queda');
  assert.deepStrictEqual(backfillMod.buscarCandidatos(db, 10).map(c => c.numericId), ['201'], 'so o que faltou volta');
});

test('backfill devolve o resultado do envio e marca falha tambem (nao reenvia em loop)', async t => {
  const db = reiniciarBanco();
  ebook(db, 'a', { hotmart_product_id: '301', cover_path: arquivo('c1.png') });
  interceptar(t, { './publisherHotmart': { backfillCapas: async (itens, aoTerminar) => { aoTerminar(itens[0], false); return { total: 1, ok: 0 }; } } });
  assert.deepStrictEqual(await backfillMod.backfill({}), { total: 1, ok: 0 });
  assert.deepStrictEqual(db.prepare('SELECT produto, ok FROM cover_backfill').all(), [{ produto: '301', ok: 0 }]);
});

// ── regenCovers.buscarSemArquivo ────────────────────────────────────────────

test('regeracao do passivo pega so quem esta no Hotmart, sem arquivo e sem backfill feito', () => {
  const db = reiniciarBanco();
  ebook(db, 'semCaminho', { hotmart_product_id: '1' });
  ebook(db, 'apagado', { hotmart_product_id: '2', cover_path: path.join(DIR, 'sumiu.png') });
  ebook(db, 'temArquivo', { hotmart_product_id: '3', cover_path: arquivo('tem.png') });
  ebook(db, 'foraDoHotmart', { hotmart_product_id: '' });
  ebook(db, 'jaEnviado', { hotmart_product_id: '5' });
  db.exec('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)');
  db.prepare("INSERT INTO cover_backfill VALUES ('5', 1, 1)").run();
  assert.deepStrictEqual(regen.buscarSemArquivo(db, 10).map(e => e.id).sort(), ['apagado', 'semCaminho']);
  assert.strictEqual(regen.buscarSemArquivo(db, 1).length, 1, 'respeita o limite');
});

// ── regenCovers.regerar ─────────────────────────────────────────────────────

function geradorFalso({ caminhos, gancho = () => true, categoria = () => 'Financas' }) {
  const chamadas = [];
  return {
    chamadas,
    mapa: {
      './coverViralAgent': {
        generateViralCover: async (...args) => { chamadas.push(args); const c = caminhos.shift(); if (c instanceof Error) throw c; return c; },
        ultimoTeveGancho: gancho,
      },
      './publisherHotmart': { getCategory: categoria },
    },
  };
}

test('regerar sem candidato nao carrega gerador', async t => {
  reiniciarBanco();
  interceptar(t, { './coverViralAgent': new Error('nao devia carregar') });
  assert.deepStrictEqual(await regen.regerar(), { total: 0, ok: 0 });
});

test('passivo: grava o caminho novo e passa idioma, categoria e opcoes certas ao gerador', async t => {
  const db = reiniciarBanco();
  ebook(db, 'en1', { hotmart_product_id: '11', title: 'Budget', subtitle: 'Sub', topic: 'tema', language: 'en' });
  ebook(db, 'x2', { hotmart_product_id: '12', title: 'Sem idioma', language: null });
  const novo = arquivo('nova.png');
  const g = geradorFalso({ caminhos: [novo, null] });
  interceptar(t, g.mapa);
  const r = await regen.regerar({ limite: 5 });
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.ok, 1);
  const porId = Object.fromEntries(g.chamadas.map(a => [a[0], a]));
  assert.deepStrictEqual(porId.Budget.slice(1, 7), ['Sub', 'tema', 'Financas', process.env.COVERS_DIR, 'en', { exigirGancho: false, exigirImagemUnica: false }]);
  assert.strictEqual(porId['Sem idioma'][5], 'pt-BR', 'sem idioma no banco a capa sai em portugues');
  assert.strictEqual(porId['Sem idioma'][1], '', 'subtitulo nulo vira vazio');
  const gravado = db.prepare("SELECT id, cover_path FROM ebooks WHERE cover_path IS NOT NULL").all();
  assert.strictEqual(gravado.length, 1);
  assert.strictEqual(gravado[0].cover_path, novo);
  assert.strictEqual(db.prepare("SELECT name FROM sqlite_master WHERE name='cover_viral_v2'").get(), undefined, 'passivo nao mexe no controle do passe TODAS');
});

test('categoria que falha ou vem vazia vira "Outros"; topico ausente usa o titulo', async t => {
  const db = reiniciarBanco();
  db.prepare("INSERT OR IGNORE INTO topics (topic) VALUES ('')").run();
  ebook(db, 'a', { hotmart_product_id: '21', title: 'Titulo A' });
  ebook(db, 'b', { hotmart_product_id: '22', title: 'Titulo B', topic: '' });
  let n = 0;
  const pedidas = [];
  const g = geradorFalso({ caminhos: [null, null], categoria: tema => { pedidas.push(tema); if (n++ === 0) throw new Error('mapa quebrado'); return ''; } });
  interceptar(t, g.mapa);
  await regen.regerar({ limite: 2 });
  assert.deepStrictEqual(g.chamadas.map(a => a[3]), ['Outros', 'Outros']);
  assert.deepStrictEqual(pedidas, ['Titulo B', 'tema'], 'topico vazio pede a categoria pelo titulo');
  assert.strictEqual(g.chamadas[0][2], 'Titulo B', 'e o titulo vira o tema do gerador');
});

test('excecao do gerador num item nao derruba o passe', async t => {
  const db = reiniciarBanco();
  ebook(db, 'a', { hotmart_product_id: '31' });
  ebook(db, 'b', { hotmart_product_id: '32' });
  const g = geradorFalso({ caminhos: [new Error('FX fora do ar'), arquivo('ok.png')] });
  interceptar(t, g.mapa);
  const r = await regen.regerar({ limite: 2 });
  assert.deepStrictEqual([r.total, r.ok], [2, 1]);
});

test('TODAS: com gancho marca concluido e reabre o upload; sem gancho conta tentativa e volta', async t => {
  const db = reiniciarBanco();
  ebook(db, 'comGancho', { hotmart_product_id: '41', cover_path: arquivo('velha1.png') });
  ebook(db, 'semArquivoGerado', { hotmart_product_id: '42', cover_path: arquivo('velha2.png') });
  ebook(db, 'imagemSemGancho', { hotmart_product_id: '43', cover_path: arquivo('velha3.png') });
  db.exec('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)');
  db.prepare("INSERT INTO cover_backfill VALUES ('41', 1, 1)").run();
  const ganchos = { [path.join(DIR, 'v1.png')]: true, [path.join(DIR, 'v3.png')]: false };
  let ultimo = null;
  // ordem de busca: rowid DESC -> imagemSemGancho, semArquivoGerado, comGancho
  const caminhos = [arquivo('v3.png'), null, arquivo('v1.png')];
  const g = geradorFalso({ caminhos: caminhos.slice(), gancho: () => ganchos[ultimo] });
  const gerar = g.mapa['./coverViralAgent'].generateViralCover;
  g.mapa['./coverViralAgent'].generateViralCover = async (...a) => { ultimo = await gerar(...a); return ultimo; };
  interceptar(t, g.mapa);
  const r = await regen.regerar({ limite: 10, todas: true });
  assert.deepStrictEqual([r.total, r.ok, r.semGancho], [3, 2, 2]);
  assert.deepStrictEqual(db.prepare('SELECT ebook_id FROM cover_viral_v2').all().map(x => x.ebook_id), ['comGancho']);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM cover_backfill WHERE produto='41'").get().n, 0, 'capa nova precisa ser reenviada');
  assert.deepStrictEqual(db.prepare('SELECT ebook_id, n FROM cover_viral_tentativas').all(), [{ ebook_id: 'semArquivoGerado', n: 1 }]);
  assert.ok(g.chamadas.every(a => a[6].exigirGancho === true && a[6].exigirImagemUnica === true));
});

test('TODAS: esgotado o teto de tentativas, a capa sai com o titulo e o livro sai da fila', async t => {
  const db = reiniciarBanco();
  ebook(db, 'teimoso', { hotmart_product_id: '51' });
  regen.garantirTabelas(db);
  db.prepare('INSERT INTO cover_viral_tentativas VALUES (?, ?, 1)').run('teimoso', regen.MAX_TENTATIVAS_GANCHO);
  const g = geradorFalso({ caminhos: [arquivo('titulo.png')], gancho: () => { throw new Error('estado de gancho indisponivel'); } });
  interceptar(t, g.mapa);
  const r = await regen.regerar({ todas: true });
  assert.strictEqual(g.chamadas[0][6].exigirGancho, false, 'no teto nao exige mais gancho');
  assert.deepStrictEqual([r.ok, r.semGancho], [1, 1]);
  assert.deepStrictEqual(db.prepare('SELECT ebook_id FROM cover_viral_v2').all(), [{ ebook_id: 'teimoso' }], 'sai da fila por teto');
});

test('TODAS sem tabela de backfill ainda: reabrir upload falha em silencio e o passe segue', async t => {
  const db = reiniciarBanco();
  ebook(db, 'a', { hotmart_product_id: '61' });
  const g = geradorFalso({ caminhos: [arquivo('z.png')] });
  interceptar(t, g.mapa);
  const r = await regen.regerar({ todas: true, limite: 1 });
  assert.strictEqual(r.ok, 1);
  assert.strictEqual(db.prepare("SELECT name FROM sqlite_master WHERE name='cover_backfill'").get(), undefined);
});

test('TODAS: falha ao contar tentativa nao derruba o passe', async t => {
  const db = reiniciarBanco();
  ebook(db, 'a', { hotmart_product_id: '71' });
  const g = geradorFalso({ caminhos: [null] });
  g.mapa['./coverViralAgent'].generateViralCover = async () => { db.exec('DROP TABLE cover_viral_tentativas'); return null; };
  interceptar(t, g.mapa);
  const r = await regen.regerar({ todas: true, limite: 1 });
  assert.deepStrictEqual([r.total, r.ok, r.semGancho], [1, 0, 1]);
});

test('pausa padrao: 4 s entre capas no passe TODAS, nenhuma no passivo', async t => {
  comAmbiente(t, { REGEN_PAUSA_MS: undefined });
  const mod = recarregar('src/agents/regenCovers.js');
  t.after(() => recarregar('src/agents/regenCovers.js'));
  const db = reiniciarBanco();
  ebook(db, 'a', { hotmart_product_id: '81' });
  ebook(db, 'b', { hotmart_product_id: '82' });
  const esperas = [];
  t.mock.method(global, 'setTimeout', (fn, ms) => { esperas.push(ms); fn(); return 0; });
  let g = geradorFalso({ caminhos: [null, null] });
  interceptar(t, g.mapa);
  await mod.regerar({ todas: true, limite: 2 });
  assert.deepStrictEqual(esperas, [4000], 'uma pausa entre as duas');
  esperas.length = 0;
  reiniciarBanco();
  ebook(db, 'c', { hotmart_product_id: '83' });
  ebook(db, 'd', { hotmart_product_id: '84' });
  g.mapa['./coverViralAgent'].generateViralCover = async () => null;
  await mod.regerar({ limite: 2 });
  assert.deepStrictEqual(esperas, [], 'passivo sem pausa');
});

// ── carga e executaveis ─────────────────────────────────────────────────────

test('sem logger os dois modulos carregam com console; sem COVERS_DIR usa o do VPS', t => {
  interceptar(t, { '../core/logger': new Error('winston ausente') });
  comAmbiente(t, { COVERS_DIR: undefined, MAX_TENTATIVAS_GANCHO: '5' });
  const r = recarregar('src/agents/regenCovers.js');
  const b = recarregar('src/agents/backfillCovers.js');
  t.after(() => { recarregar('src/agents/regenCovers.js'); recarregar('src/agents/backfillCovers.js'); });
  assert.strictEqual(r.MAX_TENTATIVAS_GANCHO, 5);
  assert.strictEqual(typeof b.backfill, 'function');
});

function executar(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'agents', script), ...args],
    { encoding: 'utf8', env: { ...process.env, METRICS_DB: ':memory:', ...env } });
}

test('executaveis: banco vazio imprime resumo zerado e sai 0 (com e sem argumentos)', () => {
  for (const [script, args] of [['backfillCovers.js', ['--limite=3', '--dry-run']], ['backfillCovers.js', []],
    ['regenCovers.js', ['--limite=2', '--todas']], ['regenCovers.js', []]]) {
    const r = executar(script, args);
    assert.strictEqual(r.status, 0, script + ' ' + r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { total: 0, ok: 0 });
  }
});

test('executaveis: banco inacessivel sai 1 com ERRO', () => {
  const invalido = path.join(DIR, 'nao', 'existe', 'metrics.db');
  for (const script of ['backfillCovers.js', 'regenCovers.js']) {
    const r = executar(script, [], { METRICS_DB: invalido });
    assert.strictEqual(r.status, 1, script);
    assert.match(r.stderr, /ERRO:/);
  }
});
