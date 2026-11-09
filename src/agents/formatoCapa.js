'use strict';
/**
 * formatoCapa.js — o formato em que TODA capa nova é gravada.
 *
 * 09/11/2026: as capas antigas tinham sido convertidas para JPEG em 08/10
 * (scripts/capasParaJpeg.py, 24 GB devolvidos), mas os geradores continuaram
 * gravando PNG de 1600x2560 — ~3,3 MB cada, ~2 GB por dia — e o disco da VPS
 * voltou a 97%. A conversão tratava o estoque; quem enchia o disco era a
 * torneira. JPEG qualidade 88 é a mesma do conversor (~600 KB numa capa real,
 * contra 4,4 MB em PNG) e as lojas já recebem JPEG das 14 mil capas antigas.
 */
const path = require('path');

const QUALIDADE = 88;
const EXTENSAO = '.jpg';

/** Opções do page.screenshot do Puppeteer para uma capa. */
function opcoesDeCaptura(extra = {}) {
  return { ...extra, type: 'jpeg', quality: QUALIDADE };
}

/** Caminho de uma capa nova: <pasta>/<prefixo>_<instante>.jpg */
function caminhoDeCapa(pasta, prefixo, agora = Date.now()) {
  return path.join(pasta, `${prefixo}_${agora}${EXTENSAO}`);
}

/**
 * Bytes de uma capa montada em Canvas (@napi-rs/canvas: qualidade 0–100).
 * 09/11/2026: o caminho de reserva do coverAgent (capa viral e HTML falharam)
 * seguia gravando PNG — duas capas no mesmo dia do conserto dos geradores.
 */
function codificarCanvas(canvas) {
  return canvas.toBuffer('image/jpeg', QUALIDADE);
}

module.exports = { QUALIDADE, EXTENSAO, opcoesDeCaptura, caminhoDeCapa, codificarCanvas };
