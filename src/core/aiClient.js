/**
 * GENIA AI Client — Fallback chain completo
 * Baseado no padrão llm_client.py do Clipcaster
 *
 * Ordem: Gemini (5 chaves) → Cerebras (6 chaves) → SambaNova (6 chaves) → Groq → DeepSeek (2 chaves) → HuggingFace (2 chaves) → Ollama VPS → Ollama Local
 *
 * Limites por provider:
 *   Gemini Flash:    15 RPM, 1500 RPD por chave (x5 chaves = 7500 RPD total)
 *   Cerebras:        60 RPM, gratuito, Qwen3-235B ~2000 tok/s
 *   SambaNova:       400 RPM, gratuito, Llama 3.3 70B (x6 chaves)
 *   Groq:            30 RPM, 14400 RPD, gratuito, Llama 3.3 70B
 *   DeepSeek:        free tier (x2 chaves)
 *   HuggingFace:     10 RPM (serverless inference, x2 chaves)
 *   Ollama VPS:      sem limite (llama3.2:3b via SSH tunnel)
 *   Ollama Local:    sem limite (local)
 */
require('dotenv').config();
const { createLogger } = require('./logger');
const logger = createLogger('aiClient');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ═══════════════════════════════════════════════════
// CONFIGURAÇÃO DE CHAVES E PROVIDERS
// ═══════════════════════════════════════════════════

// AI_STATE_FILE existe para os testes gravarem em diretorio temporario — sem ele
// um teste sobrescreveria o estado real das chaves.
const STATE_FILE = process.env.AI_STATE_FILE || path.join(__dirname, '../../data/ai_state.json');

// Suporte a múltiplas chaves por provider (rotação automática)
const PROVIDER_KEYS = {
  gemini: [
    // Chave "paga" PRIMEIRO, como manda o playbook GENIA (L2/L3). Estava no
    // container desde junho e este cliente nunca a lia. Medido em 14/09/2026: o
    // projeto dela ainda esta no FREE TIER (quotaId ...PerModel-FreeTier,
    // limite 20/dia) — o faturamento nao foi ativado no projeto da chave. Fica
    // aqui assim mesmo: no dia em que o faturamento for ligado, passa a valer
    // sem deploy nenhum.
    process.env.GEMINI_PAID_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ].filter(Boolean),

  cerebras:    [
    process.env.CEREBRAS_API_KEY,
    process.env.CEREBRAS_API_KEY_2,
    process.env.CEREBRAS_API_KEY_3,
    process.env.CEREBRAS_API_KEY_4,
    process.env.CEREBRAS_API_KEY_5,
    process.env.CEREBRAS_API_KEY_6,
  ].filter(Boolean),
  sambanova:   [
    process.env.SAMBANOVA_API_KEY,
    process.env.SAMBANOVA_API_KEY_2,
    process.env.SAMBANOVA_API_KEY_3,
    process.env.SAMBANOVA_API_KEY_4,
    process.env.SAMBANOVA_API_KEY_5,
    process.env.SAMBANOVA_API_KEY_6,
    process.env.SAMBANOVA_API_KEY_7,
    process.env.SAMBANOVA_API_KEY_8,
  ].filter(Boolean),
  groq:        [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3, process.env.GROQ_API_KEY_4, process.env.GROQ_API_KEY_5, process.env.GROQ_API_KEY_6, process.env.GROQ_API_KEY_7, process.env.GROQ_API_KEY_8].filter(Boolean),
  deepseek:    [
    process.env.DEEPSEEK_API_KEY,
    process.env.DEEPSEEK_API_KEY_2,
  ].filter(Boolean),
  huggingface: [
    process.env.HUGGINGFACE_API_KEY,
    process.env.HUGGINGFACE_API_KEY_2,
    process.env.HUGGINGFACE_API_KEY_3,
    process.env.HUGGINGFACE_API_KEY_4,
    process.env.HUGGINGFACE_API_KEY_5,
    process.env.HUGGINGFACE_API_KEY_6,
  ].filter(Boolean),
  pollinations: ['free'],
  ollamaVps:   ['vps'],
  ollama:      ['local'],
};

// Limites RPM/RPD por provider
const LIMITS = {
  gemini:      { rpm: 15,  rpd: 1500 },
  cerebras:    { rpm: 60,  rpd: 99999 },
  sambanova:   { rpm: 400, rpd: 99999 },
  groq:        { rpm: 30,  rpd: 14400 },
  deepseek:    { rpm: 10,  rpd: 99999 },
  huggingface: { rpm: 10,  rpd: 1000 },
  pollinations: { rpm: 30,  rpd: 5000 },
  ollamaVps:   { rpm: 999, rpd: 999999 },
  ollama:      { rpm: 999, rpd: 999999 },
};

// Ordem de fallback — mais rápidos/melhores primeiro
// Providers pagos (com quota) -- fallback infinito Ollama tratado separadamente
const PAID_PROVIDERS = ['gemini', 'sambanova', 'cerebras', 'groq', 'deepseek', 'huggingface', 'pollinations'];
const PROVIDERS = PAID_PROVIDERS;

