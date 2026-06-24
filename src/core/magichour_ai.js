'use strict';
/**
 * magichour_ai.js — provedor de IMAGEM e VÍDEO via Magic Hour API.
 * Primeira API de vídeo realmente funcional do ecossistema GENIA (fal.ai/HF esgotados).
 *
 * Faz IMAGEM (text-to-image, ~5 créditos) e VÍDEO (text-to-video / image-to-video,
 * ~120 créditos/5s = ~24 cr/seg). Operações de vídeo são long-running (polling ~2-5min).
 *
 * Rotação multi-conta: MAGICHOUR_API_KEY, _2 .. _8 (8 contas → 8× o saldo grátis).
 * Não há endpoint público de saldo → cada chave é marcada "sem créditos" ao receber
 * 402/403 insufficient e pulada; o caller cai pro fallback (FFmpeg/gradiente) só quando
 * TODAS as chaves esgotam.
 *
 * ATENÇÃO CRÉDITOS: vídeo é caro (~24 cr/seg). Use parcimoniosamente.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'api.magichour.ai';
// Cloudflare-friendly UA por garantia (algumas edges rejeitam sem UA).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const KEYS = [
  process.env.MAGICHOUR_API_KEY,   process.env.MAGICHOUR_API_KEY_2,
  process.env.MAGICHOUR_API_KEY_3, process.env.MAGICHOUR_API_KEY_4,
  process.env.MAGICHOUR_API_KEY_5, process.env.MAGICHOUR_API_KEY_6,
  process.env.MAGICHOUR_API_KEY_7, process.env.MAGICHOUR_API_KEY_8,
].filter(Boolean);

const _exhausted = new Set(); // chaves sem crédito (402/403) — limpo a cada 1h p/ retentar renovação
setInterval(() => _exhausted.clear(), 3_600_000).unref();

function availableKeys() { return KEYS.filter((k) => !_exhausted.has(k)); }
function isAvailable() { return availableKeys().length > 0; }

function _req(method, urlPath, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Authorization: 'Bearer ' + key, 'User-Agent': UA };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = https.request({ hostname: BASE, path: urlPath, method, headers }, (rs) => {
      const ch = [];
      rs.on('data', (c) => ch.push(c));
      rs.on('end', () => {
        const txt = Buffer.concat(ch).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch { /* keep raw */ }
        if (rs.statusCode === 402 || (rs.statusCode === 403 && /credit|balance|insufficient|locked/i.test(txt))) {
          _exhausted.add(key);
          const e = new Error('Magic Hour: sem créditos (' + rs.statusCode + ')'); e.noCredits = true;
          return reject(e);
        }
        if (rs.statusCode >= 400) return reject(new Error('Magic Hour ' + rs.statusCode + ': ' + txt.slice(0, 200)));
        resolve(json ?? {});
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function _download(url, outPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const file = fs.createWriteStream(outPath);
    https.get(url, { headers: { 'User-Agent': UA } }, (rs) => {
      if (rs.statusCode >= 400) { file.close(); return reject(new Error('download ' + rs.statusCode)); }
      rs.pipe(file);
      file.on('finish', () => file.close(() => resolve(outPath)));
    }).on('error', (e) => { file.close(); reject(e); });
  });
}

async function _poll(kind, id, key, { timeoutMs = 480000, intervalMs = 12000 } = {}) {
  const ep = kind === 'video' ? 'video-projects' : 'image-projects';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await _req('GET', '/v1/' + ep + '/' + id, null, key);
    if (d.status === 'complete' && Array.isArray(d.downloads) && d.downloads.length) return d.downloads[0].url;
    if (d.status === 'error' || d.error) throw new Error('Magic Hour render error: ' + (d.error || 'unknown'));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Magic Hour: timeout de polling (' + kind + ')');
}

// Tenta a operação com cada chave disponível; pula chaves sem crédito.
async function _withRotation(fn) {
  if (!isAvailable()) throw new Error('Magic Hour indisponível (todas as chaves esgotadas)');
  let lastErr;
  for (const key of availableKeys()) {
    try { return await fn(key); }
    catch (e) { lastErr = e; if (e && e.noCredits) continue; throw e; }
  }
  throw lastErr || new Error('Magic Hour: todas as chaves esgotadas');
}

/** Gera imagem. prompt -> PNG salvo em outPath. orientation: landscape|portrait|square */
async function generateImage(prompt, outPath, { orientation = 'landscape' } = {}) {
  return _withRotation(async (key) => {
    const sub = await _req('POST', '/v1/ai-image-generator', { name: 'genia', image_count: 1, orientation, style: { prompt } }, key);
    const url = await _poll('image', sub.id, key, { timeoutMs: 120000, intervalMs: 6000 });
    return _download(url, outPath);
  });
}

/** Gera vídeo a partir de texto. seconds: duração (5 padrão). orientation: landscape|portrait */
async function generateVideo(prompt, outPath, { seconds = 5, orientation = 'portrait' } = {}) {
  return _withRotation(async (key) => {
    const sub = await _req('POST', '/v1/text-to-video', { name: 'genia', orientation, style: { prompt }, end_seconds: seconds }, key);
    const url = await _poll('video', sub.id, key, { timeoutMs: 480000, intervalMs: 12000 });
    return _download(url, outPath);
  });
}

/** Vídeo a partir de imagem (image-to-video). imageUrl precisa ser publicamente acessível. */
async function imageToVideo(imageUrl, outPath, { seconds = 5 } = {}) {
  return _withRotation(async (key) => {
    const sub = await _req('POST', '/v1/image-to-video', { name: 'genia', assets: { image_file_path: imageUrl }, end_seconds: seconds }, key);
    const url = await _poll('video', sub.id, key, { timeoutMs: 480000, intervalMs: 12000 });
    return _download(url, outPath);
  });
}

module.exports = { isAvailable, availableKeys: () => availableKeys().length, generateImage, generateVideo, imageToVideo };
