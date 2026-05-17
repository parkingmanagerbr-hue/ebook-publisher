/**
 * Higgsfield AI Client — provider primário para imagem, vídeo e áudio
 * Docs: https://docs.higgsfield.ai | SDK: @higgsfield/client
 *
 * Endpoints:
 *   Imagem:       POST /requests/flux-pro/kontext/max/text-to-image
 *   Imagem Soul:  POST /v1/text2image/soul
 *   Vídeo (img→): POST /v1/image2video/dop  (model: dop-turbo | dop-preview | dop-lite)
 *   Speech→Vídeo: POST /v1/speak/higgsfield
 *   Status:       GET  /requests/{id}/status
 *
 * Auth: Authorization: Key KEY_ID:KEY_SECRET
 *       (cada key fornecida pelo usuário é tratada como credencial completa)
 */

'use strict';

const axios = require('axios');

const PLATFORM_BASE = 'https://platform.higgsfield.ai';
const API_BASE      = 'https://api.higgsfield.ai';

const KEYS = [
  process.env.HIGGSFIELD_API_KEY,
  process.env.HIGGSFIELD_API_KEY_2,
  process.env.HIGGSFIELD_API_KEY_3,
  process.env.HIGGSFIELD_API_KEY_4,
  process.env.HIGGSFIELD_API_KEY_5,
  process.env.HIGGSFIELD_API_KEY_6,
].filter(Boolean);

// Key state — pausa em memória (reset ao reiniciar)
const _pausedUntil = new Map();
const _keyErrors   = new Map();

function _availableKeys() {
  const now = Date.now();
  return KEYS.filter(k => (_pausedUntil.get(k) ?? 0) < now);
}

function _pauseKey(key, ms = 3_600_000) {
  _pausedUntil.set(key, Date.now() + ms);
  const errs = (_keyErrors.get(key) ?? 0) + 1;
  _keyErrors.set(key, errs);
}

function _reset() {
  setInterval(() => { _pausedUntil.clear(); _keyErrors.clear(); }, 3_600_000).unref();
}
_reset();

