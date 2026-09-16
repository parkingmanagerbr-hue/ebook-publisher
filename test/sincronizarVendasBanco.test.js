'use strict';
/**
 * sincronizarVendas: da API do Hotmart ao banco. Complementa
 * sincronizarVendas.test.js (extrair/agregar) com paginacao, reembolso,
 * orfaos e o executavel. Rede e banco sempre falsos: fetch injetado e
 * METRICS_DB=':memory:'.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { comAmbiente, recarregar, interceptar } = require('./apoio');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vendas-'));
const TOKEN = path.join(DIR, 'token.txt');
fs.writeFileSync(TOKEN, '  bearer-de-teste \n');
process.env.METRICS_DB = ':memory:';
process.env.HOTMART_TOKEN_FILE = TOKEN;
process.env.VENDAS_JANELA_DIAS = '30';

const sv = require('../src/agents/sincronizarVendas');
const { getDb } = require('../src/core/database');
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const venda = (tx, pid, comissao, extra = {}) => ({
  product: { id: pid, name: 'Produto ' + pid },
  buyer: { name: 'Fulana', email: 'f@x.com' },
  purchase: { transaction: tx, orderDate: 1789411004000, status: 'APPROVED' },
  offer: { price: { value: 4.99 } },
  commission: { value: comissao },
  ...extra,
});

function fetchFalso(t, paginas) {
  const pedidos = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    pedidos.push({ url, auth: opts.headers.Authorization, sinal: opts.signal });
    const p = paginas[pedidos.length - 1];
    if (typeof p === 'number') return { ok: false, status: p, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => p };
  });
  return pedidos;
}

// ── extrairVenda: fronteiras ────────────────────────────────────────────────

test('venda sem oferta, comissao, nome, data ou status vira zeros e vazios, nunca NaN', () => {
  const v = sv.extrairVenda({ product: { id: 9 }, purchase: { transaction: 'T', orderDate: 'lixo' } });
  assert.deepStrictEqual(v, { transacao: 'T', produtoId: '9', produto: '', quando: 0, preco: 0, comissao: 0, status: '' });
  assert.strictEqual(sv.extrairVenda({ product: { id: 9 }, purchase: { transaction: 'T' }, offer: { price: {} }, commission: {} }).preco, 0);
});

test('agregarPorProduto pula registro nulo (venda descartada na extracao)', () => {
  const agg = sv.agregarPorProduto([null, sv.extrairVenda(venda('A', 1, 2.5)), undefined]);
  assert.deepStrictEqual([...agg.keys()], ['1']);
});

// ── buscarVendas ────────────────────────────────────────────────────────────

test('pagina ate vir lote incompleto, com janela e Bearer certos', async t => {
  const cheia = Array.from({ length: 100 }, (_, i) => venda('P1-' + i, 1, 1));
  const pedidos = fetchFalso(t, [{ data: cheia }, { data: [venda('P2', 2, 1), { purchase: {} }] }]);
  const agora = Date.parse('2026-09-15T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const todas = await buscar();
  assert.strictEqual(todas.length, 101, 'registro invalido fica de fora');
  assert.strictEqual(pedidos.length, 2);
  assert.match(pedidos[0].url, /page=1&/);
  assert.match(pedidos[1].url, /page=2&/);
  assert.ok(pedidos[0].url.includes('&startDate=' + (agora - 30 * 86400000) + '&endDate=' + agora), 'janela de 30 dias da env');
  assert.strictEqual(pedidos[0].auth, 'Bearer bearer-de-teste');
  assert.ok(pedidos[0].sinal, 'toda chamada tem timeout');
});

// buscarVendas nao e exportada: e exercitada pelo sincronizar. Este atalho
// roda o sincronizar e devolve o que foi gravado.
async function buscar() {
  await sv.sincronizar();
  return getDb().prepare('SELECT * FROM vendas_hotmart').all();
}

test('HTTP de erro do relatorio aborta sem gravar nada', async t => {
  getDb().exec('DROP TABLE IF EXISTS vendas_hotmart');
  fetchFalso(t, [401]);
  await assert.rejects(() => sv.sincronizar(), /HTTP 401/);
  assert.strictEqual(getDb().prepare("SELECT name FROM sqlite_master WHERE name='vendas_hotmart'").get(), undefined);
});

test('resposta sem data (null) conta como zero vendas', async t => {
  fetchFalso(t, [null]);
  const r = await sv.sincronizar();
  assert.deepStrictEqual({ ...r, orfaos: r.orfaos.length }, { vendas: 0, suspeitas: 0, produtos: 0, receita: 0, orfaos: 0 });
});

test('para em 50 paginas mesmo que a API nunca devolva lote incompleto', async t => {
  const cheia = n => ({ data: Array.from({ length: 100 }, (_, i) => venda(n + '-' + i, 5, 0)) });
  const pedidos = fetchFalso(t, Array.from({ length: 60 }, (_, i) => cheia('pg' + i)));
  const r = await sv.sincronizar();
  assert.strictEqual(pedidos.length, 50);
  assert.strictEqual(r.vendas, 5000);
});

// ── sincronizar: banco ──────────────────────────────────────────────────────

test('rajada de teste de cartao e gravada como suspeita e nao conta venda nem receita', async t => {
  const db = prepararEbooks();
  // tres produtos no mesmo segundo (padrao do robo de 15/09) e uma venda isolada 1 dia depois
  const isolada = venda('Z9', 222, 2, { purchase: { transaction: 'Z9', orderDate: 1789411004000 + 86400000, status: 'APPROVED' } });
  fetchFalso(t, [{ data: [venda('R1', 111, 3), venda('R2', 222, 3), venda('R3', 333, 3), isolada] }]);
  const r = await sv.sincronizar();
  // receita do resumo e o dinheiro que entrou (suspeita inclusa ate um eventual
  // estorno); o que sai e a contagem por produto, que alimenta o aprendizado
  assert.deepStrictEqual([r.vendas, r.suspeitas, r.produtos, r.receita], [4, 3, 1, 11]);
  const marcadas = db.prepare('SELECT transacao, suspeita FROM vendas_hotmart ORDER BY transacao').all();
  assert.deepStrictEqual(marcadas.map(m => [m.transacao, m.suspeita]), [['R1', 1], ['R2', 1], ['R3', 1], ['Z9', 0]]);
  const conta = Object.fromEntries(db.prepare('SELECT id, sales_count FROM ebooks').all().map(x => [x.id, x.sales_count]));
  assert.deepStrictEqual([conta.a, conta.b], [0, 1], 'so a venda isolada conta');

  // segunda sincronizacao: coluna ja existe e a marca e atualizada, sem duplicar
  fetchFalso(t, [{ data: [isolada] }]);
  const r2 = await sv.sincronizar();
  assert.strictEqual(r2.suspeitas, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM vendas_hotmart').get().n, 4);
});

function prepararEbooks() {
  const db = getDb();
  db.exec('DELETE FROM ebooks; DROP TABLE IF EXISTS vendas_hotmart;');
  const ins = db.prepare("INSERT INTO topics (topic) VALUES (?) ON CONFLICT DO NOTHING");
  ins.run('t');
  db.prepare("INSERT INTO ebooks (id, topic, title, hotmart_product_id, sales_count, revenue) VALUES ('a','t','A','111', 9, 99)").run();
  db.prepare("INSERT INTO ebooks (id, topic, title, hotmart_product_id, sales_count, revenue) VALUES ('b','t','B','222', 3, 30)").run();
  db.prepare("INSERT INTO ebooks (id, topic, title, sales_count) VALUES ('c','t','C sem Hotmart', 4)").run();
  return db;
}

test('grava vendas, recontando do zero: quem nao vendeu na lista atual volta a zero', async t => {
  const db = prepararEbooks();
  fetchFalso(t, [{ data: [venda('X1', 111, 3.99), venda('X2', 111, 3.99), venda('X3', 999, 1.5, { product: { id: 999, name: 'Copia manual japonesa com titulo bem comprido para cortar em cinquenta' } })] }]);
  const r = await sv.sincronizar();
  assert.strictEqual(r.vendas, 3);
  assert.strictEqual(r.produtos, 2);
  assert.strictEqual(r.receita, 9.48);
  assert.deepStrictEqual(r.orfaos, [{ produtoId: '999', produto: 'Copia manual japonesa com titulo bem comprido para cortar em cinquenta', vendas: 1 }]);
  const linhas = Object.fromEntries(db.prepare('SELECT id, sales_count, revenue FROM ebooks').all().map(x => [x.id, [x.sales_count, x.revenue]]));
  assert.deepStrictEqual(linhas, { a: [2, 7.98], b: [0, 0], c: [4, 0] }, 'sem produto no Hotmart nao e zerado');
  const gravadas = db.prepare('SELECT * FROM vendas_hotmart ORDER BY transacao').all();
  assert.strictEqual(gravadas.length, 3);
  assert.ok(!JSON.stringify(gravadas).includes('Fulana'), 'dado do comprador nao vai para o banco');
});

test('COPIA DUPLICADA: venda da copia conta no produto que ficou e guarda o id original', async t => {
  const db = prepararEbooks();
  db.prepare('CREATE TABLE IF NOT EXISTS hotmart_copias (copia TEXT PRIMARY KEY, canonico TEXT)').run();
  db.prepare("INSERT OR REPLACE INTO hotmart_copias VALUES ('999', '111')").run();
  try {
    fetchFalso(t, [{ data: [venda('C1', 999, 4), venda('C2', 111, 4)] }]);
    const r = await sv.sincronizar();
    assert.deepStrictEqual(r.orfaos, []);
    assert.strictEqual(db.prepare("SELECT sales_count FROM ebooks WHERE id='a'").get().sales_count, 2);
    const c1 = db.prepare("SELECT produto_id, produto_original FROM vendas_hotmart WHERE transacao='C1'").get();
    assert.deepStrictEqual({ ...c1 }, { produto_id: '111', produto_original: '999' });
    assert.strictEqual(db.prepare("SELECT produto_original FROM vendas_hotmart WHERE transacao='C2'").get().produto_original, null);
  } finally {
    db.prepare('DROP TABLE hotmart_copias').run();
  }
});

test('REEMBOLSO: venda que sai da lista deixa de contar; transacao repetida atualiza status', async t => {
  const db = prepararEbooks();
  fetchFalso(t, [{ data: [venda('R1', 222, 4), venda('R2', 222, 4)] }, { data: [venda('R1', 222, 4, { purchase: { transaction: 'R1', status: 'COMPLETE' } })] }]);
  await sv.sincronizar();
  assert.strictEqual(db.prepare("SELECT sales_count FROM ebooks WHERE id='b'").get().sales_count, 2);
  await sv.sincronizar();
  assert.strictEqual(db.prepare("SELECT sales_count FROM ebooks WHERE id='b'").get().sales_count, 1, 'R2 reembolsada nao conta mais');
  assert.strictEqual(db.prepare("SELECT status FROM vendas_hotmart WHERE transacao='R1'").get().status, 'COMPLETE');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM vendas_hotmart').get().n, 2, 'historico da transacao fica; a contagem vem da lista atual');
});

// ── carga do modulo ─────────────────────────────────────────────────────────

test('sem as variaveis, usa o token do VPS e janela de 365 dias', async t => {
  comAmbiente(t, { HOTMART_TOKEN_FILE: undefined, VENDAS_JANELA_DIAS: undefined });
  const mod = recarregar('src/agents/sincronizarVendas.js');
  const lerOriginal = fs.readFileSync;
  const lidos = [];
  t.mock.method(fs, 'readFileSync', (p, ...r) => {
    if (p === '/app/data/hotmart_access_token.txt') { lidos.push(p); return 'tok-vps'; }
    return lerOriginal(p, ...r);
  });
  const agora = Date.parse('2026-09-15T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const pedidos = fetchFalso(t, [{ data: [] }]);
  await mod.sincronizar();
  assert.deepStrictEqual(lidos, ['/app/data/hotmart_access_token.txt']);
  assert.ok(pedidos[0].url.includes('&startDate=' + (agora - 365 * 86400000) + '&'));
  assert.strictEqual(pedidos[0].auth, 'Bearer tok-vps');
});

test('sem logger (winston ausente) o modulo carrega e usa o console', t => {
  interceptar(t, { '../core/logger': new Error('winston ausente') });
  const mod = recarregar('src/agents/sincronizarVendas.js');
  t.after(() => recarregar('src/agents/sincronizarVendas.js'));
  assert.strictEqual(typeof mod.extrairVenda, 'function');
});

// ── executavel ──────────────────────────────────────────────────────────────

function rodar(env) {
  const preload = path.join(DIR, 'fetch-falso.js');
  fs.writeFileSync(preload, "globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ product: { id: 7, name: 'P' }, purchase: { transaction: 'CLI1', status: 'APPROVED' }, commission: { value: 2 } }] }) });\n");
  return spawnSync(process.execPath, ['-r', preload, path.join(__dirname, '..', 'src', 'agents', 'sincronizarVendas.js')],
    { encoding: 'utf8', env: { ...process.env, METRICS_DB: ':memory:', ...env } });
}

test('executavel imprime o resumo em JSON e sai 0', () => {
  const r = rodar({ HOTMART_TOKEN_FILE: TOKEN });
  assert.strictEqual(r.status, 0, r.stderr);
  const ultima = r.stdout.trim().split('\n').pop();
  assert.deepStrictEqual(JSON.parse(ultima), { vendas: 1, suspeitas: 0, produtos: 1, receita: 2, orfaos: [{ produtoId: '7', produto: 'P', vendas: 1 }] });
});

test('executavel sem token sai 1 com a mensagem de erro', () => {
  const r = rodar({ HOTMART_TOKEN_FILE: path.join(DIR, 'nao-existe.txt') });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /ERRO: ENOENT/);
});
