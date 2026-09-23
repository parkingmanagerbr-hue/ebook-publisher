'use strict';
/**
 * Cadeia de IA (src/core/aiClient.js) com o modulo REAL e vizinhos falsos:
 * axios e @google/generative-ai trocados por roteiros, Redis por um socket
 * falso, dotenv desligado (o .env local tem chaves de verdade) e o estado em
 * diretorio temporario. Nenhuma requisicao sai da maquina.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const axios = require('axios');
const { interceptar, recarregar, comAmbiente, loggerFalso } = require('./apoio');

const VARS_CHAVE = [];
for (const base of ['GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'SAMBANOVA_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'HUGGINGFACE_API_KEY']) {
  VARS_CHAVE.push(base);
  for (let i = 2; i <= 8; i++) VARS_CHAVE.push(base + '_' + i);
}
VARS_CHAVE.push('GEMINI_PAID_KEY');
const VARS_MODELO = ['GEMINI_MODEL', 'CEREBRAS_MODEL', 'SAMBANOVA_MODEL', 'DEEPSEEK_MODEL', 'HF_MODEL', 'GROQ_MODEL', 'GROQ_MAX_TOKENS',
  'POLLINATIONS_MODEL', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_VPS_CONTAINER_IP', 'OLLAMA_VPS_MODEL', 'REDIS_URL',
  'EBOOK_GEMINI_DAILY_MAX', 'AI_PROBE_INTERVAL_MS', 'AI_STATE_FILE'];

/** Redis falso: responder(args) devolve a resposta RESP bruta, 'erro', 'timeout' ou null (fecha sem nada). */
function redisFalso(responder = () => ':1\r\n') {
  const comandos = [];
  const conexoes = [];
  return {
    comandos,
    conexoes,
    createConnection(opcoes) {
      conexoes.push(opcoes);
      const s = new EventEmitter();
      let escrito = '';
      s.setTimeout = () => {};
      s.destroy = () => { s.destruido = true; };
      s.write = c => { escrito += c; };
      s.end = () => {
        const args = escrito.split('\r\n').filter((_, i) => i > 0 && i % 2 === 0);
        comandos.push(args);
        const r = responder(args);
        setImmediate(() => {
          if (r === 'erro') s.emit('error', new Error('ECONNREFUSED'));
          else if (r === 'timeout') s.emit('timeout');
          else { if (r) s.emit('data', r); s.emit('end'); }
        });
      };
      return s;
    },
  };
}

/** Gemini falso: roteiro(modelo, chave, prompt) devolve texto ou lanca. */
function geminiFalso(roteiro) {
  const chamadas = [];
  class GoogleGenerativeAI {
    constructor(chave) { this.chave = chave; }
    getGenerativeModel({ model, systemInstruction }) {
      return { generateContent: async prompt => {
        chamadas.push({ model, chave: this.chave, systemInstruction, prompt });
        const r = await roteiro(model, this.chave, prompt);
        return { response: { text: () => r } };
      } };
    }
  }
  return { GoogleGenerativeAI, chamadas };
}

/** axios falso por URL: rotas = [[trecho da url, fn(body, config, url)]] — sem rota casada, lanca ECONNREFUSED. */
function axiosFalso(t, rotas) {
  const chamadas = [];
  const orig = { post: axios.post, get: axios.get };
  const despachar = async (metodo, url, body, config) => {
    chamadas.push({ metodo, url, body, config });
    for (const [trecho, fn] of rotas) {
      if (url.includes(trecho) && (!fn.metodo || fn.metodo === metodo)) return fn(body, config, url);
    }
    throw new Error('connect ECONNREFUSED ' + url);
  };
  axios.post = (url, body, config) => despachar('post', url, body, config);
  axios.get = (url, config) => despachar('get', url, undefined, config);
  t.after(() => { axios.post = orig.post; axios.get = orig.get; });
  return chamadas;
}

const ok = texto => ({ data: { choices: [{ message: { content: texto } }] } });
const erroHttp = (status, extra = {}) => Object.assign(new Error(extra.message || 'status ' + status), { response: { status, data: extra.data, headers: extra.headers } });

/**
 * Carrega o aiClient real com ambiente controlado. Devolve o modulo, o logger,
 * o Redis falso, o Gemini falso e o caminho do estado.
 */
function carregar(t, { env = {}, redis, gemini, estadoInicial } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'ai_state.json');
  if (estadoInicial !== undefined) fs.writeFileSync(arquivo, typeof estadoInicial === 'string' ? estadoInicial : JSON.stringify(estadoInicial));
  const limpar = {};
  for (const v of [...VARS_CHAVE, ...VARS_MODELO]) limpar[v] = undefined;
  comAmbiente(t, { ...limpar, AI_STATE_FILE: arquivo, ...env });
  const logger = loggerFalso();
  const r = redis || redisFalso();
  const g = gemini || geminiFalso(async () => 'gemini ok');
  interceptar(t, { dotenv: { config() {} }, './logger': { createLogger: () => logger }, net: r, '@google/generative-ai': g });
  const ai = recarregar('src/core/aiClient.js');
  const lerEstado = () => JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  return { ai, logger, redis: r, gemini: g, arquivo, lerEstado };
}

// ═══════════════════════════════════════════════════════════════════════════
// Defeitos encontrados
// ═══════════════════════════════════════════════════════════════════════════

test('Cerebras monta a requisicao sem ReferenceError e respeita o teto pedido', async t => {
  const { ai } = carregar(t);
  const chamadas = axiosFalso(t, [['api.cerebras.ai', async () => ok('cerebras ok')]]);
  assert.strictEqual(await ai.callCerebras('p', 's', 'chave', { maxTokens: 300 }), 'cerebras ok');
  assert.strictEqual(chamadas[0].body.max_tokens, 300);
  assert.strictEqual(await ai.callCerebras('p', 's', 'chave'), 'cerebras ok');
  assert.strictEqual(chamadas[1].body.max_tokens, 8000);
});

test('consultar o painel (getStatus) nao gasta a sondagem do provedor degradado', async t => {
  const antigo = Date.now() - 25 * 60 * 1000;
  const { ai } = carregar(t, {
    env: { GROQ_API_KEY: 'gsk_chave_um_1' },
    estadoInicial: { degraded: { groq: { until: Date.now() + 3600000, since_ms: antigo, lastProbe: antigo } }, keyIndex: {} },
  });
  const st = ai.getStatus();
  assert.strictEqual(st.groq.degraded, true, 'o painel mostra o que esta degradado');
  // A sondagem continua disponivel para quem vai de fato chamar o provedor.
  axiosFalso(t, [['api.groq.com', async () => ok('voltou')]]);
  const r = await ai.generate('p', 's', { skip: ['gemini', 'sambanova', 'cerebras'] });
  assert.strictEqual(r.provider, 'groq');
});

