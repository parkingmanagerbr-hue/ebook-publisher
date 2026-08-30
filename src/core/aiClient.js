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
const { spawn } = require('child_process');

// ═══════════════════════════════════════════════════
// CONFIGURAÇÃO DE CHAVES E PROVIDERS
// ═══════════════════════════════════════════════════

const STATE_FILE = path.join(__dirname, '../../data/ai_state.json');

// Suporte a múltiplas chaves por provider (rotação automática)
const PROVIDER_KEYS = {
  gemini: [
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
const _qRH  = (process.env.REDIS_URL || 'redis://redis:6379').replace(/^redis:\/\//, '').split(':')[0] || 'redis';
const _qRP  = parseInt(((process.env.REDIS_URL || 'redis://redis:6379').replace(/^redis:\/\//, '').split(':')[1] || '6379'));

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
        try {
          const ln = buf.split('\r\n'); const h = ln[0];
          if (h[0] === '+') return resolve(h.slice(1));
          if (h[0] === ':') return resolve(parseInt(h.slice(1)));
          if (h.startsWith('$-1')) return resolve(null);
          if (h[0] === '$') return resolve(ln[1] ?? null);
          resolve(null);
        } catch { resolve(null); }
      });
      const cmd = `*${args.length}\r\n` + args.map(a => `$${String(a).length}\r\n${a}\r\n`).join('');
      s.write(cmd); s.end();
    } catch { resolve(null); }
  });
}
const _QUOTA_SYS = 'ebook';
const _QUOTA_MAX = 200;
async function _isGeminiGloballyExhausted() { return !!(await _rCmd('GET', 'gemini:daily_exhausted')); }
async function _markGeminiGloballyExhausted() {
  const now = Date.now(), r = new Date();
  r.setUTCHours(8, 0, 0, 0);
  if (r.getTime() <= now) r.setUTCDate(r.getUTCDate() + 1);
  await _rCmd('SET', 'gemini:daily_exhausted', '1', 'EX', String(Math.min(1800, Math.ceil((r.getTime() - now) / 1000)))); // cap 30min
}
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
      return state;
    }
  } catch (e) { logger.warn('Estado corrompido, reiniciando: ' + e.message); }
  return defaults;
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { logger.warn('Falha ao salvar estado: ' + e.message); }
}

