'use strict';
/**
 * creditTracker: qual conta Gmail/servico web gera o proximo e-book no mes.
 * Modulo real, DATA_DIR em diretorio temporario, contas e limites por ambiente,
 * relogio falso para a virada do mes.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recarregar, comAmbiente } = require('./apoio');

const LIMITES = ['GAMMA_MONTHLY_LIMIT', 'PIKTOCHART_MONTHLY_LIMIT', 'EBOOKMAKER_MONTHLY_LIMIT', 'VISME_MONTHLY_LIMIT'];
const A = 'ana.silva@gmail.com';
const B = 'bruno@gmail.com';

/** Carrega o modulo com DATA_DIR proprio. sessoesGoogle: contas que ja fizeram login. */
function carregar(t, { contas = [A, B], env = {}, sessoesGoogle = [A, B], dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'credito-'));
  if (!dataDir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const limpar = {};
  for (const v of LIMITES) limpar[v] = undefined;
  comAmbiente(t, { ...limpar, DATA_DIR: dir, GMAIL_ACCOUNTS: contas.join(','), ...env });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  for (const e of sessoesGoogle) fs.writeFileSync(path.join(dir, 'sessions', 'google_' + e.replace(/[@.]/g, '_') + '.json'), '{}');
  const logs = [];
  t.mock.method(console, 'log', m => logs.push(String(m)));
  const ct = recarregar('src/agents/webEbookAgents/creditTracker.js');
  const arquivo = path.join(dir, 'web_ebook_credits.json');
  const ler = () => JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  return { ct, dir, arquivo, ler, logs };
}

const mesAtual = () => new Date().toISOString().slice(0, 7);

// ── Defeitos ────────────────────────────────────────────────────────────────

test('conta Gmail acrescentada no meio do mes entra na rotacao sem esperar o mes virar', t => {
  const { ct, dir } = carregar(t, { contas: [A], sessoesGoogle: [A, B] });
  for (const svc of ct.SERVICE_PRIORITY) for (let i = 0; i < ct.LIMITS[svc]; i++) ct.recordSuccess(svc, A);
  assert.strictEqual(ct.getNextSlot(), null, 'a unica conta esgotou tudo');

  // Operador acrescenta a conta B no .env e reinicia.
  const novo = carregar(t, { contas: [A, B], sessoesGoogle: [], dataDir: dir }).ct;
  const slot = novo.getNextSlot();
  assert.ok(slot, 'a conta nova tem credito do mes inteiro');
  assert.deepStrictEqual([slot.service, slot.email, slot.remaining], ['gamma', B, 8]);
  novo.recordSuccess('gamma', B);
  assert.strictEqual(novo.getSummary().services.gamma.used, 9, 'o uso da conta nova e contado');
});

test('falha no meio da gravacao nao destroi os creditos ja gravados', t => {
  const { ct, arquivo, ler } = carregar(t);
  ct.recordSuccess('gamma', A);
  const antes = fs.readFileSync(arquivo, 'utf8');
  // Disco cheio: grava metade do conteudo no caminho pedido e lanca.
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (p, dados, ...resto) => {
    original(p, String(dados).slice(0, 20), ...resto);
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });
  assert.throws(() => ct.recordSuccess('gamma', A), /ENOSPC/);
  fs.writeFileSync.mock.restore();
  assert.strictEqual(fs.readFileSync(arquivo, 'utf8'), antes);
  assert.strictEqual(ler().services.gamma.accounts[A].used, 1);
});

// ── Escolha do proximo slot ─────────────────────────────────────────────────

test('ordem: servico por prioridade, depois conta; limite exato esgota a conta', t => {
  const { ct } = carregar(t, { env: { GAMMA_MONTHLY_LIMIT: '2' } });
  assert.deepStrictEqual(ct.getNextSlot(), {
    service: 'gamma', email: A,
    googleSessionFile: path.join(process.env.DATA_DIR, 'sessions', 'google_ana_silva_gmail_com.json'),
    serviceSessionFile: path.join(process.env.DATA_DIR, 'sessions', 'gamma_ana_silva_gmail_com.json'),
    used: 0, limit: 2, remaining: 2,
  });
  ct.recordSuccess('gamma', A);
  assert.strictEqual(ct.getNextSlot().remaining, 1);
  ct.recordSuccess('gamma', A);                               // used === limit
  assert.deepStrictEqual([ct.getNextSlot().service, ct.getNextSlot().email], ['gamma', B]);
  ct.recordSuccess('gamma', B);
  ct.recordSuccess('gamma', B);
  assert.deepStrictEqual([ct.getNextSlot().service, ct.getNextSlot().email], ['piktochart', A]);
  assert.strictEqual(ct.isAllExhausted(), false);
});

