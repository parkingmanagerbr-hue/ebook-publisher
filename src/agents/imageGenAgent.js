/**
 * ImageGenAgent — Geração de imagens via AI com fallback chain
 *
 * Ordem (velocidade/qualidade → custo):
 *   0. Higgsfield FLUX Pro  (~10s, FLUX Pro Kontext Max — MELHOR qualidade)
 *   1. DALL-E 3             (~15s, $0.04/img, alta qualidade)
 *   2. fal.ai FLUX/schnell  (~3s, free tier — muito rápido!)
 *   3. Gemini Image Gen     (grátis com chave Gemini)
 *   4. HuggingFace FLUX     (grátis, mais lento)
 *   5. Pollinations.ai FLUX (grátis, sem chave, fallback final)
 *
 * IMPORTANTE: Nunca incluir texto nos prompts de capa/ilustração —
 * modelos de difusão não renderizam texto. O texto é sobreposto via canvas.
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/logger');
const logger = createLogger('imageGenAgent');

// ═══════════════════════════════════════════════════
// 0. HIGGSFIELD — FLUX Pro Kontext Max (melhor qualidade)
//    Env var: HIGGSFIELD_API_KEY=KEY_ID:KEY_SECRET
// ═══════════════════════════════════════════════════
async function generateWithHiggsfield(prompt, width, height, apiKey) {
  const BASE = 'https://platform.higgsfield.ai';
  const headers = {
    'Authorization': `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Aspect ratio mais próximo das dimensões solicitadas
  const ratio = width / height;
  const aspectRatio = ratio >= 1.7 ? '16:9'
    : ratio >= 1.2 ? '4:3'
    : ratio >= 0.9 ? '1:1'
    : ratio >= 0.7 ? '3:4'
    : '9:16';

  // 1. Submeter job
  const seed = Math.floor(Math.random() * 999999);
  const submitResp = await axios.post(
    `${BASE}/flux-pro/kontext/max/text-to-image`,
    { input: { prompt: prompt.slice(0, 2000), aspect_ratio: aspectRatio, safety_tolerance: 2, seed } },
    { headers, timeout: 30_000 }
  );

  const requestId = submitResp.data?.request_id;
  if (!requestId) throw new Error('Higgsfield não retornou request_id');
  logger.info(`   Higgsfield job ${requestId} submetido (${aspectRatio})...`);

  // 2. Polling até completar (máx 120s)
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await new Promise(r => setTimeout(r, 2500));
    const statusResp = await axios.get(
      `${BASE}/requests/${requestId}/status`,
      { headers, timeout: 15_000 }
    );
    const { status, results } = statusResp.data;

    if (status === 'completed') {
      const imgUrl = results?.raw?.url || results?.url;
      if (!imgUrl) throw new Error('Higgsfield: completed mas sem URL');
      const imgResp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30_000 });
      const buf = Buffer.from(imgResp.data);
      if (buf.length < 10_000) throw new Error(`Higgsfield imagem suspeita (${buf.length} bytes)`);
      return buf;
    }
    if (status === 'failed' || status === 'nsfw') {
      throw new Error(`Higgsfield job ${status}`);
    }
    // queued / in_progress — continua polling
  }
  throw new Error('Higgsfield timeout (120s)');
}

// ═══════════════════════════════════════════════════
// 1. DALL-E 3 (OpenAI) — mais rápido e confiável (~15s)
// ═══════════════════════════════════════════════════
async function generateWithDallE3(prompt, width, height, apiKey) {
  // Tenta gpt-image-1 (novo modelo) e depois dall-e-3 (legado)
  const models = [
    { id: 'gpt-image-1',  sizes: ['1024x1024', '1024x1536', '1536x1024'] },
    { id: 'dall-e-3',     sizes: ['1024x1024', '1024x1792', '1792x1024'] },
  ];

  const ratio = width / height;
  let lastErr;
  for (const { id: model, sizes } of models) {
    try {
      const size = ratio < 0.7 ? sizes[1] : ratio > 1.4 ? sizes[2] : sizes[0];
      const quality = model === 'gpt-image-1' ? 'medium' : 'standard'; // gpt-image-1: low|medium|high|auto
      const response = await axios.post(
        'https://api.openai.com/v1/images/generations',
        { model, prompt: prompt.slice(0, 4000), n: 1, size, quality },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60_000 }
      );
      const imgUrl = response.data?.data?.[0]?.url;
      const b64    = response.data?.data?.[0]?.b64_json; // gpt-image-1 retorna base64
      if (b64) return Buffer.from(b64, 'base64');
      if (!imgUrl) throw new Error(`${model} não retornou URL nem base64`);
      const imgResp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30_000 });
      const buf = Buffer.from(imgResp.data);
      if (buf.length < 10_000) throw new Error(`${model} imagem suspeita (${buf.length} bytes)`);
      return buf;
    } catch (e) {
      lastErr = e;
      const detail = e.response?.data?.error?.message?.slice(0, 100) || e.message?.slice(0, 60);
      logger.warn(`   OpenAI/${model} falhou: ${detail}`);
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════
// 2. GEMINI IMAGE GENERATION — grátis com chave Gemini
// ═══════════════════════════════════════════════════
async function generateWithImagen(prompt, aspectRatio, apiKey) {
  // Modelos atualizados (maio 2026) — em ordem de preferência
  const models = [
    { id: 'imagen-4.0-fast-generate-001', type: 'predict' },   // Imagen 4 Fast (mais rápido)
    { id: 'gemini-2.5-flash-image',       type: 'generate' },  // Gemini 2.5 Flash Image
    { id: 'gemini-3.1-flash-image-preview', type: 'generate' }, // Gemini 3.1 Flash Image
    { id: 'imagen-4.0-generate-001',      type: 'predict' },   // Imagen 4 (padrão)
  ];
  let lastErr;
  for (const { id: model, type } of models) {
    try {
      let body, endpoint;

      if (type === 'predict') {
        endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
        body = {
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio },
        };
      } else {
        endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        body = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        };
      }

      const response = await axios.post(endpoint, body, { timeout: 90_000 });

      // Resposta Imagen (predict)
      if (type === 'predict') {
        const b64 = response.data?.predictions?.[0]?.bytesBase64Encoded;
        if (b64) return Buffer.from(b64, 'base64');
        throw new Error(`${model} não retornou imagem`);
      }

      // Resposta Gemini (generateContent)
      const parts = response.data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          return Buffer.from(part.inlineData.data, 'base64');
        }
      }
      throw new Error('Sem imagem inline na resposta');
    } catch (e) {
      lastErr = e;
      const detail = e.response?.data?.error?.message?.slice(0, 80) || e.message?.slice(0, 80);
      logger.warn(`   Gemini/${model} falhou: ${detail}`);
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════
// 2. TOGETHER.AI — FLUX.1-schnell grátis ($25 free credit)
//    Env var: TOGETHER_API_KEY
// ═══════════════════════════════════════════════════
async function generateWithTogether(prompt, width, height, apiKey) {
  // Together.ai suporta dimensões múltiplas de 64, máx 1440
  const snap = v => Math.min(Math.round(v / 64) * 64, 1440);
  const w = snap(width), h = snap(height);

  const models = [
    'black-forest-labs/FLUX.1-schnell-Free', // grátis
    'black-forest-labs/FLUX.1-schnell',
    'black-forest-labs/FLUX.1.1-pro',
  ];
  let lastErr;
  for (const model of models) {
    try {
      const resp = await axios.post(
        'https://api.together.xyz/v1/images/generations',
        { model, prompt: prompt.slice(0, 2000), width: w, height: h, steps: 4, n: 1 },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 90_000,
        }
      );
      const imgUrl = resp.data?.data?.[0]?.url;
      const b64    = resp.data?.data?.[0]?.b64_json;
      if (b64) return Buffer.from(b64, 'base64');
      if (!imgUrl) throw new Error(`${model} sem URL`);
      const imgResp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30_000 });
      const buf = Buffer.from(imgResp.data);
      if (buf.length < 10_000) throw new Error(`Together imagem suspeita (${buf.length} bytes)`);
      return buf;
    } catch (e) {
      lastErr = e;
      logger.warn(`   Together/${model.split('/')[1]} falhou: ${e.response?.data?.error?.message?.slice(0,80) || e.message?.slice(0,60)}`);
      if (e.response?.status === 402 || e.response?.status === 429) break; // sem crédito/rate limit
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════
// 3. CLOUDFLARE AI — FLUX.1-schnell grátis
//    Env vars: CF_ACCOUNT_ID + CF_API_TOKEN
// ═══════════════════════════════════════════════════
async function generateWithCloudflare(prompt, width, height, accountId, apiToken) {
  const snap = v => Math.min(Math.round(v / 8) * 8, 2048);
  const w = snap(width), h = snap(height);

  const resp = await axios.post(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    { prompt: prompt.slice(0, 2000), width: w, height: h, num_steps: 4 },
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 90_000,
    }
  );
  const buf = Buffer.from(resp.data);
  if (buf.length < 10_000) throw new Error(`Cloudflare imagem suspeita (${buf.length} bytes)`);
  return buf;
}

// ═══════════════════════════════════════════════════
// 2b. HUGGINGFACE — tenta FLUX.1-schnell depois SDXL
// ═══════════════════════════════════════════════════
async function generateWithFlux(prompt, width, height, apiKey) {
  const models = [
    { id: 'black-forest-labs/FLUX.1-schnell', steps: 4,  guidance: 0 },
    { id: 'black-forest-labs/FLUX.1-dev',     steps: 20, guidance: 3.5 },
  ];
  // Router novo (requer Accept: image/png) → legacy como fallback
  const baseUrls = [
    'https://router.huggingface.co/hf-inference/models',
    'https://api-inference.huggingface.co/models',
  ];
  let lastErr;
  for (const { id: model, steps, guidance } of models) {
    for (const base of baseUrls) {
      try {
        logger.info(`   HF model: ${model.split('/')[1]} (${base.includes('router') ? 'router' : 'legacy'})`);
        const response = await axios.post(
          `${base}/${model}`,
          {
            inputs: prompt,
            parameters: {
              width:  Math.min(width, 1024),
              height: Math.min(height, 1024),
              num_inference_steps: steps,
              guidance_scale: guidance,
            },
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'Accept': 'image/png',
              'X-Use-Cache': 'false',
            },
            responseType: 'arraybuffer',
            timeout: 180_000,
          }
        );
        const buf = Buffer.from(response.data);
        if (buf.length < 10_000) throw new Error(`Imagem suspeita: ${buf.length} bytes`);
        return buf;
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        logger.warn(`   HF ${model.split('/')[1]} falhou (${status || e.code}): ${e.message?.slice(0, 60)}`);
        if (status !== 404 && status !== 503) break; // só tenta outra URL em 404/503
      }
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════
// 3. FAL.AI — FLUX.1-schnell ~3s, free tier
// ═══════════════════════════════════════════════════
async function generateWithFalAI(prompt, width, height, apiKey) {
  // fal.ai suporta dimensões customizadas (múltiplos de 32, máx 1440)
  const clamp = (v, max = 1024) => Math.min(Math.round(v / 32) * 32, max);
  const w = clamp(width, 1440);
  const h = clamp(height, 1440);

  const response = await axios.post(
    'https://fal.run/fal-ai/flux/schnell',
    {
      prompt: prompt.slice(0, 2000),
      image_size: { width: w, height: h },
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: false,
    },
    {
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );

  const imgUrl = response.data?.images?.[0]?.url;
  if (!imgUrl) throw new Error('fal.ai não retornou URL de imagem');

  const imgResp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30_000 });
  const buf = Buffer.from(imgResp.data);
  if (buf.length < 10_000) throw new Error(`fal.ai imagem suspeita (${buf.length} bytes)`);
  return buf;
}

// ═══════════════════════════════════════════════════
// 4. POLLINATIONS.AI — grátis, sem chave, usa FLUX
// ═══════════════════════════════════════════════════
async function generateWithPollinations(prompt, width, height) {
  const models = ['flux', 'flux-pro', 'turbo'];
  let lastErr;
  for (const model of models) {
    // Rate limit (402): aguarda e tenta de novo até 3x
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const encoded = encodeURIComponent(prompt);
        const seed = Math.floor(Math.random() * 999999);
        const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&model=${model}&nologo=true&seed=${seed}`;
        logger.info(`   Pollinations/${model} (tentativa ${attempt})`);
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 120_000,
          headers: { 'User-Agent': 'GENIA-EbookPublisher/1.0' },
        });
        const buf = Buffer.from(response.data);
        if (buf.length < 10_000) throw new Error(`Imagem suspeita: ${buf.length} bytes`);
        return buf;
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        if (status === 402 || status === 429) {
          const wait = attempt * 8000; // 8s, 16s, 24s
          logger.warn(`   Pollinations/${model} rate limit (${status}), aguardando ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          logger.warn(`   Pollinations/${model} falhou: ${e.message?.slice(0, 80)}`);
          break; // erro diferente de rate limit → tenta próximo model
        }
      }
    }
  }
  throw lastErr || new Error('Pollinations: todos os modelos falharam');
}

// ═══════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL
// ═══════════════════════════════════════════════════
async function generateImage({ prompt, width = 1024, height = 1024, outputPath }) {
  const higgsfieldKey = process.env.HIGGSFIELD_API_KEY;
  const openaiKey     = process.env.OPENAI_API_KEY;
  const togetherKey   = process.env.TOGETHER_API_KEY;
  const cfAccountId   = process.env.CF_ACCOUNT_ID;
  const cfApiToken    = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const falKey        = process.env.FAL_AI_API_KEY;
  const geminiKey     = process.env.GEMINI_API_KEY;
  const hfKey         = process.env.HUGGINGFACE_API_KEY;

  // Aspect ratio para Gemini/Higgsfield
  const ratio = width / height;
  const aspectRatio = ratio > 1.4 ? '16:9' : ratio < 0.75 ? '9:16' : ratio < 0.85 ? '4:3' : '1:1';

  const providers = [
    {
      name: 'Higgsfield FLUX Pro', // 🥇 melhor qualidade, FLUX Pro Kontext Max
      enabled: !!higgsfieldKey,
      fn: () => generateWithHiggsfield(prompt, width, height, higgsfieldKey),
    },
    {
      name: 'Together.ai FLUX',   // ⚡ FLUX.1-schnell grátis ($25 free credit)
      enabled: !!togetherKey,
      fn: () => generateWithTogether(prompt, width, height, togetherKey),
    },
    {
      name: 'fal.ai FLUX',        // ⚡ ~3s, free tier
      enabled: !!falKey,
      fn: () => generateWithFalAI(prompt, width, height, falKey),
    },
    {
      name: 'Cloudflare FLUX',    // grátis via Workers AI
      enabled: !!(cfAccountId && cfApiToken),
      fn: () => generateWithCloudflare(prompt, width, height, cfAccountId, cfApiToken),
    },
    {
      name: 'DALL-E 3',           // pago (~$0.04/img)
      enabled: !!openaiKey,
      fn: () => generateWithDallE3(prompt, width, height, openaiKey),
    },
    {
      name: 'Gemini Image Gen',   // grátis com chave Gemini
      enabled: !!geminiKey,
      fn: () => generateWithImagen(prompt, aspectRatio, geminiKey),
    },
    {
      name: 'HuggingFace FLUX',   // grátis, mais lento
      enabled: !!hfKey,
      fn: () => generateWithFlux(prompt, width, height, hfKey),
    },
    {
      name: 'Pollinations.ai',    // grátis, sem chave, fallback final
      enabled: true,
      fn: () => generateWithPollinations(prompt, width, height),
    },
  ];

  for (const provider of providers) {
    if (!provider.enabled) { logger.info(`⏭️  ${provider.name} pulado (sem chave)`); continue; }
    try {
      logger.info(`🎨 Gerando imagem com ${provider.name}...`);
      const t0 = Date.now();
      const buf = await provider.fn();
      logger.info(`✅ ${provider.name} ok em ${Date.now()-t0}ms (${(buf.length/1024).toFixed(0)}KB)`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buf);
      return { path: outputPath, provider: provider.name, buffer: buf };
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 150) : '';
      logger.warn(`❌ ${provider.name} falhou: ${err.message?.slice(0, 100)}${detail ? ' — '+detail : ''}`);
    }
  }
  throw new Error('Todos os providers de imagem falharam (incluindo Pollinations)');
}

module.exports = { generateImage };
