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
  ].filter(Boolean),
  groq:        [process.env.GROQ_API_KEY].filter(Boolean),
  deepseek:    [
    process.env.DEEPSEEK_API_KEY,
    process.env.DEEPSEEK_API_KEY_2,
  ].filter(Boolean),
  huggingface: [
    process.env.HUGGINGFACE_API_KEY,
    process.env.HUGGINGFACE_API_KEY_2,
    process.env.HUGGINGFACE_API_KEY_3,
    process.env.HUGGINGFACE_API_KEY_4,
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
const PROVIDERS = ['gemini', 'cerebras', 'sambanova', 'groq', 'deepseek', 'huggingface', 'pollinations', 'ollamaVps', 'ollama'];

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
    hours,
  };
  logger.warn(`⛔ Degradado: ${key} por ${hours}h`);
  saveState(state);
}

function isDegraded(state, key) {
  const d = state.degraded[key];
  if (!d) return false;
  if (Date.now() > d.until) { delete state.degraded[key]; return false; }
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
  // Modelos disponíveis (maio 2026): qwen-3-235b-a22b-instruct-2507, gpt-oss-120b, llama3.1-8b
  const model = process.env.CEREBRAS_MODEL || 'qwen-3-235b-a22b-instruct-2507';
  const response = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
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
    },
    timeout: 60_000,
  });
  if (response.data.error) throw new Error(response.data.error.message || JSON.stringify(response.data.error));
  return response.data.choices[0].message.content;
}

async function callGroq(prompt, systemPrompt, apiKey) {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
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
  // Tenta primeiro a API de inferência serverless direta (gratuita, sem créditos)
  const hfDirect = [
    "Qwen/Qwen2.5-72B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "microsoft/Phi-3-mini-4k-instruct",
  ];
  for (const model of hfDirect) {
    try {
      const url = `https://api-inference.huggingface.co/models/${model}/v1/chat/completions`;
      const r = await axios.post(url,
        { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], max_tokens: 4000, temperature: 0.7 },
        { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 90_000 }
      );
      if (r.data.choices?.[0]?.message?.content) return r.data.choices[0].message.content;
    } catch {}
  }
  // Fallback: router com providers gratuitos
  const hfRouter = [
    ["novita", "Qwen/Qwen2.5-72B-Instruct"],
    ["together", "Qwen/Qwen2.5-72B-Instruct"],
    ["novita", "meta-llama/Llama-3.1-8B-Instruct"],
  ];
  for (const [provider, model] of hfRouter) {
    try {
      const url = `https://router.huggingface.co/${provider}/models/${model}/v1/chat/completions`;
      const r = await axios.post(url,
        { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], max_tokens: 4000, temperature: 0.7 },
        { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 90_000 }
      );
      if (r.data.choices?.[0]?.message?.content) return r.data.choices[0].message.content;
    } catch {}
  }
  throw new Error("HuggingFace: nenhum provider disponivel");
}

async function callPollinations(prompt, systemPrompt) {
  const model = process.env.POLLINATIONS_MODEL || "openai";
  const r = await axios.post("https://text.pollinations.ai/openai",
    { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], max_tokens: 4000, temperature: 0.7 },
    { headers: { "Content-Type": "application/json" }, timeout: 90_000 }
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
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound')) {
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
        logger.info(`   Todas as chaves de ${provider} esgotadas, indo para próximo provider...`);
      }
    }
  }

  // Todos os providers falharam
  const summary = errors.map(e => `${e.provider}(${e.reason})`).join(', ');
  logger.error(`🔴 Todos os providers falharam: ${summary}`);
  throw new Error(`Todos os providers de AI falharam. Providers tentados: ${triedProviders.join(', ')}. Erros: ${summary}`);
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

module.exports = { generate, getStatus, resetDegraded, PROVIDERS, LIMITS };
