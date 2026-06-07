/**
 * edgeTtsAgent.js — Microsoft Edge Neural TTS via Python edge-tts CLI
 *
 * Usa o pacote Python 'edge-tts' (pip install edge-tts) que mantém o
 * protocolo WebSocket atualizado com o Microsoft Edge TTS server.
 *
 * Qualidade equivalente ao Azure Neural TTS — 300+ vozes, 100+ idiomas.
 * Gratuito, sem API key, sem limite de quota.
 *
 * Instalação no Docker: python3-pip + edge-tts instalado no Dockerfile
 */
'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { createLogger } = require('../core/logger');

const logger = createLogger('edgeTtsAgent');

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

// ─── Verificar se edge-tts está instalado ─────────────────────────────────────
let _cliPath = null;
function findEdgeTtsCli() {
  if (_cliPath !== null) return _cliPath;
  const isWin = process.platform === 'win32';
  const { execSync } = require('child_process');

  // Windows: tentar caminhos específicos + scripts Python
  if (isWin) {
    const winCandidates = [
      'edge-tts',
      'edge-tts.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'edge-tts.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'edge-tts.exe'),
      path.join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'edge-tts.exe'),
    ];
    for (const p of winCandidates) {
      try {
        execSync(`"${p}" --version`, { stdio: 'pipe', timeout: 5000 });
        _cliPath = p;
        return p;
      } catch { /* try next */ }
    }
    // Tentar via python -m edge_tts (Windows usa 'python' não 'python3')
    for (const py of ['python', 'py', 'python3']) {
      try {
        execSync(`${py} -m edge_tts --version`, { stdio: 'pipe', timeout: 5000 });
        _cliPath = `__python_module__:${py}`;
        return _cliPath;
      } catch { /* try next */ }
    }
    _cliPath = null;
    return null;
  }

  // Linux/Mac: busca tradicional
  const candidates = ['/usr/local/bin/edge-tts', '/usr/bin/edge-tts', 'edge-tts'];
  for (const p of candidates) {
    try {
      execSync(`which ${p} 2>/dev/null || ${p} --version 2>/dev/null`, { stdio: 'pipe' });
      _cliPath = p;
      return p;
    } catch { /* try next */ }
  }
  // Tentar via python3 -m edge_tts
  try {
    execSync('python3 -m edge_tts --version 2>/dev/null', { stdio: 'pipe' });
    _cliPath = '__python_module__:python3';
    return _cliPath;
  } catch { /* not available */ }
  _cliPath = null;
  return null;
}

// ─── Síntese via edge-tts CLI ─────────────────────────────────────────────────
async function synthesizeChunk(text, language = 'en', retries = 3) {
  const cli = findEdgeTtsCli();
  if (!cli) throw new Error('edge-tts CLI não encontrado — instalar: pip install edge-tts');

  const voice   = getVoice(language);
  const tmpFile = path.join(os.tmpdir(), `edge_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

  // Limpar texto (remover markdown, normalizar)
  const cleanText = text
    .replace(/[#*_~`]/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleanText || cleanText.length < 3) return null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const isPyModule = cli.startsWith('__python_module__');
        const pyBin = cli.includes(':') ? cli.split(':')[1] : 'python3';
        const args = isPyModule
          ? ['-m', 'edge_tts', '--voice', voice, '--text', cleanText, '--write-media', tmpFile]
          : ['--voice', voice, '--text', cleanText, '--write-media', tmpFile];
        const bin = isPyModule ? pyBin : cli;

        const proc = spawn(bin, args, { timeout: 60_000 });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
          if (code === 0 && fs.existsSync(tmpFile)) {
            resolve();
          } else {
            reject(new Error(`edge-tts exit ${code}: ${stderr.slice(0, 200)}`));
          }
        });
        proc.on('error', reject);
      });

      const buf = fs.readFileSync(tmpFile);
      fs.unlinkSync(tmpFile);

      if (buf.length < 100) throw new Error('edge-tts retornou áudio vazio');
      return buf;

    } catch (err) {
      if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch {} }
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
    if (_available) logger.info('✅ Edge TTS (Python CLI) disponível');
    else logger.warn('⚠️ Edge TTS retornou áudio vazio no teste');
  } catch (err) {
    logger.warn(`⚠️ Edge TTS não disponível: ${err.message}`);
    _available = false;
  }
  setTimeout(() => { _available = null; }, 3_600_000).unref();
  return _available;
}

module.exports = { synthesizeChunk, getVoice, isAvailable };