test('chave que falha no mesmo milissegundo da leitura continua degradada', async t => {
  const { ai, lerEstado } = carregar(t, { env: { DEEPSEEK_API_KEY: 'sk-deep-aaaaaaaa', DEEPSEEK_API_KEY_2: 'sk-deep-bbbbbbbb' } });
  const agora = Date.now();
  t.mock.method(Date, 'now', () => agora);
  axiosFalso(t, [['api.deepseek.com', async () => { throw erroHttp(401); }]]);
  await assert.rejects(() => ai.generate('p', 's', { skip: ['gemini', 'sambanova', 'cerebras', 'groq', 'huggingface', 'pollinations'] }), /Todos os providers/);
  const deg = lerEstado().degraded;
  assert.ok(deg['deepseek:aaaaaaaa'] && deg['deepseek:bbbbbbbb'], 'as duas chaves recusadas tem de ficar marcadas: ' + JSON.stringify(deg));
});

test('cota diaria com dica em milissegundos nao trava a chave por 6 horas', t => {
  const { ai } = carregar(t);
  const r = ai.getErrorTTL(erroHttp(429, { message: 'Limit on tokens per day (TPD). Please try again in 864ms.' }));
  assert.ok(r.hours * 3600 < 60, 'esperado ~31 s, veio ' + r.hours * 3600 + ' s');
});

test('limite por minuto com dica "3m20s" usa os 200 s, nao o padrao de 2 min', t => {
  const { ai } = carregar(t);
  const r = ai.getErrorTTL(erroHttp(429, { message: 'Rate limit reached on requests per minute. Please try again in 3m20s.' }));
  assert.strictEqual(Math.round(r.hours * 3600), 205);
});

test('marca liberada por outro processo nao volta, mesmo com o relogio parado', async t => {
  // Guarda da correcao acima: o "+1 ms" do markDegraded nao pode reabrir o bug
  // original (o ultimo a gravar ressuscitava marca ja liberada).
  const { ai, lerEstado } = carregar(t);
  const agora = Date.now();
  t.mock.method(Date, 'now', () => agora);
  const a = ai.loadState();
  a.keyIndex = {};
  ai.markDegraded(a, 'groq:aaaaaaaa', 1);
  const b = ai.loadState();
  delete b.degraded['groq:aaaaaaaa'];
  ai.saveState(b);                        // outro processo liberou
  a.keyIndex.groq = 3;
  ai.saveState(a);                        // este grava outra coisa depois
  assert.deepStrictEqual(Object.keys(lerEstado().degraded), []);
  ai.markDegraded(a, 'groq:bbbbbbbb', 1); // e a marca nova deste continua valendo
  assert.deepStrictEqual(Object.keys(lerEstado().degraded), ['groq:bbbbbbbb']);
});

// ═══════════════════════════════════════════════════════════════════════════
// Prazo de degradacao (getErrorTTL)
// ═══════════════════════════════════════════════════════════════════════════

const segundos = r => Math.round(r.hours * 3600);

test('segundosDaDica entende h, m, s e ms e devolve null sem numero', t => {
  const { ai } = carregar(t);
  assert.strictEqual(ai.segundosDaDica('Please try again in 7m35.5s.'), 455.5);
  assert.strictEqual(ai.segundosDaDica('try again in 1h2m3s'), 3723);
  assert.strictEqual(ai.segundosDaDica('try again in 864ms'), 0.864);
  assert.strictEqual(ai.segundosDaDica('try again in 2h'), 7200);
  assert.strictEqual(ai.segundosDaDica('TRY AGAIN IN 7.5 S'), 7.5);
  assert.strictEqual(ai.segundosDaDica('try again in 3 minutes'), null, '"minutes" nao e o sufixo m');
  assert.strictEqual(ai.segundosDaDica('please try again in a few minutes'), null);
  assert.strictEqual(ai.segundosDaDica(''), null);
  assert.strictEqual(ai.segundosDaDica(undefined), null);
});

test('402 e 401/403 tiram a chave por 24 h; 5xx e desconhecido por 30 min; rede por 15 min', t => {
  const { ai } = carregar(t);
  assert.deepStrictEqual(ai.getErrorTTL(erroHttp(402)), { hours: 24, reason: 'payment-required' });
  assert.deepStrictEqual(ai.getErrorTTL(Object.assign(new Error('x'), { status: 401 })), { hours: 24, reason: 'auth-error' });
  assert.deepStrictEqual(ai.getErrorTTL(erroHttp(403)), { hours: 24, reason: 'auth-error' });
  assert.deepStrictEqual(ai.getErrorTTL(erroHttp(503)), { hours: 0.5, reason: 'server-error' });
  for (const m of ['timeout of 60000ms exceeded', 'connect ECONNREFUSED', 'getaddrinfo ENOTFOUND x', 'read ECONNRESET']) {
    assert.deepStrictEqual(ai.getErrorTTL(new Error(m)), { hours: 0.25, reason: 'network' }, m);
  }
  assert.deepStrictEqual(ai.getErrorTTL(erroHttp(418)), { hours: 0.5, reason: 'unknown' });
  assert.deepStrictEqual(ai.getErrorTTL({}), { hours: 0.5, reason: 'unknown' }, 'erro sem mensagem nem status');
});

test('fila cheia do Cerebras e trava de 5 min; "queue" sozinho nao', t => {
  const { ai } = carregar(t);
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { data: { error: { code: 'queue_exceeded' } } }))), 300);
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'queue full' }))), 300);
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'queue: high traffic' }))), 300);
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'queue position 3' }))), 125);
});

test('limite por minuto: padrao 2 min, dica e retry-after, sempre entre 15 s e 10 min', t => {
  const { ai } = carregar(t);
  assert.strictEqual(segundos(ai.getErrorTTL(new Error('429 Too Many Requests'))), 125);
  assert.strictEqual(segundos(ai.getErrorTTL(new Error('rate limit exceeded'))), 125);
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'try again in 2s' }))), 15, 'piso de 15 s');
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'try again in 2h' }))), 600, 'teto de 10 min');
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'try again in 7s', headers: { 'retry-after': '40' } }))), 45, 'retry-after vale sobre a dica');
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'slow down', headers: { 'retry-after': 'Wed, 21 Oct' } }))), 125, 'retry-after em data e ignorado');
});