test('conta sem login Google e pulada, com aviso', t => {
  const { ct, logs } = carregar(t, { sessoesGoogle: [B] });
  assert.strictEqual(ct.getNextSlot().email, B);
  assert.ok(logs.includes('[creditTracker] Sem sessão Google para ' + A + ' — pulando'));
});

test('sem nenhuma conta configurada tudo esta esgotado', t => {
  const { ct } = carregar(t, { contas: [], sessoesGoogle: [] });
  assert.deepStrictEqual(ct.GMAIL_ACCOUNTS, []);
  assert.strictEqual(ct.getNextSlot(), null);
  assert.strictEqual(ct.isAllExhausted(), true);
  assert.strictEqual(ct.getSummary().services.gamma.exhausted, true);
});

test('GMAIL_ACCOUNTS aceita espacos e virgulas sobrando', t => {
  const { ct } = carregar(t, { contas: [' ' + A + ' ', '', B] });
  assert.deepStrictEqual(ct.GMAIL_ACCOUNTS, [A, B]);
});

test('cinco falhas seguidas tiram a conta do servico; sucesso zera as falhas', t => {
  const { ct, ler } = carregar(t);
  for (let i = 0; i < 4; i++) ct.recordFailure('gamma', A, 'timeout');
  assert.strictEqual(ct.getNextSlot().email, A, 'quatro falhas ainda nao tiram');
  ct.recordSuccess('gamma', A);
  assert.strictEqual(ler().services.gamma.accounts[A].failures, 0);
  for (let i = 0; i < 5; i++) ct.recordFailure('gamma', A, 'generator-not-found');
  const acc = ler().services.gamma.accounts[A];
  assert.deepStrictEqual([acc.failures, acc.lastFailure], [5, 'generator-not-found']);
  assert.ok(acc.lastUsed);
  assert.strictEqual(ct.getNextSlot().email, B);
  assert.strictEqual(ct.getSummary().services.gamma.accounts[0].failures, 5);
});

test('sucesso e falha de conta ou servico desconhecido nao criam entrada, mas gravam', t => {
  const { ct, ler } = carregar(t);
  ct.recordSuccess('canva', A);
  ct.recordFailure('gamma', 'estranho@gmail.com', 'x');
  const e = ler();
  assert.strictEqual(e.services.canva, undefined);
  assert.strictEqual(e.services.gamma.accounts['estranho@gmail.com'], undefined);
  assert.strictEqual(e.services.gamma.accounts[A].used, 0);
});

test('conta gravada sem contador de falhas (formato antigo) conta a partir de zero', t => {
  const { ct, arquivo, ler } = carregar(t);
  ct.recordSuccess('gamma', A);
  const e = ler();
  delete e.services.gamma.accounts[A].failures;
  delete e.services.gamma.accounts[A].used;
  fs.writeFileSync(arquivo, JSON.stringify(e));
  assert.strictEqual(ct.getSummary().services.gamma.used, 0);
  assert.strictEqual(ct.getSummary().services.gamma.accounts[0].failures, 0);
  ct.recordFailure('gamma', A, 'x');
  assert.strictEqual(ler().services.gamma.accounts[A].failures, 1);
});

// ── Mes e estado ────────────────────────────────────────────────────────────

test('virada do mes zera os creditos; mesmo mes preserva', t => {
  const { ct, ler, logs } = carregar(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30, 23, 0, 0) });
  ct.recordSuccess('gamma', A);
  ct.recordSuccess('gamma', A);
  assert.strictEqual(ct.getNextSlot().used, 2);
  assert.strictEqual(ler().month, '2026-09');
  t.mock.timers.setTime(Date.UTC(2026, 9, 1, 0, 0, 1));
  assert.strictEqual(ct.getNextSlot().used, 0);
  assert.ok(logs.includes('[creditTracker] Novo mês detectado (2026-09 → 2026-10) — resetando créditos'));
});

test('arquivo corrompido ou ausente comeca o mes do zero', t => {
  const { ct, arquivo } = carregar(t);
  assert.strictEqual(ct.getSummary().month, mesAtual());
  fs.writeFileSync(arquivo, '{ nao e json');
  assert.strictEqual(ct.getNextSlot().used, 0);
});