// ── Cross-system Gemini quota coordinator (Redis DB 0) ────────────────────────
const _qnet = require('net');
/** "redis://host:porta" -> { host, porta }; parte ausente cai no padrao do compose. */
function hostPortaRedis(url) {
  const partes = (url || 'redis://redis:6379').replace(/^redis:\/\//, '').split(':');
  return { host: partes[0] || 'redis', porta: parseInt(partes[1] || '6379') };
}
const { host: _qRH, porta: _qRP } = hostPortaRedis(process.env.REDIS_URL);

function _rCmd(...args) {
  return new Promise(resolve => {
    try {
      const s = _qnet.createConnection({ host: _qRH, port: _qRP });
      let buf = '';
      s.setTimeout(2000);
      s.on('timeout', () => { s.destroy(); resolve(null); });
      s.on('error', () => resolve(null));
      s.on('data', d => { buf += d; });
      s.on('end', () => {
        // buf e sempre string (mesmo vazia): nada aqui lanca, por isso sem try.
        const ln = buf.split('\r\n'); const h = ln[0];
        if (h[0] === '+') return resolve(h.slice(1));
        if (h[0] === ':') return resolve(parseInt(h.slice(1)));
        if (h.startsWith('$-1')) return resolve(null);
        if (h[0] === '$') return resolve(ln[1] ?? null);
        resolve(null);
      });
      const cmd = `*${args.length}\r\n` + args.map(a => `$${String(a).length}\r\n${a}\r\n`).join('');
      s.write(cmd); s.end();
    } catch { resolve(null); }
  });
}
const _QUOTA_SYS = 'ebook';
// Teto diario de chamadas Gemini deste sistema (rateio entre sistemas do
// ecossistema, via Redis). Era 200, numero de quando o e-book gerava pouco. Hoje
// ele e o maior consumidor legitimo: cada capa viral pede um gancho, e 200/dia
// levaria cinco dias so para o catalogo atual. Medido em 11/09/2026: systemcaster
// 266, music 1 — sobra folga. Configuravel para reduzir sem novo deploy.
const _QUOTA_MAX = parseInt(process.env.EBOOK_GEMINI_DAILY_MAX || '1500', 10);
// A bandeira global gemini:daily_exhausted nao e mais lida nem acesa por este
// cliente (ver generate). As duas funcoes que a tocavam ficaram sem chamador e
// sairam; outros sistemas do ecossistema ainda podem usa-la no Redis.
async function _withinDailyBudget() {
  const key = `ai:gemini:sys:${_QUOTA_SYS}:daily:${new Date().toISOString().slice(0, 10)}`;
  const n = await _rCmd('INCR', key);
  if (n === 1) {
    const t = new Date(); t.setUTCHours(0, 0, 0, 0); t.setUTCDate(t.getUTCDate() + 1);
    await _rCmd('EXPIRE', key, String(Math.ceil((t.getTime() - Date.now()) / 1000) + 3600));
  }
  return n === null || n <= _QUOTA_MAX;
}

const SYSTEM_DEFAULT = 'Você é um escritor profissional especializado em e-books educativos em português brasileiro. Escreva de forma clara, prática e envolvente.';

// ═══════════════════════════════════════════════════
// GERENCIAMENTO DE ESTADO (persistido em JSON)
// ═══════════════════════════════════════════════════

function loadState() {
  const defaults = { degraded: {}, keyIndex: {}, callLog: {} };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Mesclar com defaults para garantir todos os campos
      const state = { ...defaults, ...raw, degraded: raw.degraded || {}, keyIndex: raw.keyIndex || {} };
      // Limpar estado expirado
      const now = Date.now();
      for (const [key, val] of Object.entries(state.degraded)) {
        if (now > val.until) delete state.degraded[key];
      }
      // Instante da leitura: o saveState usa para saber quem mexeu no que.
      Object.defineProperty(state, '_lidoEm', { value: now, enumerable: false, configurable: true });
      return state;
    }
  } catch (e) { logger.warn('Estado corrompido, reiniciando: ' + e.message); }
  return defaults;
}

/**
 * Mescla as marcas de degradacao da memoria com as do disco.
 *
 * Varios processos usam o mesmo arquivo (o servidor, o passe de capas, as
 * sondas). Cada um lia o estado, esperava a chamada de IA (ate 2 min) e gravava
 * o objeto INTEIRO de volta — o ultimo a gravar ressuscitava marcas que outro
 * ja tinha liberado. Em 14/09/2026 as 6 chaves do HuggingFace, liberadas duas
 * vezes, voltaram as duas com a marca original, e o pipeline de livros ficou
 * sem provedor com as chaves respondendo 200.
 *
 * Regra, usando o instante em que ESTE processo leu (lidoEm):
 * - marca so na memoria, criada antes da leitura: alguem liberou -> some;
 * - marca so no disco, criada antes da leitura: este processo liberou -> some;
 * - marca so no disco, criada depois: e de outro processo -> fica;
 * - nos dois: vale a mais recente.
 */
function mesclarDegradados(memoria, disco, lidoEm) {
  const t = lidoEm || 0;
  const out = {};
  const desde = v => (v && (v.since_ms || Date.parse(v.since) || 0)) || 0;
  for (const [k, v] of Object.entries(memoria || {})) {
    const d = disco && disco[k];
    if (!d) { if (desde(v) > t) out[k] = v; continue; }
    out[k] = desde(v) >= desde(d) ? v : d;
  }
  for (const [k, d] of Object.entries(disco || {})) {
    if (k in (memoria || {})) continue;
    if (desde(d) > t) out[k] = d;
  }
  return out;
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    let disco = {};
    try { disco = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* primeiro save */ }
    const saida = {
      ...disco,
      ...state,
      degraded: state._lidoEm ? mesclarDegradados(state.degraded, disco.degraded, state._lidoEm) : state.degraded,
      keyIndex: { ...(disco.keyIndex || {}), ...(state.keyIndex || {}) },
    };
    // Temporario + rename: gravar direto truncava o arquivo antes de escrever.
    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(saida, null, 2));
    fs.renameSync(tmp, STATE_FILE);
    state.degraded = saida.degraded;
    // Nunca antes da marca mais nova gravada: ver markDegraded.
    const maisNova = Math.max(0, ...Object.values(saida.degraded || {}).map(v => (v && v.since_ms) || 0));
    Object.defineProperty(state, '_lidoEm', { value: Math.max(Date.now(), maisNova), enumerable: false, configurable: true });
  } catch (e) { logger.warn('Falha ao salvar estado: ' + e.message); }
}

