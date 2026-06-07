'use strict';
/**
 * sessionPath.js — Resolve o caminho do arquivo de sessão de forma portável.
 *
 * Prioridade:
 *   1. Env var específica (ex: HOTMART_SESSION_FILE)
 *   2. DATA_DIR/sessions/<platform>.json
 *   3. /app/data/sessions/<platform>.json  (Docker)
 *   4. <projectRoot>/data/sessions/<platform>.json  (dev local)
 */
const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function resolveSessionFile(platform, envVar) {
  // 1. Env var explícita
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  // 2. DATA_DIR env var
  if (process.env.DATA_DIR) {
    return path.join(process.env.DATA_DIR, 'sessions', `${platform}.json`);
  }

  // 3. Docker path (/app/data existe)
  if (fs.existsSync('/app/data')) {
    return `/app/data/sessions/${platform}.json`;
  }

  // 4. Dev local (relativo à raiz do projeto)
  return path.join(PROJECT_ROOT, 'data', 'sessions', `${platform}.json`);
}

module.exports = { resolveSessionFile };
