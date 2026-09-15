'use strict';
/**
 * Fila em memoria e orquestrador do painel de publicacao.
 *
 * Duas regras protegem dinheiro aqui: uma loja publica UM e-book por vez
 * (dois Puppeteer no mesmo painel ja criaram produto duplicado) e um e-book que
 * falhou tem de poder voltar para a fila sem reiniciar o servidor. As lojas sao
 * falsas (sem navegador); repositorio falso em memoria.
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const { PublishingQueue, InMemoryQueue } = require('../src/infrastructure/queue/PublishingQueue');
const { PublishingOrchestrator } = require('../src/application/orchestrator/PublishingOrchestrator');
const { PublishCommand } = require('../src/application/commands/PublishCommand');
const { Ebook } = require('../src/domain/entities/Ebook');

const novaFilaGeral = () => new PublishingQueue.constructor();

// ── InMemoryQueue ───────────────────────────────────────────────────────────

test('fila recusa o mesmo e-book enquanto ele espera ou esta ativo', async () => {
  const q = new InMemoryQueue('t');
  const eventos = [];
  q.on('added', j => eventos.push(j.id));
  assert.ok(await q.add('j1', { ebookId: 'A' }));
  assert.strictEqual(await q.add('j1b', { ebookId: 'A' }), null, 'esperando');
  q.markActive('j1');
  assert.strictEqual(await q.add('j1c', { ebookId: 'A' }), null, 'ativo');
  assert.ok(await q.add('j2', { ebookId: 'B' }), 'outro e-book entra');
  assert.deepStrictEqual(eventos, ['j1', 'j2']);
  assert.strictEqual(q.size, 2);
});

test('falha na primeira tentativa volta para a fila; na segunda fica como falha', () => {
  const q = new InMemoryQueue('t');
  q.add('j', { ebookId: 'A' });
  q.markActive('j');
  let falhas = 0;
  q.on('failed', () => falhas++);
  q.markFailed('j', new Error('timeout'));
  let j = q.getJobs()[0];
  assert.deepStrictEqual([j.status, j.attempts, j.error, j.startedAt], ['waiting', 1, 'timeout', null]);
  q.markFailed('j', 'erro em texto');
  j = q.getJobs()[0];
  assert.deepStrictEqual([j.status, j.attempts, j.error], ['failed', 2, 'erro em texto']);
  assert.strictEqual(falhas, 2);
  assert.strictEqual(q.size, 0);
});

test('REGRESSAO: e-book que esgotou as tentativas pode ser enfileirado de novo', async () => {
  // A deduplicacao olhava a lista inteira, inclusive falhas antigas: depois de
  // uma queda de sessao o e-book nunca mais entrava (add devolvia null e o
  // painel ainda contava como "enfileirado") ate reiniciar o servidor.
  const q = new InMemoryQueue('t');
  await q.add('hotmart-A', { ebookId: 'A' });
  q.markFailed('hotmart-A', new Error('sessao'));
  q.markFailed('hotmart-A', new Error('sessao'));
  const novo = await q.add('hotmart-A', { ebookId: 'A' });
  assert.ok(novo, 'tem de aceitar o e-book de volta');
  // O id se repete (loja + e-book). O registro antigo nao pode continuar la,
  // senao markActive/markCompleted achariam o antigo e o novo ficaria preso.
  q.markActive('hotmart-A');
  assert.strictEqual(novo.status, 'active');
  assert.strictEqual(q.getJobs().length, 1);
});

test('e-book concluido tambem pode voltar (republicar) sem duplicar o registro', async () => {
  const q = new InMemoryQueue('t');
  await q.add('x', { ebookId: 'A' });
  q.markCompleted('x', { ok: true });
  assert.ok(await q.add('x', { ebookId: 'A' }));
  assert.strictEqual(q.getJobs().length, 1);
  assert.strictEqual(q.getJobs()[0].status, 'waiting');
});

test('historico guarda so os 20 concluidos mais recentes', async () => {
  const q = new InMemoryQueue('t');
  const concluidos = [];
  q.on('completed', j => concluidos.push(j.id));
  for (let i = 0; i < 22; i++) { await q.add('j' + i, { ebookId: 'e' + i }); q.markCompleted('j' + i, { i }); }
  const ids = q.getJobs().map(j => j.id);
  assert.strictEqual(ids.length, 20);
  assert.ok(!ids.includes('j0') && !ids.includes('j1'), 'os mais antigos saem');
  assert.ok(ids.includes('j21'));
  assert.strictEqual(concluidos.length, 22);
});

test('progresso e marcacoes em job inexistente nao quebram', () => {
  const q = new InMemoryQueue('t');
  q.add('j', { ebookId: 'A' });
  let prog = null;
  q.on('progress', j => { prog = j.progress; });
  q.updateProgress('j', 40);
  assert.strictEqual(prog, 40);
  for (const f of ['markActive', 'updateProgress', 'markCompleted', 'markFailed'])
    assert.doesNotThrow(() => q[f]('fantasma', new Error('x')));
  assert.strictEqual(q.getJobs()[0].status, 'waiting');
});

test('clear esvazia e avisa', () => {
  const q = new InMemoryQueue('t');
  q.add('j', { ebookId: 'A' });
  let avisou = false;
  q.on('cleared', () => { avisou = true; });
  q.clear();
  assert.deepStrictEqual([q.getJobs().length, avisou], [0, true]);
});

// ── PublishingQueue (fila por loja) ─────────────────────────────────────────

test('enfileirar em loja desconhecida e erro; id do job e loja-ebook', async () => {
  const f = novaFilaGeral();
  await assert.rejects(() => f.enqueue('shopee', 'A', {}), /Unknown platform: shopee/);
  const j = await f.enqueue('cakto', 'A', { title: 'T' });
  assert.strictEqual(j.id, 'cakto-A');
  assert.deepStrictEqual(j.data, { ebookId: 'A', title: 'T' });
  assert.strictEqual(f.getQueue('cakto').size, 1);
});

test('getStatus separa ativo, esperando, concluido e falho por loja', async () => {
  const f = novaFilaGeral();
  await f.enqueue('hotmart', 'A', { title: 'A' });
  await f.enqueue('hotmart', 'B', { title: 'B' });
  await f.enqueue('hotmart', 'C', { title: 'C' });
  await f.enqueue('hotmart', 'D', { title: 'D' });
  const q = f.getQueue('hotmart');
  q.markActive('hotmart-A'); q.updateProgress('hotmart-A', 30);
  q.markCompleted('hotmart-C', {});
  q.markFailed('hotmart-D', new Error('x')); q.markFailed('hotmart-D', new Error('x'));
  const s = f.getStatus();
  assert.deepStrictEqual(s.hotmart, {
    size: 2,
    active: [{ id: 'A', title: 'A', status: 'active', progress: 30 }],
    waiting: [{ id: 'B', title: 'B', status: 'waiting', progress: 0 }],
    completed: 1, failed: 1,
  });
  assert.deepStrictEqual(s.amazon, { size: 0, active: [], waiting: [], completed: 0, failed: 0 });
});

test('clearQueue limpa uma loja, todas, e ignora loja desconhecida; on() so escuta loja existente', async () => {
  const f = novaFilaGeral();
  let limpou = 0;
  f.on('hotmart', 'cleared', () => limpou++);
  assert.doesNotThrow(() => f.on('shopee', 'cleared', () => {}));
  await f.enqueue('hotmart', 'A', {});
  await f.enqueue('cakto', 'A', {});
  f.clearQueue('cakto');
  assert.deepStrictEqual([f.getQueue('hotmart').size, f.getQueue('cakto').size], [1, 0]);
  assert.doesNotThrow(() => f.clearQueue('shopee'));
  f.clearQueue();
  assert.strictEqual(f.getQueue('hotmart').size, 0);
  assert.strictEqual(limpou, 1);
});

// ── PublishCommand ──────────────────────────────────────────────────────────

test('comando valida tipo, e-book obrigatorio no single e loja valida', () => {
  assert.throws(() => new PublishCommand('todos'), /Invalid command type/);
  assert.throws(() => new PublishCommand('single', {}), /requires ebookId/);
  assert.throws(() => PublishCommand.batch(['hotmart', 'shopee']), /Invalid store: shopee/);
  const s = PublishCommand.single('E1');
  assert.deepStrictEqual([s.type, s.ebookId, s.stores, s.requestedBy], ['single', 'E1', ['hotmart', 'cakto'], 'api']);
  const b = new PublishCommand('batch');
  assert.deepStrictEqual([b.ebookId, b.stores, b.limit, b.requestedBy], [null, ['hotmart', 'cakto'], 50, 'system']);
  const j = PublishCommand.batch(['amazon'], 5, 'cron').toJSON();
  assert.deepStrictEqual({ ...j, createdAt: undefined }, { type: 'batch', ebookId: null, stores: ['amazon'], limit: 5, requestedBy: 'cron', createdAt: undefined });
  assert.ok(Date.parse(j.createdAt));
  assert.strictEqual(PublishCommand.batch().limit, 50);
});

// ── PublishingOrchestrator ──────────────────────────────────────────────────

function repoFalso(ebooks) {
  const mapa = new Map(ebooks.map(e => [e.id, e]));
  return {
    marcados: [],
    async findById(id) { if (id === 'explode') throw new Error('banco travado'); return mapa.get(id) || null; },
    async findPendingForPlatform(store, limit) { return [...mapa.values()].filter(e => !e.isPublishedOn(store)).slice(0, limit); },
    async markPublished(id, store, pid, url) { this.marcados.push([id, store, pid, url]); },
    async getStats() { return { total: mapa.size }; },
  };
}

function orquestrador(ebooks, publicar) {
  const repo = repoFalso(ebooks);
  const o = new PublishingOrchestrator(repo);
  o.queue = novaFilaGeral();
  o.pausaEntreEbooksMs = 0;
  const chamadas = [];
  const agente = loja => ({ publish: async (e, onProgress) => { chamadas.push([loja, e.id]); return publicar(loja, e, onProgress); } });
  o.agents = { hotmart: agente('hotmart'), cakto: agente('cakto'), amazon: agente('amazon') };
  const logs = [];
  o.on('log', l => logs.push(l));
  return { o, repo, chamadas, logs };
}

const fimDaFila = (o, loja) => new Promise(r => o.on('log', l => { if (l.message === `${loja} queue exhausted`) r(); }));
const livro = (id, extra = {}) => new Ebook({ id, title: 'Livro ' + id + ' completo', pdfPath: '/p/' + id + '.pdf', ...extra });

test('lote enfileira os validos, pula os invalidos e publica em sequencia', async () => {
  const ok = { success: true, productId: 'P', url: 'https://u' };
  const { o, repo, chamadas, logs } = orquestrador([livro('A'), livro('B'), new Ebook({ id: 'curto', title: 'x', pdfPath: '/p' })],
    async (loja, e, onProgress) => { onProgress(50, 'metade'); return { ...ok, productId: 'P-' + e.id }; });
  const atualizados = [];
  o.on('ebook_updated', d => atualizados.push(d.id));
  const fim = fimDaFila(o, 'hotmart');
  const r = await o.publishBatch(['hotmart']);
  assert.deepStrictEqual(r, { queued: 2, skipped: 1 });
  await fim;
  assert.deepStrictEqual(chamadas.map(c => c[1]).sort(), ['A', 'B']);
  assert.deepStrictEqual(repo.marcados.map(m => m[2]).sort(), ['P-A', 'P-B']);
  assert.deepStrictEqual(atualizados.sort(), ['A', 'B']);
  assert.ok(logs.some(l => l.message === 'metade'), 'progresso da loja chega ao painel');
  assert.ok(logs.every(l => l.ts), 'todo evento leva horario');
  assert.ok(o.getStatus().lastPublished.hotmart);
  assert.strictEqual(o.getStatus().processing.hotmart, false);
});

test('o processamento pula e-book ja publicado, sumido ou com erro de banco, sem travar a loja', async () => {
  const ja = livro('ja');
  const { o, chamadas } = orquestrador([ja], async () => ({ success: true, productId: 'X', url: 'u' }));
  const q = o.queue.getQueue('cakto');
  await q.add('c-sumido', { ebookId: 'sumido' });
  await q.add('c-explode', { ebookId: 'explode' });
  await q.add('c-ja', { ebookId: 'ja' });
  ja.markPublished('cakto', 'C-JA', 'u');
  const fim = fimDaFila(o, 'cakto');
  o._startProcessing('cakto');
  o._startProcessing('cakto'); // segunda chamada nao abre outro laco
  await fim;
  assert.deepStrictEqual(chamadas, [], 'nada foi publicado');
  const st = o.getQueueStatus().cakto;
  assert.strictEqual(st.failed, 2, 'sumido e erro de banco terminam como falha (apos 2 tentativas)');
  assert.strictEqual(st.completed, 1);
});

test('falha da loja marca o job como falho com a mensagem da loja ou "Unknown error"', async () => {
  const { o, logs } = orquestrador([livro('A'), livro('B'), livro('C')], async (loja, e) => {
    if (e.id === 'A') return { success: false, error: 'Pricing save timeout' };
    if (e.id === 'B') return { success: false };
    throw new Error('navegador caiu');
  });
  const fim = fimDaFila(o, 'hotmart');
  await o.publishBatch(['hotmart']);
  await fim;
  const erros = logs.filter(l => l.level === 'error').map(l => l.message);
  assert.ok(erros.includes('Failed: Pricing save timeout'));
  assert.ok(erros.includes('Failed: Unknown error'));
  assert.ok(erros.includes('Failed: navegador caiu'), 'excecao da loja vira falha, nao derruba o laco');
  assert.strictEqual(o.getQueueStatus().hotmart.failed, 3);
});

test('listener do painel que lanca nao deixa a loja presa como "processando"', async () => {
  const { o } = orquestrador([livro('A')], async () => ({ success: true, productId: 'P', url: 'u' }));
  await o.queue.enqueue('amazon', 'A', {});
  o.on('queue', () => { throw new Error('socket fechado'); });
  o._startProcessing('amazon');
  assert.strictEqual(o.getStatus().processing.amazon, true);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(o.getStatus().processing.amazon, false, 'o erro fora do item nao pode prender a loja');
});

test('REGRESSAO: cancelar a fila no meio de uma publicacao nao abre um segundo navegador na mesma loja', async () => {
  // cancelQueue zerava _processing enquanto o laco ainda esperava a loja
  // responder. O proximo lote via "nao esta processando" e abria outro laco:
  // duas publicacoes simultaneas no mesmo painel.
  let ativos = 0, pico = 0;
  let liberarA;
  const { o, chamadas } = orquestrador([livro('A'), livro('B')], (loja, e) => {
    ativos++; pico = Math.max(pico, ativos);
    const fim = () => { ativos--; return { success: true, productId: 'P-' + e.id, url: 'u' }; };
    if (e.id === 'A') return new Promise(r => { liberarA = () => r(fim()); });
    return Promise.resolve(fim());
  });
  const ebookB = await o.repo.findById('B');
  ebookB.markPublished('hotmart', 'tmp', 'u'); // B fica fora do primeiro lote
  await o.publishBatch(['hotmart']);
  while (!liberarA) await new Promise(r => setImmediate(r));

  o.cancelQueue('hotmart');
  ebookB.hotmartProductId = null;
  const fim = fimDaFila(o, 'hotmart');
  await o.publishBatch(['hotmart']);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(pico, 1, 'B nao pode comecar enquanto A ainda publica');
  liberarA();
  await fim;
  assert.deepStrictEqual(chamadas.map(c => c[1]), ['A', 'B'], 'B e publicado depois de A, pelo mesmo laco');
  assert.strictEqual(pico, 1);
});

test('cancelar todas as filas (loja nula, como faz a rota) nao cria chave "null" no status', () => {
  const { o, logs } = orquestrador([], async () => ({}));
  o.cancelQueue(null);
  assert.deepStrictEqual(Object.keys(o.getStatus().processing).sort(), ['amazon', 'cakto', 'hotmart']);
  assert.strictEqual(logs.at(-1).level, 'warn');
});

test('publishSingle: inexistente e invalido lancam; loja ja publicada e pulada; loja desconhecida vira erro', async () => {
  const { o, repo, chamadas } = orquestrador([livro('A', { caktoProductId: 'C1' }), new Ebook({ id: 'semPdf', title: 'Titulo valido' })],
    async (loja, e) => ({ success: true, productId: loja + '-' + e.id, url: 'https://' + loja }));
  await assert.rejects(() => o.publishSingle('nada', ['hotmart']), /Ebook nada not found/);
  await assert.rejects(() => o.publishSingle('semPdf', ['hotmart']), /Validation failed: No PDF path/);
  const r = await o.publishSingle('A', ['cakto', 'hotmart', 'shopee']);
  assert.deepStrictEqual(r.cakto, { skipped: true, reason: 'Already published' });
  assert.deepStrictEqual(r.hotmart, { success: true, productId: 'hotmart-A', url: 'https://hotmart' });
  assert.deepStrictEqual(r.shopee, { success: false, error: 'Unknown store: shopee' });
  assert.deepStrictEqual(chamadas, [['hotmart', 'A']]);
  assert.deepStrictEqual(repo.marcados, [['A', 'hotmart', 'hotmart-A', 'https://hotmart']]);
  assert.strictEqual((await repo.findById('A')).hotmartProductId, 'hotmart-A', 'entidade tambem e atualizada');
});

test('publishSingle usa o callback de progresso padrao sem quebrar', async () => {
  const { o } = orquestrador([livro('A')], async (loja, e, onProgress) => { onProgress(10, 'x'); return { success: false, error: 'nao' }; });
  const r = await o.publishSingle('A', ['amazon']);
  assert.deepStrictEqual(r.amazon, { success: false, error: 'nao' });
});

test('emitStats repassa as estatisticas e engole erro do banco', async () => {
  const { o, repo } = orquestrador([livro('A')], async () => ({}));
  const recebidos = [];
  o.on('stats', s => recebidos.push(s));
  await o.emitStats();
  repo.getStats = async () => { throw new Error('travado'); };
  await assert.doesNotReject(() => o.emitStats());
  assert.deepStrictEqual(recebidos, [{ total: 1 }]);
});

test('construtor real monta os tres agentes de loja e usa a fila compartilhada', () => {
  const o = new PublishingOrchestrator(repoFalso([]));
  assert.deepStrictEqual(Object.keys(o.agents).sort(), ['amazon', 'cakto', 'hotmart']);
  assert.strictEqual(o.queue, PublishingQueue);
  assert.strictEqual(o.pausaEntreEbooksMs, 2000, 'a pausa de producao continua 2 s');
});

test('sem o logger (winston ausente) o orquestrador carrega e cai no console', () => {
  const alvo = path.join(__dirname, '..', 'src', 'application', 'orchestrator', 'PublishingOrchestrator.js');
  const carregarOriginal = Module._load;
  Module._load = function (pedido, pai, ...resto) {
    if (pai && pai.filename === alvo && pedido.endsWith('core/logger')) throw new Error('winston ausente');
    return carregarOriginal.call(this, pedido, pai, ...resto);
  };
  delete require.cache[alvo];
  try {
    const { PublishingOrchestrator: Isolado } = require(alvo);
    assert.strictEqual(typeof Isolado, 'function');
  } finally {
    Module._load = carregarOriginal;
    delete require.cache[alvo];
  }
});