// Degradar provider por N horas (chave específica ou provider inteiro)
function markDegraded(state, key, hours = 1) {
  state.degraded[key] = {
    until: Date.now() + hours * 3_600_000,
    since: new Date().toISOString(),
    // Instante numerico: o isDegraded usa isto para so sondar depois de
    // PROBE_MS. Sem ele, uma degradacao recem-criada seria sondada na hora.
    //
    // ESTRITAMENTE depois da ultima leitura/gravacao deste estado. A mescla do
    // saveState descarta marca "criada antes da leitura" (outro processo a
    // liberou). Com o mesmo milissegundo — falha sincrona logo depois do
    // getNextKey gravar — a marca nova era jogada fora, a chave voltava na
    // rotacao e o laco de chaves alternativas nao terminava.
    since_ms: Math.max(Date.now(), (state._lidoEm || 0) + 1),
    hours,
  };
  logger.warn(`⛔ Degradado: ${key} por ${hours}h`);
  saveState(state);
}

// Intervalo entre sondagens de um provider degradado (circuito meio-aberto).
//
// POR QUE: um 429 cujo corpo cita "day" era tratado como cota diaria e o
// provider ficava degradado ate a meia-noite UTC — sem NUNCA ser re-testado.
// Caso real (25/08/2026): o Groq bateu limite as 00:56, levou 23h de castigo, e
// aos 17:15 as OITO chaves ja respondiam 200 ha horas. O pipeline passou ~200
// ciclos falhando com "todos os providers falharam" enquanto havia um provider
// vivo bloqueado por um prazo chutado.
//
// Prazo de provider gratuito e sempre chute: a janela real de reset nao vem na
// resposta. Uma sondagem de vez em quando custa uma requisicao e devolve horas
// de producao. Se falhar de novo, o prazo se renova e nada se perde.
const PROBE_MS = parseInt(process.env.AI_PROBE_INTERVAL_MS || String(20 * 60 * 1000), 10);

function isDegraded(state, key) {
  const d = state.degraded[key];
  if (!d) return false;
  if (Date.now() > d.until) { delete state.degraded[key]; return false; }

  // Meio-aberto: passado PROBE_MS desde a ultima tentativa, libera UMA sondagem.
  // Marca o instante para nao virar enxurrada de tentativas em paralelo.
  const ultima = d.lastProbe || d.since_ms || 0;
  if (Date.now() - ultima >= PROBE_MS) {
    d.lastProbe = Date.now();
    // PRECISA persistir: o estado e relido do disco a cada chamada, entao um
    // lastProbe so em memoria se perde e a sondagem volta a disparar em toda
    // tentativa. Observado em producao: "Sondando gemini" a cada 30s, ou seja,
    // martelando o provider justamente o que o intervalo existia para evitar.
    saveState(state);
    logger.info(`🔍 Sondando ${key} (degradado, mas pode ter resetado)`);
    return false;
  }
  return true;
}

// Rotação de chaves (pega a próxima chave válida de um provider)
function getNextKey(state, provider) {
  const keys = PROVIDER_KEYS[provider];
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) {
    const k = keys[0];
    return isDegraded(state, `${provider}:${k.slice(-8)}`) ? null : k;
  }
  // Multi-chave: rotação round-robin filtrando degradadas
  const idx = state.keyIndex[provider] || 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(idx + i) % keys.length];
    const keyId = `${provider}:${k.slice(-8)}`;
    if (!isDegraded(state, keyId)) {
      state.keyIndex[provider] = (idx + i + 1) % keys.length;
      saveState(state);
      return k;
    }
  }
  return null; // Todas as chaves degradadas
}

// ═══════════════════════════════════════════════════
// OLLAMA VPS (rede Docker interna)
// ═══════════════════════════════════════════════════

const VPS_OLLAMA_CONTAINER  = process.env.OLLAMA_VPS_CONTAINER_IP || '172.18.0.11';
const VPS_OLLAMA_MODEL      = process.env.OLLAMA_VPS_MODEL || 'llama3.2:3b';

// O tunel SSH para o Ollama (ensureVpsTunnel) saiu: nada o chamava desde que o
// acesso passou a ser direto pela rede Docker (callOllamaVps). Fica o SIGINT,
// que encerra o processo como antes.
process.on('SIGINT', () => { process.exit(); });

// ═══════════════════════════════════════════════════
// CHAMADAS POR PROVIDER
// ═══════════════════════════════════════════════════

/**
 * Modelos Gemini tentados EM SEQUENCIA para a mesma chave.
 *
 * A cota do free tier e por projeto E POR MODELO (o quotaId do 429 termina em
 * PerProjectPerModel). Com um modelo so, quando o gemini-2.5-flash esgotava o dia
 * a chave inteira dava 429 e o provedor era marcado como morto — enquanto
 * gemini-flash-latest e gemini-2.5-flash-lite, baldes SEPARADOS, respondiam 200
 * na mesma chave e no mesmo minuto (medido pelo destravar_ia em 10-11/09/2026).
 * Na pratica: capas saindo sem gancho, 0 a 7 de cada 40.
 *
 * GEMINI_MODEL, se definido, vai na frente — mas nao fica sozinho.
 */
// Modelos novos entram como baldes de cota SEPARADOS. Medido em 14/09/2026:
// gemini-3-flash-preview, gemini-3.5-flash-lite e gemini-flash-lite-latest
// respondiam 200 em 8 de 12 chaves, e o sistema nunca os tinha usado.
// gemini-2.5-flash-lite e gemini-2.5-pro sairam: devolvem 404 "no longer
// available to new users" — cada tentativa era uma chamada jogada fora.
const MODELOS_GEMINI = [...new Set([
  process.env.GEMINI_MODEL,
  'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-flash-latest',
  'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.0-flash',
].filter(Boolean))];

function ehCotaOuModeloIndisponivel(e) {
  const msg = String((e && e.message) || '');
  const st = e && (e.status || (e.response && e.response.status));
  return st === 429 || st === 404 || /429|quota|RESOURCE_EXHAUSTED|not found|is not supported/i.test(msg);
}