test('cota diaria: com dica usa a dica (teto 6 h); sem dica vai ate a meia-noite UTC (piso 30 min)', t => {
  const { ai } = carregar(t);
  assert.strictEqual(segundos(ai.getErrorTTL(erroHttp(429, { message: 'tokens per day: try again in 7m35s' }))), 485);
  assert.strictEqual(ai.getErrorTTL(erroHttp(429, { message: 'requests per day, try again in 20h' })).hours, 6);
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 15, 18, 0, 0) });
  assert.strictEqual(ai.getErrorTTL(new Error('You exceeded your current quota')).hours, 6);
  assert.strictEqual(ai.getErrorTTL(erroHttp(429, { message: 'daily limit, try again in 0s' })).hours, 6, 'dica zero nao vale');
  t.mock.timers.setTime(Date.UTC(2026, 8, 15, 23, 50, 0));
  assert.strictEqual(ai.getErrorTTL(erroHttp(429, { data: { error: 'RPD reached' } })).hours, 0.5);
});

test('ehCotaOuModeloIndisponivel separa cota/modelo de erro de chave', t => {
  const { ai } = carregar(t);
  assert.strictEqual(ai.ehCotaOuModeloIndisponivel({ status: 429 }), true);
  assert.strictEqual(ai.ehCotaOuModeloIndisponivel({ response: { status: 404 } }), true);
  assert.strictEqual(ai.ehCotaOuModeloIndisponivel(new Error('[GoogleGenerativeAI Error]: RESOURCE_EXHAUSTED')), true);
  assert.strictEqual(ai.ehCotaOuModeloIndisponivel(new Error('models/x is not supported for generateContent')), true);
  assert.strictEqual(ai.ehCotaOuModeloIndisponivel(Object.assign(new Error('API key not valid'), { status: 400 })), false);
  assert.strictEqual(ai.ehCotaOuModeloIndisponivel(null), false);
  assert.strictEqual(ai.ehCotaOuModeloIndisponivel({}), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Estado em disco
// ═══════════════════════════════════════════════════════════════════════════

test('loadState: sem arquivo, arquivo corrompido e campos ausentes caem nos padroes', t => {
  const { ai, logger } = carregar(t);
  assert.deepStrictEqual(ai.loadState(), { degraded: {}, keyIndex: {}, callLog: {} });
  const c = carregar(t, { estadoInicial: '{ quebrado' });
  assert.deepStrictEqual(c.ai.loadState(), { degraded: {}, keyIndex: {}, callLog: {} });
  assert.ok(c.logger.linhas.some(l => l.startsWith('warn Estado corrompido')));
  const d = carregar(t, { estadoInicial: { callLog: { x: 1 } } });
  const st = d.ai.loadState();
  assert.deepStrictEqual({ ...st }, { degraded: {}, keyIndex: {}, callLog: { x: 1 } });
  assert.ok(!Object.keys(st).includes('_lidoEm'), '_lidoEm nao pode ir para o JSON');
  assert.strictEqual(logger.linhas.length, 0);
});

test('loadState descarta marca vencida e mantem a vigente', t => {
  const agora = Date.now();
  const { ai } = carregar(t, { estadoInicial: { degraded: { velha: { until: agora - 1 }, nova: { until: agora + 60000 } }, keyIndex: { groq: 2 } } });
  const st = ai.loadState();
  assert.deepStrictEqual(Object.keys(st.degraded), ['nova']);
  assert.deepStrictEqual(st.keyIndex, { groq: 2 });
});

test('saveState grava por temporario + rename, mescla keyIndex e nao deixa sobra', t => {
  const { ai, arquivo, lerEstado } = carregar(t, { estadoInicial: { degraded: {}, keyIndex: { groq: 1, gemini: 4 }, outro: 'preservado' } });
  ai.saveState({ degraded: { x: { until: Date.now() + 1000 } }, keyIndex: { groq: 2 } });   // sem _lidoEm: grava degraded como veio
  const e = lerEstado();
  assert.deepStrictEqual(e.keyIndex, { groq: 2, gemini: 4 });
  assert.strictEqual(e.outro, 'preservado');
  assert.deepStrictEqual(Object.keys(e.degraded), ['x']);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(arquivo)), ['ai_state.json']);
  const parcial = { keyIndex: { deepseek: 1 } };   // estado sem "degraded" nao quebra a gravacao
  ai.saveState(parcial);
  assert.deepStrictEqual(lerEstado().keyIndex, { groq: 2, gemini: 4, deepseek: 1 });
  ai.saveState(parcial);
  assert.deepStrictEqual(lerEstado().keyIndex.deepseek, 1);
});

test('saveState no primeiro uso (sem arquivo nem keyIndex) cria o arquivo', t => {
  const { ai, arquivo, lerEstado } = carregar(t);
  const st = { degraded: { legado: { until: Date.now() + 1000, since: new Date().toISOString() } } };
  ai.saveState(st);
  assert.ok(fs.existsSync(arquivo));
  assert.deepStrictEqual(lerEstado().keyIndex, {});
  ai.saveState(st);   // agora com _lidoEm; marca de formato antigo (sem since_ms) nos dois lados fica
  assert.deepStrictEqual(Object.keys(lerEstado().degraded), ['legado']);
});

test('saveState que nao consegue gravar avisa e nao derruba o chamador', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-ro-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bloqueio = path.join(dir, 'arquivo-comum');
  fs.writeFileSync(bloqueio, 'x');
  const { ai, logger } = carregar(t, { env: { AI_STATE_FILE: path.join(bloqueio, 'ai_state.json') } });
  ai.saveState({ degraded: {}, keyIndex: {} });
  assert.ok(logger.linhas.some(l => l.startsWith('warn Falha ao salvar estado')));
});

test('mesclarDegradados tolera lados ausentes, since em texto e since invalido', t => {
  const { ai } = carregar(t);
  const iso = new Date(5000).toISOString();
  assert.deepStrictEqual(ai.mesclarDegradados(null, null, 1), {});
  assert.deepStrictEqual(Object.keys(ai.mesclarDegradados({ a: { since: iso } }, undefined, 1000)), ['a']);
  assert.deepStrictEqual(ai.mesclarDegradados({ a: { since: 'lixo' } }, {}, 1000), {});
  assert.deepStrictEqual(Object.keys(ai.mesclarDegradados(undefined, { b: { since_ms: 1 } })), ['b'], 'sem lidoEm tudo e posterior a 0');
  assert.deepStrictEqual(ai.mesclarDegradados({ a: null }, { a: null }, 0), {}, 'marca nula nao e marca');
});

test('markDegraded usa 1 h por padrao', t => {
  const { ai, lerEstado } = carregar(t);
  const st = ai.loadState();
  ai.markDegraded(st, 'sambanova');
  assert.strictEqual(lerEstado().degraded.sambanova.hours, 1);
});

