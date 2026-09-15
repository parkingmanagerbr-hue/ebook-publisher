'use strict';
/**
 * publishBacklog: selecao de pendentes, publicacao por loja e o lote.
 * Complementa publishBacklog.test.js (reserva, contador, sessaoMorta).
 *
 * Dinheiro em jogo: produto duplicado em marketplace nao se desfaz, e produto
 * sem capa entra uma vez so. Lojas falsas (interceptadas); banco :memory:
 * pelo database.js real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { interceptar, recarregar, comAmbiente } = require('./apoio');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-'));
process.env.METRICS_DB = ':memory:';
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { getDb } = require('../src/core/database');
const pb = require('../src/agents/publishBacklog');

const arquivo = nome => { const p = path.join(DIR, nome); fs.writeFileSync(p, 'x'); return p; };

function reiniciar() {
  const db = getDb();
  db.exec('DELETE FROM ebooks; DROP TABLE IF EXISTS publish_claims; DROP TABLE IF EXISTS publish_failures;');
  db.prepare("INSERT OR IGNORE INTO topics (topic) VALUES ('t')").run();
  return db;
}

let seq = 0;
function ebook(db, extra = {}) {
  const id = extra.id || 'e' + (++seq);
  const l = { id, title: 'Livro ' + id, pdf_path: arquivo(id + '.pdf'), cover_path: arquivo(id + '.png'), hotmart_url: null, cakto_url: null, price: 4.99, language: 'pt-BR', ...extra };
  db.prepare("INSERT INTO ebooks (id, topic, title, subtitle, description, pdf_path, cover_path, hotmart_url, cakto_url, price, language) VALUES (@id, 't', @title, 'sub', 'desc', @pdf_path, @cover_path, @hotmart_url, @cakto_url, @price, @language)").run(l);
  return id;
}

// ── comLimite ───────────────────────────────────────────────────────────────

test('REGRESSAO: item que lanca algo que nao e Error nao derruba o lote inteiro', async () => {
  // "throw 'texto'" ou "throw null" faziam o catch ler e.message.slice e
  // lancar de novo: Promise.all rejeitava e os outros itens perdiam o resultado.
  const r = await pb.comLimite([1, 2, 3], 1, async n => {
    if (n === 1) throw 'sessao caiu';
    if (n === 2) throw null;
    return n;
  });
  assert.deepStrictEqual(r, [{ ok: false, motivo: 'sessao caiu' }, { ok: false, motivo: 'null' }, 3]);
});

// ── esgotado sem tabela ─────────────────────────────────────────────────────

test('esgotado em banco sem a tabela de falhas responde "nao" em vez de lancar', () => {
  const Database = require('better-sqlite3');
  assert.strictEqual(pb.esgotado(new Database(':memory:'), 'x', 'hotmart'), false);
});

test('registrarFalha guarda motivo ausente como vazio', () => {
  const db = reiniciar();
  pb.registrarFalha(db, 'm', 'cakto', undefined);
  assert.strictEqual(db.prepare('SELECT ultimo_motivo FROM publish_failures').get().ultimo_motivo, '');
});

// ── buscarPendentes ─────────────────────────────────────────────────────────

test('pendentes: so sem URL na loja, com PDF e capa em disco, sem titulo ja publicado', () => {
  const db = reiniciar();
  const ok = ebook(db);
  ebook(db, { hotmart_url: 'https://hotmart/x' });                       // ja publicado
  ebook(db, { title: 'Titulo repetido', hotmart_url: 'https://h/1' });
  ebook(db, { title: 'Titulo repetido' });                               // copia do que ja esta no ar
  ebook(db, { pdf_path: path.join(DIR, 'sumiu.pdf') });                  // PDF apagado
  ebook(db, { cover_path: path.join(DIR, 'sumiu.png') });                // capa apagada
  ebook(db, { cover_path: '' });                                         // sem capa (SQL)
  ebook(db, { cover_path: null });
  assert.deepStrictEqual(pb.buscarPendentes('hotmart', 10).map(e => e.id), [ok]);
});

test('pendentes do Cakto olham cakto_url, nao hotmart_url', () => {
  const db = reiniciar();
  const soHotmart = ebook(db, { hotmart_url: 'https://h' });
  ebook(db, { cakto_url: 'https://c' });
  assert.deepStrictEqual(pb.buscarPendentes('cakto', 10).map(e => e.id), [soHotmart]);
});

test('pendentes: pula esgotado e reservado por outro lote, e para no limite', () => {
  const db = reiniciar();
  const a = ebook(db);
  const b = ebook(db);
  const c = ebook(db);
  const queimado = ebook(db);   // mais recentes: sao vistos (e pulados) antes
  const reservado = ebook(db);
  pb.garantirTabelaFalhas(db);
  for (let i = 0; i < 3; i++) pb.registrarFalha(db, queimado, 'hotmart', 'No product ID after creation');
  pb.garantirTabela(db);
  pb.reservar(db, reservado, 'hotmart');
  const r = pb.buscarPendentes('hotmart', 2).map(e => e.id);
  assert.deepStrictEqual(r, [c, b], 'mais recentes primeiro, dentro do limite');
  assert.strictEqual(pb.reservar(db, c, 'hotmart'), false, 'o que foi devolvido ficou reservado');
  assert.strictEqual(pb.reservar(db, a, 'hotmart'), true, 'o que nao coube no limite continua livre');
});

test('pendentes: PDF nulo no banco conta como sem arquivo', () => {
  const db = reiniciar();
  db.prepare("INSERT INTO ebooks (id, topic, title, pdf_path, cover_path) VALUES ('n', 't', 'N', NULL, ?)").run(arquivo('n.png'));
  assert.deepStrictEqual(pb.buscarPendentes('hotmart', 5), []);
});

// ── publicarBacklog ─────────────────────────────────────────────────────────

function lojas({ hotmart, cakto }) {
  const chamadas = { hotmart: [], cakto: [] };
  return {
    chamadas,
    mapa: {
      './publisherHotmart': { publishToHotmart: async d => { chamadas.hotmart.push(d); return hotmart(d); } },
      './publisherCakto': { publishToCakto: async d => { chamadas.cakto.push(d); return cakto(d); } },
    },
  };
}

test('lote vazio nao carrega loja', async t => {
  reiniciar();
  interceptar(t, { './publisherHotmart': new Error('nao devia carregar') });
  assert.deepStrictEqual(await pb.publicarBacklog(), { total: 0, ok: 0 });
});

test('Hotmart: URL publica e grava; so id grava o id (rascunho) para nao duplicar; erro libera e conta falha', async t => {
  const db = reiniciar();
  const semUrl = ebook(db, { title: 'Sem nada' });
  const erro = ebook(db, { title: 'Com erro' });
  const rascunho = ebook(db, { title: 'Rascunho' });
  const publicado = ebook(db, { title: 'Publicado' });
  const nulo = ebook(db, { title: 'Nulo' });
  const L = lojas({ hotmart: d => ({
    Publicado: { url: 'https://hotmart.com/p/1', hotmartProductId: '8419956' },
    Rascunho: { hotmartProductId: '8419962' },
    'Com erro': { error: 'Pricing save timeout' },
    'Sem nada': {},
    Nulo: null,
  })[d.title] });
  interceptar(t, L.mapa);
  const r = await pb.publicarBacklog({ plataforma: 'HOTMART', limite: '10', paralelo: '2' });
  assert.deepStrictEqual([r.total, r.ok], [5, 1]);
  const linha = id => db.prepare('SELECT status, hotmart_url, hotmart_product_id FROM ebooks WHERE id = ?').get(id);
  assert.deepStrictEqual(linha(publicado), { status: 'published', hotmart_url: 'https://hotmart.com/p/1', hotmart_product_id: '8419956' });
  assert.deepStrictEqual(linha(rascunho), { status: 'published', hotmart_url: null, hotmart_product_id: '8419962' });
  assert.strictEqual(linha(erro).hotmart_product_id, null);
  const falhas = Object.fromEntries(db.prepare('SELECT chave, falhas, ultimo_motivo FROM publish_failures').all().map(f => [f.chave, f.ultimo_motivo]));
  assert.strictEqual(falhas['hotmart:' + erro], 'Pricing save timeout');
  assert.strictEqual(falhas['hotmart:' + semUrl], 'sem url');
  assert.strictEqual(falhas['hotmart:' + nulo], 'sem url');
  assert.match(falhas['hotmart:' + rascunho], /rascunho criado \(id=8419962\)/);
  const reservas = db.prepare('SELECT chave FROM publish_claims').all().map(x => x.chave).sort();
  assert.deepStrictEqual(reservas, ['hotmart:' + publicado].sort(), 'falha devolve o item para a fila; sucesso mantem a reserva');
  const d = L.chamadas.hotmart.find(x => x.title === 'Publicado');
  assert.deepStrictEqual(Object.keys(d).sort(), ['coverPath', 'description', 'language', 'pdfPath', 'price', 'subtitle', 'title', 'topic']);
});

test('Cakto publica um por vez mesmo pedindo paralelo, e grava URL e id', async t => {
  const db = reiniciar();
  const a = ebook(db, { title: 'A' });
  ebook(db, { title: 'B' });
  ebook(db, { title: 'C' });
  let ativos = 0, pico = 0;
  const L = lojas({ cakto: async d => {
    ativos++; pico = Math.max(pico, ativos);
    await new Promise(r => setImmediate(r));
    ativos--;
    if (d.title === 'A') return { url: 'https://pay.cakto.com.br/a', caktoProductId: 'CA' };
    if (d.title === 'B') return { error: 'login 2FA' };
    return null;
  } });
  interceptar(t, L.mapa);
  const r = await pb.publicarBacklog({ plataforma: 'cakto', limite: 5, paralelo: 8 });
  assert.strictEqual(pico, 1, '2FA do Cakto nao suporta login simultaneo');
  assert.deepStrictEqual([r.total, r.ok], [3, 1]);
  assert.deepStrictEqual(db.prepare('SELECT cakto_url, cakto_product_id FROM ebooks WHERE id = ?').get(a), { cakto_url: 'https://pay.cakto.com.br/a', cakto_product_id: 'CA' });
});

test('REGRESSAO: sessao morta aborta o resto sem chamar a loja, sem contar falha e devolvendo TODAS as reservas', async t => {
  const db = reiniciar();
  for (let i = 0; i < 4; i++) ebook(db);
  const L = lojas({ hotmart: () => { throw new Error('eBook card not found after 90s -- wizard not rendered. URL: https://sso.hotmart.com/login'); } });
  interceptar(t, L.mapa);
  const r = await pb.publicarBacklog({ plataforma: 'hotmart', limite: 4, paralelo: 1 });
  assert.strictEqual(L.chamadas.hotmart.length, 1, 'os outros 3 nao gastam 90 s cada');
  assert.deepStrictEqual([r.total, r.ok], [4, 0]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM publish_failures').get().n, 0, 'queda de sessao nao envenena o contador');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM publish_claims').get().n, 0, 'todos voltam para a fila');
});

test('publisher que lanca algo que nao e Error vira falha com motivo legivel', async t => {
  const db = reiniciar();
  const id = ebook(db);
  interceptar(t, lojas({ hotmart: () => { throw 'timeout do navegador'; } }).mapa);
  const r = await pb.publicarBacklog({ limite: 1 });
  assert.strictEqual(r.ok, 0);
  assert.strictEqual(db.prepare('SELECT ultimo_motivo FROM publish_failures WHERE chave = ?').get('hotmart:' + id).ultimo_motivo, 'timeout do navegador');
});

test('paralelo invalido ou zero cai para pelo menos 1', async t => {
  const db = reiniciar();
  ebook(db);
  interceptar(t, lojas({ hotmart: () => ({ url: 'u' }) }).mapa);
  const r = await pb.publicarBacklog({ plataforma: 'hotmart', limite: 1, paralelo: '0' });
  assert.strictEqual(r.ok, 1);
});

// ── carga e executavel ──────────────────────────────────────────────────────

test('sem logger carrega com console; teto de reserva e de falhas vem da env', t => {
  interceptar(t, { '../core/logger': new Error('winston ausente') });
  comAmbiente(t, { PUBLISH_MAX_FALHAS: '1', PUBLISH_CLAIM_MINUTES: '1' });
  const mod = recarregar('src/agents/publishBacklog.js');
  t.after(() => recarregar('src/agents/publishBacklog.js'));
  const db = reiniciar();
  mod.registrarFalha(db, 'x', 'hotmart', 'erro proprio');
  assert.strictEqual(mod.esgotado(db, 'x', 'hotmart'), true, 'com teto 1, uma falha basta');
  mod.garantirTabela(db);
  db.prepare('INSERT INTO publish_claims VALUES (?, ?)').run('hotmart:y', Date.now() - 2 * 60 * 1000);
  assert.strictEqual(mod.reservar(db, 'y', 'hotmart'), true, 'reserva de 2 min vence com teto de 1 min');
});

function executar(args, env = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'agents', 'publishBacklog.js'), ...args],
    { encoding: 'utf8', env: { ...process.env, METRICS_DB: ':memory:', ...env } });
}

test('executavel: sem pendente imprime resumo zerado e sai 0; banco inacessivel sai 1', () => {
  for (const args of [['--plataforma=cakto', '--limite=2', '--paralelo=1'], []]) {
    const r = executar(args);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { total: 0, ok: 0 });
  }
  const r = executar([], { METRICS_DB: path.join(DIR, 'nao', 'existe.db') });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /ERRO:/);
});