async function callGemini(prompt, systemPrompt, apiKey) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  let ultimo;
  for (const nome of MODELOS_GEMINI) {
    try {
      const model = genAI.getGenerativeModel({ model: nome, systemInstruction: systemPrompt });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      ultimo = e;
      // Cota/modelo: proximo balde. Qualquer outra coisa (chave invalida, rede)
      // nao melhora trocando de modelo — propaga para o chamador rotacionar.
      if (!ehCotaOuModeloIndisponivel(e)) throw e;
    }
  }
  // Todos os baldes desta chave esgotados: devolve o ultimo 429 intacto, para a
  // logica de degradacao do chamador reconhecer como cota.
  throw ultimo;
}

async function callCerebras(prompt, systemPrompt, apiKey, opts) {
  // Modelos disponíveis (maio 2026): gpt-oss-120b, zai-glm-4.7 (qwen-3-235b removido)
  const model = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';
  // `maxTokens` era usado sem existir: TODA chamada lancava ReferenceError antes
  // de sair a requisicao, e o generate degradava a chave como erro "unknown".
  const maxTokens = (opts && opts.maxTokens) || 8000;
  const response = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.7,
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    timeout: 60_000,
  });
  if (response.data.error) throw new Error(response.data.error.message || JSON.stringify(response.data.error));
  return response.data.choices[0].message.content;
}

// Modelos do Groq em ordem de preferencia.
//
// POR QUE UMA LISTA E NAO UM NOME FIXO: o default era 'llama-3.3-70b-versatile',
// que o Groq DESCONTINUOU. A API respondia 404 "model does not exist" —
// erro de MODELO, nao de chave nem de cota — mas o cliente tratava como falha
// do provider e marcava o Groq como degradado. Com Gemini em 429 e Cerebras em
// 402 (fim do tier gratuito), o Groq era o unico caminho vivo e estava fora por
// um nome de modelo velho: 189 ciclos seguidos falharam com "Todos os providers
// de AI falharam" (21/08/2026). Provedor gratuito aposenta modelo sem aviso,
// entao um nome fixo e uma bomba-relogio: cair para o proximo da lista custa
// uma requisicao e evita derrubar o pipeline inteiro.
const GROQ_MODELS = (process.env.GROQ_MODEL ? [process.env.GROQ_MODEL] : [])
  .concat(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound-mini']);

// Teto de saida do Groq.
//
// O default do cliente era 8000, mas o limite da organizacao e de 8000 tokens
// POR MINUTO somando prompt + resposta: a API devolvia 413 "Request too large
// (Limit 8000, Requested 8086)". Erro de TAMANHO, nao de chave — e o cliente
// marcava as 8 chaves como degradadas, tirando o provider inteiro do ar.
const GROQ_MAX_TOKENS = parseInt(process.env.GROQ_MAX_TOKENS || '4096', 10);

/**
 * Decide o que fazer com um erro do Groq, sem tocar em rede.
 *
 * Estava embutido no laco e por isso ninguem conseguia testar o caso que
 * derrubou a geracao: um 429 abortava TUDO com `throw`, entao o modelo menor —
 * que ainda tinha cota — nunca era tentado, e o chamador ainda degradava a
 * chave por horas. Oito chaves boas ficaram bloqueadas assim.
 *
 * Devolve: 'reduzir-teto' | 'proximo-modelo' | 'desistir'.
 */
function acaoParaErroGroq(status, mensagem) {
  const msg = String(mensagem || '');
  // 413: o prompt mais a resposta nao cabem na janela. Vale reduzir o teto e
  // tentar de novo com o MESMO modelo.
  if (status === 413 || /too large|reduce your message/i.test(msg)) return 'reduzir-teto';
  // 404: modelo aposentado — nao adianta insistir nele.
  if (status === 404 || /does not exist|decommissioned|not found/i.test(msg)) return 'proximo-modelo';
  // 429: cota do Groq e POR MODELO. Medido: gpt-oss-120b devolvia 429 enquanto
  // gpt-oss-20b respondia 200 com a MESMA chave.
  if (status === 429) return 'proximo-modelo';
  // 401/402/403 e o resto sao da chave ou da conta: trocar de modelo so gasta cota.
  return 'desistir';
}

/**
 * O teto pedido pelo chamador PRECISA chegar aqui.
 *
 * Antes, generate() chamava o provedor so com (prompt, sys, chave) e as opcoes
 * morriam no caminho: toda chamada reservava GROQ_MAX_TOKENS (4096). O Groq
 * desconta o max_tokens PEDIDO do limite por minuto no ato — um gancho de capa
 * de ~50 tokens consumia o orcamento de 80, e as chaves batiam no teto do minuto
 * em rajada. Menor teto pedido = mais chamadas cabendo no mesmo minuto.
 */
async function callGroq(prompt, systemPrompt, apiKey, opts) {
  let ultimoErro = null;
  const pedido = opts && Number(opts.maxTokens) > 0 ? Math.min(Number(opts.maxTokens), GROQ_MAX_TOKENS) : GROQ_MAX_TOKENS;
  for (const model of GROQ_MODELS) {
    // Minimo 1: com teto pedido 1 a metade era 0, e o `|| 8000` do envio
    // transformava a "reducao" num pedido de 8000 tokens.
    for (const teto of [pedido, Math.max(1, Math.floor(pedido / 2))]) {
      try {
        return await callGroqComModelo(prompt, systemPrompt, apiKey, model, teto);
      } catch (e) {
        const st = e?.response?.status;
        const msg = e?.response?.data?.error?.message || e.message || '';
        ultimoErro = e;
        const acao = acaoParaErroGroq(st, msg);
        if (acao === 'reduzir-teto') continue;
        if (acao === 'proximo-modelo') break;
        throw e;
      }
    }
  }
  // GROQ_MODELS nunca e vazia (tres fixos), entao ao chegar aqui houve erro.
  throw ultimoErro;
}

async function callGroqComModelo(prompt, systemPrompt, apiKey, model, maxTokens) {
  const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    // Usar o teto recebido, nao um 8000 fixo: o 8000 ignorava o parametro e
    // deixava INERTE a re-tentativa com metade do teto no 413 — o retry
    // reenviava exatamente a mesma requisicao e falhava igual.
    max_tokens: maxTokens,
    temperature: 0.7,
    // gpt-oss e modelo de raciocinio: o pensamento sai do mesmo max_tokens. Com
    // o padrao "medium", na re-tentativa com metade do teto sobrava resposta
    // vazia e as capas caiam em "IA nao devolveu JSON" (15/09/2026). Low basta
    // para texto curto e gasta menos do limite por minuto (o outro gargalo).
    ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    timeout: 60_000,
  });
  if (response.data.error) throw new Error(response.data.error.message || JSON.stringify(response.data.error));
  return response.data.choices[0].message.content;
}

