/**
 * audiobookAgent.js — Geração de audiobooks completos via ElevenLabs
 *
 * Pipeline:
 *   1. Extrai texto de cada seção do ebook (intro + capítulos + conclusão)
 *   2. Quebra em chunks de ~2500 chars (limite ElevenLabs por request)
 *   3. Gera áudio para cada chunk via ElevenLabs API (rotação de 3 chaves)
 *   4. Concatena todos os buffers em um único MP3
 *   5. Salva em /app/data/audiobooks/<ebookId>.mp3
 *
 * Suporte multi-idioma: eleven_multilingual_v2 model
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { createLogger } = require('../core/logger');

const logger = createLogger('audiobookAgent');

const AUDIOBOOKS_DIR = path.join(__dirname, '../../data/audiobooks');

// ─── ElevenLabs Config ────────────────────────────────────────────────────────
const ELEVENLABS_KEYS = [
  process.env.ELEVENLABS_API_KEY,
  process.env.ELEVENLABS_API_KEY_2,
  process.env.ELEVENLABS_API_KEY_3,
].filter(Boolean);

const VOICE_ID  = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam
const EL_MODEL  = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const CHUNK_MAX = 2400; // chars por request (limite seguro ElevenLabs)

// Chave exausta por 1h
const _exhausted = new Set();
setInterval(() => _exhausted.clear(), 3_600_000).unref();

let _keyIdx = 0;
function getNextKey() {
  const available = ELEVENLABS_KEYS.filter(k => !_exhausted.has(k));
  if (!available.length) throw new Error('Todas as chaves ElevenLabs esgotadas por agora');
  const key = available[_keyIdx % available.length];
  _keyIdx++;
  return key;
}

// ─── Gerar áudio de um chunk de texto ────────────────────────────────────────
async function generateAudioChunk(text, retries = 3) {
  const cleanText = text
    .replace(/[#*_~`]/g, '')          // Remove markdown
    .replace(/\n{3,}/g, '\n\n')       // Normaliza quebras
    .replace(/\[.*?\]/g, '')          // Remove links markdown
    .replace(/!\[.*?\]\(.*?\)/g, '')  // Remove imagens markdown
    .trim();

  if (!cleanText || cleanText.length < 5) return null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let apiKey;
    try {
      apiKey = getNextKey();
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
      const response = await axios.post(url, {
        text: cleanText,
        model_id: EL_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }, {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 60_000,
      });

      return Buffer.from(response.data);

    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 || status === 401 || status === 403) {
        if (apiKey) _exhausted.add(apiKey);
        logger.warn(`ElevenLabs key esgotada (status ${status}), tentando próxima...`);
        if (attempt === retries) throw new Error(`ElevenLabs: todas as tentativas falharam (${status})`);
        continue;
      }
      if (attempt === retries) throw err;
      logger.warn(`ElevenLabs tentativa ${attempt} falhou: ${err.message}, aguardando 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ─── Quebrar texto em chunks respeitando frases ────────────────────────────────
function splitIntoChunks(text, maxLen = CHUNK_MAX) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    // Frase muito longa? Quebrar em pedaços menores
    if (sentence.length > maxLen) {
      if (current) { chunks.push(current.trim()); current = ''; }
      // Quebrar por pausa natural (vírgula, ponto e vírgula)
      const subParts = sentence.split(/(?<=[,;])\s+/);
      let sub = '';
      for (const part of subParts) {
        if ((sub + ' ' + part).length > maxLen) {
          if (sub) chunks.push(sub.trim());
          sub = part;
        } else {
          sub = sub ? sub + ' ' + part : part;
        }
      }
      if (sub) current = sub;
      continue;
    }

    if ((current + ' ' + sentence).length > maxLen) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 5);
}

// ─── Preparar texto do ebook ──────────────────────────────────────────────────
function prepareEbookText(ebook) {
  const sections = [];

  // Título e subtítulo como abertura
  sections.push(`${ebook.title}. ${ebook.subtitle || ''}`);

  // Introdução
  if (ebook.introduction) {
    sections.push('Introdução. ' + ebook.introduction);
  }

  // Capítulos
  if (ebook.chapters?.length) {
    for (const ch of ebook.chapters) {
      const chapterText = `Capítulo ${ch.number}: ${ch.title}. ${ch.content || ''}`;
      sections.push(chapterText);
    }
  }

  // Conclusão
  if (ebook.conclusion) {
    sections.push('Conclusão. ' + ebook.conclusion);
  }

  return sections;
}

// ─── GERAÇÃO COMPLETA DO AUDIOBOOK ───────────────────────────────────────────
async function generateAudiobook(ebook, ebookId) {
  if (!ELEVENLABS_KEYS.length) {
    logger.warn('⚠️ Nenhuma chave ElevenLabs configurada — audiobook não gerado');
    return null;
  }

  logger.info(`\n🎙️ Iniciando audiobook: "${ebook.title}" [${ebook.language || 'pt-BR'}]`);
  fs.mkdirSync(AUDIOBOOKS_DIR, { recursive: true });

  const outPath = path.join(AUDIOBOOKS_DIR, `${ebookId}.mp3`);

  // Se já existe, pular
  if (fs.existsSync(outPath)) {
    logger.info(`✅ Audiobook já existe: ${outPath}`);
    return outPath;
  }

  const t0 = Date.now();
  const sections = prepareEbookText(ebook);
  const audioBuffers = [];

  let totalChunks = 0;
  let doneChunks = 0;
  let totalChars = 0;

  // Pré-calcular total de chunks
  for (const section of sections) {
    const chunks = splitIntoChunks(section);
    totalChunks += chunks.length;
    totalChars  += section.length;
  }

  logger.info(`📊 Audiobook: ${sections.length} seções, ~${totalChunks} chunks, ~${totalChars} chars`);

  // Processar cada seção
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const chunks = splitIntoChunks(section);
    const sectionLabel = si === 0 ? 'Título' :
                         si === 1 ? 'Introdução' :
                         si === sections.length - 1 ? 'Conclusão' :
                         `Capítulo ${si - 1}`;

    logger.info(`🎙️  ${sectionLabel}: ${chunks.length} chunks...`);

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      try {
        const buf = await generateAudioChunk(chunk);
        if (buf) {
          audioBuffers.push(buf);
          doneChunks++;
        }
        // Log progresso a cada 5 chunks
        if (doneChunks % 5 === 0) {
          logger.info(`   ⏳ Progresso: ${doneChunks}/${totalChunks} chunks (${Math.round(doneChunks/totalChunks*100)}%)`);
        }
        // Pequeno delay entre chunks para não throttling
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        logger.warn(`⚠️ Chunk ${ci+1} da seção "${sectionLabel}" falhou: ${err.message}`);
        // Continua — não para o audiobook todo por um chunk
      }
    }
  }

  if (!audioBuffers.length) {
    throw new Error('Nenhum áudio gerado — todas as chamadas ElevenLabs falharam');
  }

  // Concatenar todos os MP3 buffers
  // MP3 é simplesmente concatenável (frames independentes)
  const combined = Buffer.concat(audioBuffers);
  fs.writeFileSync(outPath, combined);

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const sizeMb  = (combined.length / 1024 / 1024).toFixed(2);
  logger.info(`✅ Audiobook gerado: ${path.basename(outPath)} (${sizeMb}MB, ${elapsed}s, ${doneChunks}/${totalChunks} chunks)`);

  return outPath;
}

// ─── Verificar disponibilidade ────────────────────────────────────────────────
function isAvailable() {
  return ELEVENLABS_KEYS.length > 0;
}

module.exports = { generateAudiobook, isAvailable, splitIntoChunks, prepareEbookText };