// Degradar provider por N horas (chave específica ou provider inteiro)
function markDegraded(state, key, hours = 1) {
  state.degraded[key] = {
    until: Date.now() + hours * 3_600_000,
    since: new Date().toISOString(),
    // Instante numerico: o isDegraded usa isto para so sondar depois de
    // PROBE_MS. Sem ele, uma degradacao recem-criada seria sondada na hora.
    since_ms: Date.now(),
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
// SSH TUNNEL PARA OLLAMA VPS
// ═══════════════════════════════════════════════════

const VPS_TUNNEL_LOCAL_PORT = parseInt(process.env.OLLAMA_VPS_TUNNEL_PORT || '11435');
const VPS_SSH_ALIAS         = process.env.OLLAMA_VPS_SSH_ALIAS || 'vps';
const VPS_OLLAMA_CONTAINER  = process.env.OLLAMA_VPS_CONTAINER_IP || '172.18.0.11';
const VPS_OLLAMA_MODEL      = process.env.OLLAMA_VPS_MODEL || 'llama3.2:3b';

let _tunnelProc = null;
let _tunnelReady = false;
let _tunnelStarting = false;

async function ensureVpsTunnel() {
  if (_tunnelReady) return true;
  if (_tunnelStarting) {
    // Aguardar até 10s se já está iniciando
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (_tunnelReady) return true;
    }
    return false;
  }

  _tunnelStarting = true;
  logger.info(`🔗 Abrindo SSH tunnel: localhost:${VPS_TUNNEL_LOCAL_PORT} → ${VPS_SSH_ALIAS}:${VPS_OLLAMA_CONTAINER}:11434`);

  return new Promise((resolve) => {
    const sshArgs = [
      '-N',                                   // não executar shell remoto
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-L', `${VPS_TUNNEL_LOCAL_PORT}:${VPS_OLLAMA_CONTAINER}:11434`,
      VPS_SSH_ALIAS,
    ];

    _tunnelProc = spawn('ssh', sshArgs, { stdio: 'ignore', detached: false });

    _tunnelProc.on('error', (err) => {
      logger.warn(`⚠️ SSH tunnel erro: ${err.message}`);
      _tunnelReady = false;
      _tunnelStarting = false;
      resolve(false);
    });

    _tunnelProc.on('exit', (code) => {
      logger.warn(`⚠️ SSH tunnel encerrou (code ${code})`);
      _tunnelReady = false;
      _tunnelStarting = false;
      _tunnelProc = null;
    });

    // Aguardar 2s para tunnel estabilizar, depois testar conectividade
    setTimeout(async () => {
      try {
        await axios.get(`http://localhost:${VPS_TUNNEL_LOCAL_PORT}/api/tags`, { timeout: 5000 });
        _tunnelReady = true;
        _tunnelStarting = false;
        logger.info(`✅ SSH tunnel ativo na porta ${VPS_TUNNEL_LOCAL_PORT} (modelo: ${VPS_OLLAMA_MODEL})`);
        resolve(true);
      } catch (e) {
        logger.warn(`⚠️ SSH tunnel aberto mas Ollama VPS não respondeu: ${e.message}`);
        _tunnelReady = false;
        _tunnelStarting = false;
        resolve(false);
      }
    }, 2000);
  });
}

// Fechar tunnel ao encerrar processo
process.on('exit', () => { if (_tunnelProc) _tunnelProc.kill(); });
process.on('SIGINT', () => { if (_tunnelProc) _tunnelProc.kill(); process.exit(); });

// ═══════════════════════════════════════════════════
// CHAMADAS POR PROVIDER
// ═══════════════════════════════════════════════════

async function callGemini(prompt, systemPrompt, apiKey) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    systemInstruction: systemPrompt,
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function callCerebras(prompt, systemPrompt, apiKey) {
  // Modelos disponíveis (maio 2026): gpt-oss-120b, zai-glm-4.7 (qwen-3-235b removido)
  const model = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';
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

async function callGroq(prompt, systemPrompt, apiKey) {
  let ultimoErro = null;
  for (const model of GROQ_MODELS) {
    for (const teto of [GROQ_MAX_TOKENS, Math.floor(GROQ_MAX_TOKENS / 2)]) {
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
  throw ultimoErro || new Error('groq: nenhum modelo disponivel');
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
    max_tokens: maxTokens || 8000,
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

async function callHuggingFace(prompt, systemPrompt, apiKey) {
  // NOTE: June 2026 audit — many routes permanently removed (410 Gone / 403 Forbidden):
  //   together/Meta-Llama-3.1-70B-Instruct-Turbo        → 410
  //   together/Qwen/Qwen2.5-72B-Instruct-Turbo          → 410
  //   fireworks-ai/llama-v3p1-70b-instruct               → 410
  //   nebius/Meta-Llama-3.1-70B-Instruct                 → 403
  //   nebius/Qwen/Qwen2.5-72B-Instruct                   → 403
  // Only hf-inference small models + cerebras-via-HF remain alive.
  const hfRouter = [
    // hf-inference free tier — small models (fast, limited quality)
    ["hf-inference", "meta-llama/Llama-3.2-3B-Instruct"],
    ["hf-inference", "HuggingFaceTB/SmolLM2-1.7B-Instruct"],
    // cerebras provider on HF router (may overlap with direct Cerebras)
    ["cerebras", "llama3.3-70b"],
  ];
  for (const [provider, model] of hfRouter) {
    try {
      const url = `https://router.huggingface.co/${provider}/models/${model}/v1/chat/completions`;
      const r = await axios.post(url,
        { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], max_tokens: 4000, temperature: 0.7 },
        { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 60_000 }
      );
      if (r.data.choices?.[0]?.message?.content) return r.data.choices[0].message.content;
    } catch (e) {
      // Log non-DNS errors to help debug
      const status = e?.response?.status;
      if (status && status !== 400 && status !== 404) {
        logger.warn(`HF router ${provider}/${model}: ${status}`);
      }
    }
  }
  throw new Error("HuggingFace: nenhum provider disponivel");
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
    const isHardQuota = body.includes('daily') || body.includes('day') || body.includes('exceeded your current quota') || body.includes('per day');
    if (isHardQuota) {
      // Quota diária → degradar até próxima meia-noite UTC
      const now = new Date();
      const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const hoursUntilMidnight = (midnight - now) / 3_600_000;
      return { hours: Math.max(0.5, hoursUntilMidnight), reason: 'quota/rate-limit' };
    }
    // Rate limit por minuto → degradar apenas 1 hora
    return { hours: 1, reason: 'quota/rate-limit' };
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
    if (provider === 'gemini') {
      if (await _isGeminiGloballyExhausted() || !(await _withinDailyBudget())) {
        markDegraded(state, 'gemini', 24);
        continue; // skip to next provider
      }
    }

    const keyId = LOCAL_PROVIDERS.has(provider) ? `${provider}:${apiKey}` : `${provider}:${apiKey.slice(-8)}`;
    const t0 = Date.now();

    try {
      logger.info(`🤖 Tentando ${provider} (${LOCAL_PROVIDERS.has(provider) ? apiKey : '...' + apiKey.slice(-8)})`);
      triedProviders.push(provider);

      const fn = PROVIDER_FNS[provider];
      const result = LOCAL_PROVIDERS.has(provider)
        ? await fn(prompt, sys)
        : await fn(prompt, sys, apiKey);

      const elapsed = Date.now() - t0;
      logger.info(`✅ ${provider} respondeu em ${elapsed}ms (${result.length} chars)`);

      // Sondagem que deu certo ENCERRA a degradacao, do provider e da chave.
      // Sem isto o circuito meio-aberto so rende uma requisicao a cada 20min:
      // o provider responde 200 e mesmo assim continua marcado como degradado
      // ate o prazo original — que e justamente o chute que se quer corrigir.
      const chaveId = apiKey ? `${provider}:${apiKey.slice(-8)}` : null;
      let limpou = false;
      for (const k of [provider, chaveId].filter(Boolean)) {
        if (state.degraded[k]) { delete state.degraded[k]; limpou = true; }
      }
      if (limpou) {
        logger.info(`♻️  ${provider} reabilitado (sondagem respondeu)`);
        saveState(state);
      }

      return { text: result, provider, elapsed };

    } catch (err) {
      const elapsed = Date.now() - t0;
      const { hours, reason } = getErrorTTL(err);

      errors.push({ provider, error: err.message?.slice(0, 120), reason });
      logger.warn(`❌ ${provider} falhou em ${elapsed}ms [${reason}]: ${err.message?.slice(0, 80)}`);

      // Degradar chave específica (ou provider inteiro se só tem uma chave)
      const keys = PROVIDER_KEYS[provider] || [];
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
            const result = await fn(prompt, sys, altKey);
            logger.info(`✅ ${provider} (chave alt) respondeu (${result.length} chars)`);
            return { text: result, provider, elapsed: Date.now() - t0 };
          } catch (errAlt) {
            const { hours: hAlt, reason: rAlt } = getErrorTTL(errAlt);
            markDegraded(state, altKeyId, hAlt);
            logger.warn(`❌ ${provider} chave ...${altKey.slice(-8)} falhou [${rAlt}]`);
            errors.push({ provider, error: errAlt.message?.slice(0, 80), key: altKeyId });
          }
        }
        if (provider === 'gemini') await _markGeminiGloballyExhausted();
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
        if (_ollamaErr.message && _ollamaErr.message.startsWith('PAID_PROVIDER_RECOVERED:')) throw _ollamaErr;
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
  const state = loadState();
  const now = Date.now();
  const result = {};

  for (const provider of PROVIDERS) {
    const keys = PROVIDER_KEYS[provider] || [];
    const providerDegraded = isDegraded(state, provider);
    const isLocal = LOCAL_PROVIDERS.has(provider);
    const availableKeys = isLocal ? 1 : keys.filter(k => {
      const keyId = `${provider}:${k.slice(-8)}`;
      return !isDegraded(state, keyId);
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
    availableProviders: PROVIDERS.filter(p => !isDegraded(state, p) && (PROVIDER_KEYS[p]?.length > 0 || LOCAL_PROVIDERS.has(p))),
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

module.exports = { generate, getStatus, resetDegraded, PROVIDERS, LIMITS,
  // exportados para teste: e onde moraram os defeitos que pararam a geracao
  acaoParaErroGroq, isDegraded, getNextKey };