async function callSambaNova(prompt, systemPrompt, apiKey) {
  const model = process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct';
  const response = await axios.post('https://api.sambanova.ai/v1/chat/completions', {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    max_tokens: 8000,
    temperature: 0.7,
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    timeout: 60_000,
  });
  if (response.data.error) throw new Error(response.data.error.message || JSON.stringify(response.data.error));
  return response.data.choices[0].message.content;
}

async function callDeepSeek(prompt, systemPrompt, apiKey) {
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const response = await axios.post(
    'https://api.deepseek.com/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 4000,
      temperature: 0.7,
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );
  if (response.data.error) throw new Error(response.data.error.message || JSON.stringify(response.data.error));
  return response.data.choices[0].message.content;
}

// ROTEADOR UNIFICADO do HF (/v1/chat/completions, modelo no corpo). As rotas
// antigas por provedor (/hf-inference/models/..., /cerebras/models/...) sumiram,
// toda chamada dava 404 e o erro era engolido — o provedor ficava marcado como
// "sem chave valida" com 6 chaves funcionando. Medido em 14/09/2026: as 6
// respondem 200 no roteador unificado, e ele serve modelos grandes. Nesse dia
// Cerebras, SambaNova e DeepSeek ja cobravam (402) e o pipeline de livros
// falhava inteiro por so sobrar o Groq.
const MODELOS_HF = [
  process.env.HF_MODEL,
  'openai/gpt-oss-120b',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'deepseek-ai/DeepSeek-V3.1',
  'meta-llama/Llama-3.3-70B-Instruct',
].filter(Boolean);

async function callHuggingFace(prompt, systemPrompt, apiKey, opts) {
  const maxTokens = (opts && opts.maxTokens) || 4000;
  let ultimoErro;
  for (const model of MODELOS_HF) {
    try {
      const r = await axios.post('https://router.huggingface.co/v1/chat/completions',
        { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.7 },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 120_000 }
      );
      const texto = r.data.choices?.[0]?.message?.content;
      if (texto) return texto;
      ultimoErro = new Error('HuggingFace ' + model + ': resposta vazia');
    } catch (e) {
      const status = e?.response?.status;
      // Credito da conta, chave invalida ou limite: e da CHAVE, nao do modelo —
      // repassar para a rotacao marcar esta chave e seguir para a proxima.
      if (status === 401 || status === 402 || status === 403 || status === 429) throw e;
      // 400/404/5xx/timeout: este modelo nao serve agora, tentar o seguinte.
      logger.warn(`HF ${model}: ${status || e.code || e.message}`);
      ultimoErro = e;
    }
  }
  // MODELOS_HF nunca e vazia, entao ao chegar aqui algum modelo falhou.
  throw ultimoErro;
}

async function callPollinations(prompt, systemPrompt) {
  const model = process.env.POLLINATIONS_MODEL || "openai";
  // Usar max_tokens reduzido para evitar ECONNRESET em respostas longas
  const r = await axios.post("https://text.pollinations.ai/openai",
    { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], max_tokens: 2000, temperature: 0.7 },
    { headers: { "Content-Type": "application/json" }, timeout: 120_000 }
  );
  return r.data.choices[0].message.content;
}

async function callOllamaVps(prompt, systemPrompt) {
  // Acesso direto ao container Ollama via rede Docker interna (sem SSH tunnel)
  const ollamaDirectUrl = 'http://' + VPS_OLLAMA_CONTAINER + ':11434';
  logger.info('Ollama VPS direto: ' + ollamaDirectUrl + ' (modelo: ' + VPS_OLLAMA_MODEL + ')');
  const response = await axios.post(ollamaDirectUrl + '/api/chat', {
    model: VPS_OLLAMA_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    stream: false,
    options: { temperature: 0.7 },
  }, { timeout: 360000 });
  return response.data.message && response.data.message.content ? response.data.message.content : response.data.response;
}

async function callOllama(prompt, systemPrompt) {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.1';
  const response = await axios.post(`${ollamaUrl}/api/chat`, {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    stream: false,
    options: { temperature: 0.7 },
  }, { timeout: 120_000 });
  return response.data.message?.content || response.data.response;
}

// ═══════════════════════════════════════════════════
// DETECÇÃO DE TIPO DE ERRO → TTL de degradação
// ═══════════════════════════════════════════════════

/**
 * Segundos da dica "try again in ..." do provedor, ou null sem dica numerica.
 *
 * Eram duas regex, cada uma com um furo: a da cota diaria lia "864ms" como 864
 * MINUTOS (o "m" casava sozinho) e travava a chave pelo teto de 6 h quando o
 * provedor pedia menos de um segundo; a do limite por minuto nao entendia
 * "3m20s" e caia no padrao de 2 min. Aceita h, m, s e ms combinados.
 */
