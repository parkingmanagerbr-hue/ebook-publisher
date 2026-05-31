/**
 * edgeTtsAgent.js — Microsoft Edge Neural TTS (gratuito, sem API key)
 *
 * Usa o mesmo serviço de voz neural do Microsoft Edge/Azure TTS.
 * Qualidade equivalente ao Azure Neural TTS — 300+ vozes, 100+ idiomas.
 * Protocolo: WebSocket para speech.platform.bing.com com sec-ms-gec token.
 *
 * Fallback gratuito para quando ElevenLabs está esgotado.
 */
'use strict';

const WebSocket  = require('ws');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../core/logger');

const logger = createLogger('edgeTtsAgent');

const EDGE_TTS_URL  = 'wss://speech.platform.bing.com/consumer/speech/synthesize/realtimeTTS/for/edge/v1';
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const TIMEOUT_MS    = 45_000;

// ─── Vozes neurais por idioma ─────────────────────────────────────────────────
const VOICE_MAP = {
  'en':    'en-US-AriaNeural',
  'en-US': 'en-US-AriaNeural',
  'en-GB': 'en-GB-SoniaNeural',
  'pt':    'pt-BR-FranciscaNeural',
  'pt-BR': 'pt-BR-FranciscaNeural',
  'pt-PT': 'pt-PT-RaquelNeural',
  'es':    'es-ES-ElviraNeural',
  'es-ES': 'es-ES-ElviraNeural',
  'es-MX': 'es-MX-DaliaNeural',
  'fr':    'fr-FR-DeniseNeural',
  'fr-FR': 'fr-FR-DeniseNeural',
  'de':    'de-DE-KatjaNeural',
  'de-DE': 'de-DE-KatjaNeural',
  'it':    'it-IT-ElsaNeural',
  'it-IT': 'it-IT-ElsaNeural',
  'ja':    'ja-JP-NanamiNeural',
  'ja-JP': 'ja-JP-NanamiNeural',
  'zh':    'zh-CN-XiaoxiaoNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  'zh-TW': 'zh-TW-HsiaoChenNeural',
  'pl':    'pl-PL-ZofiaNeural',
  'pl-PL': 'pl-PL-ZofiaNeural',
  'nl':    'nl-NL-ColetteNeural',
  'nl-NL': 'nl-NL-ColetteNeural',
  'ko':    'ko-KR-SunHiNeural',
  'ru':    'ru-RU-SvetlanaNeural',
  'ar':    'ar-SA-ZariyahNeural',
  'hi':    'hi-IN-SwaraNeural',
  'tr':    'tr-TR-EmelNeural',
};

function getVoice(language) {
  if (!language) return VOICE_MAP['en'];
  const lang = language.trim();
  return VOICE_MAP[lang] || VOICE_MAP[lang.split('-')[0]] || VOICE_MAP['en'];
}

function isoTime() {
  return new Date().toISOString();
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSSML(text, voice) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>${escapeXml(text)}</voice>` +
    `</speak>`
  );
}

/**
 * Gerar o token de segurança sec-ms-gec exigido pelo endpoint Edge TTS.
 * Algoritmo: SHA256("MSEdge" + rounded_ticks).toUpperCase()
 * onde rounded_ticks é o timestamp Windows em intervals de 10ms, arredondado para 8s.
 */
function generateSecMsGecToken() {
  // Windows FILETIME: ticks de 100ns desde 1601-01-01
  // Diferença Unix epoch → Windows epoch: 11644473600 segundos
  const WIN_EPOCH_OFFSET = 11_644_473_600n;
  const nowMs    = BigInt(Date.now());
  const ticks    = (nowMs / 1000n + WIN_EPOCH_OFFSET) * 10_000_000n;
  const interval = 8_000_000_000n; // 800 segundos em ticks
  const rounded  = ticks + interval - (ticks % interval);
  const token    = crypto
    .createHash('sha256')
    .update(`MSEdge${rounded}`)
    .digest('hex')
    .toUpperCase();
  return token;
}

// ─── Síntese de um chunk de texto via Edge TTS ────────────────────────────────
async function synthesizeChunk(text, language = 'en', retries = 3) {
  const voice  = getVoice(language);
  const connId = uuidv4().replace(/-/g, '');
  const reqId  = uuidv4().replace(/-/g, '');
  const gecToken = generateSecMsGecToken();

  const url = (
    `${EDGE_TTS_URL}` +
    `?TrustedClientToken=${TRUSTED_TOKEN}` +
    `&ConnectionId=${connId}` +
    `&Sec-MS-GEC=${gecToken}` +
    `&Sec-MS-GEC-Version=1-${gecToken}`
  );

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const audioBuffer = await new Promise((resolve, reject) => {
        const chunks  = [];
        let settled   = false;
        let timer;

        const done = (err, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve(result);
        };

        timer = setTimeout(() => done(new Error('Edge TTS timeout')), TIMEOUT_MS);

        const ws = new WebSocket(url, {
          headers: {
            'Pragma':          'no-cache',
            'Cache-Control':   'no-cache',
            'Origin':          'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
          },
        });

        ws.on('open', () => {
          // 1. Configurar saída
          ws.send(
            `X-Timestamp:${isoTime()}\r\n` +
            `Content-Type:application/json; charset=utf-8\r\n` +
            `Path:speech.config\r\n\r\n` +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                    outputFormat: OUTPUT_FORMAT,
                  },
                },
              },
            })
          );

          // 2. Enviar SSML
          ws.send(
            `X-RequestId:${reqId}\r\n` +
            `Content-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${isoTime()}\r\n` +
            `Path:ssml\r\n\r\n` +
            buildSSML(text, voice)
          );
        });

        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            const SEP = Buffer.from('\r\n\r\n');
            const idx = data.indexOf(SEP);
            if (idx !== -1) {
              const audio = data.slice(idx + SEP.length);
              if (audio.length > 0) chunks.push(audio);
            }
          } else {
            const msg = data.toString();
            if (msg.includes('Path:turn.end')) {
              ws.close();
              if (!chunks.length) {
                done(new Error('Edge TTS: nenhum áudio recebido'));
              } else {
                done(null, Buffer.concat(chunks));
              }
            }
          }
        });

        ws.on('error', err => done(err));
        ws.on('close', () => {
          if (chunks.length && !settled) done(null, Buffer.concat(chunks));
        });
      });

      return audioBuffer;

    } catch (err) {
      logger.warn(`Edge TTS tentativa ${attempt}/${retries} falhou: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ─── Verificar disponibilidade ────────────────────────────────────────────────
let _available = null;
async function isAvailable() {
  if (_available !== null) return _available;
  try {
    const buf = await synthesizeChunk('Test.', 'en', 1);
    _available = buf && buf.length > 100;
  } catch {
    _available = false;
  }
  setTimeout(() => { _available = null; }, 3_600_000).unref();
  return _available;
}

module.exports = { synthesizeChunk, getVoice, isAvailable };
