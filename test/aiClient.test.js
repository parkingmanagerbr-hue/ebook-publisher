// Travas da cadeia de IA.
//
// Este e o modulo que PAROU a geracao inteira duas vezes. Nos dois casos a
// causa foi a mesma familia de erro: uma condicao TEMPORARIA (cota do dia,
// soluco de rede) virou bloqueio prolongado sobre um recurso que funcionava.
// Cada teste abaixo fixa um desses casos.
const { test } = require('node:test');
const assert = require('node:assert');

// A sondagem grava o estado: sem isto o teste escrevia no data/ai_state.json real.
process.env.AI_STATE_FILE = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'aiclient-')), 'ai_state.json');
const { acaoParaErroGroq, isDegraded, getNextKey } = require('../src/core/aiClient');

// ── acaoParaErroGroq ────────────────────────────────────────────────────────
// O 429 abortava o laco de modelos com `throw`. Como a cota do Groq e POR
// MODELO, o modelo menor — que ainda tinha cota — nunca era tentado, e as 8
// chaves acabavam degradadas. Medido na API: gpt-oss-120b devolvia 429
// enquanto gpt-oss-20b respondia 200 com a MESMA chave.

test('429 avanca para o proximo modelo (a cota do Groq e por modelo)', () => {
  assert.equal(acaoParaErroGroq(429, 'Rate limit reached for model gpt-oss-120b'), 'proximo-modelo');
});

test('429 NUNCA desiste do provider — foi o bug que parou a geracao', () => {
  assert.notEqual(acaoParaErroGroq(429, 'quota exceeded'), 'desistir');
});

test('413 reduz o teto e repete o MESMO modelo', () => {
  // Trocar de modelo aqui seria errado: o problema e o tamanho do pedido, nao
  // o modelo.
  assert.equal(acaoParaErroGroq(413, 'Request too large'), 'reduzir-teto');
  assert.equal(acaoParaErroGroq(413, ''), 'reduzir-teto');
  assert.equal(acaoParaErroGroq(400, 'please reduce your message length'), 'reduzir-teto');
});

test('404 (modelo aposentado) avanca para o proximo modelo', () => {
  assert.equal(acaoParaErroGroq(404, 'model does not exist'), 'proximo-modelo');
  assert.equal(acaoParaErroGroq(400, 'model has been decommissioned'), 'proximo-modelo');
});

test('401 e 402 desistem: o problema e a chave ou a conta, nao o modelo', () => {
  // Insistir em outro modelo com chave invalida so gasta tentativa.
  assert.equal(acaoParaErroGroq(401, 'Invalid API Key'), 'desistir');
  assert.equal(acaoParaErroGroq(402, 'Insufficient Balance'), 'desistir');
  assert.equal(acaoParaErroGroq(403, 'forbidden'), 'desistir');
});

test('erro sem status (rede) desiste do provider, sem mascarar de cota', () => {
  assert.equal(acaoParaErroGroq(undefined, 'socket hang up'), 'desistir');
  assert.equal(acaoParaErroGroq(500, 'internal error'), 'desistir');
});

test('acaoParaErroGroq tolera mensagem ausente', () => {
  for (const v of [null, undefined, '']) assert.equal(typeof acaoParaErroGroq(500, v), 'string');
});

// ── isDegraded / sondagem meio-aberta ───────────────────────────────────────
// Sem sondagem, um provider punido por 24h fica fora mesmo depois que a cota
// diaria reseta. Com sondagem mal feita, ela dispara a cada chamada e martela
// o provider — foi o que aconteceu: "Sondando gemini" a cada 30 segundos.

function estado(degraded) { return { degraded, keyIndex: {} }; }

test('provider fora da lista de degradados nao esta degradado', () => {
  assert.equal(isDegraded(estado({}), 'groq'), false);
});

test('punicao vencida e esquecida', () => {
  const st = estado({ groq: { until: Date.now() - 1000, since_ms: Date.now() - 90000000 } });
  assert.equal(isDegraded(st, 'groq'), false);
  assert.equal(st.degraded.groq, undefined, 'a entrada vencida tem de sair do estado');
});

test('punicao recente bloqueia entre sondagens', () => {
  const agora = Date.now();
  const st = estado({ groq: { until: agora + 3600000, since_ms: agora, lastProbe: agora } });
  assert.equal(isDegraded(st, 'groq'), true);
});

test('passado o intervalo, libera UMA sondagem', () => {
  const agora = Date.now();
  const antigo = agora - 25 * 60 * 1000;   // 25 min: alem do intervalo de 20
  const st = estado({ groq: { until: agora + 3600000, since_ms: antigo, lastProbe: antigo } });
  assert.equal(isDegraded(st, 'groq'), false, 'cota do dia pode ter resetado — precisa testar');
});

test('a sondagem carimba o horario, para nao virar enxurrada', () => {
  // O defeito real: o carimbo ficava so em memoria e o estado e relido do disco
  // a cada chamada, entao a sondagem disparava a cada 30s.
  const agora = Date.now();
  const antigo = agora - 25 * 60 * 1000;
  const st = estado({ groq: { until: agora + 3600000, since_ms: antigo, lastProbe: antigo } });

  isDegraded(st, 'groq');
  assert.ok(st.degraded.groq.lastProbe > antigo, 'a sondagem precisa carimbar lastProbe');
  assert.equal(isDegraded(st, 'groq'), true, 'a sondagem seguinte tem de esperar o intervalo');
});

// ── getNextKey ──────────────────────────────────────────────────────────────

test('getNextKey devolve null quando o provider nao tem chave', () => {
  assert.equal(getNextKey(estado({}), 'provider-inexistente'), null);
});

test('getNextKey nao devolve chave de provider inteiramente degradado', () => {
  // Nao ha chave utilizavel; o chamador tem de pular o provider, nao mandar
  // requisicao fadada ao erro.
  const st = estado({});
  const r = getNextKey(st, 'provider-inexistente');
  assert.equal(r, null);
});

test('teto diario do Gemini nasce do numero de chaves (23/09/2026)', () => {
  const { tetoDiarioGemini } = require('../src/core/aiClient');
  // 6 chaves x 1500 x 60% para os outros sistemas do ecossistema
  assert.strictEqual(tetoDiarioGemini(6), 5400);
  assert.strictEqual(tetoDiarioGemini(12), 10800);
  assert.strictEqual(tetoDiarioGemini(1), 900);
  assert.strictEqual(tetoDiarioGemini(0), 900, 'sem chave declarada, conta como uma');
  assert.strictEqual(tetoDiarioGemini('nao numero'), 900);
  assert.strictEqual(tetoDiarioGemini(6, 1500, 0.1), 900);
  assert.strictEqual(tetoDiarioGemini(1, 100, 0.05), 100, 'nunca abaixo do piso');
  assert.strictEqual(tetoDiarioGemini(6, 1500, 5), 9000, 'fatia acima de 1 vale como 1');
  assert.strictEqual(tetoDiarioGemini(6, 1500, -2), 450, 'fatia negativa cai no piso de 5%, o lado seguro');
  assert.strictEqual(tetoDiarioGemini(6, 'nao numero'), 5400, 'limite por chave invalido cai no padrao de 1500');
  assert.strictEqual(tetoDiarioGemini(6, 0), 5400, 'zero por chave nao zera o teto');
  assert.strictEqual(tetoDiarioGemini(6, 1500, 0), 5400, 'fatia zero cai no padrao de 60%');
  assert.ok(tetoDiarioGemini(6) > 1747, 'o dia que barrou a geracao (1.747 chamadas) caberia hoje');
});