function segundosDaDica(texto) {
  const m = String(texto || '').toLowerCase().match(/try again in\s*(?:(\d+(?:\.\d+)?)\s*h(?![a-z]))?\s*(?:(\d+(?:\.\d+)?)\s*m(?![a-z]))?\s*(?:(\d+(?:\.\d+)?)\s*(ms|s)(?![a-z]))?/);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const n = v => parseFloat(v || 0);
  return n(m[1]) * 3600 + n(m[2]) * 60 + (m[4] === 'ms' ? n(m[3]) / 1000 : n(m[3]));
}

function getErrorTTL(err) {
  const msg = (err.message || '').toLowerCase();
  const status = err.response?.status || err.status;

  if (status === 402) return { hours: 24, reason: 'payment-required' };
  if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    // Distinguir quota diária de rate limit por minuto pelo corpo do erro
    const body = (JSON.stringify(err.response?.data || '') + msg).toLowerCase();
    // Cerebras "queue_exceeded" → servidor com alta carga, tenta de novo em 5 min
    if (body.includes('queue') && (body.includes('queue_exceeded') || body.includes('queue full') || body.includes('high traffic'))) {
      return { hours: 5/60, reason: 'quota/rate-limit' }; // 5 minutos
    }
    // 'day' solto casava por acidente ("today", nome da org). So vale o que diz
    // explicitamente que e cota diaria.
    const isHardQuota = /\bdaily\b|per day|requests per day|tokens per day|\brpd\b|\btpd\b|exceeded your current quota/.test(body);
    // A dica do provedor vale TAMBEM para limite diario. O TPD do Groq e janela
    // DESLIZANTE de 24h, nao zera a meia-noite: a mensagem diz exatamente quando
    // os tokens liberam ("try again in 7m35s"). Travar ate a meia-noite ignorava
    // isso — medido em 11/09/2026: das 8 chaves presas por 10,5 h, 4 respondiam
    // 200 pedindo 5 mil tokens. So cai na meia-noite quando nao ha dica.
    const segDica = segundosDaDica(body);
    if (isHardQuota && segDica > 0) return { hours: Math.min(6, (segDica + 30) / 3600), reason: 'quota/rate-limit' };
    if (isHardQuota) {
      // Quota diária sem dica → degradar até próxima meia-noite UTC
      const now = new Date();
      const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const hoursUntilMidnight = (midnight - now) / 3_600_000;
      return { hours: Math.max(0.5, hoursUntilMidnight), reason: 'quota/rate-limit' };
    }
    // Rate limit POR MINUTO: a janela zera em 60 s. Degradar 1 h era 60x o
    // necessario — com o laco de capas disparando rapido, cada chave batia no
    // limite do minuto uma vez e ficava presa uma hora; as 5 do Groq caiam em
    // menos de um minuto e as capas saiam sem gancho. Usa a dica do provedor
    // ("try again in 7.5s", retry-after) quando vier; senao 2 min.
    let seg = segDica === null ? 120 : segDica;
    const ra = err.response?.headers?.['retry-after'];
    if (ra && !isNaN(parseFloat(ra))) seg = parseFloat(ra);
    seg = Math.min(600, Math.max(15, seg + 5));   // folga de 5 s, entre 15 s e 10 min
    return { hours: seg / 3600, reason: 'quota/rate-limit' };
  }
  if (status >= 500) return { hours: 0.5, reason: 'server-error' };
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('econnreset')) {
    return { hours: 0.25, reason: 'network' };
  }
  if (status === 401 || status === 403) return { hours: 24, reason: 'auth-error' };
  return { hours: 0.5, reason: 'unknown' };
}

// ═══════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL — GENERATE COM FALLBACK CHAIN
// ═══════════════════════════════════════════════════

const PROVIDER_FNS = {
  gemini:      callGemini,
  cerebras:    callCerebras,
  sambanova:   callSambaNova,
  groq:        callGroq,
  deepseek:    callDeepSeek,
  huggingface: callHuggingFace,
  pollinations: (p, s, _k) => callPollinations(p, s),
  ollamaVps:   callOllamaVps,
  ollama:      callOllama,
};

// Providers sem apiKey (locais/tunnel)
const LOCAL_PROVIDERS = new Set(['ollama', 'ollamaVps', 'pollinations']);
// Providers que precisam de apiKey mas não entram no getNextKey como multi-key
// (tudo fora de LOCAL_PROVIDERS já usa getNextKey normalmente)

