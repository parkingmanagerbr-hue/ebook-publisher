/**
 * geminiImageAgent.js — Geração de imagens via Gemini Image API
 *
 * Padrão GENIA: 5 chaves em rotação, exaustão limpa a cada 1h.
 * Não usa Anthropic/Claude — usa apenas as chaves Gemini do .env.
 *
 * Modelos tentados em ordem (mais novo → mais compatível):
 *   gemini-2.0-flash-preview-image-generation
 *   gemini-2.5-flash-image
 *   gemini-3-pro-image-preview
 *   gemini-3.1-flash-image-preview
 */
'use strict';
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { createLogger } = require('../core/logger');
const logger = createLogger('geminiImageAgent');

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
].filter(Boolean);

// Modelos a tentar em ordem — para em qualquer que retornar imagem válida
// Atualizado junho/2026: gemini-2.0-flash-preview-image-generation foi descontinuado
const IMAGE_MODELS = [
  'gemini-2.5-flash-image',            // Primário (maio 2026+)
  'gemini-3.1-flash-image-preview',    // Fallback 1
  'gemini-3-pro-image-preview',        // Fallback 2
  'gemini-3.1-flash-image',            // Fallback 3
];

// Chaves esgotadas (429/403) — limpas a cada 1h
const _exhaustedKeys   = new Set();
const _exhaustedModels = new Set();
setInterval(() => { _exhaustedKeys.clear(); _exhaustedModels.clear(); }, 3_600_000).unref();

/**
 * Gera uma imagem com Gemini Image e retorna um Buffer PNG.
 * @param {string} prompt - Descrição da imagem desejada
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generateImageBuffer(prompt) {
  if (GEMINI_KEYS.length === 0) throw new Error('Nenhuma GEMINI_API_KEY configurada');

  const availableKeys   = GEMINI_KEYS.filter(k => !_exhaustedKeys.has(k));
  const availableModels = IMAGE_MODELS.filter(m => !_exhaustedModels.has(m));

  if (availableKeys.length === 0)   throw new Error('Gemini Image: todas as chaves esgotadas');
  if (availableModels.length === 0) throw new Error('Gemini Image: todos os modelos falharam');

  // Tenta cada combinação (key × model) na ordem
  const errors = [];
  for (const model of availableModels) {
    for (const key of availableKeys) {
      try {
        const url  = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const body = {
          contents: [{ parts: [{ text: prompt.slice(0, 2000) }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        };
        const res = await axios.post(url, body, { timeout: 60_000 });
        for (const part of res.data?.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData?.data) {
            const buf = Buffer.from(part.inlineData.data, 'base64');
            if (buf.length < 5_000) continue;   // imagem suspeita
            logger.info(`✅ Gemini Image gerada com ${model} (${Math.round(buf.length/1024)}KB)`);
            return buf;
          }
        }
        // Sem inlineData → modelo não suporta geração de imagem
        _exhaustedModels.add(model);
        errors.push(`${model}: sem inlineData na resposta`);
        break; // tenta próximo modelo com todas as chaves
      } catch (err) {
        const status = err?.response?.status;
        const msg    = err?.response?.data?.error?.message || err.message;
        if (status === 429 || status === 403) {
          _exhaustedKeys.add(key);
          errors.push(`${model}+key: ${status}`);
          break; // chave esgotada, tenta próxima chave no próximo model
        }
        if (status === 404 || status === 400) {
          _exhaustedModels.add(model);
          errors.push(`${model}: ${status} - modelo inválido`);
          break; // modelo inválido, tenta próximo modelo
        }
        errors.push(`${model}: ${msg}`);
      }
    }
  }

  throw new Error(`Gemini Image falhou em todos os modelos: ${errors.slice(0, 3).join('; ')}`);
}

/**
 * Gera imagem e salva em disco.
 * @param {string} prompt
 * @param {string} outputPath - caminho onde salvar o PNG
 * @returns {Promise<string>} outputPath
 */
async function generateImage(prompt, outputPath) {
  const buf = await generateImageBuffer(prompt);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

/**
 * @returns {boolean} true se há pelo menos uma chave Gemini configurada
 */
function isAvailable() {
  return GEMINI_KEYS.length > 0 && IMAGE_MODELS.filter(m => !_exhaustedModels.has(m)).length > 0;
}

module.exports = { generateImageBuffer, generateImage, isAvailable };