test('estado do mes sem algum servico (versao anterior) ganha o servico zerado', t => {
  const { ct, arquivo, ler } = carregar(t);
  fs.writeFileSync(arquivo, JSON.stringify({ month: mesAtual(), services: { gamma: { accounts: { [A]: { used: 8, limit: 8, failures: 0 } } } } }));
  assert.strictEqual(ct.getNextSlot().service, 'gamma', 'B continua com gamma');
  ct.recordSuccess('visme', B);
  assert.strictEqual(ler().services.visme.accounts[B].used, 1);
  fs.writeFileSync(arquivo, JSON.stringify({ month: mesAtual(), services: { gamma: {} } }));
  assert.strictEqual(ct.getSummary().services.gamma.used, 0);
});

test('resetMonthly recria o mes e espelha em genia/', t => {
  const { ct, dir, ler, logs } = carregar(t);
  ct.recordSuccess('gamma', A);
  const novo = ct.resetMonthly();
  assert.strictEqual(novo.services.gamma.accounts[A].used, 0);
  assert.strictEqual(ler().services.gamma.accounts[A].used, 0);
  const espelho = JSON.parse(fs.readFileSync(path.join(dir, 'genia', 'web_ebook_state.json'), 'utf8'));
  assert.strictEqual(espelho.month, mesAtual());
  assert.match(espelho._description, /créditos web ebook/);
  assert.ok(espelho._updatedAt);
  assert.ok(logs.includes('[creditTracker] ✅ Créditos mensais resetados para ' + mesAtual()));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['genia', 'sessions', 'web_ebook_credits.json']);
});

test('espelho em genia/ que falha nao impede gravar os creditos', t => {
  const { ct, dir, ler } = carregar(t);
  fs.writeFileSync(path.join(dir, 'genia'), 'arquivo comum no lugar do diretorio');
  ct.recordSuccess('gamma', A);
  assert.strictEqual(ler().services.gamma.accounts[A].used, 1);
});

// ── Painel e forcar slot ────────────────────────────────────────────────────

test('getSummary soma uso por servico sobre o total do mes', t => {
  const { ct } = carregar(t, { env: { PIKTOCHART_MONTHLY_LIMIT: '1', EBOOKMAKER_MONTHLY_LIMIT: '3', VISME_MONTHLY_LIMIT: '4' } });
  ct.recordSuccess('piktochart', A);
  ct.recordSuccess('piktochart', B);
  ct.recordSuccess('gamma', B);
  const s = ct.getSummary();
  assert.deepStrictEqual(ct.LIMITS, { gamma: 8, piktochart: 1, ebookmaker: 3, visme: 4 });
  assert.deepStrictEqual({ ...s.services.piktochart, accounts: undefined }, { used: 2, total: 2, remaining: 0, exhausted: true, accounts: undefined });
  assert.deepStrictEqual({ ...s.services.gamma, accounts: undefined }, { used: 1, total: 16, remaining: 15, exhausted: false, accounts: undefined });
  assert.deepStrictEqual(s.services.gamma.accounts, [{ email: A, used: 0, limit: 8, failures: 0 }, { email: B, used: 1, limit: 8, failures: 0 }]);
});

test('forceSlot usa o registro da conta ou, sem ele, o limite do servico', t => {
  const { ct } = carregar(t);
  ct.recordSuccess('visme', A);
  const f = ct.forceSlot('visme', A);
  assert.deepStrictEqual([f.used, f.limit, f.remaining], [1, 5, 4]);
  assert.strictEqual(f.serviceSessionFile, path.join(process.env.DATA_DIR, 'sessions', 'visme_ana_silva_gmail_com.json'));
  const g = ct.forceSlot('ebookmaker', 'fora@gmail.com');
  assert.deepStrictEqual([g.service, g.email, g.used, g.limit, g.remaining], ['ebookmaker', 'fora@gmail.com', 0, 10, 10]);
  assert.strictEqual(g.googleSessionFile, path.join(process.env.DATA_DIR, 'sessions', 'google_fora_gmail_com.json'));
});

test('sem DATA_DIR o estado fica em /app/data (padrao do container)', t => {
  const { ct } = carregar(t, { contas: [A], sessoesGoogle: [] });
  comAmbiente(t, { DATA_DIR: undefined });
  const semDir = recarregar('src/agents/webEbookAgents/creditTracker.js');
  assert.strictEqual(semDir.forceSlot('gamma', A).googleSessionFile, path.join('/app/data', 'sessions', 'google_ana_silva_gmail_com.json'));
  assert.ok(ct);
});