async function generate(prompt, systemPrompt = '', options = {}) {
  const state = loadState();
  const sys = systemPrompt || SYSTEM_DEFAULT;
  const skip = options.skip || [];

  const triedProviders = [];
  const errors = [];

  for (const provider of PROVIDERS) {
    if (skip.includes(provider)) continue;

    // Verificar se provider inteiro está degradado
    if (isDegraded(state, provider)) {
      logger.info(`⏭️  Pulando ${provider} (degraded até ${new Date(state.degraded[provider]?.until).toLocaleTimeString()})`);
      continue;
    }

    // Obter chave (com rotação multi-chave)
    let apiKey;
    if (LOCAL_PROVIDERS.has(provider)) {
      apiKey = PROVIDER_KEYS[provider][0]; // 'local' ou 'vps'
    } else {
      apiKey = getNextKey(state, provider);
      if (!apiKey) {
        logger.info(`⏭️  Pulando ${provider} (sem chave válida disponível)`);
        continue;
      }
    }

    // Cross-system quota gate for Gemini
    //
    // PULAR, nao degradar por 24h. A bandeira global dura no maximo 30 min (o
    // proprio _markGeminiGloballyExhausted limita o TTL) e o teto diario zera a
    // meia-noite UTC — ambos ja carregam a propria duracao. Marcar 24h aqui
    // transformava uma trava de MINUTOS num dia inteiro sem Gemini: medido em
    // 11/09/2026, bandeira com TTL de 86 s e o provedor bloqueado por 24 h,
    // com as capas saindo sem gancho enquanto o balde ja estava livre.
    if (provider === 'gemini') {
      // A bandeira global (gemini:daily_exhausted) NAO e mais consultada aqui.
      // Ela nasceu quando todos os sistemas usavam as MESMAS 6 chaves: um
      // esgotava e avisava os outros. Hoje este cliente tem rotacao por chave e
      // por modelo, e trava cada chave pelo tempo que o provedor manda. A
      // bandeira virou um interruptor que desligava o Gemini INTEIRO por causa
      // do balde de outro: medido em 14/09/2026, acesa com 21 min restantes
      // enquanto 8 de 12 chaves respondiam nos modelos gemini-3. O teto diario
      // (_withinDailyBudget) continua — e ele que protege os outros sistemas.
      if (!(await _withinDailyBudget())) {
        continue; // proxima chamada reavalia; a trava expira sozinha
      }
    }

    const keyId = LOCAL_PROVIDERS.has(provider) ? `${provider}:${apiKey}` : `${provider}:${apiKey.slice(-8)}`;
    const t0 = Date.now();

    try {
      logger.info(`🤖 Tentando ${provider} (${LOCAL_PROVIDERS.has(provider) ? apiKey : '...' + apiKey.slice(-8)})`);
      triedProviders.push(provider);

      const fn = PROVIDER_FNS[provider];
      const result = LOCAL_PROVIDERS.has(provider)
        ? await fn(prompt, sys, undefined, options)
        : await fn(prompt, sys, apiKey, options);

      const elapsed = Date.now() - t0;
      logger.info(`✅ ${provider} respondeu em ${elapsed}ms (${result.length} chars)`);

      // Sondagem que deu certo ENCERRA a degradacao, do provider e da chave.
      // Sem isto o circuito meio-aberto so rende uma requisicao a cada 20min:
      // o provider responde 200 e mesmo assim continua marcado como degradado
      // ate o prazo original — que e justamente o chute que se quer corrigir.
      // apiKey nunca e vazia aqui: provedor local usa o marcador ('free', 'vps').
      const chaveId = `${provider}:${apiKey.slice(-8)}`;
      let limpou = false;
      for (const k of [provider, chaveId]) {
        if (state.degraded[k]) { delete state.degraded[k]; limpou = true; }
      }
      if (limpou) {
        logger.info(`♻️  ${provider} reabilitado (sondagem respondeu)`);
        saveState(state);
      }

      return { text: result, provider, elapsed };

    } catch (err) {
      const elapsed = Date.now() - t0;

      // 400/422 e defeito da REQUISICAO, nunca da chave: a mesma chamada falha
      // igual em todas as chaves. Tratar como falha de chave derrubava as 8 do
      // Groq em cascata, em milissegundos, cada uma presa 30 min — medido em
      // 11/09/2026, quando uma unica chamada malformada (system prompt que nao
      // era string) deixou o provedor inteiro fora para quem chamava certo.
      // Aqui nao se degrada nada: registra e segue para o proximo provedor.
      const stReq = err?.response?.status || err?.status;
      if (stReq === 400 || stReq === 422) {
        const det = err?.response?.data?.error?.message || err.message || '';
        errors.push({ provider, error: String(det).slice(0, 120), reason: 'requisicao-invalida' });
        logger.warn(`❌ ${provider} recusou a REQUISICAO (${stReq}) — chaves preservadas: ${String(det).slice(0, 90)}`);
        continue;
      }

      const { hours, reason } = getErrorTTL(err);

      errors.push({ provider, error: err.message?.slice(0, 120), reason });
      logger.warn(`❌ ${provider} falhou em ${elapsed}ms [${reason}]: ${err.message?.slice(0, 80)}`);

      // Degradar chave específica (ou provider inteiro se só tem uma chave)
      const keys = PROVIDER_KEYS[provider];   // todo provedor de PROVIDERS tem entrada
      if (keys.length <= 1 || LOCAL_PROVIDERS.has(provider)) {
        markDegraded(state, provider, hours);
      } else {
        // Degradar só a chave específica, não o provider inteiro
        markDegraded(state, keyId, hours);
        // Tentar TODAS as chaves restantes do mesmo provider antes de desistir
        let altKey;
        while ((altKey = getNextKey(state, provider)) !== null) {
          const altKeyId = `${provider}:${altKey.slice(-8)}`;
          try {
            logger.info(`🔄 Re-tentando ${provider} com chave ...${altKey.slice(-8)}`);
            const fn = PROVIDER_FNS[provider];
            const result = await fn(prompt, sys, altKey, options);
            logger.info(`✅ ${provider} (chave alt) respondeu (${result.length} chars)`);
            return { text: result, provider, elapsed: Date.now() - t0 };
          } catch (errAlt) {
            const { hours: hAlt, reason: rAlt } = getErrorTTL(errAlt);
            markDegraded(state, altKeyId, hAlt);
            logger.warn(`❌ ${provider} chave ...${altKey.slice(-8)} falhou [${rAlt}]`);
            // reason faltava: o resumo final mostrava "groq(undefined)" por chave.
            errors.push({ provider, error: errAlt.message?.slice(0, 80), key: altKeyId, reason: rAlt });
          }
        }
        // Nao acende mais a bandeira global: o esgotamento destas chaves ja fica
        // registrado chave a chave aqui, e acender a bandeira desligava o Gemini
        // de sistemas com outras chaves e outros modelos.
        logger.info(`   Todas as chaves de ${provider} esgotadas, indo para próximo provider...`);
      }
    }
  }

  // Fallback infinito: Ollama VPS -- sem quota, sem limite, nunca desiste.
  // Ativado automaticamente quando todos os providers pagos estao esgotados.
  const _ollamaFallbackUrl = 'http://' + VPS_OLLAMA_CONTAINER + ':11434';
  let _ollamaAvail = false;
  try { await axios.get(_ollamaFallbackUrl + '/api/tags', { timeout: 5000 }); _ollamaAvail = true; } catch {}

  if (_ollamaAvail) {
    logger.info('Ollama VPS disponivel -- ativando fallback (modelo: ' + VPS_OLLAMA_MODEL + ')');
    let _att = 0;
    while (true) {
      _att++;
      // Antes de cada tentativa Ollama: verificar se algum provider pago recuperou
      if (_att > 1) {
        const _freshState = loadState();
        const _recovered = PAID_PROVIDERS.find(p => {
          if (isDegraded(_freshState, p)) return false;
          const _keys = PROVIDER_KEYS[p];
          if (!_keys || _keys.length === 0) return false;
          return _keys.some(k => !isDegraded(_freshState, p + ':' + k.slice(-8)));
        });
        if (_recovered) {
          logger.info('Provider pago recuperado: ' + _recovered + ' -- reiniciando ciclo com providers pagos');
          throw new Error('PAID_PROVIDER_RECOVERED:' + _recovered);
        }
      }
      try {
        logger.info('Ollama VPS gerando (tentativa ' + _att + ')...');
        const _ollamaResult = await callOllamaVps(prompt, sys);
        logger.info('Ollama VPS gerou ' + _ollamaResult.length + ' chars em ' + _att + ' tentativa(s)');
        return { text: _ollamaResult, provider: 'ollamaVps', elapsed: 0 };
      } catch (_ollamaErr) {
        const _isConn = (_ollamaErr.message||'').includes('ECONNREFUSED') || (_ollamaErr.message||'').includes('ENOTFOUND');
        const _isTout = _ollamaErr.code === 'ECONNABORTED' || (_ollamaErr.message||'').includes('timeout');
        logger.warn('Ollama VPS tentativa ' + _att + ': ' + (_ollamaErr.message||'').slice(0, 80));
        if (_isConn) break; // Ollama offline
        // (O PAID_PROVIDER_RECOVERED e lancado FORA deste try, antes da
        // tentativa; a verificacao dele aqui nunca casava e saiu.)
        const _delay = _isTout ? 60000 : 30000;
        logger.info('Aguardando ' + (_delay/1000) + 's antes do proximo Ollama...');
        await new Promise(r => setTimeout(r, _delay));
      }
    }
  }

  // Ollama local como ultimo recurso
  const _localOllamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  let _localAvail = false;
  try { await axios.get(_localOllamaUrl + '/api/tags', { timeout: 3000 }); _localAvail = true; } catch {}
  if (_localAvail) {
    logger.info('Ollama local disponivel -- fallback infinito');
    while (true) {
      try {
        const _localResult = await callOllama(prompt, sys);
        return { text: _localResult, provider: 'ollama', elapsed: 0 };
      } catch (_localErr) {
        if ((_localErr.message||'').includes('ECONNREFUSED')) break;
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  // Absolutamente tudo falhou (nem Ollama disponivel)
  const summary = errors.map(e => e.provider + '(' + e.reason + ')').join(', ');
  logger.error('Todos os providers falharam sem Ollama disponivel: ' + summary);
  throw new Error('Todos os providers de AI falharam. Providers tentados: ' + triedProviders.join(', ') + '. Erros: ' + summary);
}

// ═══════════════════════════════════════════════════
// UTILITÁRIOS
// ═══════════════════════════════════════════════════

function getStatus() {
  // So LEITURA. Usava isDegraded, que libera e CARIMBA a sondagem meio-aberta:
  // o painel e o /api/status (publico, a cada 12-20 s) consumiam a sondagem e o
  // generate nunca a recebia — o provedor ficava fora ate o prazo cheio.
  // loadState ja descarta marca vencida, entao presente = degradado.
  const state = loadState();
  const degradado = k => Boolean(state.degraded[k]);
  const result = {};

  for (const provider of PROVIDERS) {
    const keys = PROVIDER_KEYS[provider];
    const providerDegraded = degradado(provider);
    const isLocal = LOCAL_PROVIDERS.has(provider);
    const availableKeys = isLocal ? 1 : keys.filter(k => {
      const keyId = `${provider}:${k.slice(-8)}`;
      return !degradado(keyId);
    }).length;

    result[provider] = {
      configured: isLocal ? true : keys.length > 0,
      totalKeys: keys.length,
      availableKeys,
      degraded: providerDegraded,
      degradedUntil: state.degraded[provider]
        ? new Date(state.degraded[provider].until).toISOString()
        : null,
      limits: LIMITS[provider],
    };
  }

  result._summary = {
    anyAvailable: Object.values(result).some(p => !p.degraded && p.configured && p.availableKeys > 0),
    availableProviders: PROVIDERS.filter(p => !degradado(p) && (PROVIDER_KEYS[p]?.length > 0 || LOCAL_PROVIDERS.has(p))),
  };

  return result;
}

function resetDegraded(provider = null) {
  const state = loadState();
  if (provider) {
    // Limpar só um provider e suas chaves
    Object.keys(state.degraded)
      .filter(k => k.startsWith(provider))
      .forEach(k => delete state.degraded[k]);
    logger.info(`✅ Estado resetado para: ${provider}`);
  } else {
    state.degraded = {};
    logger.info('✅ Estado de todos os providers resetado');
  }
  saveState(state);
}

module.exports = { getErrorTTL, callHuggingFace, MODELOS_HF, mesclarDegradados, generate, getStatus, resetDegraded, PROVIDERS, LIMITS,
  // exportados para teste: e onde moraram os defeitos que pararam a geracao
  acaoParaErroGroq, isDegraded, getNextKey, loadState, saveState, markDegraded,
  callGemini, callCerebras, callGroq, callSambaNova, callDeepSeek, callPollinations, callOllamaVps, callOllama,
  ehCotaOuModeloIndisponivel, segundosDaDica, hostPortaRedis };