test('marca sem carimbo de tempo e sondada logo', t => {
  const { ai } = carregar(t);
  const st = { degraded: { groq: { until: Date.now() + 60000 } }, keyIndex: {} };
  assert.strictEqual(ai.isDegraded(st, 'groq'), false);
  assert.ok(st.degraded.groq.lastProbe > 0);
});

test('getNextKey: chave unica degradada some; varias giram e pulam as degradadas', t => {
  const { ai, lerEstado } = carregar(t, { env: { DEEPSEEK_API_KEY: 'sk-11111111', GROQ_API_KEY: 'g-aaaaaaaa', GROQ_API_KEY_2: 'g-bbbbbbbb', GROQ_API_KEY_3: 'g-cccccccc' } });
  const st = { degraded: {}, keyIndex: {} };
  assert.strictEqual(ai.getNextKey(st, 'deepseek'), 'sk-11111111');
  ai.markDegraded(st, 'deepseek:11111111', 1);
  assert.strictEqual(ai.getNextKey(st, 'deepseek'), null);
  assert.strictEqual(ai.getNextKey(st, 'groq'), 'g-aaaaaaaa');
  ai.markDegraded(st, 'groq:bbbbbbbb', 1);
  assert.strictEqual(ai.getNextKey(st, 'groq'), 'g-cccccccc');
  assert.strictEqual(lerEstado().keyIndex.groq, 0, 'a posicao da rotacao e persistida');
  assert.strictEqual(ai.getNextKey(st, 'groq'), 'g-aaaaaaaa');
  ai.markDegraded(st, 'groq:aaaaaaaa', 1);
  ai.markDegraded(st, 'groq:cccccccc', 1);
  assert.strictEqual(ai.getNextKey(st, 'groq'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// Provedores
// ═══════════════════════════════════════════════════════════════════════════

test('callGemini: troca de modelo so em cota/modelo indisponivel; erro de chave sobe na hora', async t => {
  let roteiro;
  const g = geminiFalso((modelo, chave, prompt) => roteiro(modelo, chave, prompt));
  const { ai } = carregar(t, { gemini: g, env: { GEMINI_MODEL: 'gemini-2.5-flash' } });

  roteiro = async () => 'direto';
  assert.strictEqual(await ai.callGemini('p', 'sistema', 'AIza-1'), 'direto');
  assert.deepStrictEqual(g.chamadas[0], { model: 'gemini-2.5-flash', chave: 'AIza-1', systemInstruction: 'sistema', prompt: 'p' });

  g.chamadas.length = 0;
  roteiro = async modelo => { if (g.chamadas.length < 3) throw Object.assign(new Error('quota ' + modelo), { status: 429 }); return 'terceiro balde'; };
  assert.strictEqual(await ai.callGemini('p', 's', 'AIza-1'), 'terceiro balde');
  const modelos = g.chamadas.map(c => c.model);
  assert.strictEqual(new Set(modelos).size, 3, 'cada tentativa num balde diferente');

  g.chamadas.length = 0;
  roteiro = async () => { throw new Error('API key not valid'); };
  await assert.rejects(() => ai.callGemini('p', 's', 'AIza-1'), /API key not valid/);
  assert.strictEqual(g.chamadas.length, 1);

  g.chamadas.length = 0;
  roteiro = async modelo => { throw Object.assign(new Error('404 ' + modelo), { status: 404 }); };
  await assert.rejects(() => ai.callGemini('p', 's', 'AIza-1'), e => e.status === 404);
  const todos = g.chamadas.map(c => c.model);
  assert.strictEqual(todos.filter(m => m === 'gemini-2.5-flash').length, 1, 'GEMINI_MODEL vai na frente sem repetir');
  assert.ok(todos.length >= 6);
});

test('callGroq: teto pedido chega ao provedor, limitado a GROQ_MAX_TOKENS', async t => {
  const { ai } = carregar(t, { env: { GROQ_MAX_TOKENS: '1000', GROQ_MODEL: 'meu-modelo' } });
  const chamadas = axiosFalso(t, [['api.groq.com', async () => ok('g')]]);
  await ai.callGroq('p', 's', 'k', { maxTokens: 50 });
  await ai.callGroq('p', 's', 'k', { maxTokens: 99999 });
  await ai.callGroq('p', 's', 'k', { maxTokens: 0 });
  await ai.callGroq('p', 's', 'k', { maxTokens: 'abc' });
  await ai.callGroq('p', 's', 'k');
  assert.deepStrictEqual(chamadas.map(c => c.body.max_tokens), [50, 1000, 1000, 1000, 1000]);
  assert.strictEqual(chamadas[0].body.model, 'meu-modelo');
  assert.strictEqual(chamadas[0].config.headers.Authorization, 'Bearer k');
});

test('callGroq: 413 repete com metade do teto; 404/429 vao ao proximo modelo; 401 desiste', async t => {
  const { ai } = carregar(t);
  let respostas;
  const chamadas = axiosFalso(t, [['api.groq.com', async () => { const r = respostas.shift(); if (r instanceof Error) throw r; return r; }]]);
  const lista = () => chamadas.splice(0).map(c => c.body.model + ':' + c.body.max_tokens);

  respostas = [erroHttp(413), ok('menor')];
  assert.strictEqual(await ai.callGroq('p', 's', 'k', { maxTokens: 800 }), 'menor');
  assert.deepStrictEqual(lista(), ['openai/gpt-oss-120b:800', 'openai/gpt-oss-120b:400']);

  respostas = [erroHttp(413), erroHttp(413), erroHttp(429, { data: { error: { message: 'Rate limit reached for model' } } }), ok('terceiro')];
  assert.strictEqual(await ai.callGroq('p', 's', 'k', { maxTokens: 1 }), 'terceiro');
  assert.deepStrictEqual(lista(), ['openai/gpt-oss-120b:1', 'openai/gpt-oss-120b:1', 'openai/gpt-oss-20b:1', 'groq/compound-mini:1'],
    'com teto 1 a "reducao" nao pode virar pedido maior');

  respostas = [erroHttp(401)];
  await assert.rejects(() => ai.callGroq('p', 's', 'k'), e => e.response.status === 401);
  assert.strictEqual(lista().length, 1);

  respostas = [erroHttp(404), erroHttp(404), erroHttp(404)];
  await assert.rejects(() => ai.callGroq('p', 's', 'k'), e => e.response.status === 404);
  assert.strictEqual(lista().length, 3);

  respostas = [{ data: { error: { message: 'org restrita' } } }];
  await assert.rejects(() => ai.callGroq('p', 's', 'k'), /org restrita/);
  respostas = [{ data: { error: { type: 'x' } } }];
  await assert.rejects(() => ai.callGroq('p', 's', 'k'), /"type":"x"/);
  respostas = [Object.assign(new Error(''), {})];
  await assert.rejects(() => ai.callGroq('p', 's', 'k'), e => e.message === '');
});

for (const [nome, fn, trecho, envModelo, padrao, teto] of [
  ['Cerebras', 'callCerebras', 'api.cerebras.ai', 'CEREBRAS_MODEL', 'gpt-oss-120b', 8000],
  ['SambaNova', 'callSambaNova', 'api.sambanova.ai', 'SAMBANOVA_MODEL', 'Meta-Llama-3.3-70B-Instruct', 8000],
  ['DeepSeek', 'callDeepSeek', 'api.deepseek.com', 'DEEPSEEK_MODEL', 'deepseek-chat', 4000],
]) {
  test(nome + ': modelo por ambiente, erro no corpo vira excecao', async t => {
    const { ai } = carregar(t);
    let resposta = ok('texto');
    const chamadas = axiosFalso(t, [[trecho, async () => resposta]]);
    assert.strictEqual(await ai[fn]('p', 'sis', 'chave-x'), 'texto');
    assert.strictEqual(chamadas[0].body.model, padrao);
    assert.strictEqual(chamadas[0].body.max_tokens, teto);
    assert.deepStrictEqual(chamadas[0].body.messages, [{ role: 'system', content: 'sis' }, { role: 'user', content: 'p' }]);
    assert.strictEqual(chamadas[0].config.headers.Authorization, 'Bearer chave-x');
    comAmbiente(t, { [envModelo]: 'outro' });
    await ai[fn]('p', 's', 'k');
    assert.strictEqual(chamadas[1].body.model, 'outro');
    resposta = { data: { error: { message: 'saldo insuficiente' } } };
    await assert.rejects(() => ai[fn]('p', 's', 'k'), /saldo insuficiente/);
    resposta = { data: { error: { code: 7 } } };
    await assert.rejects(() => ai[fn]('p', 's', 'k'), /"code":7/);
  });
}

test('callHuggingFace: resposta vazia passa ao proximo modelo; todos vazios falham com o motivo', async t => {
  const { ai, logger } = carregar(t, { env: { HF_MODEL: 'meu/modelo' } });
  let respostas;
  const chamadas = axiosFalso(t, [['router.huggingface.co', async () => { const r = respostas.shift(); if (r instanceof Error) throw r; return r; }]]);
  respostas = [{ data: { choices: [] } }, ok('segundo')];
  assert.strictEqual(await ai.callHuggingFace('p', 's', 'k'), 'segundo');
  assert.strictEqual(chamadas[0].body.model, 'meu/modelo');
  assert.strictEqual(chamadas[0].body.max_tokens, 4000);
  const semStatus = Object.assign(new Error('socket hang up'), {});
  const comCodigo = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
  respostas = [erroHttp(500), comCodigo, semStatus, { data: {} }, { data: { choices: [{ message: {} }] } }];
  await assert.rejects(() => ai.callHuggingFace('p', 's', 'k'), /resposta vazia/);
  assert.ok(logger.linhas.includes('warn HF meu/modelo: 500'));
  assert.ok(logger.linhas.some(l => l.endsWith('ETIMEDOUT')));
  assert.ok(logger.linhas.some(l => l.endsWith('socket hang up')));
});

test('Pollinations e Ollama: modelo por ambiente e resposta nos dois formatos', async t => {
  const { ai } = carregar(t);
  let resposta;
  const chamadas = axiosFalso(t, [['pollinations.ai', async () => ok('poll')], ['/api/chat', async () => resposta]]);
  assert.strictEqual(await ai.callPollinations('p', 's'), 'poll');
  assert.strictEqual(chamadas[0].body.model, 'openai');
  assert.strictEqual(chamadas[0].body.max_tokens, 2000);
  comAmbiente(t, { POLLINATIONS_MODEL: 'mistral', OLLAMA_URL: 'http://ollama-local:1', OLLAMA_MODEL: 'qwen' });
  await ai.callPollinations('p', 's');
  assert.strictEqual(chamadas[1].body.model, 'mistral');

  resposta = { data: { message: { content: 'chat' } } };
  assert.strictEqual(await ai.callOllama('p', 's'), 'chat');
  assert.strictEqual(chamadas[2].url, 'http://ollama-local:1/api/chat');
  assert.strictEqual(chamadas[2].body.model, 'qwen');
  resposta = { data: { response: 'gerado' } };
  assert.strictEqual(await ai.callOllama('p', 's'), 'gerado');
  comAmbiente(t, { OLLAMA_URL: undefined, OLLAMA_MODEL: undefined });
  await ai.callOllama('p', 's');
  assert.strictEqual(chamadas[4].url, 'http://localhost:11434/api/chat');
  assert.strictEqual(chamadas[4].body.model, 'llama3.1');

  resposta = { data: { message: { content: 'vps' } } };
  assert.strictEqual(await ai.callOllamaVps('p', 's'), 'vps');
  assert.strictEqual(chamadas[5].url, 'http://172.18.0.11:11434/api/chat');
  assert.strictEqual(chamadas[5].body.model, 'llama3.2:3b');
  resposta = { data: { message: {}, response: 'bruto' } };
  assert.strictEqual(await ai.callOllamaVps('p', 's'), 'bruto');
  resposta = { data: { response: 'sem message' } };
  assert.strictEqual(await ai.callOllamaVps('p', 's'), 'sem message');
});

test('Ollama VPS: endereco e modelo vem do ambiente', async t => {
  const { ai } = carregar(t, { env: { OLLAMA_VPS_CONTAINER_IP: '10.0.0.9', OLLAMA_VPS_MODEL: 'phi' } });
  const chamadas = axiosFalso(t, [['/api/chat', async () => ({ data: { response: 'ok' } })]]);
  await ai.callOllamaVps('p', 's');
  assert.strictEqual(chamadas[0].url, 'http://10.0.0.9:11434/api/chat');
  assert.strictEqual(chamadas[0].body.model, 'phi');
});

// ═══════════════════════════════════════════════════════════════════════════
// Orcamento diario do Gemini (Redis compartilhado)
// ═══════════════════════════════════════════════════════════════════════════

const TODOS = ['gemini', 'sambanova', 'cerebras', 'groq', 'deepseek', 'huggingface', 'pollinations'];
const so = (...p) => ({ skip: TODOS.filter(x => !p.includes(x)) });

test('hostPortaRedis le REDIS_URL e cai no padrao do compose', t => {
  const { ai } = carregar(t);
  assert.deepStrictEqual(ai.hostPortaRedis('redis://cache:6380'), { host: 'cache', porta: 6380 });
  assert.deepStrictEqual(ai.hostPortaRedis('redis://cache'), { host: 'cache', porta: 6379 });
  assert.deepStrictEqual(ai.hostPortaRedis('redis://:7000'), { host: 'redis', porta: 7000 });
  assert.deepStrictEqual(ai.hostPortaRedis(undefined), { host: 'redis', porta: 6379 });
});

test('primeira chamada do dia conta no Redis e agenda a expiracao para depois da meia-noite UTC', async t => {
  const redis = redisFalso(args => (args[0] === 'INCR' ? ':1\r\n' : '+OK\r\n'));
  const { ai } = carregar(t, { redis, env: { GEMINI_API_KEY: 'AIza-gem-11111111', REDIS_URL: 'redis://cache-x:6390' } });
  const r = await ai.generate('p', 's', so('gemini'));
  assert.strictEqual(r.provider, 'gemini');
  assert.deepStrictEqual(redis.conexoes[0], { host: 'cache-x', port: 6390 });
  assert.strictEqual(redis.comandos[0][0], 'INCR');
  assert.strictEqual(redis.comandos[0][1], 'ai:gemini:sys:ebook:daily:' + new Date().toISOString().slice(0, 10));
  assert.strictEqual(redis.comandos[1][0], 'EXPIRE');
  const ttl = Number(redis.comandos[1][2]);
  assert.ok(ttl > 3600 && ttl <= 86400 + 3600, 'ttl ' + ttl);
});

test('teto diario do Gemini: acima pula para o proximo provedor sem degradar', async t => {
  let contagem = ':1501\r\n';
  const redis = redisFalso(() => contagem);
  // Teto fixado aqui: o padrao passou a depender de quantas chaves o ambiente
  // tem (1.500 por chave x 60% guardados para os outros sistemas). O que este
  // teste guarda e o comportamento no limite, nao o numero.
  const { ai, lerEstado, arquivo } = carregar(t, { redis, env: { GEMINI_API_KEY: 'AIza-gem-11111111', EBOOK_GEMINI_DAILY_MAX: '1500' } });
  axiosFalso(t, [['pollinations.ai', async () => ok('poll')]]);
  const r = await ai.generate('p', 's', so('gemini', 'pollinations'));
  assert.strictEqual(r.provider, 'pollinations');
  assert.strictEqual(redis.comandos.length, 1, 'contagem > 1 nao reagenda expiracao');
  assert.ok(!fs.existsSync(arquivo) || Object.keys(lerEstado().degraded).length === 0, 'teto do dia nao degrada chave');
  contagem = ':1500\r\n';
  assert.strictEqual((await ai.generate('p', 's', so('gemini', 'pollinations'))).provider, 'gemini', 'no limite exato ainda passa');
});

test('EBOOK_GEMINI_DAILY_MAX reduz o teto sem deploy', async t => {
  const { ai } = carregar(t, { redis: redisFalso(() => ':6\r\n'), env: { GEMINI_API_KEY: 'AIza-gem-11111111', EBOOK_GEMINI_DAILY_MAX: '5' } });
  axiosFalso(t, [['pollinations.ai', async () => ok('poll')]]);
  assert.strictEqual((await ai.generate('p', 's', so('gemini', 'pollinations'))).provider, 'pollinations');
});

test('Redis fora do ar ou com resposta estranha nao bloqueia o Gemini; contador nao numerico bloqueia', async t => {
  const casos = [
    ['erro', 'gemini'], ['timeout', 'gemini'], [null, 'gemini'], ['$-1\r\n', 'gemini'], ['$2\r\n12\r\n', 'gemini'],
    ['$5', 'gemini'], ['-ERR wrong type\r\n', 'gemini'], ['+OK\r\n', 'pollinations'],
  ];
  for (const [resposta, esperado] of casos) {
    const redis = redisFalso(() => resposta);
    const { ai } = carregar(t, { redis, env: { GEMINI_API_KEY: 'AIza-gem-11111111' } });
    axiosFalso(t, [['pollinations.ai', async () => ok('poll')]]);
    assert.strictEqual((await ai.generate('p', 's', so('gemini', 'pollinations'))).provider, esperado, 'resposta ' + JSON.stringify(resposta));
  }
  const quebrado = { createConnection() { throw new Error('sem socket'); } };
  const { ai } = carregar(t, { redis: quebrado, env: { GEMINI_API_KEY: 'AIza-gem-11111111' } });
  assert.strictEqual((await ai.generate('p', 's', so('gemini'))).provider, 'gemini');
});

// ═══════════════════════════════════════════════════════════════════════════
// generate: cadeia de fallback
// ═══════════════════════════════════════════════════════════════════════════

test('generate repassa o teto ao provedor e usa o sistema padrao quando nao ha system prompt', async t => {
  const { ai } = carregar(t, { env: { GROQ_API_KEY: 'gsk-11111111' } });
  const chamadas = axiosFalso(t, [['api.groq.com', async () => ok('resposta')]]);
  const r = await ai.generate('escreva', '', { ...so('groq'), maxTokens: 60 });
  assert.strictEqual(r.text, 'resposta');
  assert.strictEqual(r.provider, 'groq');
  assert.strictEqual(typeof r.elapsed, 'number');
  assert.strictEqual(chamadas[0].body.max_tokens, 60);
  assert.match(chamadas[0].body.messages[0].content, /escritor profissional/);
  await ai.generate('escreva', undefined, so('groq'));
  assert.match(chamadas[1].body.messages[0].content, /escritor profissional/);
});

test('generate sem opcoes percorre a cadeia; provedor sem chave e pulado', async t => {
  const { ai, logger } = carregar(t);
  axiosFalso(t, [['pollinations.ai', async () => ok('so o gratuito')]]);
  const r = await ai.generate('p');
  assert.strictEqual(r.provider, 'pollinations');
  assert.ok(logger.linhas.includes('info ⏭️  Pulando groq (sem chave válida disponível)'));
});

test('provedor degradado inteiro e pulado; sondagem que responde encerra a degradacao', async t => {
  const agora = Date.now();
  const { ai, lerEstado, logger } = carregar(t, {
    env: { GROQ_API_KEY: 'gsk-11111111' },
    estadoInicial: { degraded: {
      groq: { until: agora + 3600000, since_ms: agora, lastProbe: agora },
      pollinations: { until: agora + 3600000, since_ms: agora - 3600000 },
      'pollinations:free': { until: agora + 3600000, since_ms: agora - 3600000, lastProbe: agora },
    }, keyIndex: {} },
  });
  const chamadas = axiosFalso(t, [['pollinations.ai', async () => ok('sondou')]]);
  const r = await ai.generate('p', 's', so('groq', 'pollinations'));
  assert.strictEqual(r.provider, 'pollinations');
  assert.strictEqual(chamadas.length, 1, 'groq degradado nao recebeu requisicao');
  assert.ok(logger.linhas.some(l => l.startsWith('info ⏭️  Pulando groq (degraded até')));
  assert.deepStrictEqual(Object.keys(lerEstado().degraded), ['groq']);
});

test('400/422 sao da requisicao: nenhuma chave e degradada e a cadeia segue', async t => {
  const { ai, lerEstado } = carregar(t, { env: { GROQ_API_KEY: 'gsk-11111111', GROQ_API_KEY_2: 'gsk-22222222', DEEPSEEK_API_KEY: 'sk-33333333' } });
  axiosFalso(t, [
    ['api.groq.com', async () => { throw erroHttp(400, { data: { error: { message: 'messages.0.content must be a string' } } }); }],
    ['api.deepseek.com', async () => { throw Object.assign(new Error('unprocessable'), { status: 422 }); }],
    ['pollinations.ai', async () => ok('seguiu')],
  ]);
  const r = await ai.generate('p', 's', so('groq', 'deepseek', 'pollinations'));
  assert.strictEqual(r.provider, 'pollinations');
  assert.deepStrictEqual(lerEstado().degraded, {});
  axiosFalso(t, [['api.groq.com', async () => { throw Object.assign(new Error(''), { status: 400 }); }]]);
  await assert.rejects(() => ai.generate('p', 's', so('groq')), /groq\(requisicao-invalida\)/);
});

test('provedor de chave unica que falha e degradado inteiro', async t => {
  const { ai, lerEstado } = carregar(t, { env: { DEEPSEEK_API_KEY: 'sk-33333333' } });
  axiosFalso(t, [['api.deepseek.com', async () => { throw erroHttp(402); }], ['pollinations.ai', async () => ok('p')]]);
  assert.strictEqual((await ai.generate('p', 's', so('deepseek', 'pollinations'))).provider, 'pollinations');
  const d = lerEstado().degraded;
  assert.deepStrictEqual(Object.keys(d), ['deepseek']);
  assert.strictEqual(d.deepseek.hours, 24);
});

test('varias chaves: a que falha e marcada e a proxima responde na mesma chamada', async t => {
  const { ai, lerEstado } = carregar(t, { env: { GROQ_API_KEY: 'gsk-aaaaaaaa', GROQ_API_KEY_2: 'gsk-bbbbbbbb' } });
  axiosFalso(t, [['api.groq.com', async (body, config) => {
    if (config.headers.Authorization.endsWith('aaaaaaaa')) throw erroHttp(401);
    return ok('segunda chave');
  }]]);
  const r = await ai.generate('p', 's', so('groq'));
  assert.deepStrictEqual([r.text, r.provider], ['segunda chave', 'groq']);
  assert.deepStrictEqual(Object.keys(lerEstado().degraded), ['groq:aaaaaaaa']);
});

test('todas as chaves e provedores falham, sem Ollama: erro lista quem foi tentado e por que', async t => {
  const { ai, lerEstado } = carregar(t, { env: { HUGGINGFACE_API_KEY: 'hf-aaaaaaaa', HUGGINGFACE_API_KEY_2: 'hf-bbbbbbbb' } });
  const semMensagem = new Error('x');
  axiosFalso(t, [
    ['router.huggingface.co', async () => { throw erroHttp(429); }],
    ['pollinations.ai', async () => { semMensagem.message = undefined; throw semMensagem; }],
  ]);
  await assert.rejects(() => ai.generate('p', 's', so('huggingface', 'pollinations')), e => {
    assert.match(e.message, /Providers tentados: huggingface, pollinations\./);
    assert.match(e.message, /Erros: huggingface\(quota\/rate-limit\), huggingface\(quota\/rate-limit\), pollinations\(unknown\)\./);
    assert.ok(!e.message.includes('undefined'), 'o operador precisa ler o motivo de cada chave');
    return true;
  });
  const d = lerEstado().degraded;
  assert.ok(d['huggingface:aaaaaaaa'] && d['huggingface:bbbbbbbb'] && d.pollinations);
});

// ── Fallback Ollama ─────────────────────────────────────────────────────────

/** Avanca o relogio falso ate a promessa terminar (os laços do Ollama esperam 30-60 s). */
async function comRelogio(t, promessa) {
  let fim = false;
  const p = promessa.finally(() => { fim = true; });
  p.catch(() => {});
  while (!fim) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(60000); }
  return p;
}

test('Ollama VPS responde quando tudo mais falhou', async t => {
  const { ai } = carregar(t);
  const chamadas = axiosFalso(t, [['11434/api/tags', async () => ({ data: {} })], ['11434/api/chat', async () => ({ data: { response: 'do vps' } })]]);
  const r = await ai.generate('p', 's', so('pollinations'));
  assert.deepStrictEqual(r, { text: 'do vps', provider: 'ollamaVps', elapsed: 0 });
  assert.strictEqual(chamadas.find(c => c.metodo === 'get').url, 'http://172.18.0.11:11434/api/tags');
});

test('Ollama VPS com timeout espera 60 s e tenta de novo enquanto nenhum pago voltou', async t => {
  const { ai, logger } = carregar(t, { env: { GROQ_API_KEY: 'gsk-11111111' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  axiosFalso(t, [
    ['172.18.0.11:11434/api/tags', async () => ({ data: {} })],
    ['172.18.0.11:11434/api/chat', async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('estourou'), { code: 'ECONNABORTED' });
      if (n === 2) throw new Error('timeout of 360000ms exceeded');
      return { data: { response: 'na terceira' } };
    }],
  ]);
  const r = await comRelogio(t, ai.generate('p', 's'));
  assert.strictEqual(r.text, 'na terceira');
  assert.strictEqual(logger.linhas.filter(l => l === 'info Aguardando 60s antes do proximo Ollama...').length, 2);
});

test('Ollama VPS com erro comum espera 30 s; provedor pago disponivel interrompe o fallback', async t => {
  const { ai, logger } = carregar(t, { env: { GROQ_API_KEY: 'gsk-11111111' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  axiosFalso(t, [
    ['172.18.0.11:11434/api/tags', async () => ({ data: {} })],
    ['172.18.0.11:11434/api/chat', async () => { throw new Error(''); }],
  ]);
  // groq foi pulado (skip), entao nao esta degradado: conta como "recuperado".
  await assert.rejects(() => comRelogio(t, ai.generate('p', 's', { skip: ['groq'] })), /PAID_PROVIDER_RECOVERED:groq/);
  assert.ok(logger.linhas.includes('info Aguardando 30s antes do proximo Ollama...'));
});

test('Ollama VPS fora do ar (ECONNREFUSED) cai no Ollama local', async t => {
  const { ai } = carregar(t, { env: { OLLAMA_URL: 'http://meu-ollama:9' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let local = 0;
  const chamadas = axiosFalso(t, [
    ['172.18.0.11:11434/api/tags', async () => ({ data: {} })],
    ['172.18.0.11:11434/api/chat', async () => { throw new Error('connect ECONNREFUSED 172.18.0.11'); }],
    ['meu-ollama:9/api/tags', async () => ({ data: {} })],
    ['meu-ollama:9/api/chat', async () => {
      local++;
      if (local === 1) throw new Error('model loading');
      if (local === 2) throw new Error('');   // erro sem mensagem tambem espera e tenta de novo
      return { data: { message: { content: 'local' } } };
    }],
  ]);
  const r = await comRelogio(t, ai.generate('p', 's'));
  assert.deepStrictEqual(r, { text: 'local', provider: 'ollama', elapsed: 0 });
  assert.ok(chamadas.some(c => c.url === 'http://meu-ollama:9/api/tags'));
});

test('Ollama VPS ENOTFOUND e Ollama local recusando: erro final', async t => {
  const { ai } = carregar(t);
  axiosFalso(t, [
    ['172.18.0.11:11434/api/tags', async () => ({ data: {} })],
    ['172.18.0.11:11434/api/chat', async () => { throw new Error('getaddrinfo ENOTFOUND ollama'); }],
    ['localhost:11434/api/tags', async () => ({ data: {} })],
    ['localhost:11434/api/chat', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }],
  ]);
  await assert.rejects(() => ai.generate('p', 's'), /Todos os providers de AI falharam/);
});

test('verificacao de recuperacao ignora provedor degradado e sem chave', async t => {
  const agora = Date.now();
  const marca = { until: agora + 3600000, since_ms: agora, lastProbe: agora };
  const { ai } = carregar(t, {
    env: { DEEPSEEK_API_KEY: 'sk-11111111', GROQ_API_KEY: 'gsk-aaaaaaaa', GROQ_API_KEY_2: 'gsk-bbbbbbbb' },
    estadoInicial: { degraded: { deepseek: marca, 'groq:aaaaaaaa': marca, 'groq:bbbbbbbb': marca, pollinations: marca }, keyIndex: {} },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  axiosFalso(t, [
    ['172.18.0.11:11434/api/tags', async () => ({ data: {} })],
    ['172.18.0.11:11434/api/chat', async () => { if (++n === 1) throw new Error('falhou'); return { data: { response: 'segunda' } }; }],
  ]);
  const r = await comRelogio(t, ai.generate('p', 's'));
  assert.strictEqual(r.text, 'segunda', 'nenhum pago disponivel: continua no Ollama');
});

// ═══════════════════════════════════════════════════════════════════════════
// Painel e operacao
// ═══════════════════════════════════════════════════════════════════════════

test('getStatus conta chaves disponiveis e resume quem esta no ar', t => {
  const agora = Date.now();
  const { ai } = carregar(t, {
    env: { GROQ_API_KEY: 'gsk-aaaaaaaa', GROQ_API_KEY_2: 'gsk-bbbbbbbb', DEEPSEEK_API_KEY: 'sk-11111111' },
    estadoInicial: { degraded: { 'groq:aaaaaaaa': { until: agora + 60000 }, deepseek: { until: agora + 60000 } }, keyIndex: {} },
  });
  const s = ai.getStatus();
  assert.deepStrictEqual({ ...s.groq, limits: undefined }, { configured: true, totalKeys: 2, availableKeys: 1, degraded: false, degradedUntil: null, limits: undefined });
  assert.strictEqual(s.deepseek.degraded, true);
  assert.strictEqual(s.deepseek.degradedUntil, new Date(agora + 60000).toISOString());
  assert.deepStrictEqual({ configured: s.gemini.configured, totalKeys: s.gemini.totalKeys }, { configured: false, totalKeys: 0 });
  assert.deepStrictEqual({ configured: s.pollinations.configured, availableKeys: s.pollinations.availableKeys }, { configured: true, availableKeys: 1 });
  assert.deepStrictEqual(s.groq.limits, { rpm: 30, rpd: 14400 });
  assert.deepStrictEqual(s._summary, { anyAvailable: true, availableProviders: ['groq', 'pollinations'] });
});

test('resetDegraded limpa um provedor (e suas chaves) ou todos', t => {
  const agora = Date.now();
  const marca = { until: agora + 60000, since_ms: agora - 1000 };
  const { ai, lerEstado } = carregar(t, { estadoInicial: { degraded: { groq: marca, 'groq:aaaaaaaa': marca, deepseek: marca }, keyIndex: {} } });
  ai.resetDegraded('groq');
  assert.deepStrictEqual(Object.keys(lerEstado().degraded), ['deepseek']);
  ai.resetDegraded();
  assert.deepStrictEqual(lerEstado().degraded, {});
});

test('Ctrl+C encerra o processo', t => {
  carregar(t);
  const ouvinte = process.listeners('SIGINT').at(-1);
  const exit = t.mock.method(process, 'exit', () => {});
  ouvinte();
  assert.strictEqual(exit.mock.callCount(), 1);
  process.removeListener('SIGINT', ouvinte);
});

test('quando ninguem e tentado, a falha DIZ por que cada um ficou de fora', async t => {
  // 23/09/2026: com o teto diario estourado a excecao saia muda — "Providers
  // tentados: . Erros: " — e nao havia como descobrir que era o teto.
  const { ai } = carregar(t, {
    redis: redisFalso(() => ':9999\r\n'),
    env: { GEMINI_API_KEY: 'AIza-gem-11111111', EBOOK_GEMINI_DAILY_MAX: '10' },
  });
  axiosFalso(t, []);
  await assert.rejects(() => ai.generate('p', 's', so('gemini')), e => {
    assert.match(e.message, /Providers tentados: \(nenhum\)/);
    assert.match(e.message, /Erros: \(nenhum\)/);
    assert.match(e.message, /Pulados: gemini\(teto diario 10\)/);
    return true;
  });
});

test('teto calculado: mais chaves, mais teto', () => {
  const { tetoDiarioGemini } = require('../src/core/aiClient');
  assert.strictEqual(tetoDiarioGemini(6), 5400);
  assert.strictEqual(tetoDiarioGemini(2, 1000, 0.5), 1000);
});
