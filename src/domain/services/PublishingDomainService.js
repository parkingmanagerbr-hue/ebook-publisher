/**
 * PublishingDomainService.js — Domain Service
 * Pure business logic for publishing decisions.
 * No I/O — operates only on domain entities.
 */
'use strict';

const { Ebook } = require('../entities/Ebook');

class PublishingDomainService {
  /**
   * Determine which ebooks need publishing on which platforms.
   * @param {Ebook[]} ebooks
   * @param {string[]} targetPlatforms
   * @returns {{ ebook: Ebook, platforms: string[] }[]}
   */
  filterNeedsPublishing(ebooks, targetPlatforms = ['hotmart', 'cakto']) {
    const result = [];
    for (const ebook of ebooks) {
      if (!ebook.pdfPath) continue; // Must have PDF
      const pending = ebook.pendingPlatforms(targetPlatforms);
      if (pending.length > 0) {
        result.push({ ebook, platforms: pending });
      }
    }
    return result;
  }

  /**
   * Check if an ebook is a duplicate (same title already published).
   * @param {Ebook} candidate
   * @param {Ebook[]} existing
   * @returns {boolean}
   */
  isDuplicate(candidate, existing) {
    const normalize = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const candidateTitle = normalize(candidate.title);
    return existing.some(e => {
      if (e.id === candidate.id) return false;
      const existingTitle = normalize(e.title);
      // Exact match or very high similarity (first 30 chars match)
      return existingTitle === candidateTitle ||
        (candidateTitle.length > 10 && existingTitle.startsWith(candidateTitle.slice(0, 30)));
    });
  }

  /**
   * Sort ebooks by priority score (descending).
   * @param {{ ebook: Ebook, score: number, platforms: string[] }[]} scoredItems
   * @returns {{ ebook: Ebook, score: number, platforms: string[] }[]}
   */
  sortByPriority(scoredItems) {
    return [...scoredItems].sort((a, b) => b.score - a.score);
  }

  /**
   * Validate an ebook is safe to publish.
   * @param {Ebook} ebook
   * @returns {{ valid: boolean, reasons: string[] }}
   */
  validateForPublishing(ebook) {
    const reasons = [];
    if (!ebook.title || ebook.title.length < 5) reasons.push('Title too short');
    if (!ebook.pdfPath)                         reasons.push('No PDF path');
    if (ebook.status === 'publishing')          reasons.push('Already being published');
    return { valid: reasons.length === 0, reasons };
  }
}

module.exports = { PublishingDomainService };
