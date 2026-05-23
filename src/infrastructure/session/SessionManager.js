/**
 * SessionManager.js — Loads, validates, and refreshes platform sessions.
 * Reads from /app/data/sessions/{platform}.json
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/data/sessions';

// Session TTL in ms (Hotmart ~48h, Cakto ~7 days)
const SESSION_TTL = {
  hotmart: 48 * 60 * 60 * 1000,
  cakto:   7 * 24 * 60 * 60 * 1000,
  amazon:  30 * 24 * 60 * 60 * 1000,
};

class SessionManager {
  constructor() {
    this._cache = {};
  }

  /**
   * Load a session from disk.
   * @param {string} platform
   * @returns {{ cookies: Object[], localStorage: Object, savedAt: number }|null}
   */
  load(platform) {
    const filePath = path.join(SESSIONS_DIR, `${platform}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      this._cache[platform] = { data, loadedAt: Date.now() };
      return data;
    } catch (e) {
      return null;
    }
  }

  /**
   * Check if a platform session exists and is likely still valid.
   * @param {string} platform
   * @returns {{ exists: boolean, valid: boolean, ageMs: number, expiresIn: number }}
   */
  check(platform) {
    const filePath = path.join(SESSIONS_DIR, `${platform}.json`);
    if (!fs.existsSync(filePath)) {
      return { exists: false, valid: false, ageMs: 0, expiresIn: 0 };
    }

    try {
      const data  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const saved = data.savedAt || fs.statSync(filePath).mtimeMs;
      const ageMs = Date.now() - saved;
      const ttl   = SESSION_TTL[platform] || SESSION_TTL.hotmart;
      const valid = ageMs < ttl;

      return {
        exists:    true,
        valid,
        ageMs,
        expiresIn: Math.max(0, ttl - ageMs),
        savedAt:   new Date(saved).toISOString(),
      };
    } catch {
      return { exists: false, valid: false, ageMs: 0, expiresIn: 0 };
    }
  }

  /**
   * Get health status for all platforms.
   * @returns {Object}
   */
  getAllStatus() {
    const platforms = ['hotmart', 'cakto', 'amazon'];
    const result = {};
    for (const p of platforms) {
      result[p] = this.check(p);
    }
    return result;
  }

  /**
   * Save a session to disk.
   * @param {string} platform
   * @param {Object} sessionData
   */
  save(platform, sessionData) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const filePath = path.join(SESSIONS_DIR, `${platform}.json`);
    const data = { ...sessionData, savedAt: Date.now() };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    this._cache[platform] = { data, loadedAt: Date.now() };
  }
}

// Singleton
const instance = new SessionManager();
module.exports = { SessionManager: instance };
