/**
 * PriorityScorer.js — ML Priority Scoring for Publishing Queue
 * Scores each ebook 0-100 to determine publishing priority.
 *
 * SCORING FORMULA:
 *  - Category weight (40%): financas=95, saude=90, negocios=85,
 *    tecnologia=80, relacionamento=75, outros=60
 *  - Title quality (20%): length 30-60 chars=+10, has colon=+5, has number=+5
 *  - Assets: has cover=+10, has PDF=+10 (required)
 *  - Recency: newer = higher (decay 1pt/day, max 10 days)
 *  - Platform bonus: already on 1 platform=+5 (proven content)
 *  - Normalized 0-100
 */
'use strict';

const fs = require('fs');

// Category keyword -> weight (0-100)
const CATEGORY_WEIGHTS = {
  // Finance
  financas: 95, investimento: 95, dinheiro: 92, renda: 90, credito: 88,
  bolsa: 88, acoes: 87, trading: 85,
  // Health
  saude: 90, emagrecimento: 90, dieta: 88, fitness: 87, exercicio: 85,
  musculacao: 83, ansiedade: 88, mental: 87, sono: 82,
  // Business
  negocios: 85, empreend: 85, marketing: 84, vendas: 83, carreira: 80,
  produtividade: 80, lideranca: 78, gestao: 78,
  // Tech
  tecnologia: 80, programar: 80, software: 78, inteligencia: 78, python: 75,
  digital: 75,
  // Relationships
  relacionamento: 75, comunicacao: 73, familia: 70, maternidade: 70,
  // Education
  idioma: 68, lingua: 68, educacao: 65, concurso: 65,
  // Default
  _default: 60,
};

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

class PriorityScorer {
  /**
   * Score a single ebook.
   * @param {import('../../domain/entities/Ebook').Ebook} ebook
   * @returns {number} Score 0-100
   */
  score(ebook) {
    let total = 0;

    // ── 1. Category weight (up to 40 pts) ─────────────────────────────────────
    const text = norm(`${ebook.topic} ${ebook.title}`);
    let catWeight = CATEGORY_WEIGHTS._default;
    for (const [kw, w] of Object.entries(CATEGORY_WEIGHTS)) {
      if (kw === '_default') continue;
      if (text.includes(kw)) { catWeight = Math.max(catWeight, w); }
    }
    total += (catWeight / 100) * 40;

    // ── 2. Title quality (up to 20 pts) ───────────────────────────────────────
    const title  = ebook.title || '';
    let titlePts = 0;
    if (title.length >= 30 && title.length <= 60) titlePts += 10;
    else if (title.length >= 20 && title.length < 30) titlePts += 5;
    if (title.includes(':') || title.includes('—') || title.includes('-')) titlePts += 5;
    if (/\d/.test(title)) titlePts += 5;
    total += Math.min(20, titlePts);

    // ── 3. Assets (up to 20 pts) ──────────────────────────────────────────────
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath))     total += 10;
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) total += 10;

    // ── 4. Recency (up to 10 pts) ─────────────────────────────────────────────
    const createdAt = new Date(ebook.createdAt || Date.now());
    const ageDays   = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const recency   = Math.max(0, 10 - ageDays);
    total += recency;

    // ── 5. Platform bonus (up to 5 pts) ───────────────────────────────────────
    if (ebook.publishedCount() === 1) total += 5;

    // ── Normalize 0-100 ───────────────────────────────────────────────────────
    return Math.round(Math.min(100, Math.max(0, total)));
  }

  /**
   * Score and sort an array of ebooks.
   * @param {import('../../domain/entities/Ebook').Ebook[]} ebooks
   * @returns {{ ebook: import('../../domain/entities/Ebook').Ebook, score: number }[]}
   */
  scoreAll(ebooks) {
    return ebooks
      .map(ebook => ({ ebook, score: this.score(ebook) }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Get the category label for an ebook (for logging/display).
   * @param {import('../../domain/entities/Ebook').Ebook} ebook
   * @returns {string}
   */
  getCategory(ebook) {
    const text = norm(`${ebook.topic} ${ebook.title}`);
    if (['financas','investimento','dinheiro','renda','bolsa','acoes','trading'].some(k => text.includes(k))) return 'financas';
    if (['saude','emagrecimento','dieta','fitness','ansiedade','mental'].some(k => text.includes(k)))         return 'saude';
    if (['negocios','empreend','marketing','vendas','carreira'].some(k => text.includes(k)))                  return 'negocios';
    if (['tecnologia','programar','software','inteligencia','python'].some(k => text.includes(k)))            return 'tecnologia';
    if (['relacionamento','comunicacao','familia'].some(k => text.includes(k)))                               return 'relacionamento';
    return 'outros';
  }
}

// Singleton
const instance = new PriorityScorer();
module.exports = { PriorityScorer: instance };