// ── HTTP helper ────────────────────────────────────────────────────────────────
async function _post(key, path, body) {
  const base = path.startsWith('/v1') ? API_BASE : PLATFORM_BASE;
  const res = await axios.post(`${base}${path}`, body, {
    headers: {
      'Authorization': `Key ${key}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
  return res.data;
}

async function _getStatus(key, requestId) {
  const res = await axios.get(`${PLATFORM_BASE}/requests/${requestId}/status`, {
    headers: { 'Authorization': `Key ${key}` },
    timeout: 15_000,
  });
  return res.data;
}

// ── Polling ────────────────────────────────────────────────────────────────────
async function _poll(key, requestId, maxMs = 300_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3_000));
    const s = await _getStatus(key, requestId);
    const status = s?.status ?? s?.state;
    if (status === 'completed') return s;
    if (status === 'failed')    throw new Error(`Higgsfield falhou: ${JSON.stringify(s.error ?? s)}`);
    if (status === 'nsfw')      throw new Error('Higgsfield: conteúdo NSFW rejeitado — créditos reembolsados');
  }
  throw new Error('Higgsfield: timeout de polling (5 min)');
}

// ── Extrai URL do resultado ────────────────────────────────────────────────────
function getResultUrl(result) {
  // V2: jobs[].results.raw.url
  if (result?.jobs) {
    for (const job of result.jobs) {
      if (job?.results?.raw?.url)  return job.results.raw.url;
      if (job?.results?.min?.url)  return job.results.min.url;
    }
  }
  // V1 / raw: output_url, url, results[0].url
  return result?.output_url
      ?? result?.url
      ?? result?.results?.[0]?.url
      ?? null;
}

// ── Executa com rotação de chaves ──────────────────────────────────────────────
async function _withRotation(fn) {
  const available = _availableKeys();
  if (available.length === 0) throw new Error('Higgsfield: todas as chaves esgotadas/pausadas');

  let lastErr;
  for (const key of available) {
    try {
      return await fn(key);
    } catch (err) {
      const status = err?.response?.status;
      const msg    = String(err?.message ?? err);

      if (status === 401 || status === 403 || /auth|invalid.key/i.test(msg)) {
        _pauseKey(key, 24 * 3_600_000); // chave inválida — pausa 24h
        lastErr = err;
        continue;
      }
      if (status === 402 || /credit|insuff/i.test(msg)) {
        _pauseKey(key, 24 * 3_600_000); // sem créditos — pausa 24h
        lastErr = err;
        continue;
      }
      if (status === 429 || /rate.?limit|quota/i.test(msg)) {
        _pauseKey(key, 3_600_000); // rate limit — pausa 1h
        lastErr = err;
        continue;
      }
      // Qualquer outro erro — propaga imediatamente (problema no input, não na chave)
      throw err;
    }
  }
  throw lastErr ?? new Error('Higgsfield: todas as chaves falharam');
}

// ════════════════════════════════════════════════════════════════════════════════
// API Pública
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Gera imagem a partir de texto.
 * @param {string} prompt
 * @param {object} opts  { aspectRatio: '16:9'|'9:16'|'1:1'|'4:3', seed? }
 * @returns {Promise<{url: string, raw: object}>}
 */
async function generateImage(prompt, opts = {}) {
  return _withRotation(async (key) => {
    const body = {
      prompt,
      aspect_ratio:     opts.aspectRatio     ?? '16:9',
      safety_tolerance: opts.safetyTolerance ?? 2,
      seed:             opts.seed            ?? Math.floor(Math.random() * 1_000_000),
    };
    const submit = await _post(key, '/requests/flux-pro/kontext/max/text-to-image', body);
    const reqId  = submit?.request_id ?? submit?.id;
    if (!reqId) throw new Error(`Higgsfield: sem request_id na resposta: ${JSON.stringify(submit)}`);

    const result = await _poll(key, reqId);
    const url    = getResultUrl(result);
    if (!url) throw new Error('Higgsfield: URL de imagem não encontrada na resposta');
    return { url, raw: result };
  });
}

/**
 * Gera vídeo animado a partir de uma imagem.
 * @param {string} imageUrl  URL pública da imagem base
 * @param {string} prompt    Descrição do movimento/estilo
 * @param {object} opts      { model: 'dop-turbo'|'dop-preview'|'dop-lite', motionStrength? }
 * @returns {Promise<{url: string, raw: object}>}
 */
async function generateVideo(imageUrl, prompt, opts = {}) {
  return _withRotation(async (key) => {
    const body = {
      model:        opts.model ?? 'dop-turbo',
      prompt,
      input_images: [{ type: 'image_url', image_url: imageUrl }],
    };
    const submit = await _post(key, '/v1/image2video/dop', body);
    const reqId  = submit?.request_id ?? submit?.generation_id ?? submit?.id;
    if (!reqId) throw new Error(`Higgsfield: sem request_id: ${JSON.stringify(submit)}`);

    const result = await _poll(key, reqId, 600_000); // vídeo pode demorar 10min
    const url    = getResultUrl(result);
    if (!url) throw new Error('Higgsfield: URL de vídeo não encontrada');
    return { url, raw: result };
  });
}

/**
 * Gera vídeo de fala (talking head) a partir de imagem + áudio.
 * @param {string} imageUrl  Foto do personagem (URL pública)
 * @param {string} audioUrl  Áudio de fala (URL pública, WAV recomendado)
 * @param {string} prompt    Estilo/contexto
 * @param {object} opts      { quality: 'mid'|'high', duration: 'short'|'long' }
 * @returns {Promise<{url: string, raw: object}>}
 */
async function speechToVideo(imageUrl, audioUrl, prompt = '', opts = {}) {
  return _withRotation(async (key) => {
    const body = {
      input_image: { type: 'image_url',  image_url: imageUrl },
      input_audio: { type: 'audio_url',  audio_url: audioUrl },
      prompt,
      quality:  opts.quality  ?? 'mid',
      duration: opts.duration ?? 'short',
    };
    const submit = await _post(key, '/v1/speak/higgsfield', body);
    const reqId  = submit?.request_id ?? submit?.generation_id ?? submit?.id;
    if (!reqId) throw new Error(`Higgsfield: sem request_id: ${JSON.stringify(submit)}`);

    const result = await _poll(key, reqId, 300_000);
    const url    = getResultUrl(result);
    if (!url) throw new Error('Higgsfield: URL de speech-video não encontrada');
    return { url, raw: result };
  });
}

/**
 * Gera imagem Soul (personagem consistente com estilo artístico).
 * @param {string} prompt
 * @param {object} opts  { styleId?, width?: 1536, height?: 1536, quality?: 'HD'|'STANDARD' }
 */
async function generateSoulImage(prompt, opts = {}) {
  return _withRotation(async (key) => {
    const body = {
      prompt,
      width_and_height: `${opts.width ?? 1536}x${opts.height ?? 1536}`,
      quality:          opts.quality ?? 'HD',
      batch_size:       1,
      ...(opts.styleId ? { style_id: opts.styleId, style_strength: opts.styleStrength ?? 0.8 } : {}),
      ...(opts.soulId  ? { custom_reference_id: opts.soulId, custom_reference_strength: 1 } : {}),
    };
    const submit = await _post(key, '/v1/text2image/soul', body);
    const reqId  = submit?.request_id ?? submit?.generation_id ?? submit?.id;
    if (!reqId) throw new Error(`Higgsfield: sem request_id: ${JSON.stringify(submit)}`);

    const result = await _poll(key, reqId);
    const url    = getResultUrl(result);
    if (!url) throw new Error('Higgsfield: URL de soul-image não encontrada');
    return { url, raw: result };
  });
}

/** Retorna true se há pelo menos uma chave disponível */
function isAvailable() { return _availableKeys().length > 0; }

/** Status de todas as chaves */
function status() {
  const now = Date.now();
  return KEYS.map((k, i) => ({
    index:   i + 1,
    paused:  (_pausedUntil.get(k) ?? 0) > now,
    pausedUntilMs: _pausedUntil.get(k) ?? 0,
    errors:  _keyErrors.get(k) ?? 0,
  }));
}

module.exports = {
  generateImage,
  generateVideo,
  speechToVideo,
  generateSoulImage,
  getResultUrl,
  isAvailable,
  status,
  KEYS,
};
